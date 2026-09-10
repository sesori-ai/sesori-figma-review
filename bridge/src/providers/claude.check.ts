import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderOutput, ReviewProvider } from "./types.ts";

const testRoots = [mkdtempSync(join(tmpdir(), "claude-adapter-")), mkdtempSync(join(tmpdir(), "review-adapter-"))];
process.env.CLAUDE_CONFIG_DIR = testRoots[0];
process.env.SESORI_REVIEW_HOME = testRoots[1];
process.on("exit", () => testRoots.forEach(root => rmSync(root, { recursive: true, force: true })));
const {
  addClaudeUsage,
  ClaudeCostTracker,
  ClaudeDisplayMapper,
  ClaudeProvider,
  ClaudeUsageTracker,
  createClaudeBoundaryDelegate,
  readClaudeTranscript,
  zeroClaudeUsage,
} = await import("./claude.ts");
const { FIGMA_TOOLS } = await import("../figma-tools.ts");
const { workspaceFor } = await import("../workspace.ts");
const workspace = workspaceFor("adapter-file", "Adapter fixture");

assert.deepEqual(FIGMA_TOOLS.map(tool => tool.name), ["get_flow", "get_screen", "focus", "annotate", "ask_user"]);
assert.deepEqual(FIGMA_TOOLS.map(tool => tool.description), [
  "Prototype flow of the user's current Figma page: screens (id, name, size) and transitions (from, to, trigger, navigation, via which element). Falls back to listing top-level frames when the page has no prototype flow.",
  "PNG screenshot of a node plus its layer tree (ids, names, types, bounds relative to the node, text, existing annotations). Works for whole screens and for single components.",
  "Select a node and scroll/zoom the user's canvas to it. Call it before discussing a node so the user sees what you mean.",
  "Attach a Dev Mode annotation (markdown) to a node, appended to what is already there.",
  "Ask the user a question about a specific spot in the design. Focuses their canvas on nodeId (if given), shows the question with optional choice buttons in the plugin, and waits for the answer. Returns the answer and the user's current selection.",
]);
assert.equal(FIGMA_TOOLS[1].schema.shape.scale.description, "Export scale, default 1; use 2 for small components");
assert.equal(FIGMA_TOOLS[0].schema.safeParse({}).success, true);
assert.equal(FIGMA_TOOLS[1].schema.safeParse({ nodeId: "1:2", scale: 2 }).success, true);
assert.equal(FIGMA_TOOLS[1].schema.safeParse({ nodeId: 4 }).success, false);
assert.equal(FIGMA_TOOLS[2].schema.safeParse({ nodeId: "1:2" }).success, true);
assert.equal(FIGMA_TOOLS[3].schema.safeParse({ nodeId: "1:2", markdown: "Note" }).success, true);
assert.equal(FIGMA_TOOLS[4].schema.safeParse({ question: "Next?", options: ["1", "2", "3", "4", "5"] }).success, false);

class FakeQuery implements AsyncIterable<unknown> {
  readonly models: (string | undefined)[] = [];
  readonly efforts: (string | null)[] = [];
  interrupts = 0;
  closes = 0;
  failInterrupts = 0;
  failEfforts = 0;
  failModelCalls = new Set<number>();
  nextEffortGate?: Promise<void>;
  constructor(readonly messages: unknown[] = [], readonly statuses: unknown = []) {}
  async *[Symbol.asyncIterator]() { yield* this.messages; }
  async interrupt() {
    this.interrupts++;
    if (this.failInterrupts-- > 0) throw new Error("interrupt failed");
  }
  async setModel(model?: string) {
    this.models.push(model);
    if (this.failModelCalls.delete(this.models.length)) throw new Error("setModel failed");
  }
  async applyFlagSettings(settings: { effortLevel: string | null }) {
    this.efforts.push(settings.effortLevel);
    const gate = this.nextEffortGate;
    this.nextEffortGate = undefined;
    if (gate) await gate;
    if (this.failEfforts-- > 0) throw new Error("effort failed");
  }
  async mcpServerStatus() {
    if (this.statuses instanceof Error) throw this.statuses;
    if (this.statuses instanceof Promise) return await this.statuses;
    return this.statuses as { name: string; status: string; error?: string }[];
  }
  close() { this.closes++; }
}
class FakeWarm {
  closes = 0;
  queries = 0;
  queryThrows = false;
  closeThrows = false;
  constructor(readonly nativeQuery = new FakeQuery()) {}
  query(_prompt: AsyncIterable<unknown>) {
    this.queries++;
    if (this.queryThrows) throw new Error("warm query consume failed");
    return this.nativeQuery;
  }
  close() {
    this.closes++;
    if (this.closeThrows) throw new Error("warm close failed");
  }
}
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  return { promise: new Promise<T>((yes, no) => { resolve = yes; reject = no; }), resolve, reject };
};
const baseRecord = {
  provider: "claude" as const,
  sessionId: "11111111-1111-4111-8111-111111111111",
  title: "Fixture",
  anchor: { type: "page" as const, nodeIds: [] },
  pageId: "0:1",
  pageName: "Page",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  turns: 0,
  costUsd: 0,
  costStatus: "unavailable" as const,
  usage: zeroClaudeUsage(),
};
const allowBoundary = (label: string) => ({
  tool: async () => ({ content: [{ type: "text" as const, text: label }] }),
  permission: async () => ({ behavior: "deny" as const, message: label }),
});
const delegated = createClaudeBoundaryDelegate(allowBoundary("old"));
delegated.current = allowBoundary("new");
assert.deepEqual(await delegated.boundary.tool({ tool: "focus", args: { nodeId: "1:2" } }),
  { content: [{ type: "text", text: "new" }] });
assert.deepEqual(await delegated.boundary.permission({ tool: "Write", input: {} }),
  { behavior: "deny", message: "new" });

let preparedCallbacks = 0;
const provider: ReviewProvider = new ClaudeProvider({ version: "test", log: () => {}, onPrepared: () => preparedCallbacks++ });
assert.deepEqual(provider.health({ settings: { model: "haiku", effort: "low" } }).models.map(model => model.value),
  ["", "opus", "sonnet", "haiku"]);
provider.dispose();
assert.equal(preparedCallbacks, 1);
assert.equal(provider.health({ settings: { model: "haiku", effort: "low" } }).status, "starting");

type Native = NonNullable<ConstructorParameters<typeof ClaudeProvider>[0]["native"]>;
type WarmCall = { options: Parameters<Native["warm"]>[0]["options"]; pending: ReturnType<typeof deferred<FakeWarm>> };
const lifecycle = () => {
  const warmCalls: WarmCall[] = [], coldQueries: FakeQuery[] = [];
  const coldOptions: Parameters<Native["cold"]>[0]["options"][] = [];
  const native: Native = {
    warm: ({ options }) => {
      const pending = deferred<FakeWarm>();
      warmCalls.push({ options, pending });
      return pending.promise;
    },
    cold: ({ options }) => { const query = new FakeQuery(); coldQueries.push(query); coldOptions.push(options); return query; },
  };
  let callbacks = 0;
  const logs: unknown[][] = [];
  const provider = new ClaudeProvider({
    version: "test", log: (...values) => logs.push(values), onPrepared: () => callbacks++, native,
  });
  return { provider, warmCalls, coldQueries, coldOptions, logs, callbacks: () => callbacks };
};
const warmArgs = (boundary: ReturnType<typeof allowBoundary>, settings = { model: "haiku", effort: "low" }) => ({
  fileId: "adapter-file", dir: workspace, settings, boundary,
});

const priorLimits = {
  turns: process.env.SESORI_REVIEW_MAX_TURNS,
  budget: process.env.SESORI_REVIEW_MAX_BUDGET_USD,
};
try {
  delete process.env.SESORI_REVIEW_MAX_TURNS;
  delete process.env.SESORI_REVIEW_MAX_BUDGET_USD;
  const absent = lifecycle();
  absent.provider.prepare(warmArgs(allowBoundary("absent")));
  assert.equal(absent.warmCalls[0].options.maxTurns, undefined);
  assert.equal(absent.warmCalls[0].options.maxBudgetUsd, undefined);
  absent.warmCalls[0].pending.resolve(new FakeWarm());
  await Promise.resolve();
  absent.provider.dispose();

  const invalidLimits = [
    ...["", "NaN", "Infinity", "0", "-1", "1.5", "0x10", String(Number.MAX_SAFE_INTEGER + 1), "garbage"]
      .map(value => ({ name: "SESORI_REVIEW_MAX_TURNS" as const, value })),
    ...["", "NaN", "Infinity", "0", "-1", "garbage"]
      .map(value => ({ name: "SESORI_REVIEW_MAX_BUDGET_USD" as const, value })),
  ];
  for (const invalid of invalidLimits) {
    delete process.env.SESORI_REVIEW_MAX_TURNS;
    delete process.env.SESORI_REVIEW_MAX_BUDGET_USD;
    process.env[invalid.name] = invalid.value;
    const warmAttempt = lifecycle();
    assert.throws(() => warmAttempt.provider.prepare(warmArgs(allowBoundary("invalid"))), new RegExp(invalid.name));
    assert.equal(warmAttempt.warmCalls.length, 0);
    const coldAttempt = lifecycle();
    await assert.rejects(coldAttempt.provider.start({ ...warmArgs(allowBoundary("invalid")), baseRecord }), new RegExp(invalid.name));
    assert.equal(coldAttempt.coldQueries.length, 0);
  }
  process.env.SESORI_REVIEW_MAX_TURNS = "3";
  process.env.SESORI_REVIEW_MAX_BUDGET_USD = "0.05";
  const validWarm = lifecycle();
  validWarm.provider.prepare(warmArgs(allowBoundary("valid")));
  assert.equal(validWarm.warmCalls[0].options.maxTurns, 3);
  assert.equal(validWarm.warmCalls[0].options.maxBudgetUsd, 0.05);
  validWarm.warmCalls[0].pending.resolve(new FakeWarm());
  await Promise.resolve();
  validWarm.provider.dispose();
  const validCold = lifecycle();
  const validSession = await validCold.provider.start({ ...warmArgs(allowBoundary("valid")), baseRecord });
  assert.equal(validCold.coldOptions[0].maxTurns, 3);
  assert.equal(validCold.coldOptions[0].maxBudgetUsd, 0.05);
  validSession.close();
} finally {
  if (priorLimits.turns === undefined) delete process.env.SESORI_REVIEW_MAX_TURNS;
  else process.env.SESORI_REVIEW_MAX_TURNS = priorLimits.turns;
  if (priorLimits.budget === undefined) delete process.env.SESORI_REVIEW_MAX_BUDGET_USD;
  else process.env.SESORI_REVIEW_MAX_BUDGET_USD = priorLimits.budget;
}

// Same immutable options rebind boundary; changed model replaces pending warm and stale resolution cannot win.
const cached = lifecycle();
const firstBoundary = allowBoundary("first"), reboundBoundary = allowBoundary("rebound");
cached.provider.prepare(warmArgs(firstBoundary));
cached.provider.prepare(warmArgs(reboundBoundary));
assert.equal(cached.warmCalls.length, 1, "same warm options do not restart native startup");
const canUseTool = cached.warmCalls[0].options.canUseTool!;
const permission = await canUseTool("Write", {}, {} as Parameters<typeof canUseTool>[2]);
assert.deepEqual(permission, { behavior: "deny", message: "rebound" }, "warm permission boundary delegates to latest owner");
cached.provider.prepare(warmArgs(reboundBoundary, { model: "sonnet", effort: "low" }));
assert.equal(cached.warmCalls.length, 2, "model change replaces warm query");
const staleWarm = new FakeWarm();
cached.warmCalls[0].pending.resolve(staleWarm);
await Promise.resolve();
assert.equal(staleWarm.closes, 1);
assert.equal(cached.callbacks(), 0, "stale replaced warm resolution cannot publish health");
assert.equal(cached.provider.health({ settings: { model: "sonnet", effort: "low" } }).status, "starting");
const currentWarm = new FakeWarm();
cached.warmCalls[1].pending.resolve(currentWarm);
await Promise.resolve();
assert.equal(cached.callbacks(), 1);
assert.equal(cached.provider.health({ settings: { model: "sonnet", effort: "low" } }).status, "ready");
await cached.provider.start({
  ...warmArgs(allowBoundary("start"), { model: "sonnet", effort: "low" }), baseRecord,
});
assert.equal(currentWarm.queries, 1, "matching warm query is consumed");
assert.equal(cached.coldQueries.length, 0);

// New prepare/dispose while consumed warm awaits fences stale success and uses a cold query for the requested start.
const consumed = lifecycle();
consumed.provider.prepare(warmArgs(firstBoundary));
const consumedStart = consumed.provider.start({ ...warmArgs(reboundBoundary), baseRecord });
consumed.provider.prepare(warmArgs(reboundBoundary, { model: "sonnet", effort: "low" }));
const consumedWarm = new FakeWarm();
consumed.warmCalls[0].pending.resolve(consumedWarm);
await consumedStart;
assert.equal(consumedWarm.closes, 1);
assert.equal(consumed.coldQueries.length, 1, "stale consumed warm falls back cold");
const replacementWarm = new FakeWarm();
consumed.warmCalls[1].pending.resolve(replacementWarm);
await Promise.resolve();
assert.equal(consumed.provider.health({ settings: { model: "sonnet", effort: "low" } }).status, "ready");
consumed.provider.dispose();
await Promise.resolve();
assert.equal(replacementWarm.closes, 1);
assert.equal(consumed.provider.health({ settings: { model: "sonnet", effort: "low" } }).status, "starting");

const disposed = lifecycle();
disposed.provider.prepare(warmArgs(firstBoundary));
disposed.provider.dispose();
const disposedWarm = new FakeWarm();
disposed.warmCalls[0].pending.resolve(disposedWarm);
await Promise.resolve();
assert.equal(disposedWarm.closes, 1);
assert.equal(disposed.callbacks(), 1, "dispose publishes once; stale resolution stays fenced");
assert.equal(disposed.provider.health({ settings: { model: "haiku", effort: "low" } }).status, "starting");
const disposedConsumed = lifecycle();
disposedConsumed.provider.prepare(warmArgs(firstBoundary));
const startBeforeDispose = disposedConsumed.provider.start({ ...warmArgs(reboundBoundary), baseRecord });
disposedConsumed.provider.dispose();
const staleAfterDispose = new FakeWarm();
disposedConsumed.warmCalls[0].pending.resolve(staleAfterDispose);
await startBeforeDispose;
assert.equal(staleAfterDispose.closes, 1);
assert.equal(disposedConsumed.coldQueries.length, 1);
assert.equal(disposedConsumed.provider.health({ settings: { model: "haiku", effort: "low" } }).status, "starting");

const rejected = lifecycle();
rejected.provider.prepare(warmArgs(firstBoundary));
const rejectedStart = rejected.provider.start({ ...warmArgs(reboundBoundary), baseRecord });
rejected.warmCalls[0].pending.reject(new Error("startup failed"));
await rejectedStart;
assert.equal(rejected.coldQueries.length, 1, "failed consumed warm falls back cold");

const failedPrepared = deferred<FakeWarm>();
const retryQuery = new FakeQuery([
  { type: "system", subtype: "init", session_id: baseRecord.sessionId, model: "haiku", mcp_servers: [] },
  { type: "result", is_error: false, usage: {}, total_cost_usd: 0 },
]);
const retryNative: Native = { warm: () => failedPrepared.promise, cold: () => retryQuery };
const retryProvider = new ClaudeProvider({ version: "test", log: () => {}, onPrepared: () => {}, native: retryNative });
retryProvider.prepare(warmArgs(firstBoundary));
failedPrepared.reject(new Error("prepare failed"));
await Promise.resolve();
assert.equal(retryProvider.health({ settings: { model: "haiku", effort: "low" } }).status, "unavailable");
const retrySession = await retryProvider.start({ ...warmArgs(firstBoundary), baseRecord });
assert.equal(retryProvider.health({ settings: { model: "haiku", effort: "low" } }).status, "starting",
  "owned cold retry clears completed prepare error without claiming readiness");
const retryOutputs = [];
for await (const output of retrySession.output) retryOutputs.push(output);
const retryInitialized = retryOutputs.find(output => output.kind === "initialized");
assert.equal(retryInitialized?.kind === "initialized" ? retryInitialized.health.status : undefined, "ready");

const consumeThrows = lifecycle();
consumeThrows.provider.prepare(warmArgs(firstBoundary));
const unusableWarm = new FakeWarm();
unusableWarm.queryThrows = true;
consumeThrows.warmCalls[0].pending.resolve(unusableWarm);
await Promise.resolve();
await consumeThrows.provider.start({ ...warmArgs(reboundBoundary), baseRecord });
assert.equal(unusableWarm.queries, 1);
assert.equal(unusableWarm.closes, 1, "warm resource closes when query consumption throws");
assert.equal(consumeThrows.coldQueries.length, 1, "consume throw falls back cold");

const closeThrows = lifecycle();
closeThrows.provider.prepare(warmArgs(firstBoundary));
const uncloseableWarm = new FakeWarm();
uncloseableWarm.closeThrows = true;
closeThrows.warmCalls[0].pending.resolve(uncloseableWarm);
await Promise.resolve();
closeThrows.provider.dispose();
await Promise.resolve();
assert.equal(uncloseableWarm.closes, 1);
assert.ok(closeThrows.logs.some(values => String(values[0]).includes("failed to close warm query")),
  "synchronous warm close failure is handled and logged");

const mismatched = lifecycle();
mismatched.provider.prepare(warmArgs(firstBoundary, { model: "opus", effort: "high" }));
const mismatchedWarm = new FakeWarm();
mismatched.warmCalls[0].pending.resolve(mismatchedWarm);
await Promise.resolve();
await mismatched.provider.start({ ...warmArgs(reboundBoundary), baseRecord });
await Promise.resolve();
assert.equal(mismatchedWarm.closes, 1, "start never consumes a previous, potentially pricier settings entry");
assert.equal(mismatched.coldQueries.length, 1);
assert.equal(mismatched.coldOptions[0].model, "haiku");
assert.equal(mismatched.coldOptions[0].effort, "low");
const effortChanged = lifecycle();
effortChanged.provider.prepare(warmArgs(firstBoundary));
effortChanged.provider.prepare(warmArgs(firstBoundary, { model: "haiku", effort: "high" }));
assert.equal(effortChanged.warmCalls.length, 2, "effort change replaces warm query");
const oldEffortWarm = new FakeWarm(), newEffortWarm = new FakeWarm();
effortChanged.warmCalls[0].pending.resolve(oldEffortWarm);
effortChanged.warmCalls[1].pending.resolve(newEffortWarm);
await Promise.resolve();
assert.equal(oldEffortWarm.closes, 1);
effortChanged.provider.dispose();
await Promise.resolve();
assert.equal(newEffortWarm.closes, 1);

const permissionChanged = lifecycle();
const permissionsPath = join(workspace, "permissions.json");
const originalAllow = JSON.parse(readFileSync(permissionsPath, "utf8")).allow as string[];
permissionChanged.provider.prepare(warmArgs(firstBoundary));
const permissionWarm1 = new FakeWarm();
permissionChanged.warmCalls[0].pending.resolve(permissionWarm1);
await Promise.resolve();
const prepareAllow = [...originalAllow.slice(1), "FixturePrepare"];
writeFileSync(permissionsPath, JSON.stringify({ allow: prepareAllow }));
permissionChanged.provider.prepare(warmArgs(firstBoundary));
assert.equal(permissionChanged.warmCalls.length, 2, "prepare replaces warm query after permission revocation");
await Promise.resolve();
assert.equal(permissionWarm1.closes, 1);
const permissionWarm2 = new FakeWarm();
permissionChanged.warmCalls[1].pending.resolve(permissionWarm2);
await Promise.resolve();
const startAllow = [...prepareAllow.slice(1), "FixtureStart"];
writeFileSync(permissionsPath, JSON.stringify({ allow: startAllow }));
await permissionChanged.provider.start({ ...warmArgs(firstBoundary), baseRecord });
await Promise.resolve();
assert.equal(permissionWarm2.closes, 1, "start rejects warm snapshot after another permission change");
assert.deepEqual(permissionChanged.coldOptions[0].allowedTools, startAllow, "cold options use one current allow snapshot");
writeFileSync(permissionsPath, JSON.stringify({ allow: originalAllow }));

const sessionWith = async (query: FakeQuery) => {
  const native: Native = { warm: async () => new FakeWarm(), cold: () => query };
  const provider = new ClaudeProvider({ version: "test", log: () => {}, onPrepared: () => {}, native });
  return provider.start({ ...warmArgs(firstBoundary), resume: baseRecord.sessionId, baseRecord });
};

// Partial update rolls back; updates serialize, while Stop stays independent of the settings queue.
const settingsQuery = new FakeQuery();
const settingsSession = await sessionWith(settingsQuery);
settingsSession.send({ text: "active turn", selection: [] });
settingsQuery.failEfforts = 1;
await assert.rejects(settingsSession.applySettings({ settings: { model: "sonnet", effort: "high" } }), /effort failed/);
assert.deepEqual(settingsQuery.models, ["sonnet", "haiku"]);
assert.deepEqual(settingsQuery.efforts, ["high", "low"]);
const effortGate = deferred<void>();
settingsQuery.nextEffortGate = effortGate.promise;
const firstUpdate = settingsSession.applySettings({ settings: { model: "sonnet", effort: "medium" } });
await Promise.resolve(); await Promise.resolve();
const secondUpdate = settingsSession.applySettings({ settings: { model: "opus", effort: "low" } });
await Promise.resolve();
assert.equal(settingsQuery.models.at(-1), "sonnet", "second settings update waits for first");
await settingsSession.interrupt();
assert.equal(settingsQuery.interrupts, 1, "Stop is independent of settings serialization");
effortGate.resolve();
await firstUpdate; await secondUpdate;
assert.deepEqual(settingsQuery.models.slice(-2), ["sonnet", "opus"]);

const rollbackQuery = new FakeQuery();
const rollbackSession = await sessionWith(rollbackQuery);
rollbackQuery.failEfforts = 1;
rollbackQuery.failModelCalls.add(2);
await assert.rejects(rollbackSession.applySettings({ settings: { model: "sonnet", effort: "high" } }), /session closed/);
assert.equal(rollbackQuery.closes, 1, "failed rollback closes unknown-state session");
assert.throws(() => rollbackSession.send({ text: "must reject", selection: [] }), /session is closed/);
await rollbackSession.interrupt();
assert.equal(rollbackQuery.interrupts, 0, "closed session interrupt settles without native control");
await assert.rejects(rollbackSession.applySettings({ settings: { model: "opus", effort: "low" } }), /session is closed/);
const explicitlyClosedQuery = new FakeQuery();
const explicitlyClosed = await sessionWith(explicitlyClosedQuery);
explicitlyClosed.close();
assert.throws(() => explicitlyClosed.send({ text: "must reject", selection: [] }), /session is closed/);
await explicitlyClosed.interrupt();
assert.equal(explicitlyClosedQuery.interrupts, 0);

const turnOutcome = (outputs: ProviderOutput[]) => {
  const output = outputs.find(item => item.kind === "event" && item.event.type === "turn_end");
  return output?.kind === "event" && output.event.type === "turn_end" ? output.event.outcome : undefined;
};
const nativeInit = { type: "system", subtype: "init", session_id: baseRecord.sessionId, mcp_servers: [] };
const idleStopQuery = new FakeQuery([nativeInit, {
  type: "result", is_error: false, usage: {}, total_cost_usd: 0,
}]);
const idleStopSession = await sessionWith(idleStopQuery);
await idleStopSession.interrupt();
assert.equal(idleStopQuery.interrupts, 0, "idle Stop does not taint or call native control");
idleStopSession.send({ text: "next turn", selection: [] });
const idleOutputs = [];
for await (const output of idleStopSession.output) idleOutputs.push(output);
assert.equal(turnOutcome(idleOutputs), "completed", "idle Stop cannot mark next turn interrupted");
await idleStopSession.interrupt();
assert.equal(idleStopQuery.interrupts, 0, "late Stop after natural result is idle");

const failedStopQuery = new FakeQuery([nativeInit, { type: "result", is_error: false, usage: {}, total_cost_usd: 0 }]);
const failedStopSession = await sessionWith(failedStopQuery);
failedStopSession.send({ text: "active", selection: [] });
failedStopQuery.failInterrupts = 1;
await assert.rejects(failedStopSession.interrupt(), /interrupt failed/);
const failedStopOutputs = [];
for await (const output of failedStopSession.output) failedStopOutputs.push(output);
assert.equal(turnOutcome(failedStopOutputs), "completed", "failed interrupt rolls back only its active turn intent");

const duplicateStopQuery = new FakeQuery([nativeInit, { type: "result", is_error: false, usage: {}, total_cost_usd: 0 }]);
const duplicateStopSession = await sessionWith(duplicateStopQuery);
duplicateStopSession.send({ text: "active", selection: [] });
const firstStop = duplicateStopSession.interrupt();
duplicateStopQuery.failInterrupts = 1;
const duplicateStop = duplicateStopSession.interrupt();
await Promise.all([firstStop, duplicateStop]);
assert.equal(duplicateStopQuery.interrupts, 1, "duplicate Stop is idempotent while first intent remains active");
const duplicateOutputs = [];
for await (const output of duplicateStopSession.output) duplicateOutputs.push(output);
assert.equal(turnOutcome(duplicateOutputs), "interrupted");

const suspendedQuery = new FakeQuery([
  nativeInit,
  { type: "result", is_error: false, usage: {}, total_cost_usd: 0 },
  { type: "result", is_error: false, usage: {}, total_cost_usd: 0 },
]);
const suspendedSession = await sessionWith(suspendedQuery);
const iterator = suspendedSession.output[Symbol.asyncIterator]();
suspendedSession.send({ text: "first", selection: [] });
await iterator.next(); // init
const firstTurnEnd = await iterator.next();
assert.equal(firstTurnEnd.value?.kind, "event");
suspendedSession.send({ text: "second", selection: [] });
await suspendedSession.interrupt();
await iterator.next(); // old result usage after consumer started next turn
const secondTurnEnd = await iterator.next();
assert.equal(secondTurnEnd.value?.kind === "event" && secondTurnEnd.value.event.type === "turn_end"
  ? secondTurnEnd.value.event.outcome : undefined, "interrupted", "old result continuation cannot clear next turn");

const nativeStartQuery = new FakeQuery([
  nativeInit,
  { type: "stream_event", event: { type: "message_start", message: { id: "native" } } },
  { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
  { type: "result", is_error: false, usage: {}, total_cost_usd: 0 },
]);
const nativeStartSession = await sessionWith(nativeStartQuery);
const nativeIterator = nativeStartSession.output[Symbol.asyncIterator]();
await nativeIterator.next(); // init
await nativeIterator.next(); // text_start after top-level message_start establishes active turn
await nativeStartSession.interrupt();
const nativeTurnEnd = await nativeIterator.next();
assert.equal(nativeTurnEnd.value?.kind === "event" && nativeTurnEnd.value.event.type === "turn_end"
  ? nativeTurnEnd.value.event.outcome : undefined, "interrupted");

// Actual session iteration keeps native init MCP status if refresh fails, then emits normalized accounting.
const initQuery = new FakeQuery([
  { type: "system", subtype: "init", session_id: baseRecord.sessionId, claude_code_version: "test", model: "haiku",
    mcp_servers: [{ name: "figma", status: "failed", error: "not connected" }, { name: "figma-desktop", status: "disconnected" }] },
  { type: "result", is_error: false, usage: { input_tokens: 2, output_tokens: 3 }, total_cost_usd: 0.01 },
], new Error("refresh failed"));
const initLogs: unknown[][] = [];
const initNative: Native = { warm: async () => new FakeWarm(), cold: () => initQuery };
const initProvider = new ClaudeProvider({ version: "test", log: (...values) => initLogs.push(values), onPrepared: () => {}, native: initNative });
const initSession = await initProvider.start({ ...warmArgs(firstBoundary), resume: baseRecord.sessionId, baseRecord });
const outputs = [];
for await (const output of initSession.output) outputs.push(output);
const initialized = outputs.find(output => output.kind === "initialized");
assert.deepEqual(initialized?.servers, [
  { name: "figma", status: "failed", error: "not connected" },
  { name: "figma-desktop", status: "disconnected", error: undefined },
]);
assert.ok(initLogs.some(values => String(values[0]).includes("using init snapshot")));
assert.deepEqual(outputs.at(-1), {
  kind: "usage", usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 },
  cost: { usd: 0.01, status: "unavailable" }, turnCompleted: true,
});

const lateStatus = deferred<{ name: string; status: string }[]>();
const stalledQuery = new FakeQuery([
  { ...nativeInit, mcp_servers: [{ name: "figma", status: "disconnected" }] },
  { type: "result", is_error: false, usage: {}, total_cost_usd: 0 },
], lateStatus.promise);
const stalledLogs: unknown[][] = [];
const stalledNative: Native = { warm: async () => new FakeWarm(), cold: () => stalledQuery };
const stalledProvider = new ClaudeProvider({
  version: "test", log: (...values) => stalledLogs.push(values), onPrepared: () => {},
  native: stalledNative, mcpStatusTimeoutMs: 5,
});
const stalledSession = await stalledProvider.start({ ...warmArgs(firstBoundary), resume: baseRecord.sessionId, baseRecord });
const stalledOutputs = [];
for await (const output of stalledSession.output) stalledOutputs.push(output);
assert.deepEqual(stalledOutputs.find(output => output.kind === "initialized")?.servers,
  [{ name: "figma", status: "disconnected", error: undefined }]);
assert.equal(stalledOutputs.at(-1)?.kind, "usage", "MCP timeout cannot block following model output");
assert.ok(stalledLogs.some(values => String(values[1]).includes("timed out")));
lateStatus.reject(new Error("late refresh rejection"));
await Promise.resolve(); // Promise.race retains rejection handler after timeout

let usage = addClaudeUsage(zeroClaudeUsage(), {
  input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 7,
});
usage = addClaudeUsage(usage, { input_tokens: 1, output_tokens: 1 });
assert.deepEqual(usage, { input: 11, output: 21, cacheRead: 100, cacheWrite: 7 });
const tracker = new ClaudeUsageTracker({ committed: zeroClaudeUsage() });
assert.deepEqual(tracker.messageStart({ input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 50 }),
  { input: 10, output: 1, cacheRead: 50, cacheWrite: 0 });
assert.deepEqual(tracker.messageDelta({ output_tokens: 8 }), { input: 10, output: 8, cacheRead: 50, cacheWrite: 0 });
assert.deepEqual(tracker.messageDelta({ output_tokens: 20 }), { input: 10, output: 20, cacheRead: 50, cacheWrite: 0 });
assert.deepEqual(tracker.complete({ input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 50 }),
  { input: 10, output: 20, cacheRead: 50, cacheWrite: 0 });
assert.deepEqual(tracker.complete({ input_tokens: 2, output_tokens: 3 }),
  { input: 12, output: 23, cacheRead: 50, cacheWrite: 0 }, "per-turn results add once");
const responses = new ClaudeUsageTracker({ committed: { input: 5, output: 7, cacheRead: 0, cacheWrite: 0 } });
responses.messageStart({ input_tokens: 10, output_tokens: 1 });
responses.messageDelta({ output_tokens: 4 });
assert.deepEqual(responses.messageStart({ input_tokens: 12, output_tokens: 1 }),
  { input: 27, output: 12, cacheRead: 0, cacheWrite: 0 });
assert.deepEqual(responses.messageDelta({ output_tokens: 8, cache_read_input_tokens: 3 }),
  { input: 27, output: 19, cacheRead: 3, cacheWrite: 0 });
assert.deepEqual(responses.complete({ input_tokens: 22, output_tokens: 12, cache_read_input_tokens: 3 }),
  { input: 27, output: 19, cacheRead: 3, cacheWrite: 0 });
const freshCost = new ClaudeCostTracker({ baseUsd: 0, baseStatus: "unavailable", resumed: false });
assert.deepEqual(freshCost.snapshot(), { usd: 0, status: "unavailable" });
assert.deepEqual(freshCost.complete(undefined), { usd: 0, status: "unavailable" });
assert.deepEqual(freshCost.complete(0.1), { usd: 0.1, status: "reported" });
const resumedCost = new ClaudeCostTracker({ baseUsd: 1.5, baseStatus: "reported", resumed: true });
assert.deepEqual(resumedCost.complete(0.1), { usd: 1.6, status: "reported" });
assert.deepEqual(resumedCost.complete(0.25), { usd: 1.75, status: "reported" }, "cost uses immutable resume baseline");
for (const invalid of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
  assert.deepEqual(resumedCost.complete(invalid), { usd: 1.75, status: "unavailable" });
}
assert.deepEqual(resumedCost.complete(0.4), { usd: 1.9, status: "reported" }, "valid native cost recovers reporting");
assert.deepEqual(resumedCost.complete(0.2), { usd: 1.7, status: "reported" },
  "each valid native cumulative snapshot replaces rather than max-clamps");
const unavailableResume = new ClaudeCostTracker({ baseUsd: 0, baseStatus: "unavailable", resumed: true });
assert.deepEqual(unavailableResume.complete(0.2), { usd: 0.2, status: "unavailable" },
  "zero-turn crashed resume cannot invent historical provenance");
const estimatedResume = new ClaudeCostTracker({ baseUsd: 2, baseStatus: "estimated", resumed: true });
assert.deepEqual(estimatedResume.complete(0.3), { usd: 2.3, status: "estimated" });

const nativeSession = "11111111-1111-4111-8111-111111111111";
const session = { provider: "claude" as const, sessionId: nativeSession };
const display = new ClaudeDisplayMapper();
const map = (message: unknown) => display.map({ message, sessionId: nativeSession, interrupted: false });
assert.deepEqual(map({ type: "stream_event", uuid: "a", event: { type: "message_start", message: { id: "msg" } } }), []);
assert.deepEqual(map({ type: "stream_event", uuid: "b", event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } } }), []);
assert.deepEqual(map({ type: "stream_event", uuid: "c", event: { type: "content_block_stop", index: 0 } }), []);
assert.deepEqual(map({ type: "stream_event", uuid: "d", event: { type: "content_block_start", index: 1, content_block: { type: "text" } } }),
  [{ type: "text_start", session, itemId: `${nativeSession}:msg:1` }]);
assert.deepEqual(map({ type: "stream_event", uuid: "e", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hi" } } }),
  [{ type: "text_delta", session, itemId: `${nativeSession}:msg:1`, text: "Hi" }]);
assert.deepEqual(map({ type: "stream_event", uuid: "f", event: { type: "content_block_stop", index: 1 } }),
  [{ type: "text_end", session, itemId: `${nativeSession}:msg:1` }]);
assert.deepEqual(map({ type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "mcp__figma__focus", input: { nodeId: "1:2" } }] } }),
  [{ type: "tool", session, itemId: "t", name: "mcp__figma__focus", input: { nodeId: "1:2" } }]);

const dir = join(tmpdir(), "adapter workspace");
const transcriptDir = join(process.env.CLAUDE_CONFIG_DIR, "projects", dir.replace(/[^a-zA-Z0-9]/g, "-"));
mkdirSync(transcriptDir, { recursive: true });
writeFileSync(join(transcriptDir, `${nativeSession}.jsonl`), [
  { type: "user", message: { content: "[Figma file F]\nReview.\n[Current selection: none]" } },
  { type: "user", message: { content: [
    { type: "text", text: "[Figma file F]\nArray text.\n[Current selection: none]" },
    { type: "image", source: { data: "hidden" } },
    { type: "tool_result", tool_use_id: "not-a-question", content: "ignored" },
  ] } },
  { type: "assistant", message: { content: [{ type: "thinking", thinking: "hidden" }, { type: "image", source: { data: "hidden" } }, { type: "tool_use", id: "q", name: "mcp__figma__ask_user", input: { question: "Next?" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "q", content: "Next\n[Current selection: none]" }] } },
  { type: "assistant", message: { content: [{ type: "text", text: "Done" }] } },
].map(value => JSON.stringify(value)).join("\n"));
assert.deepEqual(readClaudeTranscript({ dir, sessionId: nativeSession }), [
  { role: "user", text: "Review." },
  { role: "user", text: "Array text." },
  { role: "tool", name: "mcp__figma__ask_user", input: { question: "Next?" } },
  { role: "answer", text: "Next" },
  { role: "assistant", text: "Done" },
]);
assert.deepEqual(readClaudeTranscript({ dir, sessionId: "33333333-3333-4333-8333-333333333333" }), []);
assert.throws(() => readClaudeTranscript({ dir, sessionId: "../../outside" }), /Invalid Claude native session id/);

console.log("claude adapter check ok");
