import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DownMsg, HistoryItem, ProviderHealth, ProviderSessionRecord, ProviderSettings } from "../../shared/protocol.ts";
import { decodeBridgeMessage } from "../../plugin/src/wire.ts";
import type { ProviderOutput, ProviderRequestBoundary, ReviewProvider, ReviewSession } from "./providers/types.ts";

process.env.SESORI_REVIEW_HOME = mkdtempSync(join(tmpdir(), "review-bridge-check-"));
const { createReviewBridge } = await import("./review-bridge.ts");
const { readSettings } = await import("./workspace.ts");

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
  readonly settingCalls = new ObservedCalls();
  readonly closeCalls = new ObservedCalls();
  sent: string[] = [];
  interrupted = 0;
  settings: ProviderSettings[] = [];
  closed = 0;
  throwOnSend = false;
  settingGate?: { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void };
  constructor(readonly provider: "claude" | "codex") {}
  send(args: { text: string }) { if (this.throwOnSend) throw new Error("dispatch rejected"); this.sent.push(args.text); this.sendCalls.hit(); }
  async interrupt() { this.interrupted++; this.interruptCalls.hit(); }
  async applySettings(args: { settings: ProviderSettings }) {
    this.settings.push(args.settings); this.settingCalls.hit();
    await this.settingGate?.promise;
  }
  close() { this.closed++; this.closeCalls.hit(); }
}
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
class FakeProvider implements ReviewProvider {
  prepareCount = 0;
  readonly startCalls = new ObservedCalls();
  disposeCount = 0;
  starts: { deferred: ReturnType<typeof deferred<ReviewSession>>; boundary: ProviderRequestBoundary }[] = [];
  history: HistoryItem[] = [{ role: "assistant", text: "native history" }];
  constructor(readonly id: "claude" | "codex") {}
  health(args: { settings: ProviderSettings }): ProviderHealth {
    return { provider: this.id, status: "ready", model: args.settings.model, models: [] };
  }
  prepare() { this.prepareCount++; }
  start(args: { boundary: ProviderRequestBoundary }) {
    const pending = deferred<ReviewSession>(); this.starts.push({ deferred: pending, boundary: args.boundary }); this.startCalls.hit(); return pending.promise;
  }
  readHistory() { return this.history; }
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
const usage = (input: number, cost: number, status: "reported" | "estimated", turnCompleted = false): ProviderOutput => ({
  kind: "usage", usage: { input, output: input + 1, cacheRead: 0, cacheWrite: 0 }, cost: { usd: cost, status }, turnCompleted,
});

const claude = new FakeProvider("claude"), codex = new FakeProvider("codex");
const logs: string[] = [], staleErrorLogged = deferred<void>();
const app = createReviewBridge({
  version: "test", port: 0, log: (...values) => {
    const line = values.map(String).join(" "); logs.push(line);
    if (line.includes("stale session error")) staleErrorLogged.resolve();
  },
  createProviders: () => ({ claude, codex }), probeFigmaMcp: async () => "down",
});
const port = await app.listening;
const valid = await new Client(port).opened();
valid.send({ kind: "hello", protocolVersion: 3, fileId: "file-a", fileName: "File" });
await valid.next(message => message.kind === "connection");

for (const protocolVersion of [undefined, 1, 2, 4]) {
  const invalid = await new Client(port).opened();
  invalid.send({ kind: "hello", protocolVersion, fileId: "file-a", fileName: "Invalid" });
  assert.match((await invalid.next(message => message.kind === "error")).message, /protocol mismatch/);
}
valid.send({ kind: "health" });
await valid.next(message => message.kind === "health");
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

fresh.send(startMessage("old")); fresh.send(startMessage("current"));
await claude.startCalls.waitFor({ count: 3 });
const oldSession = new FakeSession("claude"), currentSession = new FakeSession("claude");
claude.starts[1].deferred.resolve(oldSession); claude.starts[2].deferred.resolve(currentSession);
await Promise.all([oldSession.closeCalls.waitFor({ count: 1 }), currentSession.sendCalls.waitFor({ count: 1 })]);
assert.deepEqual([oldSession.closed, oldSession.sent.length, currentSession.sent.length], [1, 0, 1], "only current reservation sends initial prompt");
currentSession.output.push(initialized("native-current"));
await fresh.next(down({ kind: "started", where: message => message.intentId === "current" }));
const liveRef = { provider: "claude" as const, sessionId: "native-current" };
currentSession.output.push({ kind: "event", event: { type: "text_start", session: liveRef, itemId: "live" } });
currentSession.output.push({ kind: "event", event: { type: "text_delta", session: liveRef, itemId: "live", text: "prefix" } });
await fresh.next(down({ kind: "event", where: message => message.event.type === "text_delta" }));
fresh.send({ kind: "hello", protocolVersion: 3, fileId: "file-a", fileName: "File" });
assert.deepEqual((await fresh.next(message => message.kind === "connection")).activeText, [{ session: liveRef, itemId: "live", text: "prefix" }]);
fresh.send({ kind: "user", text: "steer", selection: [] });
await fresh.next(down({ kind: "busy", where: message => message.busy }));
fresh.send({ kind: "hello", protocolVersion: 3, fileId: "file-a", fileName: "File" });
assert.deepEqual((await fresh.next(message => message.kind === "connection")).activeText, [{ session: liveRef, itemId: "live", text: "prefix" }]);
fresh.send({ kind: "interrupt" }); await currentSession.interruptCalls.waitFor({ count: 1 });
assert.deepEqual([currentSession.sent, currentSession.interrupted], [["prompt-current", "steer"], 1]);

currentSession.output.push(usage(10, 5, "estimated"));
assert.deepEqual((await fresh.next(down({ kind: "session", where: message => message.session.usage.input === 10 && message.session.turns === 0 }))).session,
  { ...(await import("./workspace.ts")).readSessions(join(process.env.SESORI_REVIEW_HOME, "files", "file-a"))[0], usage: { input: 10, output: 11, cacheRead: 0, cacheWrite: 0 }, costUsd: 5, costStatus: "estimated" });
fresh.send({ kind: "hello", protocolVersion: 3, fileId: "file-a", fileName: "File" });
assert.equal((await fresh.next(message => message.kind === "connection")).busy, true, "provisional usage remains attached to busy turn");
currentSession.output.push(usage(3, 2, "reported"));
const replacement = await fresh.next(down({ kind: "session", where: message => message.session.usage.input === 3 }));
assert.deepEqual([replacement.session.usage.input, replacement.session.costUsd, replacement.session.costStatus], [3, 2, "reported"],
  "authoritative usage/cost snapshots replace rather than sum and may validly decrease");

const beforeLiveSettings = readSettings().providers.claude;
const gate = deferred<void>(); currentSession.settingGate = gate;
fresh.send({ kind: "settings", requestId: "claude-live", provider: "claude", settings: { model: "sonnet", effort: "high" } });
await currentSession.settingCalls.waitFor({ count: 1 });
fresh.send({ kind: "settings", requestId: "codex-race", provider: "codex", settings: { model: "image", effort: "medium" } });
await fresh.next(down({ kind: "health", where: message => message.health.settingsResult?.requestId === "codex-race" }));
const settingsOrigin = fresh, settingsReplacement = await new Client(port).opened();
settingsReplacement.send({ kind: "hello", protocolVersion: 3, fileId: "file-a", fileName: "File" });
await settingsReplacement.next(message => message.kind === "connection");
assert.deepEqual((await settingsReplacement.next(message => message.kind === "health")).health.settings.providers.claude, beforeLiveSettings);
gate.resolve();
const settled = await settingsReplacement.next(down({ kind: "health", where: message => !message.health.settingsResult
  && message.health.settings.providers.claude.model === "sonnet" }));
assert.equal(settled.health.settingsResult, undefined);
assert.deepEqual(settingsOrigin.matching(down({ kind: "health", where: message => message.health.settingsResult?.requestId === "claude-live" })), []);
fresh = settingsReplacement;
assert.deepEqual(readSettings().providers, {
  claude: { model: "sonnet", effort: "high" }, codex: { model: "image", effort: "medium" },
}, "awaited active update preserves unrelated provider commit");
assert.deepEqual(currentSession.settings, [{ model: "sonnet", effort: "high" }]);
assert.equal(claude.disposeCount, disposeBeforeNoop + 1);
const rejectedGate = deferred<void>(); currentSession.settingGate = rejectedGate;
fresh.send({ kind: "settings", requestId: "rejected", provider: "claude", settings: { model: "bad", effort: "high" } });
await currentSession.settingCalls.waitFor({ count: 2 }); rejectedGate.reject(new Error("native rejected"));
const rejectedHealth = await fresh.next(down({ kind: "health", where: message => message.health.settingsResult?.requestId === "rejected" }));
assert.equal(rejectedHealth.health.settingsResult?.accepted, false);
const rejectedPlain = await fresh.next(down({ kind: "health", where: message => !message.health.settingsResult }));
assert.equal(rejectedPlain.health.settings.providers.claude.model, "sonnet");
assert.deepEqual(readSettings().providers.claude, { model: "sonnet", effort: "high" }, "failed live setting rolls back persisted truth");
currentSession.settingGate = undefined;
fresh.send({ kind: "settings", requestId: "select-codex", provider: "codex", settings: { model: "image", effort: "medium" }, selectedProvider: "codex" });
await fresh.next(down({ kind: "health", where: message => message.health.settingsResult?.requestId === "select-codex" }));
assert.ok(codex.prepareCount > 0, "actual selected-provider transition prepares its provider");
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
attachedClient.send({ kind: "open", intentId: "attach-history", fileId: "file-a", fileName: "File", session: { provider: "claude", sessionId: "native-current" } });
assert.deepEqual((await attachedClient.next(message => message.kind === "history")).messages,
  [{ role: "assistant", text: "prefix", itemId: "live" }]);

const other = await new Client(port).opened();
other.send({ kind: "hello", protocolVersion: 3, fileId: "file-b", fileName: "Other" });
await other.next(message => message.kind === "connection");
other.send({ kind: "close", reason: "other file" });
other.send({ kind: "health" }); await other.next(message => message.kind === "health");
assert.equal(currentSession.closed, 0, "file-scoped close cannot end another file conversation");

attachedClient.send(startMessage("replacement"));
attachedClient.send({ kind: "hello", protocolVersion: 3, fileId: "file-a", fileName: "File" });
assert.equal((await attachedClient.next(message => message.kind === "connection")).intentId, "replacement");
currentSession.output.reject(new Error("late old failure"));
await staleErrorLogged.promise;
assert.deepEqual(attachedClient.matching(message => message.kind === "error"), [], "stale pump failure is not published to replacement view");
const replacementSession = new FakeSession("claude"); claude.starts[3].deferred.resolve(replacementSession);
await replacementSession.sendCalls.waitFor({ count: 1 });
assert.ok(logs.some(line => line.includes("stale session error")), "late old rejection is logged but not published");

attachedClient.send(startMessage("dispatch-failure"));
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

valid.close(); settingsOrigin.close(); fresh.close(); attachedClient.close(); other.close();
await app.shutdown();
console.log("review bridge integration check ok");
