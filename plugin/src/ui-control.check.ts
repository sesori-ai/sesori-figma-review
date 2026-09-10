import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { buildSync } from "esbuild";
import { PROTOCOL_VERSION, type DownMsg, type Health, type SessionRecord } from "../../shared/protocol.ts";

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
const text = (node: ElementStub): string => `${node.textContent}${node.inner}${node.children.map(text).join("")}`;
const count = (value: string, part: string) => value.split(part).length - 1;

class Harness {
  elements = new Map<string, ElementStub>();
  sockets: SocketStub[] = [];
  timers: (() => void)[] = [];
  posted: unknown[] = [];
  constructor() {
    const ids = ["btn-settings", "dot", "status", "cost", "btn-flow", "btn-stop", "btn-selection", "btn-new", "btn-history",
      "settings", "model", "effort", "about", "sessions", "chat", "empty", "sel", "input", "send"];
    for (const id of ids) this.elements.set(id, new ElementStub(id.startsWith("btn-") || id === "send" ? "button" : id === "input" ? "textarea" : id === "model" || id === "effort" ? "select" : "div", id));
    this.get("chat").append(this.get("empty")); this.get("sel").append(new ElementStub("svg"), new ElementStub("span"));
    const footer = new ElementStub("footer"), body = new ElementStub("body");
    const owner = this;
    class Socket extends SocketStub { constructor(url: string) { super(url); owner.sockets.push(this); } }
    const document = { getElementById: (id: string) => this.elements.get(id), createElement: (tag: string) => new ElementStub(tag),
      createElementNS: (_ns: string, tag: string) => new ElementStub(tag), querySelector: (query: string) => query === "footer" ? footer : undefined,
      body, execCommand: () => true };
    const window: { onmessage?: (event: { data: unknown }) => void } = {};
    vm.runInNewContext(bundle, { document, window, parent: { postMessage: (message: unknown) => this.posted.push(message) }, navigator: { userAgent: "Electron" },
      WebSocket: Socket, Option: class extends ElementStub { constructor(label: string, value: string) { super("option"); this.textContent = label; this.value = value; } },
      setTimeout: (callback: () => void) => { this.timers.push(callback); return this.timers.length; }, clearTimeout: () => {}, console });
    window.onmessage?.({ data: { pluginMessage: { kind: "context", fileId: "file", fileName: "File", page: "Page", selection: [], annotations: {} } } });
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
admission.deliver({ kind: "sessions", sessions: [session] }); admission.socket.close();
const beforeNew = text(admission.get("chat")); admission.get("btn-new").onclick?.();
assert.equal(text(admission.get("chat")), beforeNew); assert.equal(admission.sent("close").length, 0);
admission.get("btn-history").onclick?.(); const opens = admission.sent("open").length;
admission.button(admission.get("sessions"), "Open").onclick?.(); assert.equal(admission.sent("open").length, opens);

// Interrupted settings remain explicitly unconfirmed, then authoritative reconnect health decides either outcome without resend.
const settings = new Harness();
assert.equal(settings.get("model").disabled, true); settings.connect();
settings.get("model").value = "sonnet"; settings.get("model").onchange?.();
assert.equal(settings.sent("settings").length, 1); settings.socket.close();
assert.match(text(settings.get("chat")), /not confirmed/);
settings.reconnect({ kind: "connection", protocolVersion: PROTOCOL_VERSION, busy: false });
settings.deliver({ kind: "health", health: health("sonnet", "low") });
assert.equal(settings.get("model").value, "sonnet"); assert.doesNotMatch(text(settings.get("chat")), /not confirmed/); assert.equal(settings.sent("settings").length, 1);
settings.get("model").value = "haiku"; settings.get("model").onchange?.(); settings.socket.close();
settings.reconnect({ kind: "connection", protocolVersion: PROTOCOL_VERSION, busy: false });
settings.deliver({ kind: "health", health: health("sonnet", "low") });
assert.equal(settings.get("model").value, "sonnet");

// Lost History reply retries same intent. Snapshot identity restores a mid-item prefix; native overlap is not duplicated.
const history = new Harness();
const connection: Extract<DownMsg, { kind: "connection" }> = { kind: "connection", protocolVersion: PROTOCOL_VERSION, session, busy: true,
  activeText: [{ session, itemId: "live", text: "Hello " }, { session, itemId: "done", text: "Complete" }] };
history.connect(connection); const firstOpen = history.sent("open").slice(-1)[0]! as { intentId: string };
history.socket.close(); history.reconnect(connection); const retryOpen = history.sent("open").slice(-1)[0]! as { intentId: string };
assert.equal(retryOpen.intentId, firstOpen.intentId);
history.deliver({ kind: "event", event: { type: "text_start", session, itemId: "live" } });
history.deliver({ kind: "event", event: { type: "text_delta", session, itemId: "live", text: "world" } });
history.deliver({ kind: "event", event: { type: "text_delta", session, itemId: "done", text: "Complete" } });
history.deliver({ kind: "tool", id: "ask", tool: "ask_user", args: { question: "Continue?", options: ["Yes"] } });
history.deliver({ kind: "permission", id: "permission", tool: "annotate", input: {} });
history.get("input").value = "wait"; history.get("send").onclick?.(); assert.equal(history.get("input").value, "wait");
history.deliver({ kind: "history", intentId: firstOpen.intentId, session, attached: true, messages: [{ role: "assistant", text: "Complete", itemId: "done" }] });
const rendered = text(history.get("chat"));
assert.match(rendered, /Hello .*world/); assert.equal(count(rendered, "Complete"), 1); assert.match(rendered, /Continue/); assert.match(rendered, /annotate/);
const yes = history.button(history.get("chat"), "Yes"), allow = history.button(history.get("chat"), "Allow");
yes.onclick?.(); yes.onclick?.(); allow.onclick?.(); allow.onclick?.();
assert.equal(history.sent("reply").length, 2);
history.get("btn-new").onclick?.();
history.deliver({ kind: "history", intentId: firstOpen.intentId, session, attached: true, messages: [{ role: "assistant", text: "stale" }] });
assert.doesNotMatch(text(history.get("chat")), /stale/);

// Cancellation before History completion prevents card resurrection and duplicate replies.
const cancel = new Harness(); cancel.connect(connection);
const cancelOpen = cancel.sent("open").slice(-1)[0]! as { intentId: string };
cancel.deliver({ kind: "tool", id: "cancelled", tool: "ask_user", args: { question: "Gone?", options: ["Yes"] } });
const staleYes = cancel.button(cancel.get("chat"), "Yes");
cancel.deliver({ kind: "cancel_request", id: "cancelled", reason: "Provider cancelled" });
cancel.deliver({ kind: "history", intentId: cancelOpen.intentId, session, attached: true, messages: [] }); staleYes.onclick?.();
assert.equal(cancel.sent("reply").length, 0); assert.equal(cancel.get("chat").querySelectorAll(".actionable").length, 0);

assert.ok(readFileSync(new URL("./ui.ts", import.meta.url), "utf8").includes("new ConversationView"));
console.log("bundled ui lifecycle check ok");
