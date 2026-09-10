// Headless local harness: WebSocket server for the Figma plugin + Claude Agent SDK session manager.
// The user never talks to this process; every interaction happens in the plugin UI.
import { createSdkMcpServer, query, startup, tool, type Options, type Query, type SDKUserMessage, type WarmQuery } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { BRIDGE_PORT, FIGMA_MCP_URL, type DownMsg, type Health, type NodeRef, type PermissionDecision, type SessionRecord, type ToolResult, type UpMsg } from "../../shared/protocol.ts";
import { readFileSync } from "node:fs";
import { addUsage, hasClaudeAuth, installPlugin, readAllow, readSessions, readSettings, readTranscript, saveSession, saveSettings, workspaceFor, zeroUsage } from "./workspace.ts";

const VERSION: string = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version; // root package: same depth from bridge/src and bridge/dist, and it ships in the tarball
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const now = () => new Date().toISOString();

// ---- plugin connections (one per open Figma file, keyed by fileId) ----------------
const clients = new Map<string, WebSocket>();
const pending = new Map<string, { ws: WebSocket; resolve: (v: any) => void; onDrop: unknown }>();
const live = (ws?: WebSocket): ws is WebSocket => !!ws && ws.readyState === ws.OPEN;
const send = (fileId: string, m: DownMsg) => { const ws = clients.get(fileId); if (live(ws)) ws.send(JSON.stringify(m)); };

/** Send a request to the file's plugin and wait for its `reply`; resolves with `onDrop` if the plugin is gone. */
function ask<T>(fileId: string, m: { kind: "tool"; tool: string; args: Record<string, unknown> } | { kind: "permission"; tool: string; input: Record<string, unknown> }, onDrop: T): Promise<T> {
  return new Promise(resolve => {
    const ws = clients.get(fileId);
    if (!live(ws)) return resolve(onDrop);
    const id = randomUUID();
    pending.set(id, { ws, resolve, onDrop });
    ws.send(JSON.stringify({ ...m, id }));
  });
}

// ---- Figma tools (in-process MCP server; each call is executed by the plugin) --------
const disconnected: ToolResult = { content: [{ type: "text", text: "The Figma plugin is not connected. Ask the user to reopen it." }], isError: true };
const figmaTool = (fileId: string, name: string, description: string, shape: z.ZodRawShape) =>
  tool(name, description, shape, args => ask(fileId, { kind: "tool", tool: name, args }, disconnected));

// One server instance per query: an MCP server instance binds to a single transport.
const figmaServer = (fileId: string) => createSdkMcpServer({ name: "figma", version: VERSION, tools: [
  figmaTool(fileId, "get_flow", "Prototype flow of the user's current Figma page: screens (id, name, size) and transitions (from, to, trigger, navigation, via which element). Falls back to listing top-level frames when the page has no prototype flow.", {}),
  figmaTool(fileId, "get_screen", "PNG screenshot of a node plus its layer tree (ids, names, types, bounds relative to the node, text, existing annotations). Works for whole screens and for single components.",
    { nodeId: z.string().describe("Node id such as 12:34"), scale: z.number().min(0.25).max(3).optional().describe("Export scale, default 1; use 2 for small components") }),
  figmaTool(fileId, "focus", "Select a node and scroll/zoom the user's canvas to it. Call it before discussing a node so the user sees what you mean.", { nodeId: z.string() }),
  figmaTool(fileId, "annotate", "Attach a Dev Mode annotation (markdown) to a node, appended to what is already there.",
    // .optional(), not .default(): the SDK's input validation rejected calls that omitted a defaulted field
    { nodeId: z.string(), markdown: z.string().describe("Annotation body, markdown"), replace: z.boolean().optional().describe("Replace the node's existing annotations instead of appending; only when the user asked for it") }),
  figmaTool(fileId, "ask_user", "Ask the user a question about a specific spot in the design. Focuses their canvas on nodeId (if given), shows the question with optional choice buttons in the plugin, and waits for the answer. Returns the answer and the user's current selection.",
    { nodeId: z.string().optional(), question: z.string(), options: z.array(z.string()).max(4).optional() }),
]});

const SYSTEM = `You are a senior product designer and front-end lead doing a design review inside Figma, through a plugin chat panel.
The user watches the canvas while you talk: call focus on a node before discussing it, and cover one screen per message.
Be concrete and brief in chat; put implementation detail into annotations. When something is ambiguous, ask with ask_user instead of assuming.`;

function options(fileId: string, dir: string, resume?: string): Options {
  const appRepo = process.env.APP_REPO;
  const settings = readSettings();
  return {
    cwd: dir,
    resume,
    settingSources: ["project"], // CLAUDE.md, .claude/skills, .mcp.json from the workspace
    additionalDirectories: appRepo ? [appRepo] : [],
    systemPrompt: SYSTEM,
    mcpServers: { figma: figmaServer(fileId), "figma-desktop": { type: "http", url: FIGMA_MCP_URL } },
    strictMcpConfig: true, // do not pull in the user's personal MCP servers
    tools: ["Read", "Glob", "Grep", "Write", "Edit", "Skill"],
    allowedTools: readAllow(dir), // auto-approve list, editable per file in <workspace>/permissions.json
    disallowedTools: ["AskUserQuestion"], // ask_user replaces it (it focuses the canvas)
    permissionMode: "default",
    canUseTool: async (toolName, input) => { // everything not in the allow list (e.g. writes outside notes/) → plugin card
      const d = await ask<PermissionDecision>(fileId, { kind: "permission", tool: toolName, input }, { behavior: "deny", message: "Figma plugin disconnected" });
      return d.behavior === "allow" ? { behavior: "allow", updatedInput: input } : d;
    },
    includePartialMessages: true,
    model: settings.model || undefined,
    effort: settings.effort || undefined,
    stderr: d => log("[claude]", d.trim()),
  };
}

// ---- conversations --------------------------------------------------------------
type Conv = { q: Query; push: (m: SDKUserMessage | null) => void; fileId: string; dir: string; rec: SessionRecord; baseCost: number };
let conv: Conv | undefined; // ponytail: one conversation at a time across all files; starting one ends the previous
let warm: { dir: string; wq: Promise<WarmQuery> } | undefined;
const health: Health = { bridge: VERSION, figmaMcp: "down", settings: readSettings() };

function inputStream() {
  const buf: (SDKUserMessage | null)[] = [];
  let wake = () => {};
  async function* gen() {
    for (;;) {
      while (buf.length) { const m = buf.shift()!; if (m === null) return; yield m; }
      await new Promise<void>(r => (wake = r));
    }
  }
  return { gen: gen(), push: (m: SDKUserMessage | null) => { buf.push(m); wake(); } };
}

function userMessage(text: string, selection: NodeRef[], context?: string): SDKUserMessage {
  const sel = selection.length ? selection.map(n => `${n.name} (${n.type} ${n.id})`).join(", ") : "none";
  const parts = [text, `[Current selection: ${sel}]`];
  if (context) parts.unshift(`[${context}]`);
  return { type: "user", message: { role: "user", content: parts.join("\n") }, parent_tool_use_id: null };
}

/** Spawn the CLI for the next fresh session in this workspace so `start` does not pay the boot cost. */
function prewarm(fileId: string, dir: string) {
  if (warm?.dir === dir) return;
  warm?.wq.then(w => w.close()).catch(() => {});
  const wq = startup({ options: options(fileId, dir) });
  warm = { dir, wq };
  wq.then(() => { health.claude ??= "ready"; health.error = undefined; }, e => { health.error = `Claude failed to start: ${e.message ?? e}`; warm = undefined; }).then(() => send(fileId, { kind: "health", health }));
}

async function startConv(m: Extract<UpMsg, { kind: "start" }>) {
  endConv();
  const dir = workspaceFor(m.fileId, m.fileName);
  const { gen, push } = inputStream();
  let q: Query | undefined;
  if (!m.resume && warm?.dir === dir) {
    const w = warm; warm = undefined;
    try { q = (await w.wq).query(gen); } catch (e) { log("pre-warmed query unusable, starting cold", e); }
  }
  q ??= query({ prompt: gen, options: options(m.fileId, dir, m.resume) });
  const prev = m.resume ? readSessions(dir).find(s => s.sessionId === m.resume) : undefined;
  const rec: SessionRecord = prev ?? { sessionId: "", title: m.text.slice(0, 80), anchor: m.anchor, pageId: m.pageId, pageName: m.pageName, createdAt: now(), updatedAt: now(), turns: 0, costUsd: 0, usage: zeroUsage() };
  conv = { q, push, fileId: m.fileId, dir, rec, baseCost: rec.costUsd }; // ponytail: total_cost_usd assumed not restored by --resume; base + this process
  const anchor = `Figma file "${m.fileName}", page "${m.pageName}" (${m.pageId}). Anchor: ${m.anchor.type}${m.anchor.nodeIds.length ? " " + m.anchor.nodeIds.join(", ") : ""}`;
  push(userMessage(m.text, m.selection, anchor));
  send(m.fileId, { kind: "busy", busy: true });
  void pump(conv);
  prewarm(m.fileId, dir); // next fresh session boots while this one runs
}

function endConv() {
  if (!conv) return;
  conv.push(null);
  conv.q.close();
  conv = undefined;
}

async function pump(c: Conv) {
  const out = (m: DownMsg) => send(c.fileId, m);
  try {
    for await (const msg of c.q) {
      if (conv !== c) break;
      if (msg.type === "system" && msg.subtype === "init") {
        c.rec.sessionId = msg.session_id;
        Object.assign(health, { claude: msg.claude_code_version, model: msg.model, servers: msg.mcp_servers, error: undefined });
        c.q.mcpServerStatus().then(s => { health.servers = s.map(x => ({ name: x.name, status: x.status, error: x.error })); out({ kind: "health", health }); }).catch(() => {});
        out({ kind: "health", health });
        saveSession(c.dir, c.rec);
        out({ kind: "session", session: c.rec });
      }
      if (msg.type === "stream_event" && !msg.parent_tool_use_id) { // live token count: one API response = message_start (input) + message_delta (output)
        const ev = msg.event as any;
        if (ev.type === "message_start") c.rec.usage = addUsage(c.rec.usage, { ...ev.message.usage, output_tokens: 0 });
        if (ev.type === "message_delta") { c.rec.usage = addUsage(c.rec.usage, { output_tokens: ev.usage?.output_tokens }); out({ kind: "session", session: c.rec }); }
      }
      if (msg.type === "result") {
        c.rec.turns++;
        c.rec.costUsd = c.baseCost + msg.total_cost_usd;
        c.rec.updatedAt = now();
        log("turn done", { streamed: c.rec.usage, result: msg.usage, cost: msg.total_cost_usd });
        saveSession(c.dir, c.rec);
        out({ kind: "session", session: c.rec });
        out({ kind: "sessions", sessions: readSessions(c.dir) });
        out({ kind: "busy", busy: false });
      }
      if (msg.type !== "user") out({ kind: "sdk", msg }); // tool results (with screenshots) stay in the bridge
    }
  } catch (e) {
    log("session error", e);
    out({ kind: "error", message: `Session error: ${(e as Error).message ?? e}` });
  } finally {
    if (conv === c) { conv = undefined; out({ kind: "busy", busy: false }); }
  }
}

// ---- health ----------------------------------------------------------------------
async function probeFigmaMcp(): Promise<Health["figmaMcp"]> {
  try { // any HTTP answer means the desktop server is listening; connection refused means it is off
    await fetch(FIGMA_MCP_URL, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "sesori-review", version: VERSION } } }),
      signal: AbortSignal.timeout(1500) });
    return "up";
  } catch { return "down"; }
}
async function sendHealth(fileId: string) { health.figmaMcp = await probeFigmaMcp(); send(fileId, { kind: "health", health }); }

// ---- inbound ---------------------------------------------------------------------
async function onUp(ws: WebSocket & { fileId?: string }, m: UpMsg) {
  switch (m.kind) {
    case "hello": {
      const old = clients.get(m.fileId);
      if (old && old !== ws) old.close(); // same file opened twice: the newest plugin instance wins
      clients.set(m.fileId, ws);
      ws.fileId = m.fileId;
      const dir = workspaceFor(m.fileId, m.fileName);
      send(m.fileId, { kind: "sessions", sessions: readSessions(dir) });
      const mine = conv && conv.fileId === m.fileId;
      if (mine) send(m.fileId, { kind: "session", session: conv!.rec }); // plugin reopened mid-session: re-attach
      send(m.fileId, { kind: "busy", busy: !!mine });
      prewarm(m.fileId, dir);
      return sendHealth(m.fileId);
    }
    case "start": return startConv(m);
    case "open": {
      const dir = workspaceFor(m.fileId, m.fileName);
      const session = readSessions(dir).find(s => s.sessionId === m.sessionId);
      if (!session) return send(m.fileId, { kind: "error", message: "Unknown session" });
      const attached = conv?.rec.sessionId === m.sessionId;
      return send(m.fileId, { kind: "history", session: attached ? conv!.rec : session, messages: readTranscript(dir, m.sessionId), attached });
    }
    case "user":
      if (!conv || conv.fileId !== ws.fileId) return send(ws.fileId!, { kind: "error", message: "No active session for this file. Start one or open one from History." });
      conv.push(userMessage(m.text, m.selection)); // Claude Code merges it into the running turn between tool calls (steer)
      return send(conv.fileId, { kind: "busy", busy: true });
    case "reply": { const p = pending.get(m.id); pending.delete(m.id); p?.resolve(m.result); return; }
    case "interrupt": if (conv && conv.fileId === ws.fileId) await conv.q.interrupt(); return;
    case "settings": {
      saveSettings(m.settings);
      health.settings = m.settings;
      if (conv) { // live session switches too; effort "" falls back to Claude Code's default
        await conv.q.setModel(m.settings.model || undefined);
        await conv.q.applyFlagSettings({ effortLevel: m.settings.effort || null });
      }
      if (warm) { const dir = warm.dir; warm.wq.then(w => w.close()).catch(() => {}); warm = undefined; prewarm(ws.fileId!, dir); } // re-warm with the new model
      return send(ws.fileId!, { kind: "health", health });
    }
    case "health": return sendHealth(ws.fileId!);
  }
}

new WebSocketServer({ port: BRIDGE_PORT, host: "127.0.0.1" }).on("connection", (ws: WebSocket & { fileId?: string }) => {
  log("plugin connected");
  ws.on("message", raw => { onUp(ws, JSON.parse(String(raw))).catch(e => { if (ws.fileId) send(ws.fileId, { kind: "error", message: String(e) }); }); });
  ws.on("close", () => {
    if (ws.fileId && clients.get(ws.fileId) === ws) clients.delete(ws.fileId);
    for (const [id, p] of pending) if (p.ws === ws) { pending.delete(id); p.resolve(p.onDrop); } // unblock tool calls waiting on a plugin that is gone
    log("plugin disconnected", ws.fileId ?? "");
  });
});
log(`bridge ${VERSION} listening on ws://127.0.0.1:${BRIDGE_PORT}` + (process.env.APP_REPO ? ` · app repo ${process.env.APP_REPO}` : ""));
const manifest = installPlugin();
console.log(manifest
  ? `\nSesori Figma Review is running. Keep this terminal open.\n\nFirst time? Add the plugin to Figma desktop once:\n  Plugins → Development → Import plugin from manifest… → ${manifest}\nThen run it from Plugins → Development → Sesori Figma Review.\n`
  : "\nPlugin build not found (run `npm run build`); the bridge is up but there is nothing to import into Figma.\n");
if (!hasClaudeAuth()) console.log("No Claude credentials found: run `claude` once to sign in, or export ANTHROPIC_API_KEY. The plugin will show \"Claude failed to start\" until then.\n");
