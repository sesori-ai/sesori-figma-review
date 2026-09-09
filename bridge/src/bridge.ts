// Headless local harness: WebSocket server for the Figma plugin + Claude Agent SDK session manager.
// The user never talks to this process; every interaction happens in the plugin UI.
import { createSdkMcpServer, query, startup, tool, type Options, type Query, type SDKUserMessage, type WarmQuery } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { BRIDGE_PORT, FIGMA_MCP_URL, type DownMsg, type Health, type NodeRef, type PermissionDecision, type SessionRecord, type ToolResult, type UpMsg } from "../../shared/protocol.ts";
import { readSessions, saveSession, sumUsage, workspaceFor, zeroUsage } from "./workspace.ts";

const VERSION = "0.1.0";
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const now = () => new Date().toISOString();

// ---- plugin connection --------------------------------------------------------
let plugin: WebSocket | undefined;
const pending = new Map<string, { resolve: (v: any) => void; onDrop: unknown }>();
const send = (m: DownMsg) => { if (plugin && plugin.readyState === plugin.OPEN) plugin.send(JSON.stringify(m)); };

/** Send a request to the plugin and wait for its `reply`; resolves with `onDrop` if the plugin is gone. */
function ask<T>(m: { kind: "tool"; tool: string; args: Record<string, unknown> } | { kind: "permission"; tool: string; input: Record<string, unknown> }, onDrop: T): Promise<T> {
  return new Promise(resolve => {
    if (!plugin || plugin.readyState !== plugin.OPEN) return resolve(onDrop);
    const id = randomUUID();
    pending.set(id, { resolve, onDrop });
    send({ ...m, id });
  });
}

// ---- Figma tools (in-process MCP server; each call is executed by the plugin) --------
const disconnected: ToolResult = { content: [{ type: "text", text: "The Figma plugin is not connected. Ask the user to reopen it." }], isError: true };
const figmaTool = (name: string, description: string, shape: z.ZodRawShape) =>
  tool(name, description, shape, args => ask({ kind: "tool", tool: name, args }, disconnected));

// One server instance per query: an MCP server instance binds to a single transport.
const figmaServer = () => createSdkMcpServer({ name: "figma", version: VERSION, tools: [
  figmaTool("get_flow", "Prototype flow of the user's current Figma page: screens (id, name, size) and transitions (from, to, trigger, navigation, via which element). Falls back to listing top-level frames when the page has no prototype flow.", {}),
  figmaTool("get_screen", "PNG screenshot of a node plus its layer tree (ids, names, types, bounds relative to the node, text, existing annotations). Works for whole screens and for single components.",
    { nodeId: z.string().describe("Node id such as 12:34"), scale: z.number().min(0.25).max(3).default(1).describe("Export scale; use 2 for small components") }),
  figmaTool("focus", "Select a node and scroll/zoom the user's canvas to it. Call it before discussing a node so the user sees what you mean.", { nodeId: z.string() }),
  figmaTool("annotate", "Attach a Dev Mode annotation (markdown) to a node. The user approves each call in the plugin.",
    { nodeId: z.string(), markdown: z.string().describe("Annotation body, markdown"), replace: z.boolean().default(false).describe("Replace the node's existing annotations instead of appending") }),
  figmaTool("ask_user", "Ask the user a question about a specific spot in the design. Focuses their canvas on nodeId (if given), shows the question with optional choice buttons in the plugin, and waits for the answer. Returns the answer and the user's current selection.",
    { nodeId: z.string().optional(), question: z.string(), options: z.array(z.string()).max(4).optional() }),
]});

const SYSTEM = `You are a senior product designer and front-end lead doing a design review inside Figma, through a plugin chat panel.
Use the figma tools to look at and steer the user's canvas. Be concrete and brief in chat; put implementation detail into annotations.
When something is ambiguous, ask with ask_user instead of assuming.`;

function options(dir: string, resume?: string): Options {
  const appRepo = process.env.APP_REPO;
  return {
    cwd: dir,
    resume,
    settingSources: ["project"], // CLAUDE.md, .claude/skills, .mcp.json from the workspace
    additionalDirectories: appRepo ? [appRepo] : [],
    systemPrompt: SYSTEM,
    mcpServers: { figma: figmaServer(), "figma-desktop": { type: "http", url: FIGMA_MCP_URL } },
    strictMcpConfig: true, // do not pull in the user's personal MCP servers
    tools: ["Read", "Glob", "Grep", "Write", "Edit", "Skill"],
    allowedTools: [
      "Read", "Glob", "Grep", "Skill",
      `Edit(//${dir.replace(/^\//, "")}/notes/**)`, // Edit rules also govern Write
      "mcp__figma__get_flow", "mcp__figma__get_screen", "mcp__figma__focus", "mcp__figma__ask_user",
      "mcp__figma-desktop", // every tool of the local Figma MCP server
    ],
    disallowedTools: ["AskUserQuestion"], // ask_user replaces it (it focuses the canvas)
    permissionMode: "default",
    canUseTool: async (toolName, input) => { // everything not allowed above (annotate, writes outside notes/) → plugin card
      const d = await ask<PermissionDecision>({ kind: "permission", tool: toolName, input }, { behavior: "deny", message: "Figma plugin disconnected" });
      return d.behavior === "allow" ? { behavior: "allow", updatedInput: input } : d;
    },
    includePartialMessages: true,
    model: process.env.FIGMA_REVIEW_MODEL,
    stderr: d => log("[claude]", d.trim()),
  };
}

// ---- conversations --------------------------------------------------------------
type Conv = { q: Query; push: (m: SDKUserMessage | null) => void; dir: string; rec: SessionRecord; baseCost: number; baseUsage: SessionRecord["usage"]; usageById: Map<string, any> };
let conv: Conv | undefined;
let warm: { dir: string; wq: Promise<WarmQuery> } | undefined;
const health: Health = { bridge: VERSION, figmaMcp: "down" };

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
function prewarm(dir: string) {
  if (warm?.dir === dir) return;
  warm?.wq.then(w => w.close()).catch(() => {});
  const wq = startup({ options: options(dir) });
  warm = { dir, wq };
  wq.then(() => { health.claude ??= "ready"; health.error = undefined; }, e => { health.error = `Claude failed to start: ${e.message ?? e}`; warm = undefined; }).then(() => send({ kind: "health", health }));
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
  q ??= query({ prompt: gen, options: options(dir, m.resume) });
  const prev = m.resume ? readSessions(dir).find(s => s.sessionId === m.resume) : undefined;
  const rec: SessionRecord = prev ?? { sessionId: "", title: m.text.slice(0, 80), anchor: m.anchor, pageId: m.pageId, pageName: m.pageName, createdAt: now(), updatedAt: now(), turns: 0, costUsd: 0, usage: zeroUsage() };
  conv = { q, push, dir, rec, baseCost: rec.costUsd, baseUsage: rec.usage, usageById: new Map() }; // ponytail: cost/usage assumed not restored by --resume; base + this process
  const anchor = `Figma file "${m.fileName}", page "${m.pageName}" (${m.pageId}). Anchor: ${m.anchor.type}${m.anchor.nodeIds.length ? " " + m.anchor.nodeIds.join(", ") : ""}`;
  push(userMessage(m.text, m.selection, anchor));
  send({ kind: "busy", busy: true });
  void pump(conv);
  prewarm(dir); // next fresh session boots while this one runs
}

function endConv() {
  if (!conv) return;
  conv.push(null);
  conv.q.close();
  conv = undefined;
}

async function pump(c: Conv) {
  try {
    for await (const msg of c.q) {
      if (conv !== c) break;
      if (msg.type === "system" && msg.subtype === "init") {
        c.rec.sessionId = msg.session_id;
        Object.assign(health, { claude: msg.claude_code_version, model: msg.model, servers: msg.mcp_servers, error: undefined });
        c.q.mcpServerStatus().then(s => { health.servers = s.map(x => ({ name: x.name, status: x.status, error: x.error })); send({ kind: "health", health }); }).catch(() => {});
        send({ kind: "health", health });
        saveSession(c.dir, c.rec);
        send({ kind: "session", session: c.rec });
      }
      if (msg.type === "assistant") c.usageById.set(msg.message.id, msg.message.usage);
      if (msg.type === "result") {
        c.rec.turns++;
        c.rec.costUsd = c.baseCost + msg.total_cost_usd;
        c.rec.usage = sumUsage(c.usageById, c.baseUsage);
        c.rec.updatedAt = now();
        saveSession(c.dir, c.rec);
        send({ kind: "session", session: c.rec });
        send({ kind: "sessions", sessions: readSessions(c.dir) });
        send({ kind: "busy", busy: false });
      }
      if (msg.type !== "user") send({ kind: "sdk", msg }); // tool results (with screenshots) stay in the bridge
    }
  } catch (e) {
    log("session error", e);
    send({ kind: "error", message: `Session error: ${(e as Error).message ?? e}` });
  } finally {
    if (conv === c) { conv = undefined; send({ kind: "busy", busy: false }); }
  }
}

// ---- health ----------------------------------------------------------------------
async function probeFigmaMcp(): Promise<Health["figmaMcp"]> {
  try { // any HTTP answer means the desktop server is listening; connection refused means it is off
    await fetch(FIGMA_MCP_URL, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "figma-ai-review", version: VERSION } } }),
      signal: AbortSignal.timeout(1500) });
    return "up";
  } catch { return "down"; }
}
async function sendHealth() { health.figmaMcp = await probeFigmaMcp(); send({ kind: "health", health }); }

// ---- inbound ---------------------------------------------------------------------
async function onUp(m: UpMsg) {
  switch (m.kind) {
    case "hello": {
      const dir = workspaceFor(m.fileId, m.fileName);
      send({ kind: "sessions", sessions: readSessions(dir) });
      if (conv?.dir === dir) send({ kind: "session", session: conv.rec }); // plugin reopened mid-session: re-attach
      prewarm(dir);
      return sendHealth();
    }
    case "start": return startConv(m);
    case "user":
      if (!conv) return send({ kind: "error", message: "No active session. Start one or resume from History." });
      conv.push(userMessage(m.text, m.selection)); // Claude Code merges it into the running turn between tool calls (steer)
      return send({ kind: "busy", busy: true });
    case "reply": { const p = pending.get(m.id); pending.delete(m.id); p?.resolve(m.result); return; }
    case "interrupt": await conv?.q.interrupt(); return;
    case "health": return sendHealth();
  }
}

new WebSocketServer({ port: BRIDGE_PORT, host: "127.0.0.1" }).on("connection", ws => {
  plugin?.close(); // ponytail: one plugin connection at a time, last one wins
  plugin = ws;
  log("plugin connected");
  ws.on("message", raw => { onUp(JSON.parse(String(raw))).catch(e => send({ kind: "error", message: String(e) })); });
  ws.on("close", () => {
    if (plugin === ws) plugin = undefined;
    for (const p of pending.values()) p.resolve(p.onDrop); // unblock tool calls waiting on a plugin that is gone
    pending.clear();
    log("plugin disconnected");
  });
});
log(`bridge ${VERSION} listening on ws://127.0.0.1:${BRIDGE_PORT}` + (process.env.APP_REPO ? ` · app repo ${process.env.APP_REPO}` : ""));
