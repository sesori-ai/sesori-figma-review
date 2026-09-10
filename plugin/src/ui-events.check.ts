import assert from "node:assert/strict";
import type { ReviewEvent, SessionRecord } from "../../shared/protocol.ts";
import { composerRoute, drainStartupInputs, eventBelongsToSession, providerSettingOptions, sessionCostLabel } from "./ui-events.ts";

const session: SessionRecord = {
  provider: "claude",
  sessionId: "claude-session",
  title: "Review",
  anchor: { type: "flow", nodeIds: [] },
  pageId: "0:1",
  pageName: "Page",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  turns: 1,
  costUsd: 0.1234,
  costStatus: "reported",
  usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
};
const event: ReviewEvent = { type: "text_delta", session: { provider: "claude", sessionId: "claude-session" }, itemId: "i1", text: "Hi" };
assert.equal(eventBelongsToSession({ event }), false, "events wait for an authoritative session identity");
assert.equal(eventBelongsToSession({ event, session }), true);
assert.equal(eventBelongsToSession({ event: { ...event, session: { provider: "codex", sessionId: "claude-session" } }, session }), false);
assert.equal(eventBelongsToSession({ event: { ...event, session: { provider: "claude", sessionId: "other" } }, session }), false);
assert.equal(sessionCostLabel({ session, precision: 3 }), "$0.123");
assert.equal(sessionCostLabel({ session: { ...session, costStatus: "estimated" }, precision: 2 }), "~$0.12");
assert.equal(sessionCostLabel({ session: { ...session, costUsd: 0, costStatus: "unavailable" }, precision: 3 }), "Cost unavailable");
assert.equal(composerRoute({ starting: true, hasLiveSession: false, hasOpenedSession: false }), "queue", "startup follow-up waits to steer first session");
assert.equal(composerRoute({ starting: false, hasLiveSession: false, hasOpenedSession: false }), "start");
assert.equal(composerRoute({ starting: false, hasLiveSession: true, hasOpenedSession: true }), "resume");
assert.equal(composerRoute({ starting: false, hasLiveSession: true, hasOpenedSession: false }), "send");
const startupInputs = [{ text: "follow up", selection: [{ id: "1:2" }] }];
assert.deepEqual(drainStartupInputs({ inputs: startupInputs }), [{ text: "follow up", selection: [{ id: "1:2" }] }]);
assert.deepEqual(startupInputs, [], "startup input is delivered once after native session identity arrives");
assert.deepEqual(providerSettingOptions({
  health: {
    provider: "codex", status: "ready", models: [
      { value: "cheap", label: "Cheap", efforts: ["", "low"] },
      { value: "image", label: "Image", efforts: ["", "medium"] },
    ],
  },
  settings: { model: "cheap", effort: "low" },
}), {
  models: [{ value: "cheap", label: "Cheap" }, { value: "image", label: "Image" }],
  efforts: [{ value: "", label: "Default" }, { value: "low", label: "low" }],
});
console.log("ui events check ok");
