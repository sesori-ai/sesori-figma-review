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
assert.equal(view.update({ ...session("new-session"), turns: 1 }), true);
assert.equal(view.update(session("old-session")), false, "late old-session update cannot hijack view");

// Choosing a History row supersedes startup; only its matching response can own the view.
const historyView = new ConversationView();
historyView.begin({ intentId: "starting", retainSession: false });
historyView.queue({ text: "queued", selection: [] });
assert.deepEqual(historyView.leave({ reason: "Opened History" }), [{ text: "queued", selection: [] }]);
historyView.beginHistory({ intentId: "history-new", session: { provider: "claude", sessionId: "history" } });
assert.equal(historyView.confirm({ intentId: "starting", session: session("late") }), undefined);
assert.equal(historyView.confirmHistory({ intentId: "history-old", session: session("wrong") }), false);
assert.equal(historyView.confirmHistory({ intentId: "history-new", session: session("history") }), true);
assert.equal(historyView.session?.sessionId, "history");
historyView.beginHistory({ intentId: "late-history", session: { provider: "claude", sessionId: "old" } });
historyView.begin({ intentId: "new-start", retainSession: false });
assert.equal(historyView.confirmHistory({ intentId: "late-history", session: session("old") }), false,
  "late History response cannot steal a newer view");

// Disconnect cancels cards once without abandoning a current resumable session.
const reconnectView = new ConversationView();
reconnectView.begin({ intentId: "ready", retainSession: false });
reconnectView.confirm({ intentId: "ready", session: session("live") });
const disconnected: string[] = [];
let composerHidden = true;
reconnectView.addCard({ id: "question", cancel: reason => { disconnected.push(reason); composerHidden = false; } });
reconnectView.disconnect({ reason: "Bridge disconnected" });
reconnectView.disconnect({ reason: "Bridge disconnected" });
assert.deepEqual(disconnected, ["Bridge disconnected"]);
assert.equal(composerHidden, false, "disconnect card cancellation restores composer callback");
assert.equal(reconnectView.session?.sessionId, "live", "disconnect preserves resumable view");

// Matching snapshot finishes startup once; bridge restart cancels orphaned queue without replay.
const startingView = new ConversationView();
startingView.begin({ intentId: "pending", retainSession: false });
startingView.queue({ text: "queued", selection: [] });
assert.deepEqual(startingView.reconcile({ intentId: "pending", session: session("attached") }), {
  queued: [{ text: "queued", selection: [] }], cancelled: [],
});
const orphanedView = new ConversationView();
orphanedView.begin({ intentId: "orphan", retainSession: false });
orphanedView.queue({ text: "do not replay", selection: [] });
assert.deepEqual(orphanedView.reconcile({}), { queued: [], cancelled: [{ text: "do not replay", selection: [] }] });
orphanedView.begin({ intentId: "usable", retainSession: false });
assert.deepEqual(orphanedView.confirm({ intentId: "usable", session: session("usable") }), []);

// Fresh plugin can attach authoritative active/idle session from connection snapshot.
const freshView = new ConversationView();
assert.deepEqual(freshView.reconcile({ session: session("already-active") }), { queued: [], cancelled: [] });
assert.equal(freshView.update({ ...session("already-active"), turns: 1 }), true);

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
