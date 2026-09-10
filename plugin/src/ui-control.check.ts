import assert from "node:assert/strict";
import { PROTOCOL_VERSION, type Health, type ReviewEvent, type SessionRecord } from "../../shared/protocol.ts";
import { eventBelongsToSession, providerSettingOptions, sessionCostLabel } from "./ui-events.ts";
import { ConnectionAdmission, SettingsControl } from "./ui-state.ts";
import { ConversationView } from "./view-control.ts";
import { decodeBridgeMessage } from "./wire.ts";

const session = (id: string, provider: "claude" | "codex" = "claude"): SessionRecord => ({
  provider, sessionId: id, title: id, anchor: { type: "page", nodeIds: [] }, pageId: "0:1", pageName: "Page",
  createdAt: "now", updatedAt: "now", turns: 0, costUsd: 0, costStatus: "unavailable",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
const health = (args?: { model?: string; effort?: string; requestId?: string; accepted?: boolean; error?: string }): Health => ({
  protocolVersion: 3, bridge: "0.3.0", selectedProvider: "claude", providers: [{ provider: "claude", status: "ready", models: [] }],
  figmaMcp: "up", settings: { provider: "claude", providers: {
    claude: { model: args?.model ?? "haiku", effort: args?.effort ?? "low" }, codex: { model: "", effort: "" },
  } },
  settingsResult: args?.requestId ? { requestId: args.requestId, accepted: args.accepted ?? true, error: args.error } : undefined,
});

assert.equal(PROTOCOL_VERSION, 3);
assert.equal(decodeBridgeMessage({ kind: "health", health: { bridge: "legacy" } }), undefined);
for (const protocolVersion of [undefined, 1, 2, 4]) {
  assert.equal(decodeBridgeMessage({ kind: "connection", protocolVersion, busy: false }), undefined);
}
assert.deepEqual(decodeBridgeMessage({ kind: "connection", protocolVersion: 3, busy: false }), { kind: "connection", protocolVersion: 3, busy: false });
assert.ok(decodeBridgeMessage({ kind: "health", health: health() }));

const admission = new ConnectionAdmission();
let typed = "kept text", blocked = 0;
if (admission.admit({ onBlocked: () => blocked++ })) typed = "";
assert.deepEqual([typed, blocked], ["kept text", 1], "click/Enter before socket open retains input and gives feedback");
admission.opened();
if (admission.admit({ onBlocked: () => blocked++ })) typed = "";
assert.deepEqual([typed, blocked], ["kept text", 2], "socket open before v3 acknowledgement also retains input");
admission.acknowledge(); assert.equal(admission.admit({ onBlocked: () => blocked++ }), true);
admission.disconnected(); assert.equal(admission.ready, false, "disconnect closes admission after a transmitted start");

const view = new ConversationView();
view.begin({ intentId: "old", retainSession: false });
view.begin({ intentId: "new", retainSession: false });
view.queue({ text: "steer after start", selection: [{ id: "1:2", name: "Login", type: "FRAME" }] });
assert.equal(view.confirm({ intentId: "old", session: session("old") }), undefined);
assert.deepEqual(view.confirm({ intentId: "new", session: session("live") }), {
  inputs: [{ text: "steer after start", selection: [{ id: "1:2", name: "Login", type: "FRAME" }] }], adopted: false,
});
assert.equal(view.update(session("late")), false);
assert.equal(view.update({ ...session("live"), turns: 1 }), true);

const pending = new ConversationView();
pending.begin({ intentId: "pending", retainSession: false });
pending.queue({ text: "queued", selection: [] });
assert.deepEqual(pending.reconcile({ intentId: "pending" }), {
  queued: [], cancelled: [], adoptedStart: false, cancelledStart: false,
}, "same-client reconnect retains pending start without a native id");
assert.deepEqual(pending.confirm({ intentId: "pending", session: session("started") }), {
  inputs: [{ text: "queued", selection: [] }], adopted: false,
});
const fresh = new ConversationView();
assert.deepEqual(fresh.reconcile({ intentId: "pending" }), {
  queued: [], cancelled: [], adoptedStart: true, cancelledStart: false,
});
assert.deepEqual(fresh.confirm({ intentId: "pending", session: session("started") }), { inputs: [], adopted: true });
const cancelled = new ConversationView();
cancelled.begin({ intentId: "transmitted", retainSession: false });
assert.equal(cancelled.reconcile({}).cancelledStart, true, "lost transmitted start becomes explicit cancellation, never replay");

const attached = new ConversationView();
attached.reconcile({ session: session("active") });
attached.beginHistory({ intentId: "history", session: { provider: "claude", sessionId: "active" }, retainSession: true });
const delta: ReviewEvent = { type: "text_delta", session: { provider: "claude", sessionId: "active" }, itemId: "block", text: "new" };
assert.equal(attached.bufferEvent(delta), true, "events buffer while native history reconciles");
attached.update({ ...session("active"), turns: 2 });
assert.deepEqual(attached.confirmHistory({ intentId: "history", session: session("active") }), {
  events: [delta], session: { ...session("active"), turns: 2 },
}, "live metrics and events survive an older history response");

const cardCancellations: string[] = [];
attached.addCard({ id: "question", cancel: reason => cardCancellations.push(reason) });
attached.disconnect({ reason: "Bridge disconnected" }); attached.disconnect({ reason: "Bridge disconnected" });
assert.deepEqual(cardCancellations, ["Bridge disconnected"]);
assert.equal(attached.session?.sessionId, "active");

const settings = new SettingsControl();
const modelEdit = settings.request({ provider: "claude", settings: { model: "new-model", effort: "low" } });
assert.deepEqual(settings.acceptHealth({ health: health(), provider: "claude" }).settings, { model: "new-model", effort: "low" },
  "unrelated/older health cannot erase pending model edit");
const effortEdit = settings.request({ provider: "claude", settings: { model: "new-model", effort: "medium" } });
assert.deepEqual(effortEdit.settings, { model: "new-model", effort: "medium" }, "simple model then effort edit preserves both DOM values");
assert.deepEqual(settings.acceptHealth({ health: health({ model: "new-model", requestId: modelEdit.requestId }), provider: "claude" }).settings,
  { model: "new-model", effort: "medium" }, "older acknowledgement cannot erase newer intent");
assert.deepEqual(settings.acceptHealth({ health: health({ model: "new-model", effort: "medium", requestId: effortEdit.requestId }), provider: "claude" }).settings,
  { model: "new-model", effort: "medium" });
const rejected = settings.request({ provider: "claude", settings: { model: "bad", effort: "high" } });
const rollback = settings.acceptHealth({ health: health({ requestId: rejected.requestId, accepted: false, error: "rejected" }), provider: "claude" });
assert.deepEqual(rollback, { settings: { model: "haiku", effort: "low" }, error: "rejected" });

assert.equal(eventBelongsToSession({ event: delta, session: session("active") }), true);
assert.equal(sessionCostLabel({ session: { ...session("estimated"), costUsd: 0.123, costStatus: "estimated" }, precision: 2 }), "~$0.12");
assert.deepEqual(providerSettingOptions({
  health: { provider: "claude", status: "ready", models: [{ value: "haiku", label: "Haiku", efforts: ["", "low"] }] },
  settings: { model: "haiku", effort: "low" },
}), { models: [{ value: "haiku", label: "Haiku" }], efforts: [{ value: "", label: "Default" }, { value: "low", label: "low" }] });
console.log("ui control check ok");
