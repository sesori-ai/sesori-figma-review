import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import {
  FIGMA_MCP_URL,
  PROTOCOL_VERSION,
  type DownMsg,
  type Health,
  type PermissionDecision,
  type ProviderHealth,
  type ProviderId,
  type ProviderSettings,
  type SessionRecord,
  type Settings,
  type ToolResult,
  type UpMsg,
} from "../../shared/protocol.ts";
import { activateProvider } from "./provider-activation.ts";
import type { ProviderRequestBoundary, ReviewProvider, ReviewSession } from "./providers/types.ts";
import { readSessions, readSettings, saveSession, saveSettings, workspaceFor, zeroUsage } from "./workspace.ts";

type ProviderMap = Record<ProviderId, ReviewProvider | undefined>;
type Socket = WebSocket & { fileId?: string; protocolOk?: boolean };
type Conversation = {
  owner: string;
  intentId: string;
  fileId: string;
  dir: string;
  record: SessionRecord;
  session: ReviewSession;
  busy: boolean;
  textItems: Map<string, string>;
  health?: ProviderHealth;
  servers?: Health["servers"];
};
type Pending = {
  ws: WebSocket;
  owner: string;
  resolve: (value: ToolResult | PermissionDecision) => void;
  onDrop: ToolResult | PermissionDecision;
};

const now = () => new Date().toISOString();
const live = (ws?: WebSocket): ws is WebSocket => !!ws && ws.readyState === ws.OPEN;
const samePreference = (left: ProviderSettings, right: ProviderSettings) =>
  left.model === right.model && left.effort === right.effort;
const disconnected: ToolResult = {
  content: [{ type: "text", text: "The Figma plugin is not connected. Ask the user to reopen it." }],
  isError: true,
};
const denied: PermissionDecision = { behavior: "deny", message: "Figma plugin disconnected" };
const dormantBoundary: ProviderRequestBoundary = { tool: async () => disconnected, permission: async () => denied };

export type ReviewBridge = {
  listening: Promise<number>;
  shutdown: () => Promise<void>;
};

export function createReviewBridge(args: {
  version: string;
  port: number;
  log: (...values: unknown[]) => void;
  createProviders: (args: { onChanged: () => void }) => ProviderMap;
  probeFigmaMcp?: () => Promise<Health["figmaMcp"]>;
}): ReviewBridge {
  const clients = new Map<string, WebSocket>();
  const pending = new Map<string, Pending>();
  const activeOwners = new Set<string>();
  let figmaMcp: Health["figmaMcp"] = "down";
  let conv: Conversation | undefined;
  let starting: { fileId: string; intentId: string } | undefined;
  let stopped = false;

  const send = (fileId: string, message: DownMsg) => {
    const ws = clients.get(fileId);
    if (live(ws)) ws.send(JSON.stringify(message));
  };
  const providerChanged = () => {
    for (const fileId of clients.keys()) send(fileId, { kind: "health", health: makeHealth() });
  };
  const providers = args.createProviders({ onChanged: providerChanged });

  function makeHealth(extra?: Pick<Health, "settingsResult">): Health {
    const settings = readSettings();
    return {
      bridge: args.version,
      protocolVersion: PROTOCOL_VERSION,
      figmaMcp,
      selectedProvider: settings.provider,
      liveProvider: conv?.record.provider,
      settings,
      providers: (["claude", "codex"] as const).map(provider => {
        if (conv?.record.provider === provider && conv.health) return conv.health;
        return providers[provider]?.health({ settings: settings.providers[provider] }) ?? {
          provider,
          status: "unavailable",
          models: [],
          error: `${provider === "codex" ? "Codex" : "Claude"} is not available in this build.`,
        };
      }),
      servers: conv?.servers,
      ...extra,
    };
  }

  function ask(request: {
    fileId: string;
    owner: string;
    message: { kind: "tool"; tool: string; args: Record<string, unknown> }
      | { kind: "permission"; tool: string; input: Record<string, unknown> };
    onDrop: ToolResult | PermissionDecision;
  }): Promise<ToolResult | PermissionDecision> {
    return new Promise(resolve => {
      if (!activeOwners.has(request.owner)) return resolve(request.onDrop);
      const ws = clients.get(request.fileId);
      if (!live(ws)) return resolve(request.onDrop);
      const id = randomUUID();
      pending.set(id, { ws, owner: request.owner, resolve, onDrop: request.onDrop });
      ws.send(JSON.stringify({ ...request.message, id }));
    });
  }
  const boundary = (owner: { fileId: string; owner: string }): ProviderRequestBoundary => ({
    tool: request => ask({ ...owner, message: { kind: "tool", tool: request.tool, args: request.args }, onDrop: disconnected }) as Promise<ToolResult>,
    permission: request => ask({ ...owner, message: { kind: "permission", ...request }, onDrop: denied }) as Promise<PermissionDecision>,
  });
  function cancelRequests(owner: { owner: string; reason: string }) {
    for (const [id, request] of pending) {
      if (request.owner !== owner.owner) continue;
      pending.delete(id);
      request.resolve(request.onDrop);
      if (live(request.ws)) request.ws.send(JSON.stringify({ kind: "cancel_request", id, reason: owner.reason } satisfies DownMsg));
    }
  }
  function deactivate(owner: { owner: string; reason: string }) {
    activeOwners.delete(owner.owner);
    cancelRequests(owner);
  }
  function prepareProvider(provider: ReviewProvider, fileId: string, dir: string) {
    provider.prepare({ fileId, dir, settings: readSettings().providers[provider.id], boundary: dormantBoundary });
  }
  function freshRecord(message: Extract<UpMsg, { kind: "start" }>, provider: ProviderId): SessionRecord {
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
    const reservation = { fileId: message.fileId, intentId: message.intentId };
    starting = reservation;
    endConversation("Started another session");
    const dir = workspaceFor(message.fileId, message.fileName);
    const settings = readSettings();
    const providerId = message.resume?.provider ?? settings.provider;
    const provider = providers[providerId];
    if (!provider) {
      if (starting === reservation) starting = undefined;
      return send(message.fileId, { kind: "error", message: `${providerId === "codex" ? "Codex" : providerId} is not available in this build.` });
    }
    const previous = message.resume
      ? readSessions(dir).find(item => item.provider === message.resume!.provider && item.sessionId === message.resume!.sessionId)
      : undefined;
    if (message.resume && !previous) {
      if (starting === reservation) starting = undefined;
      return send(message.fileId, { kind: "error", message: "Unknown provider-qualified session" });
    }
    const record = previous ?? freshRecord(message, providerId);
    const owner = randomUUID();
    activeOwners.add(owner);
    let dispatchFailed = false;
    try {
      const activated = await activateProvider({
        provider,
        start: {
          fileId: message.fileId,
          dir,
          resume: message.resume?.sessionId,
          settings: settings.providers[providerId],
          boundary: boundary({ fileId: message.fileId, owner }),
          baseRecord: record,
        },
        isCurrent: () => starting === reservation,
        accept: session => {
          const current: Conversation = { owner, intentId: message.intentId, fileId: message.fileId, dir, record, session, busy: true, textItems: new Map() };
          starting = undefined;
          conv = current;
          const anchor = `Figma file "${message.fileName}", page "${message.pageName}" (${message.pageId}). Anchor: ${message.anchor.type}${message.anchor.nodeIds.length ? ` ${message.anchor.nodeIds.join(", ")}` : ""}`;
          try { session.send({ text: message.text, selection: message.selection, context: anchor }); }
          catch (error) {
            dispatchFailed = true;
            if (conv === current) {
              conv = undefined;
              deactivate({ owner, reason: "Initial message failed" });
              session.close();
              send(message.fileId, { kind: "error", message: `Session failed to accept the initial message: ${error instanceof Error ? error.message : String(error)}` });
            } else args.log("stale initial message failure", error);
            throw error;
          }
          send(message.fileId, { kind: "busy", busy: true });
          void pump(current);
          prepareProvider(provider, message.fileId, dir);
        },
      });
      if (!activated) deactivate({ owner, reason: "Superseded while starting" });
    } catch (error) {
      deactivate({ owner, reason: "Session failed to start" });
      if (dispatchFailed) return;
      if (starting === reservation) { starting = undefined; throw error; }
      args.log("stale provider start failed", error);
    }
  }

  function endConversation(reason: string) {
    if (!conv) return;
    const current = conv;
    conv = undefined;
    deactivate({ owner: current.owner, reason });
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
          const event = output.event;
          if (event.type === "text_start") current.textItems.set(event.itemId, "");
          if (event.type === "text_delta") current.textItems.set(event.itemId, (current.textItems.get(event.itemId) ?? "") + event.text);
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
            send(current.fileId, { kind: "busy", busy: false });
          } else send(current.fileId, { kind: "session", session: current.record });
        }
      }
    } catch (error) {
      args.log(conv === current ? "session error" : "stale session error", error);
      if (conv === current) send(current.fileId, { kind: "error", message: `Session error: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      if (conv === current) {
        deactivate({ owner: current.owner, reason: "Session ended" });
        conv = undefined;
        send(current.fileId, { kind: "busy", busy: false });
      }
    }
  }

  async function probeFigmaMcp(): Promise<Health["figmaMcp"]> {
    if (args.probeFigmaMcp) return args.probeFigmaMcp();
    try {
      await fetch(FIGMA_MCP_URL, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "sesori-review", version: args.version } } }),
        signal: AbortSignal.timeout(1500),
      });
      return "up";
    } catch { return "down"; }
  }
  async function sendHealth(fileId: string) {
    figmaMcp = await probeFigmaMcp();
    send(fileId, { kind: "health", health: makeHealth() });
  }

  function sendSettingsResult(ws: Socket, result: NonNullable<Health["settingsResult"]>) {
    if (ws.fileId && clients.get(ws.fileId) === ws) send(ws.fileId, { kind: "health", health: makeHealth({ settingsResult: result }) });
  }
  const publishSettledSettings = (ws: Socket) => {
    if (ws.fileId) send(ws.fileId, { kind: "health", health: makeHealth() });
  };
  async function updateSettings(ws: Socket, message: Extract<UpMsg, { kind: "settings" }>) {
    const before = readSettings();
    const preferenceChanged = !samePreference(before.providers[message.provider], message.settings);
    const selected = message.selectedProvider ?? before.provider;
    const selectedChanged = selected !== before.provider;
    const target = conv;
    if (target?.record.provider === message.provider && preferenceChanged) {
      try { await target.session.applySettings({ settings: message.settings }); }
      catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        publishSettledSettings(ws);
        sendSettingsResult(ws, { requestId: message.requestId, accepted: false, error: reason });
        return;
      }
      if (conv !== target) {
        publishSettledSettings(ws);
        sendSettingsResult(ws, { requestId: message.requestId, accepted: false, error: "Session changed before settings were committed." });
        return;
      }
      if (target.health) target.health = { ...target.health, model: message.settings.model || target.health.model };
    }
    const latest = readSettings();
    const next: Settings = {
      provider: selectedChanged ? selected : latest.provider,
      providers: { ...latest.providers, [message.provider]: preferenceChanged ? message.settings : latest.providers[message.provider] },
    };
    if (preferenceChanged || selectedChanged) saveSettings(next);
    if (preferenceChanged) providers[message.provider]?.dispose();
    if (selectedChanged && (!preferenceChanged || before.provider !== message.provider)) providers[before.provider]?.dispose();
    if (ws.fileId && (selectedChanged || (preferenceChanged && next.provider === message.provider))) {
      const provider = providers[next.provider];
      if (provider) prepareProvider(provider, ws.fileId, workspaceFor(ws.fileId, "Figma file"));
    }
    publishSettledSettings(ws);
    sendSettingsResult(ws, { requestId: message.requestId, accepted: true });
  }

  async function onUp(ws: Socket, message: UpMsg) {
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
        const pendingMine = !mine && starting?.fileId === message.fileId;
        send(message.fileId, {
          kind: "connection",
          protocolVersion: PROTOCOL_VERSION,
          intentId: mine ? conv!.intentId : pendingMine ? starting!.intentId : undefined,
          session: mine ? conv!.record : undefined,
          activeText: mine && conv!.record.sessionId ? [...conv!.textItems].map(([itemId, text]) => ({
            session: { provider: conv!.record.provider, sessionId: conv!.record.sessionId }, itemId, text,
          })) : undefined,
          busy: mine ? conv!.busy : false,
        });
        send(message.fileId, { kind: "sessions", sessions: readSessions(dir) });
        const settings = readSettings(), selectedProvider = providers[settings.provider];
        if (selectedProvider) prepareProvider(selectedProvider, message.fileId, dir);
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
        const startingTurn = !conv.busy;
        conv.session.send({ text: message.text, selection: message.selection });
        if (startingTurn) conv.textItems.clear();
        conv.busy = true;
        return send(conv.fileId, { kind: "busy", busy: true });
      case "reply": {
        const request = pending.get(message.id);
        if (!request || request.ws !== ws || !activeOwners.has(request.owner)) return;
        pending.delete(message.id);
        request.resolve(message.result);
        return;
      }
      case "interrupt":
        if (conv && conv.fileId === ws.fileId) {
          cancelRequests({ owner: conv.owner, reason: "Turn stopped" });
          await conv.session.interrupt();
        }
        return;
      case "close":
        if (!ws.fileId || clients.get(ws.fileId) !== ws) return;
        if (starting?.fileId === ws.fileId) starting = undefined;
        if (conv?.fileId === ws.fileId) endConversation(message.reason);
        return;
      case "settings": return updateSettings(ws, message);
      case "health": return sendHealth(ws.fileId!);
    }
  }

  function decodeUp(raw: unknown): UpMsg | undefined {
    let value: unknown;
    try { value = JSON.parse(String(raw)); } catch { return; }
    if (!value || typeof value !== "object" || !("kind" in value) || typeof value.kind !== "string") return;
    if (value.kind === "hello") {
      if (!("fileId" in value) || typeof value.fileId !== "string" || !("fileName" in value) || typeof value.fileName !== "string") return;
      return { ...value, protocolVersion: "protocolVersion" in value && typeof value.protocolVersion === "number" ? value.protocolVersion : 0 } as UpMsg;
    }
    return value as UpMsg;
  }
  function receive(ws: Socket, raw: unknown) {
    const message = decodeUp(raw);
    if (!message) { ws.send(JSON.stringify({ kind: "error", message: "Malformed plugin message" } satisfies DownMsg)); return ws.close(); }
    onUp(ws, message).catch(error => { if (ws.fileId) send(ws.fileId, { kind: "error", message: String(error) }); });
  }

  const server = new WebSocketServer({ port: args.port, host: "127.0.0.1" });
  const listening = new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Bridge did not bind a TCP port"));
      args.log(`bridge ${args.version} listening on ws://127.0.0.1:${address.port}`);
      resolve(address.port);
    });
  });
  server.on("connection", (ws: Socket) => {
    args.log("plugin connected");
    ws.on("message", raw => receive(ws, raw));
    ws.on("close", () => {
      if (ws.fileId && clients.get(ws.fileId) === ws) clients.delete(ws.fileId);
      for (const [id, request] of pending) if (request.ws === ws) { pending.delete(id); request.resolve(request.onDrop); }
      args.log("plugin disconnected", ws.fileId ?? "");
    });
  });

  return {
    listening,
    shutdown: async () => {
      if (stopped) return;
      stopped = true;
      starting = undefined;
      endConversation("Bridge shutting down");
      for (const provider of Object.values(providers)) provider?.dispose();
      for (const ws of clients.values()) ws.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
