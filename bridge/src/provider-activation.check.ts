import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DownMsg, HistoryItem, ProviderHealth, ProviderSessionRecord, ProviderSettings } from "../../shared/protocol.ts";
import { decodeBridgeMessage } from "../../plugin/src/wire.ts";
import { CODEX_PERMISSION_PROFILE, type CodexExecutionPolicy } from "./providers/codex-execution.ts";
import type { CodexNotification, CodexServerRequest } from "./providers/codex-protocol.ts";
import type { ProviderHistory, ProviderOutput, ProviderRequestBoundary, ReviewProvider, ReviewSession } from "./providers/types.ts";

process.env.SESORI_REVIEW_HOME = mkdtempSync(join(tmpdir(), "review-bridge-check-"));
const { createReviewBridge } = await import("./review-bridge.ts");
const { readSessions, readSettings } = await import("./workspace.ts");
const { CodexProvider } = await import("./providers/codex.ts");

class OutputQueue implements AsyncIterable<ProviderOutput> {
  private values: ProviderOutput[] = [];
  private waiters: { resolve: (result: IteratorResult<ProviderOutput>) => void; reject: (error: unknown) => void }[] = [];
  private failure?: unknown;
  push(value: ProviderOutput) { const waiter = this.waiters.shift(); waiter ? waiter.resolve({ value, done: false }) : this.values.push(value); }
  reject(error: unknown) { this.failure = error; this.waiters.shift()?.reject(error); }
  [Symbol.asyncIterator](): AsyncIterator<ProviderOutput> {
    return { next: async () => {
      if (this.failure) throw this.failure;
      const value = this.values.shift();
      if (value) return { value, done: false };
      return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    } };
  }
}
class ObservedCalls {
  count = 0;
  private waiters: { count: number; resolve: () => void }[] = [];
  hit() { this.count++; for (const waiter of this.waiters.splice(0)) this.count >= waiter.count ? waiter.resolve() : this.waiters.push(waiter); }
  waitFor(args: { count: number }) {
    if (this.count >= args.count) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`fixture call ${args.count} was not observed`)), 2000);
      this.waiters.push({ count: args.count, resolve: () => { clearTimeout(timeout); resolve(); } });
    });
  }
}
class FakeSession implements ReviewSession {
  readonly output = new OutputQueue();
  readonly sendCalls = new ObservedCalls();
  readonly interruptCalls = new ObservedCalls();
  readonly interruptSuccesses = new ObservedCalls();
  readonly settingCalls = new ObservedCalls();
  readonly closeCalls = new ObservedCalls();
  sent: string[] = [];
  interrupted = 0;
  settings: ProviderSettings[] = [];
  closed = 0;
  throwOnSend = false;
  interruptGate?: Promise<void>;
  settingGate?: { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void };
  readonly settingGates = new Map<number, Promise<void>>();
  readonly throwSettingCalls = new Set<number>();
  constructor(readonly provider: "claude" | "codex") {}
  send(args: { text: string }) { if (this.throwOnSend) throw new Error("dispatch rejected"); this.sent.push(args.text); this.sendCalls.hit(); }
  async interrupt() { this.interrupted++; this.interruptCalls.hit(); await this.interruptGate; this.interruptSuccesses.hit(); }
  async applySettings(args: { settings: ProviderSettings }) {
    this.settings.push(args.settings); this.settingCalls.hit();
    await (this.settingGates.get(this.settingCalls.count) ?? this.settingGate?.promise);
    if (this.throwSettingCalls.has(this.settingCalls.count)) throw new Error("rollback rejected");
  }
  close() { this.closed++; this.closeCalls.hit(); }
}
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
type ActualClientArgs = {
  policy: CodexExecutionPolicy;
  onNotification?: (notification: CodexNotification) => void;
  onRequest?: (request: CodexServerRequest) => Promise<unknown>;
};
const codexConfig = (policy: CodexExecutionPolicy, runtime: boolean) => ({
  default_permissions: CODEX_PERMISSION_PROFILE, approvals_reviewer: "user", web_search: "disabled",
  approval_policy: { granular: { sandbox_approval: false, rules: true, mcp_elicitations: false,
    request_permissions: true, skill_approval: false } },
  features: { apps: false, plugins: false, multi_agent: false, remote_plugin: false, hooks: false, goals: false,
    memories: false, web_search: false, web_search_cached: false, web_search_request: false,
    skill_mcp_dependency_install: false, request_permissions_tool: true, step_model_switching: true },
  agents: { enabled: false }, feedback: { enabled: false }, apps: { _default: { enabled: false } }, plugins: {},
  mcp_servers: runtime ? { "figma-desktop": { enabled: true, url: "http://127.0.0.1:3845/mcp" } } : {},
  permissions: { [CODEX_PERMISSION_PROFILE]: {
    description: "Sesori Review: workspace read-only, notes write-only",
    filesystem: { ":minimal": "read", [policy.dir]: "read", [policy.notesDir]: "write",
      ...(policy.appRepo ? { [policy.appRepo]: "read" } : {}) },
    network: { enabled: false },
  } },
});
class ActualCodexClient {
  calls: { method: string; params: unknown }[] = [];
  disposed = 0;
  constructor(readonly args: ActualClientArgs, readonly runtime: boolean) {}
  async connect() {
    return { userAgent: "codex_app_server/0.154.0", codexHome: "/owned", platformFamily: "unix", platformOs: "macos" };
  }
  async request<T>(args: { method: string; params: unknown; parse: (value: unknown) => T }): Promise<T> {
    this.calls.push({ method: args.method, params: args.params });
    const params = args.params as Record<string, unknown>;
    let response: unknown = {};
    if (args.method === "config/read") response = { config: codexConfig(this.args.policy, this.runtime), origins: {} };
    if (args.method === "account/read") response = { requiresOpenaiAuth: true, account: { type: "chatgpt" } };
    if (args.method === "model/list") response = { data: [{ id: "codex-cheap", model: "codex-cheap",
      displayName: "Codex Cheap", hidden: false, isDefault: true, defaultReasoningEffort: "low",
      inputModalities: ["text", "image"], supportedReasoningEfforts: [{ reasoningEffort: "low" }] }] };
    if (args.method === "permissionProfile/list") response = { data: [{ id: CODEX_PERMISSION_PROFILE, allowed: true }] };
    if (args.method === "thread/start") response = { thread: { id: "actual-thread", turns: [],
      environments: [this.args.policy.thread.defaultEnvironment] }, model: "codex-cheap", cwd: params.cwd,
      runtimeWorkspaceRoots: params.runtimeWorkspaceRoots, approvalsReviewer: "user",
      approvalPolicy: this.args.policy.thread.approvalPolicy, activePermissionProfile: { id: CODEX_PERMISSION_PROFILE },
      reasoningEffort: "low", serviceTier: "default" };
    if (args.method === "turn/start") {
      response = { turn: { id: `actual-turn-${this.calls.filter(call => call.method === "turn/start").length}`,
        items: [], status: "inProgress" } };
      const turnId = (response as { turn: { id: string } }).turn.id, threadId = String(params.threadId);
      this.notify("thread/settings/updated", { threadId,
        threadSettings: { model: "codex-cheap", effort: "low", serviceTier: "default" } });
      this.notify("turn/started", { threadId, turn: { id: turnId, items: [], status: "inProgress" } });
    }
    if (args.method === "turn/steer") response = { turnId: params.expectedTurnId };
    if (args.method === "account/usage/read") response = { threadUsage: null };
    return args.parse(response);
  }
  requestOptionalAccounting<T>(args: { method: "account/usage/read"; params: unknown;
    parse: (value: unknown) => T }): Promise<T | undefined> { return this.request(args); }
  notify(method: string, params: unknown) { this.args.onNotification?.({ method, params }); }
  dispose() { this.disposed++; }
  disposeAndWait() { this.dispose(); return Promise.resolve(); }
}

class FakeProvider implements ReviewProvider {
  prepareCount = 0;
  readonly startCalls = new ObservedCalls();
  readonly historyCalls = new ObservedCalls();
  disposeCount = 0;
  throwOnPrepare = false;
  throwOnHistory = false;
  starts: { deferred: ReturnType<typeof deferred<ReviewSession>>; boundary: ProviderRequestBoundary }[] = [];
  history: HistoryItem[] = [{ role: "assistant", text: "native history" }];
  historyGate?: Promise<void>;
  historyResult?: ProviderHistory;
  constructor(readonly id: "claude" | "codex") {}
  health(args: { settings: ProviderSettings }): ProviderHealth {
    return { provider: this.id, status: "ready", model: args.settings.model, models: [] };
  }
  prepare() { this.prepareCount++; if (this.throwOnPrepare) throw new Error("prepare rejected"); }
  start(args: { boundary: ProviderRequestBoundary }) {
    const pending = deferred<ReviewSession>(); this.starts.push({ deferred: pending, boundary: args.boundary }); this.startCalls.hit(); return pending.promise;
  }
  async readHistory() {
    this.historyCalls.hit();
    if (this.throwOnHistory) throw new Error("history rejected");
    await this.historyGate;
    return this.historyResult ?? { messages: this.history };
  }
  dispose() { this.disposeCount++; }
}
type Message<K extends DownMsg["kind"]> = Extract<DownMsg, { kind: K }>;
const down = <K extends DownMsg["kind"]>(args: { kind: K; where?: (message: Message<K>) => boolean }) =>
  (message: DownMsg): message is Message<K> => message.kind === args.kind
    && (!args.where || args.where(message as Message<K>));

class Client {
  private inbox: DownMsg[] = [];
  private waiters: { match: (message: DownMsg) => boolean; resolve: (message: DownMsg) => void }[] = [];
  readonly ws: WebSocket;
  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ws.addEventListener("message", event => {
      const message = decodeBridgeMessage(JSON.parse(String(event.data)));
      if (!message) throw new Error("Bridge sent an invalid protocol message");
      const index = this.waiters.findIndex(waiter => waiter.match(message));
      if (index >= 0) this.waiters.splice(index, 1)[0].resolve(message); else this.inbox.push(message);
    });
  }
  async opened() { if (this.ws.readyState !== WebSocket.OPEN) await new Promise((resolve, reject) => {
    this.ws.addEventListener("open", resolve, { once: true }); this.ws.addEventListener("error", reject, { once: true });
  }); return this; }
  send(message: unknown) { this.ws.send(JSON.stringify(message)); }
  async next<T extends DownMsg>(match: (message: DownMsg) => message is T): Promise<T>;
  async next(match: (message: DownMsg) => boolean): Promise<DownMsg> {
    const index = this.inbox.findIndex(match);
    if (index >= 0) return this.inbox.splice(index, 1)[0]!;
    return Promise.race([
      new Promise<DownMsg>(resolve => this.waiters.push({ match, resolve })),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("bridge message timeout")), 2000)),
    ]);
  }
  matching<T extends DownMsg>(match: (message: DownMsg) => message is T): T[] { return this.inbox.filter(match); }
  close() { this.ws.close(); }
}
const startMessage = (intentId: string, fileId = "file-a") => ({
  kind: "start", intentId, fileId, fileName: "File", pageId: "0:1", pageName: "Page",
  anchor: { type: "page", nodeIds: [] }, text: `prompt-${intentId}`, selection: [],
});
const initialized = (sessionId: string): ProviderOutput => ({
  kind: "initialized", sessionId,
  health: { provider: "claude", status: "ready", model: "haiku", models: [] },
});
const usage = (input: number, cost: number, status: "reported" | "estimated", turnCompleted = false,
  accountingCheckpoint = false): ProviderOutput => ({
  kind: "usage", usage: { input, output: input + 1, cacheRead: 0, cacheWrite: 0 }, cost: { usd: cost, status },
  turnCompleted, accountingCheckpoint,
});

const claude = new FakeProvider("claude"), codex = new FakeProvider("codex");
const logs: string[] = [], staleSessionLogs = new ObservedCalls(), staleInterruptLogs = new ObservedCalls(), staleStartLogs = new ObservedCalls();
let mcpStatus = 503, rejectSettingsRename = false, temporarySettingsPath = "";
const app = createReviewBridge({
  version: "test", port: 0, log: (...values) => {
    const line = values.map(String).join(" "); logs.push(line);
    if (line.includes("stale session error")) staleSessionLogs.hit();
    if (line.includes("stale interrupt failed")) staleInterruptLogs.hit();
    if (line.includes("stale provider start failed")) staleStartLogs.hit();
  },
  createProviders: () => ({ claude, codex }), fetchMcp: async () => new Response(null, { status: mcpStatus }),
  settingsIo: {
    write: (path, content) => { temporarySettingsPath = path; writeFileSync(path, content); },
    rename: (source, destination) => { if (rejectSettingsRename) throw new Error("rename rejected"); renameSync(source, destination); },
    remove: path => rmSync(path, { force: true }),
  },
});
const port = await app.listening;
const valid = await new Client(port).opened();
valid.send({ kind: "hello", protocolVersion: 3, fileId: "file-a", fileName: "File" });
await valid.next(message => message.kind === "connection");
assert.equal((await valid.next(message => message.kind === "health")).health.figmaMcp, "down");
mcpStatus = 204;

for (const protocolVersion of [undefined, 1, 2, 4]) {
  const invalid = await new Client(port).opened();
  invalid.send({ kind: "hello", protocolVersion, fileId: "file-a", fileName: "Invalid" });
  assert.match((await invalid.next(message => message.kind === "error")).message, /protocol mismatch/);
}
valid.send({ kind: "health" });
assert.equal((await valid.next(message => message.kind === "health")).health.figmaMcp, "up");
assert.equal(claude.prepareCount, 1, "invalid handshakes do not evict or reprepare valid client");

const prepareBeforeNoop = claude.prepareCount, disposeBeforeNoop = claude.disposeCount;
valid.send({ kind: "settings", requestId: "noop", provider: "claude", settings: { model: "", effort: "" } });
await valid.next(down({ kind: "health", where: message => message.health.settingsResult?.requestId === "noop" }));
valid.send({ kind: "settings", requestId: "codex-only", provider: "codex", settings: { model: "cheap", effort: "low" } });
await valid.next(down({ kind: "health", where: message => message.health.settingsResult?.requestId === "codex-only" }));
assert.deepEqual([claude.prepareCount, claude.disposeCount], [prepareBeforeNoop, disposeBeforeNoop],
  "no-op and Codex-only preferences do not dispose/reprepare Claude");

valid.send(startMessage("pending"));
await claude.startCalls.waitFor({ count: 1 });
valid.send({ kind: "hello", protocolVersion: 3, fileId: "file-a", fileName: "File" });
assert.equal((await valid.next(message => message.kind === "connection")).intentId, "pending");
let fresh = await new Client(port).opened();
fresh.send({ kind: "hello", protocolVersion: 3, fileId: "file-a", fileName: "File" });
assert.equal((await fresh.next(message => message.kind === "connection")).intentId, "pending", "fresh client adopts pending reservation");
await fresh.next(message => message.kind === "health");
fresh.send({ kind: "close", reason: "close pending" });
fresh.send({ kind: "health" }); await fresh.next(message => message.kind === "health");
const stalePending = new FakeSession("claude"); claude.starts[0].deferred.resolve(stalePending);
await stalePending.closeCalls.waitFor({ count: 1 });
assert.deepEqual([stalePending.closed, stalePending.sent.length], [1, 0]);

const supersededClient = await new Client(port).opened();
supersededClient.send({ kind: "hello", protocolVersion: 3, fileId: "file-b", fileName: "Other" });
await supersededClient.next(message => message.kind === "connection");
supersededClient.send(startMessage("old", "file-b")); await claude.startCalls.waitFor({ count: 2 });
fresh.send({ kind: "settings", requestId: "during-old", provider: "claude", settings: { model: "haiku", effort: "low" } });
await fresh.next(down({ kind: "health", where: message => message.health.settingsResult?.requestId === "during-old" }));
const oldSession = new FakeSession("claude"), oldReconcile = deferred<void>(); oldSession.settingGate = oldReconcile;
claude.starts[1].deferred.resolve(oldSession); await oldSession.settingCalls.waitFor({ count: 1 });
fresh.send(startMessage("current")); await claude.startCalls.waitFor({ count: 3 });
const supersededError = await supersededClient.next(message => message.kind === "error");
await oldSession.closeCalls.waitFor({ count: 1 });
assert.deepEqual([supersededError.intentId, oldSession.sent.length, oldSession.closed], ["old", 0, 1]);
oldReconcile.reject(new Error("late superseded reconciliation")); await staleStartLogs.waitFor({ count: 1 });
fresh.send({ kind: "settings", requestId: "during-current", provider: "claude", settings: { model: "sonnet", effort: "medium" } });
await fresh.next(down({ kind: "health", where: message => message.health.settingsResult?.requestId === "during-current" }));
const currentSession = new FakeSession("claude"), currentReconcile = deferred<void>(); currentSession.settingGate = currentReconcile;
claude.throwOnPrepare = true; claude.starts[2].deferred.resolve(currentSession);
await currentSession.settingCalls.waitFor({ count: 1 }); assert.equal(currentSession.sent.length, 0);
currentReconcile.resolve(); await currentSession.sendCalls.waitFor({ count: 1 }); currentSession.settingGate = undefined;
assert.deepEqual([oldSession.closed, oldSession.sent.length, currentSession.sent, currentSession.settings[0]],
  [1, 0, ["prompt-current"], { model: "sonnet", effort: "medium" }]);
assert.deepEqual(fresh.matching(message => message.kind === "error"), [], "late reconciliation cannot contaminate replacement");
currentSession.output.push(initialized("native-current"));
await fresh.next(down({ kind: "started", where: message => message.intentId === "current" }));
assert.ok(logs.some(line => line.includes("advisory preparation failed"))); claude.throwOnPrepare = false;
const liveRef = { provider: "claude" as const, sessionId: "native-current" };
currentSession.output.push({ kind: "event", event: { type: "text_start", session: liveRef, itemId: "live" } });
currentSession.output.push({ kind: "event", event: { type: "text_delta", session: liveRef, itemId: "live", text: "prefix" } });
await fresh.next(down({ kind: "event", where: message => message.event.type === "text_delta" }));
claude.throwOnPrepare = true; mcpStatus = 503; fresh.send({ kind: "hello", protocolVersion: 3, fileId: "file-a", fileName: "File" });
assert.deepEqual((await fresh.next(message => message.kind === "connection")).activeText, [{ session: liveRef, itemId: "live", text: "prefix" }]);
await fresh.next(down({ kind: "health", where: message => message.health.figmaMcp === "down" }));
claude.throwOnPrepare = false; mcpStatus = 204;
fresh.send({ kind: "user", text: "steer", selection: [] });
await fresh.next(down({ kind: "busy", where: message => message.busy }));
fresh.send({ kind: "hello", protocolVersion: 3, fileId: "file-a", fileName: "File" });
assert.deepEqual((await fresh.next(message => message.kind === "connection")).activeText, [{ session: liveRef, itemId: "live", text: "prefix" }]);
assert.deepEqual(currentSession.sent, ["prompt-current", "steer"]);
const heldTool = claude.starts[2].boundary.tool({ tool: "focus", args: { nodeId: "1:2" } });
const heldCard = await fresh.next(message => message.kind === "tool");
const rejectedStop = deferred<void>(); currentSession.interruptGate = rejectedStop.promise;
fresh.send({ kind: "interrupt" }); await currentSession.interruptCalls.waitFor({ count: 1 });
assert.equal((await fresh.next(message => message.kind === "cancel_request")).id, heldCard.id,
  "Stop revokes pending cards before native interrupt settles");
assert.equal((await heldTool).isError, true);
rejectedStop.reject(new Error("interrupt rejected"));
assert.match((await fresh.next(message => message.kind === "error")).message, /Stop failed: interrupt rejected/);
currentSession.interruptGate = undefined; fresh.send({ kind: "interrupt" });
await currentSession.interruptSuccesses.waitFor({ count: 1 });

currentSession.output.push(usage(10, 5, "estimated"));
assert.deepEqual((await fresh.next(down({ kind: "session", where: message => message.session.usage.input === 10 && message.session.turns === 0 }))).session,
  { ...(await import("./workspace.ts")).readSessions(join(process.env.SESORI_REVIEW_HOME, "files", "file-a"))[0], usage: { input: 10, output: 11, cacheRead: 0, cacheWrite: 0 }, costUsd: 5, costStatus: "estimated" });
fresh.send({ kind: "hello", protocolVersion: 3, fileId: "file-a", fileName: "File" });
assert.equal((await fresh.next(message => message.kind === "connection")).busy, true, "provisional usage remains attached to busy turn");
currentSession.output.push(usage(3, 2, "reported"));
const replacement = await fresh.next(down({ kind: "session", where: message => message.session.usage.input === 3 }));
assert.deepEqual([replacement.session.usage.input, replacement.session.costUsd, replacement.session.costStatus], [3, 2, "reported"],
  "authoritative usage/cost snapshots replace rather than sum and may validly decrease");

const beforeLiveSettings = readSettings().providers.claude, disposeBeforeLive = claude.disposeCount;
const gate = deferred<void>(); currentSession.settingGate = gate;
fresh.send({ kind: "settings", requestId: "claude-live", provider: "claude", settings: { model: "sonnet", effort: "high" } });
await currentSession.settingCalls.waitFor({ count: 2 });
fresh.send({ kind: "settings", requestId: "codex-race", provider: "codex", settings: { model: "image", effort: "medium" } });
await fresh.next(down({ kind: "health", where: message => message.health.settingsResult?.requestId === "codex-race" }));
const settingsOrigin = fresh, settingsReplacement = await new Client(port).opened();
settingsReplacement.send({ kind: "hello", protocolVersion: 3, fileId: "file-a", fileName: "File" });
await settingsReplacement.next(message => message.kind === "connection");
assert.deepEqual((await settingsReplacement.next(message => message.kind === "health")).health.settings.providers.claude, beforeLiveSettings);
const prepareBeforeCommit = claude.prepareCount;
gate.resolve();
const settled = await settingsReplacement.next(down({ kind: "health", where: message => !message.health.settingsResult
  && message.health.settings.providers.claude.model === "sonnet" }));
assert.equal(settled.health.settingsResult, undefined);
assert.deepEqual(settingsOrigin.matching(down({ kind: "health", where: message => message.health.settingsResult?.requestId === "claude-live" })), []);
fresh = settingsReplacement;
assert.deepEqual(readSettings().providers, {
  claude: { model: "sonnet", effort: "high" }, codex: { model: "image", effort: "medium" },
}, "awaited active update preserves unrelated provider commit");
assert.deepEqual(currentSession.settings.at(-1), { model: "sonnet", effort: "high" });
assert.deepEqual([claude.disposeCount, claude.prepareCount], [disposeBeforeLive, prepareBeforeCommit],
  "accepted live settings keep active provider ownership without re-preparing beneath it");
const reversionGate = deferred<void>(); currentSession.settingGate = reversionGate;
fresh.send({ kind: "settings", requestId: "away", provider: "claude", settings: { model: "haiku", effort: "low" } });
await currentSession.settingCalls.waitFor({ count: 3 });
fresh.send({ kind: "settings", requestId: "back", provider: "claude", settings: { model: "sonnet", effort: "high" } });
fresh.send({ kind: "interrupt" }); await currentSession.interruptCalls.waitFor({ count: 3 });
assert.equal(currentSession.settingCalls.count, 3, "same-provider reversion waits behind the complete first transaction");
reversionGate.resolve();
await fresh.next(down({ kind: "health", where: message => message.health.settingsResult?.requestId === "away" }));
await fresh.next(down({ kind: "health", where: message => message.health.settingsResult?.requestId === "back" }));
assert.deepEqual(currentSession.settings.slice(-2), [{ model: "haiku", effort: "low" }, { model: "sonnet", effort: "high" }]);
assert.deepEqual(readSettings().providers.claude, { model: "sonnet", effort: "high" });
const rejectedGate = deferred<void>(); currentSession.settingGate = rejectedGate;
fresh.send({ kind: "settings", requestId: "rejected", provider: "claude", settings: { model: "bad", effort: "high" } });
await currentSession.settingCalls.waitFor({ count: 5 }); rejectedGate.reject(new Error("native rejected"));
const rejectedHealth = await fresh.next(down({ kind: "health", where: message => message.health.settingsResult?.requestId === "rejected" }));
assert.equal(rejectedHealth.health.settingsResult?.accepted, false);
const rejectedPlain = await fresh.next(down({ kind: "health", where: message => !message.health.settingsResult
  && message.health.settings.providers.claude.model === "sonnet" }));
assert.equal(rejectedPlain.health.settings.providers.claude.model, "sonnet");
assert.deepEqual(readSettings().providers.claude, { model: "sonnet", effort: "high" }, "failed live setting rolls back persisted truth");
currentSession.settingGate = undefined;
const committedSettingsPath = join(process.env.SESORI_REVIEW_HOME, "settings.json");
const committedSettings = readFileSync(committedSettingsPath, "utf8"); rejectSettingsRename = true;
fresh.send({ kind: "settings", requestId: "persist-rejected", provider: "claude", settings: { model: "haiku", effort: "low" } });
const persistenceRejected = await fresh.next(down({ kind: "health", where: message => message.health.settingsResult?.requestId === "persist-rejected" }));
rejectSettingsRename = false;
assert.equal(persistenceRejected.health.settingsResult?.accepted, false);
assert.match(persistenceRejected.health.settingsResult?.error ?? "", /Settings were not saved: rename rejected/);
assert.deepEqual(currentSession.settings.slice(-2), [{ model: "haiku", effort: "low" }, { model: "sonnet", effort: "high" }]);
assert.deepEqual([currentSession.closed, readFileSync(committedSettingsPath, "utf8"), existsSync(temporarySettingsPath)], [0, committedSettings, false]);
codex.throwOnPrepare = true;
fresh.send({ kind: "settings", requestId: "select-codex", provider: "codex", settings: { model: "image", effort: "medium" }, selectedProvider: "codex" });
await fresh.next(down({ kind: "health", where: message => message.health.settingsResult?.requestId === "select-codex" }));
assert.ok(codex.prepareCount > 0, "advisory preparation failure does not lose settings acknowledgment"); codex.throwOnPrepare = false;
fresh.send({ kind: "settings", requestId: "select-claude", provider: "claude", settings: { model: "sonnet", effort: "high" }, selectedProvider: "claude" });
await fresh.next(down({ kind: "health", where: message => message.health.settingsResult?.requestId === "select-claude" }));
claude.history = [{ role: "assistant", text: "prefix", itemId: "live" }];
currentSession.output.push(usage(4, 1, "reported", true));
await fresh.next(down({ kind: "busy", where: message => !message.busy }));
fresh.send({ kind: "hello", protocolVersion: 3, fileId: "file-a", fileName: "File" });
assert.deepEqual((await fresh.next(message => message.kind === "connection")).activeText, [{ session: liveRef, itemId: "live", text: "prefix" }]);
fresh.send({ kind: "user", text: "second turn", selection: [] });
await fresh.next(down({ kind: "busy", where: message => message.busy }));
currentSession.output.push({ kind: "event", event: { type: "text_start", session: liveRef, itemId: "second" } });
currentSession.output.push({ kind: "event", event: { type: "text_delta", session: liveRef, itemId: "second", text: "new turn" } });
await fresh.next(down({ kind: "event", where: message => message.event.itemId === "second" && message.event.type === "text_delta" }));
fresh.send({ kind: "hello", protocolVersion: 3, fileId: "file-a", fileName: "File" });
assert.deepEqual((await fresh.next(message => message.kind === "connection")).activeText, [{ session: liveRef, itemId: "second", text: "new turn" }]);
currentSession.output.push(usage(5, 1, "reported", true)); await fresh.next(down({ kind: "busy", where: message => !message.busy }));
currentSession.throwOnSend = true; fresh.send({ kind: "user", text: "rejected third turn", selection: [] });
assert.match((await fresh.next(message => message.kind === "error")).message, /dispatch rejected/); currentSession.throwOnSend = false;
fresh.send({ kind: "hello", protocolVersion: 3, fileId: "file-a", fileName: "File" });
assert.deepEqual((await fresh.next(message => message.kind === "connection")).activeText, [{ session: liveRef, itemId: "second", text: "new turn" }]);

const attachedClient = await new Client(port).opened();
attachedClient.send({ kind: "hello", protocolVersion: 3, fileId: "file-a", fileName: "File" });
const snapshot = await attachedClient.next(message => message.kind === "connection");
assert.equal(snapshot.session?.sessionId, "native-current");
assert.deepEqual(snapshot.activeText, [{ session: liveRef, itemId: "second", text: "new turn" }]);
claude.throwOnHistory = true;
attachedClient.send({ kind: "open", intentId: "failed-history", fileId: "file-a", fileName: "File", session: liveRef });
const historyError = await attachedClient.next(message => message.kind === "error");
assert.deepEqual([historyError.intentId, historyError.message], ["failed-history", "history rejected"]); claude.throwOnHistory = false;
attachedClient.send({ kind: "open", intentId: "attach-history", fileId: "file-a", fileName: "File", session: { provider: "claude", sessionId: "native-current" } });
assert.deepEqual((await attachedClient.next(message => message.kind === "history")).messages,
  [{ role: "assistant", text: "prefix", itemId: "live" }]);

const other = await new Client(port).opened();
other.send({ kind: "hello", protocolVersion: 3, fileId: "file-b", fileName: "Other" });
await other.next(message => message.kind === "connection");
other.send({ kind: "close", reason: "other file" });
other.send({ kind: "health" }); await other.next(message => message.kind === "health");
assert.equal(currentSession.closed, 0, "file-scoped close cannot end another file conversation");

const staleRollback = deferred<void>(), rollbackCall = currentSession.settingCalls.count + 2;
currentSession.settingGates.set(rollbackCall, staleRollback.promise); rejectSettingsRename = true;
attachedClient.send({ kind: "settings", requestId: "persist-stale", provider: "claude", settings: { model: "haiku", effort: "medium" } });
await currentSession.settingCalls.waitFor({ count: rollbackCall });
const staleStop = deferred<void>(); currentSession.interruptGate = staleStop.promise;
attachedClient.send({ kind: "interrupt" }); await currentSession.interruptCalls.waitFor({ count: 4 });
attachedClient.send(startMessage("replacement")); await claude.startCalls.waitFor({ count: 4 });
staleRollback.resolve();
const stalePersistence = await attachedClient.next(down({ kind: "health", where: message => message.health.settingsResult?.requestId === "persist-stale" }));
rejectSettingsRename = false; assert.equal(stalePersistence.health.settingsResult?.accepted, false); assert.equal(currentSession.closed, 1);
attachedClient.send({ kind: "hello", protocolVersion: 3, fileId: "file-a", fileName: "File" });
assert.equal((await attachedClient.next(message => message.kind === "connection")).intentId, "replacement");
const replacementSession = new FakeSession("claude"); claude.starts[3].deferred.resolve(replacementSession);
await replacementSession.sendCalls.waitFor({ count: 1 });
const replacementTool = claude.starts[3].boundary.tool({ tool: "focus", args: { nodeId: "2:3" } });
const replacementCard = await attachedClient.next(message => message.kind === "tool");
currentSession.output.reject(new Error("late old failure")); await staleSessionLogs.waitFor({ count: 1 });
staleStop.reject(new Error("late interrupt rejection")); await staleInterruptLogs.waitFor({ count: 1 });
assert.deepEqual(attachedClient.matching(message => message.kind === "error"), [], "predecessor errors are not published to replacement view");
assert.equal(attachedClient.matching(message => message.kind === "cancel_request").some(message => message.id === replacementCard.id), false);
assert.ok(logs.some(line => line.includes("stale session error")), "late old rejection is logged but not published");
replacementSession.throwSettingCalls.add(2); rejectSettingsRename = true;
attachedClient.send({ kind: "settings", requestId: "persist-fail-closed", provider: "claude", settings: { model: "haiku", effort: "high" } });
const failClosed = await attachedClient.next(down({ kind: "health", where: message => message.health.settingsResult?.requestId === "persist-fail-closed" }));
rejectSettingsRename = false;
assert.match(failClosed.health.settingsResult?.error ?? "", /native rollback failed and session was closed/);
assert.deepEqual([replacementSession.closed, (await replacementTool).isError], [1, true]);

attachedClient.send(startMessage("dispatch-failure")); await claude.startCalls.waitFor({ count: 5 });
attachedClient.send({ kind: "hello", protocolVersion: 3, fileId: "file-a", fileName: "File" });
assert.equal((await attachedClient.next(message => message.kind === "connection")).intentId, "dispatch-failure");
replacementSession.output.push(usage(99, 99, "estimated"));
attachedClient.send({ kind: "health" }); await attachedClient.next(message => message.kind === "health");
assert.deepEqual(attachedClient.matching(down({ kind: "session", where: message => message.session.usage.input === 99 })), [],
  "stale output cannot mutate replacement view");
const failingSession = new FakeSession("claude"); failingSession.throwOnSend = true; claude.starts[4].deferred.resolve(failingSession);
assert.match((await attachedClient.next(message => message.kind === "error")).message, /failed to accept the initial message/);
assert.equal(failingSession.closed, 1);
attachedClient.send({ kind: "user", text: "after failure", selection: [] });
assert.match((await attachedClient.next(message => message.kind === "error")).message, /No active session/);
attachedClient.send(startMessage("reconcile-failure")); await claude.startCalls.waitFor({ count: 6 });
attachedClient.send({ kind: "settings", requestId: "latest-before-failure", provider: "claude", settings: { model: "haiku", effort: "low" } });
await attachedClient.next(down({ kind: "health", where: message => message.health.settingsResult?.requestId === "latest-before-failure" }));
const reconcileFailure = new FakeSession("claude"); reconcileFailure.throwSettingCalls.add(1); claude.starts[5].deferred.resolve(reconcileFailure);
await reconcileFailure.closeCalls.waitFor({ count: 1 });
const reconciliationError = await attachedClient.next(message => message.kind === "error");
assert.deepEqual([reconciliationError.intentId, reconcileFailure.sent.length], ["reconcile-failure", 0]);
attachedClient.send(startMessage("close-held")); await claude.startCalls.waitFor({ count: 7 });
attachedClient.send({ kind: "settings", requestId: "close-latest", provider: "claude", settings: { model: "sonnet", effort: "low" } });
await attachedClient.next(down({ kind: "health", where: message => message.health.settingsResult?.requestId === "close-latest" }));
const closeHeld = new FakeSession("claude"), closeGate = deferred<void>(); closeHeld.settingGate = closeGate;
claude.starts[6].deferred.resolve(closeHeld); await closeHeld.settingCalls.waitFor({ count: 1 });
other.send({ kind: "close", reason: "foreign file closed" }); other.send({ kind: "health" }); await other.next(message => message.kind === "health");
assert.equal(closeHeld.closed, 0, "foreign-file close cannot retire pending native session");
attachedClient.send({ kind: "close", reason: "owning file closed" }); await closeHeld.closeCalls.waitFor({ count: 1 });
assert.equal(closeHeld.sent.length, 0, "owning-file close retires native session before reconciliation settles"); closeGate.resolve();
attachedClient.send(startMessage("shutdown-held")); await claude.startCalls.waitFor({ count: 8 });
attachedClient.send({ kind: "settings", requestId: "shutdown-latest", provider: "claude", settings: { model: "haiku", effort: "medium" } });
await attachedClient.next(down({ kind: "health", where: message => message.health.settingsResult?.requestId === "shutdown-latest" }));
const shutdownHeld = new FakeSession("claude"), shutdownGate = deferred<void>(); shutdownHeld.settingGate = shutdownGate;
claude.starts[7].deferred.resolve(shutdownHeld); await shutdownHeld.settingCalls.waitFor({ count: 1 });
const shutdown = app.shutdown(); await shutdownHeld.closeCalls.waitFor({ count: 1 });
assert.equal(shutdownHeld.sent.length, 0, "shutdown retires native session before reconciliation settles");
shutdownGate.reject(new Error("late shutdown reconciliation")); await staleStartLogs.waitFor({ count: 2 }); await shutdown;
assert.deepEqual([closeHeld.closed, closeHeld.sent.length, shutdownHeld.closed, shutdownHeld.sent.length], [1, 0, 1, 0]);
writeFileSync(join(process.env.SESORI_REVIEW_HOME, "settings.json"), JSON.stringify({ provider: "codex",
  providers: { claude: { model: "", effort: "" }, codex: { model: "luna", effort: "max" } } }));
const codexApp = createReviewBridge({ version: "test", port: 0, log: () => {}, createProviders: () => ({ claude, codex }) });
const codexClient = await new Client(await codexApp.listening).opened();
codexClient.send({ kind: "hello", protocolVersion: 3, fileId: "codex-file", fileName: "Codex" });
await codexClient.next(message => message.kind === "connection"); await codexClient.next(message => message.kind === "health");
codexClient.send(startMessage("codex-core", "codex-file")); await codex.startCalls.waitFor({ count: 1 });
for (const tool of ["get_flow", "get_screen", "focus", "annotate", "ask_user"] as const) {
  const response = codex.starts[0].boundary.tool({ tool, args: { proof: tool } });
  const card = await codexClient.next(message => message.kind === "tool");
  assert.deepEqual([card.tool, card.args], [tool, { proof: tool }]);
  codexClient.send({ kind: "reply", id: card.id, result: { content: [{ type: "text", text: `${tool}-ok` }] } });
  assert.deepEqual(await response, { content: [{ type: "text", text: `${tool}-ok` }] });
}
const permission = codex.starts[0].boundary.permission({ tool: "codex_file_change", input: { pathClass: "notes" } });
const permissionCard = await codexClient.next(message => message.kind === "permission");
codexClient.send({ kind: "reply", id: permissionCard.id, result: { behavior: "allow" } });
assert.deepEqual(await permission, { behavior: "allow" });
const codexSession = new FakeSession("codex"); codex.starts[0].deferred.resolve(codexSession);
await codexSession.sendCalls.waitFor({ count: 1 });
codexSession.output.push({ kind: "initialized", sessionId: "codex-owned", health: {
  provider: "codex", status: "ready", model: "luna", models: [] } });
await codexClient.next(down({ kind: "started", where: message => message.session.provider === "codex" }));
codexSession.output.push({ kind: "usage", usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
  cost: { usd: 0, status: "unavailable" }, turnCompleted: true });
const codexRecord = await codexClient.next(down({ kind: "session", where: message => message.session.turns === 1 }));
assert.deepEqual([codexRecord.session.provider, codexRecord.session.costUsd, codexRecord.session.costStatus],
  ["codex", 0, "unavailable"]);
const completionTimestamp = codexRecord.session.updatedAt;
await codexClient.next(down({ kind: "busy", where: message => !message.busy }));
const completedBusyMessages = codexClient.matching(down({ kind: "busy", where: message => !message.busy })).length;
codexSession.output.push(usage(2, 0.75, "estimated", false, true));
await codexClient.next(down({ kind: "session", where: message => message.session.costUsd === 0.75 }));
const refreshedSessions = await codexClient.next(down({ kind: "sessions", where: message =>
  message.sessions.some(session => session.sessionId === "codex-owned" && session.costUsd === 0.75) }));
const refreshedHistoryRow = refreshedSessions.sessions.find(session => session.sessionId === "codex-owned")!;
const checkpointed = readSessions(join(process.env.SESORI_REVIEW_HOME, "files", "codex-file"))[0]!;
assert.deepEqual([checkpointed.turns, checkpointed.updatedAt, checkpointed.costUsd, checkpointed.costStatus,
  refreshedHistoryRow.turns, refreshedHistoryRow.updatedAt, refreshedHistoryRow.costUsd, refreshedHistoryRow.costStatus],
[1, completionTimestamp, 0.75, "estimated", 1, completionTimestamp, 0.75, "estimated"],
"delayed cost checkpoints persist and refresh History rows without incrementing turns or changing completion time");
assert.equal(codexClient.matching(down({ kind: "busy", where: message => !message.busy })).length, completedBusyMessages,
  "accounting checkpoints do not publish a false turn completion");
codex.history = [{ role: "tool", name: "ask_user", input: { question: "Q" } }, { role: "answer", text: "A" }];
codexClient.send({ kind: "open", intentId: "codex-history", fileId: "codex-file", fileName: "Codex",
  session: { provider: "codex", sessionId: "codex-owned" } });
assert.deepEqual((await codexClient.next(message => message.kind === "history")).messages, codex.history);
const unavailableGate = deferred<void>(); codex.historyGate = unavailableGate.promise;
codex.historyResult = { messages: codex.history, cost: { usd: 0, status: "unavailable" } };
codexClient.send({ kind: "open", intentId: "codex-history-unavailable", fileId: "codex-file", fileName: "Codex",
  session: { provider: "codex", sessionId: "codex-owned" } });
await codex.historyCalls.waitFor({ count: 2 });
codexSession.output.push(usage(4, 7, "estimated"));
await codexClient.next(down({ kind: "session", where: message => message.session.costUsd === 7 }));
assert.equal(readSessions(join(process.env.SESORI_REVIEW_HOME, "files", "codex-file"))[0]!.costUsd, 0.75,
  "non-checkpoint in-memory accounting remains newer than disk during attached history");
unavailableGate.resolve();
const unavailableHistory = await codexClient.next(down({ kind: "history",
  where: message => message.intentId === "codex-history-unavailable" }));
assert.deepEqual([unavailableHistory.attached, unavailableHistory.session.costUsd, unavailableHistory.session.costStatus],
  [true, 7, "unavailable"], "unavailable history preserves newer attached USD while marking provenance unavailable");
assert.deepEqual([readSessions(join(process.env.SESORI_REVIEW_HOME, "files", "codex-file"))[0]!.costUsd,
  readSessions(join(process.env.SESORI_REVIEW_HOME, "files", "codex-file"))[0]!.costStatus], [7, "unavailable"]);
const historyGate = deferred<void>(); codex.historyGate = historyGate.promise;
codex.historyResult = { messages: codex.history, cost: { usd: 9, status: "estimated" } };
codexClient.send({ kind: "open", intentId: "codex-history-race", fileId: "codex-file", fileName: "Codex",
  session: { provider: "codex", sessionId: "codex-owned" } });
await codex.historyCalls.waitFor({ count: 3 });
codexSession.output.push({ kind: "usage", usage: { input: 6, output: 7, cacheRead: 1, cacheWrite: 0 },
  cost: { usd: 2, status: "estimated" }, turnCompleted: true });
await codexClient.next(down({ kind: "session", where: message => message.session.turns === 2 }));
codexClient.send({ kind: "close", reason: "fixture complete" }); await codexSession.closeCalls.waitFor({ count: 1 });
historyGate.resolve();
const racedHistory = await codexClient.next(down({ kind: "history", where: message => message.intentId === "codex-history-race" }));
assert.deepEqual([racedHistory.attached, racedHistory.session.turns, racedHistory.session.usage.input,
  racedHistory.session.costUsd], [false, 2, 6, 9],
"history revalidates attachment and merges cost into latest completed-turn record");
assert.deepEqual(readSessions(join(process.env.SESORI_REVIEW_HOME, "files", "codex-file"))[0]?.usage,
  { input: 6, output: 7, cacheRead: 1, cacheWrite: 0 });

codexSession.output.reject(new Error("fixture complete")); codexClient.close(); await codexApp.shutdown();
writeFileSync(join(process.env.SESORI_REVIEW_HOME, "settings.json"), JSON.stringify({ provider: "codex",
  providers: { claude: { model: "", effort: "" }, codex: { model: "codex-cheap", effort: "low" } } }));
const actualClients: ActualCodexClient[] = [];
let actualCodex!: InstanceType<typeof CodexProvider>;
const defaultClaude = new FakeProvider("claude");
const actualApp = createReviewBridge({ version: "test", port: 0, log: () => {}, createProviders: ({ onChanged }) => {
  actualCodex = new CodexProvider({ version: "test", log: () => {}, onPrepared: onChanged,
    clientFactory: args => { const client = new ActualCodexClient(args, actualClients.length % 2 === 1);
      actualClients.push(client); return client; } });
  return { claude: defaultClaude, codex: actualCodex };
} });
const actualClient = await new Client(await actualApp.listening).opened();
actualClient.send({ kind: "hello", protocolVersion: 3, fileId: "actual-codex", fileName: "Actual Codex" });
await actualClient.next(message => message.kind === "connection"); await actualClient.next(message => message.kind === "health");
actualClient.send(startMessage("actual-codex-start", "actual-codex"));
await actualClient.next(down({ kind: "started", where: message => message.session.provider === "codex" }));
assert.equal(actualClients.length, 2); const actualRuntime = actualClients[1]!;
actualRuntime.notify("turn/completed", { threadId: "actual-thread",
  turn: { id: "actual-turn-1", items: [], status: "completed", error: null } });
await actualClient.next(down({ kind: "busy", where: message => !message.busy }));
actualClient.send({ kind: "settings", requestId: "future-claude", provider: "claude",
  settings: { model: "", effort: "" }, selectedProvider: "claude" });
await actualClient.next(down({ kind: "health", where: message => message.health.settingsResult?.requestId === "future-claude" }));
const attachedActual = Reflect.get(actualCodex, "active") as { close: () => void } | undefined;
assert.ok(attachedActual, "default-provider switch preserves actual CodexProvider attached session");
assert.equal(actualRuntime.disposed, 0, "default-provider switch cannot retire attached Codex runtime");
actualClient.send({ kind: "user", text: "still attached", selection: [] });
await actualClient.next(down({ kind: "busy", where: message => message.busy }));
const reuseDeadline = Date.now() + 2_000;
while (actualRuntime.calls.filter(call => call.method === "turn/start").length < 2 && Date.now() < reuseDeadline) {
  await new Promise(resolve => setImmediate(resolve));
}
assert.equal(actualRuntime.calls.filter(call => call.method === "turn/start").length, 2,
  "preserved Codex session remains usable after future default changes to Claude");
actualClient.close(); await actualApp.shutdown();
await new Promise(resolve => setImmediate(resolve));
assert.equal(actualRuntime.disposed, 1, "bridge shutdown eventually retires preserved actual Codex runtime");

const transportApp = createReviewBridge({ version: "test", port: 0, log: () => {},
  createProviders: () => ({ claude: undefined, codex: undefined }) });
const transportClient = await new Client(await transportApp.listening).opened();
const transportShutdown = transportApp.shutdown();
try {
  await Promise.race([transportShutdown, new Promise<never>((_, reject) =>
    AbortSignal.timeout(2000).addEventListener("abort", () => reject(new Error("shutdown left pre-hello transport open"))))]);
} finally { transportClient.close(); await transportShutdown; }
console.log("review bridge integration check ok");
