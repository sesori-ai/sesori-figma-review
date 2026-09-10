import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoryItem, ProviderHealth, ProviderSessionRecord, ProviderSettings } from "../../shared/protocol.ts";
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
class FakeSession implements ReviewSession {
  readonly output = new OutputQueue();
  sent: string[] = [];
  interrupted = 0;
  settings: ProviderSettings[] = [];
  closed = 0;
  throwOnSend = false;
  settingGate?: { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void };
  constructor(readonly provider: "claude" | "codex") {}
  send(args: { text: string }) { if (this.throwOnSend) throw new Error("dispatch rejected"); this.sent.push(args.text); }
  async interrupt() { this.interrupted++; }
  async applySettings(args: { settings: ProviderSettings }) {
    this.settings.push(args.settings);
    await this.settingGate?.promise;
  }
  close() { this.closed++; }
}
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
class FakeProvider implements ReviewProvider {
  prepareCount = 0;
  disposeCount = 0;
  starts: { deferred: ReturnType<typeof deferred<ReviewSession>>; boundary: ProviderRequestBoundary }[] = [];
  history: HistoryItem[] = [{ role: "assistant", text: "native history" }];
  constructor(readonly id: "claude" | "codex") {}
  health(args: { settings: ProviderSettings }): ProviderHealth {
    return { provider: this.id, status: "ready", model: args.settings.model, models: [] };
  }
  prepare() { this.prepareCount++; }
  start(args: { boundary: ProviderRequestBoundary }) {
    const pending = deferred<ReviewSession>(); this.starts.push({ deferred: pending, boundary: args.boundary }); return pending.promise;
  }
  readHistory() { return this.history; }
  dispose() { this.disposeCount++; }
}
class Client {
  private inbox: unknown[] = [];
  private waiters: { match: (message: any) => boolean; resolve: (message: any) => void }[] = [];
  readonly ws: WebSocket;
  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ws.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      const index = this.waiters.findIndex(waiter => waiter.match(message));
      if (index >= 0) this.waiters.splice(index, 1)[0].resolve(message); else this.inbox.push(message);
    });
  }
  async opened() { if (this.ws.readyState !== WebSocket.OPEN) await new Promise((resolve, reject) => {
    this.ws.addEventListener("open", resolve, { once: true }); this.ws.addEventListener("error", reject, { once: true });
  }); return this; }
  send(message: unknown) { this.ws.send(JSON.stringify(message)); }
  async next(match: (message: any) => boolean) {
    const index = this.inbox.findIndex(match);
    if (index >= 0) return this.inbox.splice(index, 1)[0] as any;
    return Promise.race([
      new Promise<any>(resolve => this.waiters.push({ match, resolve })),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("bridge message timeout")), 2000)),
    ]);
  }
  matching(match: (message: any) => boolean) { return this.inbox.filter(match); }
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
const logs: string[] = [];
const app = createReviewBridge({
  version: "test", port: 0, log: (...values) => logs.push(values.map(String).join(" ")),
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
await valid.next(message => message.kind === "health" && message.health.settingsResult?.requestId === "noop");
valid.send({ kind: "settings", requestId: "codex-only", provider: "codex", settings: { model: "cheap", effort: "low" } });
await valid.next(message => message.kind === "health" && message.health.settingsResult?.requestId === "codex-only");
assert.deepEqual([claude.prepareCount, claude.disposeCount], [prepareBeforeNoop, disposeBeforeNoop],
  "no-op and Codex-only preferences do not dispose/reprepare Claude");

valid.send(startMessage("pending"));
await new Promise(resolve => setTimeout(resolve, 0));
valid.send({ kind: "hello", protocolVersion: 3, fileId: "file-a", fileName: "File" });
assert.equal((await valid.next(message => message.kind === "connection")).intentId, "pending");
let fresh = await new Client(port).opened();
fresh.send({ kind: "hello", protocolVersion: 3, fileId: "file-a", fileName: "File" });
assert.equal((await fresh.next(message => message.kind === "connection")).intentId, "pending", "fresh client adopts pending reservation");
await fresh.next(message => message.kind === "health");
fresh.send({ kind: "close", reason: "close pending" });
fresh.send({ kind: "health" }); await fresh.next(message => message.kind === "health");
const stalePending = new FakeSession("claude"); claude.starts[0].deferred.resolve(stalePending);
await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual([stalePending.closed, stalePending.sent.length], [1, 0]);

fresh.send(startMessage("old")); fresh.send(startMessage("current"));
await new Promise(resolve => setTimeout(resolve, 0));
const oldSession = new FakeSession("claude"), currentSession = new FakeSession("claude");
claude.starts[1].deferred.resolve(oldSession); claude.starts[2].deferred.resolve(currentSession);
await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual([oldSession.closed, oldSession.sent.length, currentSession.sent.length], [1, 0, 1], "only current reservation sends initial prompt");
currentSession.output.push(initialized("native-current"));
await fresh.next(message => message.kind === "started" && message.intentId === "current");
const liveRef = { provider: "claude" as const, sessionId: "native-current" };
currentSession.output.push({ kind: "event", event: { type: "text_start", session: liveRef, itemId: "live" } });
currentSession.output.push({ kind: "event", event: { type: "text_delta", session: liveRef, itemId: "live", text: "prefix" } });
await fresh.next(message => message.kind === "event" && message.event.type === "text_delta");
fresh.send({ kind: "hello", protocolVersion: 3, fileId: "file-a", fileName: "File" });
assert.deepEqual((await fresh.next(message => message.kind === "connection")).activeText, [{ session: liveRef, itemId: "live", text: "prefix" }]);
fresh.send({ kind: "user", text: "steer", selection: [] });
await fresh.next(message => message.kind === "busy" && message.busy);
fresh.send({ kind: "hello", protocolVersion: 3, fileId: "file-a", fileName: "File" });
assert.deepEqual((await fresh.next(message => message.kind === "connection")).activeText, [{ session: liveRef, itemId: "live", text: "prefix" }]);
fresh.send({ kind: "interrupt" }); await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual([currentSession.sent, currentSession.interrupted], [["prompt-current", "steer"], 1]);

currentSession.output.push(usage(10, 5, "estimated"));
assert.deepEqual((await fresh.next(message => message.kind === "session" && message.session.usage.input === 10 && message.session.turns === 0)).session,
  { ...(await import("./workspace.ts")).readSessions(join(process.env.SESORI_REVIEW_HOME, "files", "file-a"))[0], usage: { input: 10, output: 11, cacheRead: 0, cacheWrite: 0 }, costUsd: 5, costStatus: "estimated" });
fresh.send({ kind: "hello", protocolVersion: 3, fileId: "file-a", fileName: "File" });
assert.equal((await fresh.next(message => message.kind === "connection")).busy, true, "provisional usage remains attached to busy turn");
currentSession.output.push(usage(3, 2, "reported"));
const replacement = await fresh.next(message => message.kind === "session" && message.session.usage.input === 3);
assert.deepEqual([replacement.session.usage.input, replacement.session.costUsd, replacement.session.costStatus], [3, 2, "reported"],
  "authoritative usage/cost snapshots replace rather than sum and may validly decrease");

const beforeLiveSettings = readSettings().providers.claude;
const gate = deferred<void>(); currentSession.settingGate = gate;
fresh.send({ kind: "settings", requestId: "claude-live", provider: "claude", settings: { model: "sonnet", effort: "high" } });
await new Promise(resolve => setTimeout(resolve, 0));
fresh.send({ kind: "settings", requestId: "codex-race", provider: "codex", settings: { model: "image", effort: "medium" } });
await fresh.next(message => message.kind === "health" && message.health.settingsResult?.requestId === "codex-race");
const settingsOrigin = fresh, settingsReplacement = await new Client(port).opened();
settingsReplacement.send({ kind: "hello", protocolVersion: 3, fileId: "file-a", fileName: "File" });
await settingsReplacement.next(message => message.kind === "connection");
assert.deepEqual((await settingsReplacement.next(message => message.kind === "health")).health.settings.providers.claude, beforeLiveSettings);
gate.resolve();
const settled = await settingsReplacement.next(message => message.kind === "health" && !message.health.settingsResult
  && message.health.settings.providers.claude.model === "sonnet");
assert.equal(settled.health.settingsResult, undefined);
assert.deepEqual(settingsOrigin.matching(message => message.kind === "health" && message.health.settingsResult?.requestId === "claude-live"), []);
fresh = settingsReplacement;
assert.deepEqual(readSettings().providers, {
  claude: { model: "sonnet", effort: "high" }, codex: { model: "image", effort: "medium" },
}, "awaited active update preserves unrelated provider commit");
assert.deepEqual(currentSession.settings, [{ model: "sonnet", effort: "high" }]);
assert.equal(claude.disposeCount, disposeBeforeNoop + 1);
const rejectedGate = deferred<void>(); currentSession.settingGate = rejectedGate;
fresh.send({ kind: "settings", requestId: "rejected", provider: "claude", settings: { model: "bad", effort: "high" } });
await new Promise(resolve => setTimeout(resolve, 0)); rejectedGate.reject(new Error("native rejected"));
const rejectedHealth = await fresh.next(message => message.kind === "health" && message.health.settingsResult?.requestId === "rejected");
assert.equal(rejectedHealth.health.settingsResult.accepted, false);
const rejectedPlain = await fresh.next(message => message.kind === "health" && !message.health.settingsResult);
assert.equal(rejectedPlain.health.settings.providers.claude.model, "sonnet");
assert.deepEqual(readSettings().providers.claude, { model: "sonnet", effort: "high" }, "failed live setting rolls back persisted truth");
currentSession.settingGate = undefined;
fresh.send({ kind: "settings", requestId: "select-codex", provider: "codex", settings: { model: "image", effort: "medium" }, selectedProvider: "codex" });
await fresh.next(message => message.kind === "health" && message.health.settingsResult?.requestId === "select-codex");
assert.ok(codex.prepareCount > 0, "actual selected-provider transition prepares its provider");
fresh.send({ kind: "settings", requestId: "select-claude", provider: "claude", settings: { model: "sonnet", effort: "high" }, selectedProvider: "claude" });
await fresh.next(message => message.kind === "health" && message.health.settingsResult?.requestId === "select-claude");
currentSession.output.push(usage(4, 1, "reported", true));
await fresh.next(message => message.kind === "busy" && !message.busy);
fresh.send({ kind: "hello", protocolVersion: 3, fileId: "file-a", fileName: "File" });
assert.deepEqual((await fresh.next(message => message.kind === "connection")).activeText, [{ session: liveRef, itemId: "live", text: "prefix" }]);
fresh.send({ kind: "user", text: "second turn", selection: [] });
await fresh.next(message => message.kind === "busy" && message.busy);
currentSession.output.push({ kind: "event", event: { type: "text_start", session: liveRef, itemId: "second" } });
currentSession.output.push({ kind: "event", event: { type: "text_delta", session: liveRef, itemId: "second", text: "new turn" } });
await fresh.next(message => message.kind === "event" && message.event.itemId === "second" && message.event.type === "text_delta");
fresh.send({ kind: "hello", protocolVersion: 3, fileId: "file-a", fileName: "File" });
assert.deepEqual((await fresh.next(message => message.kind === "connection")).activeText, [{ session: liveRef, itemId: "second", text: "new turn" }]);

const attachedClient = await new Client(port).opened();
attachedClient.send({ kind: "hello", protocolVersion: 3, fileId: "file-a", fileName: "File" });
const snapshot = await attachedClient.next(message => message.kind === "connection");
assert.equal(snapshot.session.sessionId, "native-current");
attachedClient.send({ kind: "open", intentId: "attach-history", fileId: "file-a", fileName: "File", session: { provider: "claude", sessionId: "native-current" } });
assert.deepEqual((await attachedClient.next(message => message.kind === "history")).messages, claude.history);

const other = await new Client(port).opened();
other.send({ kind: "hello", protocolVersion: 3, fileId: "file-b", fileName: "Other" });
await other.next(message => message.kind === "connection");
other.send({ kind: "close", reason: "other file" });
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(currentSession.closed, 0, "file-scoped close cannot end another file conversation");

attachedClient.send(startMessage("replacement"));
attachedClient.send({ kind: "hello", protocolVersion: 3, fileId: "file-a", fileName: "File" });
assert.equal((await attachedClient.next(message => message.kind === "connection")).intentId, "replacement");
currentSession.output.reject(new Error("late old failure"));
await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual(attachedClient.matching(message => message.kind === "error"), [], "stale pump failure is not published to replacement view");
const replacementSession = new FakeSession("claude"); claude.starts[3].deferred.resolve(replacementSession);
await new Promise(resolve => setTimeout(resolve, 0));
assert.ok(logs.some(line => line.includes("stale session error")), "late old rejection is logged but not published");

attachedClient.send(startMessage("dispatch-failure"));
attachedClient.send({ kind: "hello", protocolVersion: 3, fileId: "file-a", fileName: "File" });
assert.equal((await attachedClient.next(message => message.kind === "connection")).intentId, "dispatch-failure");
replacementSession.output.push(usage(99, 99, "estimated"));
await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual(attachedClient.matching(message => message.kind === "session" && message.session.usage.input === 99), [],
  "stale output cannot mutate replacement view");
const failingSession = new FakeSession("claude"); failingSession.throwOnSend = true; claude.starts[4].deferred.resolve(failingSession);
assert.match((await attachedClient.next(message => message.kind === "error")).message, /failed to accept the initial message/);
assert.equal(failingSession.closed, 1);
attachedClient.send({ kind: "user", text: "after failure", selection: [] });
assert.match((await attachedClient.next(message => message.kind === "error")).message, /No active session/);

valid.close(); settingsOrigin.close(); fresh.close(); attachedClient.close(); other.close();
await app.shutdown();
console.log("review bridge integration check ok");
