import assert from "node:assert/strict";
import { PROTOCOL_VERSION, type ReviewEvent, type SessionRecord } from "../../shared/protocol.ts";
import { eventBelongsToSession, providerSettingOptions, sessionCostLabel } from "./ui-events.ts";
import { ConversationView } from "./view-control.ts";
import { decodeBridgeMessage } from "./wire.ts";

const session = (id: string, provider: "claude" | "codex" = "claude"): SessionRecord => ({
  provider, sessionId: id, title: id, anchor: { type: "page", nodeIds: [] }, pageId: "0:1", pageName: "Page",
  createdAt: "now", updatedAt: "now", turns: 0, costUsd: 0, costStatus: "unavailable",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});

assert.equal(PROTOCOL_VERSION, 3);
assert.equal(decodeBridgeMessage({ kind: "health", health: { bridge: "legacy" } }), undefined);
assert.equal(decodeBridgeMessage({ kind: "connection", protocolVersion: 2, busy: false }), undefined);
assert.deepEqual(decodeBridgeMessage({ kind: "connection", protocolVersion: 3, busy: false }), { kind: "connection", protocolVersion: 3, busy: false });
assert.ok(decodeBridgeMessage({ kind: "health", health: {
  protocolVersion: 3, bridge: "0.3.0", selectedProvider: "claude", providers: [{ provider: "claude", status: "ready" }],
  figmaMcp: "up", settings: { provider: "claude", providers: { claude: { model: "haiku", effort: "low" }, codex: { model: "", effort: "" } } },
} }));

const view = new ConversationView();
view.begin({ intentId: "old", retainSession: false });
view.queue({ text: "do not replay", selection: [] });
view.begin({ intentId: "new", retainSession: false });
view.queue({ text: "steer after start", selection: [{ id: "1:2", name: "Login", type: "FRAME" }] });
assert.equal(view.confirm({ intentId: "old", session: session("old") }), undefined);
assert.deepEqual(view.confirm({ intentId: "new", session: session("live") }), [{
  text: "steer after start", selection: [{ id: "1:2", name: "Login", type: "FRAME" }],
}]);
assert.equal(view.update(session("late")), false);
assert.equal(view.update({ ...session("live"), turns: 1 }), true);

const cancelled: string[] = [];
view.addCard({ id: "question", cancel: reason => cancelled.push(`question:${reason}`) });
view.addCard({ id: "permission", cancel: reason => cancelled.push(`permission:${reason}`) });
view.disconnect({ reason: "Bridge disconnected" });
view.disconnect({ reason: "Bridge disconnected" });
assert.deepEqual(cancelled, ["question:Bridge disconnected", "permission:Bridge disconnected"]);
assert.equal(view.session?.sessionId, "live", "reconnect preserves resumable card-free view");

const restart = new ConversationView();
restart.begin({ intentId: "lost", retainSession: false });
restart.queue({ text: "never replay ambiguously", selection: [] });
assert.deepEqual(restart.reconcile({}), { queued: [], cancelled: [{ text: "never replay ambiguously", selection: [] }] });
assert.deepEqual(restart.reconcile({ session: session("reattached") }), { queued: [], cancelled: [] });
assert.equal(restart.session?.sessionId, "reattached");

const event: ReviewEvent = { type: "text_delta", session: { provider: "claude", sessionId: "live" }, itemId: "block", text: "Hi" };
assert.equal(eventBelongsToSession({ event, session: view.session }), true);
assert.equal(eventBelongsToSession({ event: { ...event, session: { provider: "codex", sessionId: "live" } }, session: view.session }), false);
assert.equal(sessionCostLabel({ session: { ...session("estimated"), costUsd: 0.123, costStatus: "estimated" }, precision: 2 }), "~$0.12");
assert.equal(sessionCostLabel({ session: session("unknown"), precision: 2 }), "Cost unavailable");
assert.deepEqual(providerSettingOptions({
  health: { provider: "claude", status: "ready", models: [{ value: "haiku", label: "Haiku", efforts: ["", "low"] }] },
  settings: { model: "haiku", effort: "low" },
}), {
  models: [{ value: "haiku", label: "Haiku" }],
  efforts: [{ value: "", label: "Default" }, { value: "low", label: "low" }],
});
console.log("ui control check ok");
