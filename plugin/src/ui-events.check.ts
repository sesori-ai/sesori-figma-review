import assert from "node:assert/strict";
import type { ReviewEvent, SessionRecord } from "../../shared/protocol.ts";
import { eventBelongsToSession, sessionCostLabel } from "./ui-events.ts";

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
console.log("ui events check ok");
