// Headless local harness: WebSocket server for the Figma plugin and one provider-neutral conversation owner.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { WebSocketServer, type WebSocket } from "ws";
import {
  BRIDGE_PORT,
  FIGMA_MCP_URL,
  PROTOCOL_VERSION,
  type DownMsg,
  type Health,
  type PermissionDecision,
  type ProviderHealth,
  type ProviderId,
  type SessionRecord,
  type ToolResult,
  type UpMsg,
} from "../../shared/protocol.ts";
import { applyForCurrentConversation, isOwnedByFile, isRegisteredFileSocket, type FileOwned } from "./conversation-owner.ts";
import { ClaudeProvider } from "./providers/claude.ts";
import type { ProviderRequestBoundary, ReviewProvider, ReviewSession } from "./providers/types.ts";
import { hasClaudeAuth, installPlugin, readSessions, readSettings, saveSession, saveSettings, workspaceFor, zeroUsage } from "./workspace.ts";

const emitWarning = process.emitWarning.bind(process); // SDK warns that allowedTools bypasses canUseTool; that is the editable auto-approve list by design
process.emitWarning = ((...args: Parameters<typeof process.emitWarning>) => {
  if (!/canUseTool/.test(String(args[0]))) emitWarning(...args);
}) as typeof process.emitWarning;

const VERSION: string = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
const log = (...values: unknown[]) => console.log(new Date().toISOString(), ...values);
const now = () => new Date().toISOString();
const port = Number(process.env.SESORI_REVIEW_PORT ?? BRIDGE_PORT);

const clients = new Map<string, WebSocket>();
type Pending = { ws: WebSocket; owner: string; resolve: (value: ToolResult | PermissionDecision) => void; onDrop: ToolResult | PermissionDecision };
const pending = new Map<string, Pending>();
const activeRequestOwners = new Set<string>();
const live = (ws?: WebSocket): ws is WebSocket => !!ws && ws.readyState === ws.OPEN;
const send = (fileId: string, message: DownMsg) => { const ws = clients.get(fileId); if (live(ws)) ws.send(JSON.stringify(message)); };

function ask(args: {
  fileId: string;
  owner: string;
  message: { kind: "tool"; tool: string; args: Record<string, unknown> } | { kind: "permission"; tool: string; input: Record<string, unknown> };
  onDrop: ToolResult | PermissionDecision;
}): Promise<ToolResult | PermissionDecision> {
  return new Promise(resolve => {
    if (!activeRequestOwners.has(args.owner)) return resolve(args.onDrop);
    const ws = clients.get(args.fileId);
    if (!live(ws)) return resolve(args.onDrop);
    const id = randomUUID();
    pending.set(id, { ws, owner: args.owner, resolve, onDrop: args.onDrop });
    ws.send(JSON.stringify({ ...args.message, id }));
  });
}

function cancelOutstandingRequests(args: { owner: string; reason: string }) {
  for (const [id, request] of pending) {
    if (request.owner !== args.owner) continue;
    pending.delete(id);
    request.resolve(request.onDrop);
    request.ws.send(JSON.stringify({ kind: "cancel_request", id, reason: args.reason } satisfies DownMsg));
  }
}

function deactivateRequestOwner(args: { owner: string; reason: string }) {
  activeRequestOwners.delete(args.owner);
  cancelOutstandingRequests(args);
}

const disconnected: ToolResult = {
  content: [{ type: "text", text: "The Figma plugin is not connected. Ask the user to reopen it." }],
  isError: true,
};
const denied: PermissionDecision = { behavior: "deny", message: "Figma plugin disconnected" };
const boundary = (args: { fileId: string; owner: string }): ProviderRequestBoundary => ({
  tool: request => ask({ ...args, message: { kind: "tool", tool: request.tool, args: request.args }, onDrop: disconnected }) as Promise<ToolResult>,
  permission: request => ask({ ...args, message: { kind: "permission", ...request }, onDrop: denied }) as Promise<PermissionDecision>,
});

const providerChanged = () => { for (const fileId of clients.keys()) send(fileId, { kind: "health", health: makeHealth() }); };
const claude = new ClaudeProvider({ version: VERSION, log, onPrepared: providerChanged });
const providers: Record<ProviderId, ReviewProvider | undefined> = { claude, codex: undefined };

function makeHealth(): Health {
  const settings = readSettings();
  return {
    bridge: VERSION,
    protocolVersion: PROTOCOL_VERSION,
    figmaMcp: healthFigmaMcp,
    selectedProvider: settings.provider,
    liveProvider: conv?.record.provider,
    settings,
    providers: [
      conv?.record.provider === "claude" && conv.health ? conv.health : claude.health({ settings: settings.providers.claude }),
      { provider: "codex", status: "unavailable", models: [], error: "Codex is not available in this build." },
    ],
    servers: conv?.servers,
  };
}

let healthFigmaMcp: Health["figmaMcp"] = "down";
type Conversation = {
  owner: string;
  intentId: string;
  fileId: string;
  dir: string;
  record: SessionRecord;
  session: ReviewSession;
  busy: boolean;
  health?: ProviderHealth;
  servers?: Health["servers"];
};
let conv: Conversation | undefined;
type StartReservation = FileOwned & { intentId: string };
let startingRequest: StartReservation | undefined;
const preparedOwners = new Map<string, string>();
const preparedKey = (args: { provider: ProviderId; fileId: string }) => `${args.provider}:${args.fileId}`;
const sameProviderSettings = (left: ReturnType<typeof readSettings>["providers"][ProviderId], right: ReturnType<typeof readSettings>["providers"][ProviderId]) =>
  left.model === right.model && left.effort === right.effort;

function clearPreparedProvider(args: { provider: ProviderId; reason: string }) {
  for (const [key, owner] of preparedOwners) {
    if (!key.startsWith(`${args.provider}:`)) continue;
    preparedOwners.delete(key);
    deactivateRequestOwner({ owner, reason: args.reason });
  }
}

function prepareProvider(args: { provider: ReviewProvider; fileId: string; dir: string; settings: ReturnType<typeof readSettings>["providers"][ProviderId] }) {
  const key = preparedKey({ provider: args.provider.id, fileId: args.fileId });
  for (const [otherKey, otherOwner] of preparedOwners) {
    if (otherKey !== key && otherKey.startsWith(`${args.provider.id}:`)) {
      preparedOwners.delete(otherKey);
      deactivateRequestOwner({ owner: otherOwner, reason: "Another workspace was prepared" });
    }
  }
  const owner = preparedOwners.get(key) ?? randomUUID();
  preparedOwners.set(key, owner);
  activeRequestOwners.add(owner);
  args.provider.prepare({ ...args, boundary: boundary({ fileId: args.fileId, owner }) });
}

function newRecord(message: Extract<UpMsg, { kind: "start" }>, provider: ProviderId): SessionRecord {
  return {
    provider,
    sessionId: "",
    title: message.text.slice(0, 80),
    anchor: message.anchor,
    pageId: message.pageId,
    pageName: message.pageName,
    createdAt: now(),
    updatedAt: now(),
    turns: 0,
    costUsd: 0,
    costStatus: "unavailable",
    usage: zeroUsage(),
  };
}

async function startConversation(message: Extract<UpMsg, { kind: "start" }>) {
  const reservation: StartReservation = { fileId: message.fileId, intentId: message.intentId };
  startingRequest = reservation; // actual starts retain global one-conversation supersession
  endConversation("Started another session");
  const dir = workspaceFor(message.fileId, message.fileName);
  const settings = readSettings();
  const providerId = message.resume?.provider ?? settings.provider;
  const provider = providers[providerId];
  if (!provider) {
    if (startingRequest === reservation) startingRequest = undefined;
    return send(message.fileId, { kind: "error", message: `${providerId === "codex" ? "Codex" : providerId} is not available in this build.` });
  }
  const previous = message.resume
    ? readSessions(dir).find(session => session.provider === message.resume!.provider && session.sessionId === message.resume!.sessionId)
    : undefined;
  if (message.resume && !previous) {
    if (startingRequest === reservation) startingRequest = undefined;
    return send(message.fileId, { kind: "error", message: "Unknown provider-qualified session" });
  }
  const record = previous ?? newRecord(message, providerId);
  const key = preparedKey({ provider: providerId, fileId: message.fileId });
  const owner = !message.resume ? preparedOwners.get(key) ?? randomUUID() : randomUUID();
  activeRequestOwners.add(owner);
  if (!message.resume) preparedOwners.delete(key); // fresh sessions may claim prepared query and its captured owner
  let session: ReviewSession;
  try {
    session = await provider.start({
      fileId: message.fileId,
      dir,
      resume: message.resume?.sessionId,
      settings: settings.providers[providerId],
      boundary: boundary({ fileId: message.fileId, owner }),
      baseRecord: record,
    });
  } catch (error) {
    deactivateRequestOwner({ owner, reason: "Session failed to start" });
    if (startingRequest === reservation) { startingRequest = undefined; throw error; }
    return;
  }
  if (startingRequest !== reservation) {
    deactivateRequestOwner({ owner, reason: "Superseded while starting" });
    session.close();
    return;
  }
  const current: Conversation = { owner, intentId: message.intentId, fileId: message.fileId, dir, record, session, busy: true };
  startingRequest = undefined;
  conv = current;
  const anchor = `Figma file "${message.fileName}", page "${message.pageName}" (${message.pageId}). Anchor: ${message.anchor.type}${message.anchor.nodeIds.length ? ` ${message.anchor.nodeIds.join(", ")}` : ""}`;
  session.send({ text: message.text, selection: message.selection, context: anchor });
  send(message.fileId, { kind: "busy", busy: true });
  void pump(current);
  prepareProvider({ provider, fileId: message.fileId, dir, settings: settings.providers[providerId] });
}

function endConversation(reason: string) {
  if (!conv) return;
  const current = conv;
  conv = undefined;
  deactivateRequestOwner({ owner: current.owner, reason });
  current.session.close();
  send(current.fileId, { kind: "busy", busy: false });
}

async function pump(current: Conversation) {
  try {
    for await (const output of current.session.output) {
      if (conv !== current) break;
      if (output.kind === "initialized") {
        current.record.sessionId = output.sessionId;
        current.health = output.health;
        current.servers = output.servers;
        saveSession(current.dir, current.record);
        send(current.fileId, { kind: "health", health: makeHealth() });
        send(current.fileId, { kind: "started", intentId: current.intentId, session: current.record });
      } else if (output.kind === "event") {
        send(current.fileId, output);
      } else {
        current.record.usage = output.usage;
        current.record.costUsd = output.cost.usd;
        current.record.costStatus = output.cost.status;
        if (output.turnCompleted) {
          current.record.turns++;
          current.record.updatedAt = now();
          saveSession(current.dir, current.record);
          current.busy = false;
          send(current.fileId, { kind: "session", session: current.record });
          send(current.fileId, { kind: "sessions", sessions: readSessions(current.dir) });
          send(current.fileId, { kind: "busy", busy: current.busy });
        } else {
          send(current.fileId, { kind: "session", session: current.record });
        }
      }
    }
  } catch (error) {
    log("session error", error);
    send(current.fileId, { kind: "error", message: `Session error: ${error instanceof Error ? error.message : String(error)}` });
  } finally {
    if (conv === current) {
      deactivateRequestOwner({ owner: current.owner, reason: "Session ended" });
      conv = undefined;
      send(current.fileId, { kind: "busy", busy: false });
    }
  }
}

async function probeFigmaMcp(): Promise<Health["figmaMcp"]> {
  try {
    await fetch(FIGMA_MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "sesori-review", version: VERSION } } }),
      signal: AbortSignal.timeout(1500),
    });
    return "up";
  } catch { return "down"; }
}
async function sendHealth(fileId: string) { healthFigmaMcp = await probeFigmaMcp(); send(fileId, { kind: "health", health: makeHealth() }); }

async function onUp(ws: WebSocket & { fileId?: string; protocolOk?: boolean }, message: UpMsg) {
  if (message.kind !== "hello" && !ws.protocolOk) return;
  switch (message.kind) {
    case "hello": {
      ws.protocolOk = message.protocolVersion === PROTOCOL_VERSION;
      if (!ws.protocolOk) {
        if (live(ws)) ws.send(JSON.stringify({ kind: "error", message: `Plugin/bridge protocol mismatch (${message.protocolVersion}/${PROTOCOL_VERSION}). Rebuild or restart both from the same @sesori/figma-review version.` } satisfies DownMsg));
        ws.close();
        return;
      }
      const old = clients.get(message.fileId);
      if (old && old !== ws) old.close();
      clients.set(message.fileId, ws);
      ws.fileId = message.fileId;
      const dir = workspaceFor(message.fileId, message.fileName);
      const mine = conv?.fileId === message.fileId;
      send(message.fileId, {
        kind: "connection",
        protocolVersion: PROTOCOL_VERSION,
        intentId: mine ? conv!.intentId : undefined,
        session: mine ? conv!.record : undefined,
        busy: mine ? conv!.busy : false,
      });
      send(message.fileId, { kind: "sessions", sessions: readSessions(dir) });
      const settings = readSettings();
      const selected = providers[settings.provider];
      if (selected) prepareProvider({ provider: selected, fileId: message.fileId, dir, settings: settings.providers[settings.provider] });
      return sendHealth(message.fileId);
    }
    case "start": return startConversation(message);
    case "open": {
      const dir = workspaceFor(message.fileId, message.fileName);
      const session = readSessions(dir).find(item => item.provider === message.session.provider && item.sessionId === message.session.sessionId);
      if (!session) return send(message.fileId, { kind: "error", message: "Unknown provider-qualified session" });
      const attached = conv?.record.provider === message.session.provider && conv.record.sessionId === message.session.sessionId;
      const provider = providers[session.provider];
      if (!provider) return send(message.fileId, { kind: "error", message: `${session.provider} is unavailable; cannot read its native history.` });
      return send(message.fileId, { kind: "history", intentId: message.intentId, session: attached ? conv!.record : session, messages: provider.readHistory({ dir, sessionId: session.sessionId }), attached });
    }
    case "user":
      if (!conv || conv.fileId !== ws.fileId) return send(ws.fileId!, { kind: "error", message: "No active session for this file. Start one or open one from History." });
      conv.busy = true;
      conv.session.send({ text: message.text, selection: message.selection });
      return send(conv.fileId, { kind: "busy", busy: conv.busy });
    case "reply": {
      const request = pending.get(message.id);
      if (!request || request.ws !== ws || !activeRequestOwners.has(request.owner)) return;
      pending.delete(message.id);
      request.resolve(message.result);
      return;
    }
    case "interrupt":
      if (conv && conv.fileId === ws.fileId) {
        cancelOutstandingRequests({ owner: conv.owner, reason: "Turn stopped" });
        await conv.session.interrupt();
      }
      return;
    case "close": {
      if (!ws.fileId || !isRegisteredFileSocket({ registeredSocket: clients.get(ws.fileId), requestSocket: ws })) return;
      if (isOwnedByFile({ resource: startingRequest, fileId: ws.fileId })) startingRequest = undefined;
      if (isOwnedByFile({ resource: conv, fileId: ws.fileId })) endConversation(message.reason);
      return;
    }
    case "settings": {
      const previous = readSettings();
      const changed = (["claude", "codex"] as const).filter(provider =>
        !sameProviderSettings(previous.providers[provider], message.settings.providers[provider]));
      saveSettings(message.settings);
      const target = conv;
      if (target && changed.includes(target.record.provider)) {
        await applyForCurrentConversation({
          captured: target,
          current: () => conv,
          apply: () => target.session.applySettings({ settings: message.settings.providers[target.record.provider] }),
          commit: () => {
            if (target.health) target.health = { ...target.health, model: message.settings.providers[target.record.provider].model || target.health.model };
          },
          onStaleError: error => log("ignored settings result for replaced session", String(error)),
        });
      }
      const dir = ws.fileId ? workspaceFor(ws.fileId, "Figma file") : undefined;
      for (const providerId of changed) {
        clearPreparedProvider({ provider: providerId, reason: "Settings changed" });
        providers[providerId]?.dispose();
        if (dir && providerId === message.settings.provider && providers[providerId]) {
          prepareProvider({ provider: providers[providerId]!, fileId: ws.fileId!, dir, settings: message.settings.providers[providerId] });
        }
      }
      if (dir && previous.provider !== message.settings.provider && !changed.includes(message.settings.provider)) {
        const selected = providers[message.settings.provider];
        if (selected) prepareProvider({ provider: selected, fileId: ws.fileId!, dir, settings: message.settings.providers[message.settings.provider] });
      }
      return send(ws.fileId!, { kind: "health", health: makeHealth() });
    }
    case "health": return sendHealth(ws.fileId!);
  }
}

function decodeUp(raw: unknown): UpMsg | undefined {
  let value: unknown;
  try { value = JSON.parse(String(raw)); } catch { return; }
  if (!value || typeof value !== "object" || !("kind" in value) || typeof value.kind !== "string") return;
  if (value.kind === "hello" && (!("protocolVersion" in value) || typeof value.protocolVersion !== "number"
    || !("fileId" in value) || typeof value.fileId !== "string" || !("fileName" in value) || typeof value.fileName !== "string")) return;
  return value as UpMsg;
}

new WebSocketServer({ port, host: "127.0.0.1" }).on("connection", (ws: WebSocket & { fileId?: string; protocolOk?: boolean }) => {
  log("plugin connected");
  ws.on("message", raw => {
    const message = decodeUp(raw);
    if (!message) { ws.send(JSON.stringify({ kind: "error", message: "Malformed plugin message" } satisfies DownMsg)); return ws.close(); }
    onUp(ws, message).catch(error => { if (ws.fileId) send(ws.fileId, { kind: "error", message: String(error) }); });
  });
  ws.on("close", () => {
    if (ws.fileId && clients.get(ws.fileId) === ws) clients.delete(ws.fileId);
    for (const [id, request] of pending) if (request.ws === ws) { pending.delete(id); request.resolve(request.onDrop); }
    log("plugin disconnected", ws.fileId ?? "");
  });
});

log(`bridge ${VERSION} listening on ws://127.0.0.1:${port}` + (process.env.APP_REPO ? ` · app repo ${process.env.APP_REPO}` : ""));
const manifest = installPlugin();
console.log(manifest
  ? `\nSesori Review is running. Keep this terminal open.\n\nFirst time? Add the plugin to Figma desktop once:\n  Plugins → Development → Import plugin from manifest… → ${manifest}\nThen run it from Plugins → Development → Sesori Review.\n`
  : "\nPlugin build not found (run `npm run build`); the bridge is up but there is nothing to import into Figma.\n");
if (!hasClaudeAuth()) console.log("No Claude credentials found: run `claude` once to sign in, or export ANTHROPIC_API_KEY. The plugin will show \"Claude failed to start\" until then.\n");
