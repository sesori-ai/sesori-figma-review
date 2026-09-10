import assert from "node:assert/strict";
import type { SessionRecord } from "../../shared/protocol.ts";
import { ConversationView } from "./view-control.ts";

const session = (sessionId: string): SessionRecord => ({
  provider: "claude",
  sessionId,
  title: sessionId,
  anchor: { type: "page", nodeIds: [] },
  pageId: "0:1",
  pageName: "Page",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  turns: 0,
  costUsd: 0,
  costStatus: "unavailable",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});

// A stale confirmation cannot drain input queued for a newer start intent.
const view = new ConversationView();
view.begin({ intentId: "old", retainSession: false });
view.begin({ intentId: "new", retainSession: false });
view.queue({ text: "steer new", selection: [{ id: "1:2", name: "Login", type: "FRAME" }] });
assert.equal(view.confirm({ intentId: "old", session: session("old-session") }), undefined);
assert.equal(view.session, undefined);
assert.deepEqual(view.confirm({ intentId: "new", session: session("new-session") }), [
  { text: "steer new", selection: [{ id: "1:2", name: "Login", type: "FRAME" }] },
]);
assert.equal((view.session as SessionRecord | undefined)?.sessionId, "new-session");
assert.equal(view.update({ ...session("new-session"), turns: 1 }), true, "normal updates keep current view authoritative");
assert.equal(view.update(session("old-session")), false, "late old-session update cannot hijack view");

// History during startup explicitly returns queued text and ignores late startup confirmation.
const historyView = new ConversationView();
historyView.begin({ intentId: "starting", retainSession: false });
historyView.queue({ text: "queued", selection: [] });
assert.deepEqual(historyView.leave({ reason: "Opened History" }), [{ text: "queued", selection: [] }]);
assert.equal(historyView.confirm({ intentId: "starting", session: session("late") }), undefined);
assert.equal(historyView.showHistory(session("history")), true);
assert.equal(historyView.session?.sessionId, "history");

// New/History view switches cancel every actionable question/permission card once.
for (const reason of ["Started a new view", "Opened History"]) {
  const cardView = new ConversationView();
  const cancelled: string[] = [];
  cardView.addCard({ id: "question", cancel: value => cancelled.push(`question:${value}`) });
  cardView.addCard({ id: "permission", cancel: value => cancelled.push(`permission:${value}`) });
  cardView.leave({ reason });
  assert.deepEqual(cancelled, [`question:${reason}`, `permission:${reason}`]);
  cardView.leave({ reason });
  assert.equal(cancelled.length, 2, "cards cancel exactly once");
}

console.log("view control check ok");
