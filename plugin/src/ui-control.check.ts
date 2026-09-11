import assert from "node:assert/strict";
import vm from "node:vm";
import { buildSync } from "esbuild";
import { PROTOCOL_VERSION, type DownMsg, type Health, type ReviewEvent, type SessionRecord } from "../../shared/protocol.ts";
import { eventBelongsToSession, providerSettingOptions, sessionCostLabel } from "./ui-events.ts";
import { ConversationView } from "./view-control.ts";
import { decodeBridgeMessage } from "./wire.ts";

class ElementStub {
  children: ElementStub[] = [];
  parent?: ElementStub;
  className = "";
  textContent = "";
  value = "";
  inner = "";
  hidden = false;
  disabled = false;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  onclick?: (event?: unknown) => void;
  onchange?: () => void;
  oninput?: () => void;
  onkeydown?: (event: { key: string; shiftKey: boolean; preventDefault(): void }) => void;
  scrollHeight = 20;
  scrollTop = 0;
  constructor(readonly tagName: string, readonly id = "") {}
  get innerHTML() { return this.inner; }
  set innerHTML(value: string) { this.inner = value; if (!value) this.replaceChildren(); }
  get lastElementChild() { return this.children[this.children.length - 1]; }
  get parentNode() { return this.parent; }
  get classList() {
    return {
      add: (...names: string[]) => { this.className = [...new Set([...this.className.split(" "), ...names])].filter(Boolean).join(" "); },
      remove: (...names: string[]) => { this.className = this.className.split(" ").filter(name => !names.includes(name)).join(" "); },
      contains: (name: string) => this.className.split(" ").includes(name),
    };
  }
  append(...values: (ElementStub | string)[]) {
    for (const value of values) {
      const child = typeof value === "string" ? Object.assign(new ElementStub("#text"), { textContent: value }) : value;
      child.remove(); child.parent = this; this.children.push(child);
    }
  }
  prepend(value: ElementStub) { value.remove(); value.parent = this; this.children.unshift(value); }
  insertBefore(value: ElementStub, before?: ElementStub | null) {
    value.remove(); value.parent = this;
    const index = before ? this.children.indexOf(before) : -1;
    this.children.splice(index < 0 ? this.children.length : index, 0, value);
  }
  replaceChildren(...values: ElementStub[]) { for (const child of this.children) child.parent = undefined; this.children = []; this.append(...values); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = undefined; }
  querySelectorAll(selector: string): ElementStub[] {
    const matches = (node: ElementStub) => selector === "button" ? node.tagName === "button" : selector.startsWith(".") && node.classList.contains(selector.slice(1));
    return this.children.flatMap(child => [ ...(matches(child) ? [child] : []), ...child.querySelectorAll(selector) ]);
  }
  focus() {}
  select() {}
}

const bundle = buildSync({ entryPoints: [new URL("./ui.ts", import.meta.url).pathname], bundle: true, write: false,
  platform: "browser", format: "iife", target: "es2022", define: { __VERSION__: '"test"' } }).outputFiles[0]!.text;
const session: SessionRecord = { provider: "claude", sessionId: "11111111-1111-4111-8111-111111111111", title: "Review", anchor: { type: "page", nodeIds: [] },
  pageId: "page", pageName: "Page", createdAt: "2026-01-01", updatedAt: "2026-01-01", turns: 1, costUsd: 0, costStatus: "reported", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const health = (model = "haiku", effort = "low"): Health => ({ protocolVersion: PROTOCOL_VERSION, bridge: "test", figmaMcp: "up", selectedProvider: "claude",
  providers: [{ provider: "claude", status: "ready", models: [{ value: "haiku", label: "Haiku", efforts: ["low", "medium"] }, { value: "sonnet", label: "Sonnet", efforts: ["low", "medium"] }] },
    { provider: "codex", status: "unavailable", models: [] }],
  settings: { provider: "claude", providers: { claude: { model, effort }, codex: { model: "default", effort: "default" } } } });
const resultHealth = (requestId: string, accepted: boolean, model: string, effort: string, error?: string): Health =>
  ({ ...health(model, effort), settingsResult: { requestId, accepted, error } });
const text = (node: ElementStub): string => `${node.textContent}${node.inner}${node.children.map(text).join("")}`;
const count = (value: string, part: string) => value.split(part).length - 1;

class Harness {
  elements = new Map<string, ElementStub>();
  sockets: SocketStub[] = [];
  timers: (() => void)[] = [];
  posted: unknown[] = [];
  footer = new ElementStub("footer");
  constructor() {
    const ids = ["btn-settings", "dot", "status", "cost", "btn-flow", "btn-stop", "btn-selection", "btn-new", "btn-history",
      "settings", "model", "effort", "about", "sessions", "chat", "empty", "sel", "input", "send"];
    for (const id of ids) this.elements.set(id, new ElementStub(id.startsWith("btn-") || id === "send" ? "button" : id === "input" ? "textarea" : id === "model" || id === "effort" ? "select" : "div", id));
    this.get("chat").append(this.get("empty")); this.get("sel").append(new ElementStub("svg"), new ElementStub("span"));
    const body = new ElementStub("body");
    const owner = this;
    class Socket extends SocketStub { constructor(url: string) { super(url); owner.sockets.push(this); } }
    const document = { getElementById: (id: string) => this.elements.get(id), createElement: (tag: string) => new ElementStub(tag),
      createElementNS: (_ns: string, tag: string) => new ElementStub(tag), querySelector: (query: string) => query === "footer" ? this.footer : undefined,
      body, execCommand: () => true };
    const window: { onmessage?: (event: { data: unknown }) => void } = {};
    vm.runInNewContext(bundle, { document, window, parent: { postMessage: (message: unknown) => this.posted.push(message) }, navigator: { userAgent: "Electron" },
      WebSocket: Socket, Option: class extends ElementStub { constructor(label: string, value: string) { super("option"); this.textContent = label; this.value = value; } },
      setTimeout: (callback: () => void) => { this.timers.push(callback); return this.timers.length; }, clearTimeout: () => {}, console });
    window.onmessage?.({ data: { pluginMessage: { kind: "context", fileId: "file", fileName: "File", pageId: "page", pageName: "Page", selection: [], annotations: {} } } });
  }
  get(id: string) { return this.elements.get(id)!; }
  get socket() { return this.sockets[this.sockets.length - 1]!; }
  deliver(message: DownMsg) { this.socket.onmessage?.({ data: JSON.stringify(message) }); }
  connect(connection: Extract<DownMsg, { kind: "connection" }> = { kind: "connection", protocolVersion: PROTOCOL_VERSION, busy: false }) {
    this.socket.open(); this.deliver(connection); this.deliver({ kind: "health", health: health() });
  }
  reconnect(connection: Extract<DownMsg, { kind: "connection" }>) { this.timers.shift()?.(); this.socket.open(); this.deliver(connection); }
  sent(kind: string) { return this.sockets.flatMap(socket => socket.sent.map(raw => JSON.parse(raw) as Record<string, unknown>)).filter(message => message.kind === kind); }
  button(root: ElementStub, label: string) { return root.querySelectorAll("button").find(button => button.textContent === label)!; }
}
class SocketStub {
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (event: { data: string }) => void;
  constructor(readonly url: string) {}
  open() { this.readyState = SocketStub.OPEN; this.onopen?.(); }
  send(raw: string) { this.sent.push(raw); }
  close() { this.readyState = 3; this.onclose?.(); }
}

// Composer, New, and History Open preserve state until both socket and protocol acknowledgement exist.
const admission = new Harness();
admission.get("input").value = "kept"; admission.get("send").onclick?.();
assert.equal(admission.get("input").value, "kept");
admission.socket.open(); admission.get("send").onclick?.();
assert.equal(admission.get("input").value, "kept");
admission.deliver({ kind: "connection", protocolVersion: PROTOCOL_VERSION, busy: false }); admission.deliver({ kind: "health", health: health() });
admission.get("send").onclick?.(); assert.equal(admission.get("input").value, ""); assert.equal(admission.sent("start").length, 1);
admission.deliver({ kind: "sessions", sessions: [session] }); admission.get("input").value = "offline draft"; admission.socket.close();
const beforeNew = text(admission.get("chat")); admission.get("btn-new").onclick?.();
assert.equal(text(admission.get("chat")), beforeNew); assert.equal(admission.sent("close").length, 0);
admission.get("btn-history").onclick?.(); const opens = admission.sent("open").length;
admission.button(admission.get("sessions"), "Open").onclick?.(); assert.equal(admission.sent("open").length, opens);
assert.equal(admission.get("input").value, "offline draft"); assert.equal(text(admission.get("chat")), beforeNew);
assert.match(JSON.stringify(admission.posted), /New was not started/); assert.match(JSON.stringify(admission.posted), /History was not opened/);
admission.get("model").value = "sonnet"; admission.get("model").onchange?.();
assert.equal(admission.get("model").value, "haiku"); assert.equal(admission.sent("settings").length, 0);
admission.timers.shift()?.(); admission.socket.open();
admission.get("model").value = "sonnet"; admission.get("model").onchange?.();
assert.equal(admission.get("model").value, "haiku"); assert.equal(admission.sent("settings").length, 0);
assert.match(JSON.stringify(admission.posted), /Settings were not changed/);

// Rapid edits survive an older result; current accepted/rejected results settle intent. Reconnect health separately resolves lost results.
const settings = new Harness();
assert.equal(settings.get("model").disabled, true); settings.connect();
settings.get("model").value = "sonnet"; settings.get("model").onchange?.();
settings.get("effort").value = "medium"; settings.get("effort").onchange?.();
const edits = settings.sent("settings") as { requestId: string; settings: { model: string; effort: string } }[];
assert.deepEqual(edits[1]!.settings, { model: "sonnet", effort: "medium" });
settings.deliver({ kind: "health", health: resultHealth(edits[0]!.requestId, false, "sonnet", "low", "stale") });
assert.deepEqual([settings.get("model").value, settings.get("effort").value], ["sonnet", "medium"]);
assert.doesNotMatch(text(settings.get("chat")), /stale/);
settings.deliver({ kind: "health", health: resultHealth(edits[1]!.requestId, true, "sonnet", "medium") });
settings.get("model").value = "haiku"; settings.get("model").onchange?.();
const rejected = settings.sent("settings").slice(-1)[0] as { requestId: string };
settings.deliver({ kind: "health", health: resultHealth(rejected.requestId, false, "sonnet", "medium", "rejected") });
assert.equal(settings.get("model").value, "sonnet"); assert.match(text(settings.get("chat")), /rejected/);
settings.get("model").value = "haiku"; settings.get("model").onchange?.(); settings.socket.close();
assert.match(text(settings.get("chat")), /not confirmed/);
settings.reconnect({ kind: "connection", protocolVersion: PROTOCOL_VERSION, busy: false }); settings.deliver({ kind: "health", health: health("haiku", "medium") });
assert.equal(settings.get("model").value, "haiku"); assert.doesNotMatch(text(settings.get("chat")), /not confirmed/);
settings.get("model").value = "sonnet"; settings.get("model").onchange?.(); settings.socket.close();
settings.reconnect({ kind: "connection", protocolVersion: PROTOCOL_VERSION, busy: false }); settings.deliver({ kind: "health", health: health("haiku", "medium") });
assert.equal(settings.get("model").value, "haiku");

// A no-retained History row blocks click/Enter submission and a second row supersedes its correlated result.
const rows = new Harness(), otherSession = { ...session, sessionId: "22222222-2222-4222-8222-222222222222", title: "Other" };
rows.connect(); rows.deliver({ kind: "sessions", sessions: [session, otherSession] }); rows.get("btn-history").onclick?.();
rows.get("sessions").querySelectorAll("button")[0]!.onclick?.();
const rowFirst = rows.sent("open").slice(-1)[0] as { intentId: string };
rows.get("input").value = "click"; rows.get("send").onclick?.(); assert.equal(rows.get("input").value, "click");
rows.get("input").onkeydown?.({ key: "Enter", shiftKey: false, preventDefault() {} }); assert.equal(rows.get("input").value, "click");
assert.equal(rows.sent("user").length + rows.sent("start").length, 0);
rows.get("btn-history").onclick?.(); rows.get("sessions").querySelectorAll("button")[1]!.onclick?.();
const rowSecond = rows.sent("open").slice(-1)[0] as { intentId: string };
assert.notEqual(rowSecond.intentId, rowFirst.intentId);
rows.deliver({ kind: "history", intentId: rowFirst.intentId, session: otherSession, attached: false, messages: [{ role: "assistant", text: "stale row" }] });
assert.doesNotMatch(text(rows.get("chat")), /stale row/);
rows.deliver({ kind: "history", intentId: rowSecond.intentId, session, attached: false, messages: [{ role: "assistant", text: "current row" }] });
assert.match(text(rows.get("chat")), /current row/);

// Same-session reconnect restores History; recovered queued-start input waits for that reconstruction.
const restored = new Harness(); restored.connect({ kind: "connection", protocolVersion: PROTOCOL_VERSION, session, busy: false });
let restoreOpen = restored.sent("open").slice(-1)[0] as { intentId: string };
restored.deliver({ kind: "history", intentId: restoreOpen.intentId, session, attached: true, messages: [{ role: "assistant", text: "before reconnect" }] });
restored.socket.close(); restored.reconnect({ kind: "connection", protocolVersion: PROTOCOL_VERSION, session, busy: false });
restoreOpen = restored.sent("open").slice(-1)[0] as { intentId: string };
restored.deliver({ kind: "history", intentId: restoreOpen.intentId, session, attached: true, messages: [{ role: "assistant", text: "after reconnect" }] });
assert.match(text(restored.get("chat")), /after reconnect/);
const queued = new Harness(); queued.connect();
queued.get("input").value = "start"; queued.get("send").onclick?.();
const queuedStart = queued.sent("start")[0] as { intentId: string };
queued.get("input").value = "queued"; queued.get("send").onclick?.(); queued.socket.close();
queued.reconnect({ kind: "connection", protocolVersion: PROTOCOL_VERSION, intentId: queuedStart.intentId, session, busy: true });
const queuedOpen = queued.sent("open").slice(-1)[0] as { intentId: string };
assert.equal(queued.sent("user").length, 0);
queued.deliver({ kind: "history", intentId: queuedOpen.intentId, session, attached: true, messages: [{ role: "assistant", text: "context" }] });
assert.equal(queued.sent("user").length, 1);
const queuedText = text(queued.get("chat")); assert.equal(count(queuedText, "queued"), 1); assert.ok(queuedText.indexOf("context") < queuedText.indexOf("queued"));
const detached = new Harness(); detached.connect(); detached.get("input").value = "start"; detached.get("send").onclick?.();
const detachedStart = detached.sent("start")[0] as { intentId: string }; detached.get("input").value = "detached"; detached.get("send").onclick?.(); detached.socket.close();
detached.reconnect({ kind: "connection", protocolVersion: PROTOCOL_VERSION, intentId: detachedStart.intentId, session, busy: false });
const detachedOpen = detached.sent("open").slice(-1)[0] as { intentId: string };
detached.deliver({ kind: "history", intentId: detachedOpen.intentId, session, attached: false, messages: [] });
assert.equal(detached.sent("user").length, 0); assert.match(JSON.stringify(detached.posted), /queued message was cancelled/);
detached.get("input").value = "deliberate"; detached.get("send").onclick?.();
assert.deepEqual((detached.sent("start").slice(-1)[0] as { resume?: unknown }).resume, { provider: "claude", sessionId: session.sessionId });

// Correlated History failure uses authoritative attachment; stale failure cannot release a newer read.
const failedHistory = new Harness(); failedHistory.connect({ kind: "connection", protocolVersion: PROTOCOL_VERSION, session, busy: false });
let failedOpen = failedHistory.sent("open").slice(-1)[0] as { intentId: string };
failedHistory.deliver({ kind: "history", intentId: failedOpen.intentId, session, attached: true, messages: [] });
failedHistory.socket.close(); failedHistory.reconnect({ kind: "connection", protocolVersion: PROTOCOL_VERSION, busy: false });
failedOpen = failedHistory.sent("open").slice(-1)[0] as { intentId: string };
failedHistory.deliver({ kind: "error", intentId: "stale-history", message: "stale" });
failedHistory.get("input").value = "retry"; failedHistory.get("send").onclick?.(); assert.equal(failedHistory.get("input").value, "retry");
failedHistory.deliver({ kind: "error", intentId: failedOpen.intentId, message: "native history failed" }); failedHistory.get("send").onclick?.();
assert.deepEqual((failedHistory.sent("start").slice(-1)[0] as { resume?: unknown }).resume, { provider: "claude", sessionId: session.sessionId });
const attachedFailure = new Harness(); attachedFailure.connect({ kind: "connection", protocolVersion: PROTOCOL_VERSION, session, busy: false });
const attachedOpen = attachedFailure.sent("open").slice(-1)[0] as { intentId: string };
attachedFailure.deliver({ kind: "error", intentId: attachedOpen.intentId, message: "failed while attached" });
attachedFailure.get("input").value = "live"; attachedFailure.get("send").onclick?.();
assert.deepEqual([attachedFailure.sent("user").length, attachedFailure.sent("start").length], [1, 0]);

// Retry adopts a newer identity snapshot boundary; completed native identity also rejects delayed SDK overlap.
const history = new Harness();
const connection: Extract<DownMsg, { kind: "connection" }> = { kind: "connection", protocolVersion: PROTOCOL_VERSION, session, busy: true,
  activeText: [{ session, itemId: "partial", text: "A" }, { session, itemId: "done", text: "Complete" }] };
history.connect(connection); const firstOpen = history.sent("open").slice(-1)[0]! as { intentId: string };
history.deliver({ kind: "event", event: { type: "text_delta", session, itemId: "partial", text: "B" } });
history.socket.close(); history.reconnect({ ...connection, activeText: [{ session, itemId: "partial", text: "AB" }, { session, itemId: "done", text: "Complete" }] });
const retryOpen = history.sent("open").slice(-1)[0]! as { intentId: string };
assert.equal(retryOpen.intentId, firstOpen.intentId);
history.deliver({ kind: "event", event: { type: "text_delta", session, itemId: "done", text: "Complete" } });
history.deliver({ kind: "tool", id: "ask", tool: "ask_user", args: { question: "Continue?", options: ["Yes"] } });
history.deliver({ kind: "permission", id: "permission", tool: "annotate", input: {} });
history.get("input").value = "wait"; history.get("send").onclick?.(); assert.equal(history.get("input").value, "wait");
history.deliver({ kind: "history", intentId: firstOpen.intentId, session, attached: true, messages: [{ role: "assistant", text: "Complete", itemId: "done" }] });
let rendered = text(history.get("chat"));
assert.match(rendered, /AB/); assert.equal(count(rendered, "Complete"), 1); assert.match(rendered, /Continue/); assert.match(rendered, /annotate/);
assert.equal(history.footer.hidden, true);
const order = history.get("chat").children.map(child => child.className);
assert.ok(order.findIndex(cls => cls === "msg assistant") < order.findIndex(cls => cls.includes("actionable")));
assert.ok(order.findIndex(cls => cls.includes("actionable")) < order.findIndex(cls => cls === "typing"));
history.deliver({ kind: "event", event: { type: "text_delta", session, itemId: "partial", text: "C" } });
history.deliver({ kind: "event", event: { type: "text_delta", session, itemId: "done", text: "Complete" } });
rendered = text(history.get("chat")); assert.match(rendered, /ABC/); assert.equal(count(rendered, "Complete"), 1);
const yes = history.button(history.get("chat"), "Yes"), allow = history.button(history.get("chat"), "Allow");
yes.onclick?.(); yes.onclick?.(); allow.onclick?.(); allow.onclick?.();
assert.equal(history.sent("reply").length, 2); assert.equal(history.footer.hidden, false);
history.get("btn-new").onclick?.();
history.deliver({ kind: "history", intentId: firstOpen.intentId, session, attached: true, messages: [{ role: "assistant", text: "stale" }] });
assert.doesNotMatch(text(history.get("chat")), /stale/);

// Colliding item IDs from another native session/provider cannot retire or replace target History state.
for (const foreign of [
  { ...session, sessionId: "33333333-3333-4333-8333-333333333333" },
  { ...session, provider: "codex" as const },
]) {
  const owned = new Harness(); owned.connect({ ...connection, activeText: [{ session, itemId: "collision", text: "A" }] });
  const intentId = (owned.sent("open").slice(-1)[0] as { intentId: string }).intentId;
  owned.deliver({ kind: "event", event: { type: "text_delta", session, itemId: "collision", text: "B" } });
  owned.socket.close(); owned.reconnect({ ...connection, session: foreign, activeText: [{ session: foreign, itemId: "collision", text: "X" }] });
  owned.deliver({ kind: "history", intentId, session, attached: true, messages: [] });
  assert.match(text(owned.get("chat")), /AB/); assert.doesNotMatch(text(owned.get("chat")), /X/);
}

// Cancellation before History completion prevents card resurrection and duplicate replies.
const cancel = new Harness(); cancel.connect(connection);
const cancelOpen = cancel.sent("open").slice(-1)[0]! as { intentId: string };
cancel.deliver({ kind: "tool", id: "cancelled", tool: "ask_user", args: { question: "Gone?", options: ["Yes"] } });
const staleYes = cancel.button(cancel.get("chat"), "Yes");
assert.equal(cancel.footer.hidden, true);
cancel.deliver({ kind: "cancel_request", id: "cancelled", reason: "Provider cancelled" });
assert.equal(cancel.footer.hidden, false);
cancel.deliver({ kind: "history", intentId: cancelOpen.intentId, session, attached: true, messages: [] }); staleYes.onclick?.();
assert.equal(cancel.sent("reply").length, 0); assert.equal(cancel.get("chat").querySelectorAll(".actionable").length, 0);

// Pure wire/display/view boundaries remain explicit where DOM integration would not add evidence.
assert.equal(PROTOCOL_VERSION, 3);
assert.equal(decodeBridgeMessage({ kind: "health", health: { bridge: "legacy" } }), undefined);
for (const protocolVersion of [undefined, 1, 2, 4]) assert.equal(decodeBridgeMessage({ kind: "connection", protocolVersion, busy: false }), undefined);
assert.deepEqual(decodeBridgeMessage({ kind: "connection", protocolVersion: 3, busy: false }), { kind: "connection", protocolVersion: 3, busy: false });
assert.equal(decodeBridgeMessage({ kind: "connection", protocolVersion: 3, busy: false, activeText: [{ itemId: 1 }] }), undefined);
assert.ok(decodeBridgeMessage({ kind: "connection", protocolVersion: 3, intentId: "pending", busy: true }));
const validEvents: ReviewEvent[] = [
  { type: "text_start", session, itemId: "start" }, { type: "text_end", session, itemId: "end" },
  { type: "text_delta", session, itemId: "delta", text: "x" }, { type: "status", session, itemId: "status", text: "working" },
  { type: "tool", session, itemId: "tool", name: "focus", input: {} }, { type: "error", session, itemId: "error", message: "failed" },
  { type: "turn_end", session, itemId: "turn", outcome: "completed" },
];
for (const event of validEvents) assert.ok(decodeBridgeMessage({ kind: "event", event }));
assert.ok(decodeBridgeMessage({ kind: "history", intentId: "history", session, attached: false, messages: [
  { role: "user", text: "question" }, { role: "answer", text: "answer" }, { role: "assistant", text: "reply", itemId: "a" },
  { role: "tool", name: "focus", input: {}, itemId: "t" },
] }));
for (const malformed of [
  { kind: "connection", protocolVersion: 3, busy: false, session: { provider: "claude", sessionId: "ref-only" } },
  { kind: "sessions", sessions: [{ provider: "claude", sessionId: "ref-only" }] },
  { kind: "history", intentId: "h", session, attached: false, messages: [{ role: "tool", name: "focus", input: [] }] },
  { kind: "event", event: { type: "text_delta", session, itemId: "x" } },
  { kind: "event", event: { type: "turn_end", session, itemId: "x", outcome: "unknown" } },
  { kind: "health", health: { ...health(), providers: [{ provider: "claude", status: "ready", models: [{ value: "x" }] }] } },
  { kind: "health", health: { ...health(), servers: [{ name: "mcp", status: 500 }] } },
  { kind: "health", health: { ...health(), settingsResult: { requestId: "x", accepted: "yes" } } },
]) assert.equal(decodeBridgeMessage(malformed), undefined);
const delta: ReviewEvent = { type: "text_delta", session, itemId: "item", text: "text" };
assert.equal(eventBelongsToSession({ event: delta, session }), true);
assert.equal(eventBelongsToSession({ event: { ...delta, session: { provider: "codex", sessionId: session.sessionId } }, session }), false);
assert.equal(eventBelongsToSession({ event: { ...delta, session: { provider: "claude", sessionId: "wrong" } }, session }), false);
assert.equal(sessionCostLabel({ session: { ...session, costUsd: 0.123, costStatus: "estimated" }, precision: 2 }), "~$0.12");
assert.equal(sessionCostLabel({ session: { ...session, costStatus: "unavailable" }, precision: 2 }), "Cost unavailable");
assert.deepEqual(providerSettingOptions({ health: undefined, settings: { model: "", effort: "" } }),
  { models: [{ value: "", label: "Default" }], efforts: [{ value: "", label: "Default" }] });
assert.deepEqual(providerSettingOptions({ health: health().providers[0], settings: { model: "legacy", effort: "custom" } }), {
  models: [{ value: "haiku", label: "Haiku" }, { value: "sonnet", label: "Sonnet" }, { value: "legacy", label: "legacy" }],
  efforts: [{ value: "low", label: "low" }, { value: "medium", label: "medium" }, { value: "custom", label: "custom" }],
});
const stale = new ConversationView(); stale.begin({ intentId: "old", retainSession: false }); stale.begin({ intentId: "current", retainSession: false });
assert.equal(stale.confirm({ intentId: "old", session }), undefined);
assert.ok(stale.confirm({ intentId: "current", session }));
assert.equal(stale.update({ ...session, sessionId: "wrong" }), false);
assert.equal(stale.update({ ...session, provider: "codex" }), false);
const abandonedHistory = new ConversationView(); abandonedHistory.beginHistory({ intentId: "abandoned", session, attached: true, inputs: [{ text: "owned", selection: [] }] });
assert.equal(abandonedHistory.leave({ reason: "New or another History row" }).length, 1);
let cancellations = 0; stale.addCard({ id: "card", cancel: () => cancellations++ });
stale.disconnect({ reason: "offline" }); stale.disconnect({ reason: "offline again" }); assert.equal(cancellations, 1);
console.log("bundled ui lifecycle check ok");
