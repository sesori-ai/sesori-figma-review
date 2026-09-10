// UI iframe: the only user-facing surface. WebSocket client to the bridge, chat renderer, and relay
// between the bridge and the sandbox (tool calls go down to code.ts, replies come back up).
import { marked } from "marked";
import { BRIDGE_PORT, PROTOCOL_VERSION, type Anchor, type DownMsg, type Health, type NodeRef, type PermissionDecision, type ReviewEvent, type SessionRecord, type SessionRef, type Settings, type UpMsg } from "../../shared/protocol.ts";
import { eventBelongsToSession, providerSettingOptions, sessionCostLabel } from "./ui-events.ts";
import { ConversationView } from "./view-control.ts";
import { decodeBridgeMessage } from "./wire.ts";

declare const __VERSION__: string; // injected by build.mjs from package.json
const md = (s: string) => marked.parse(s.replace(/</g, "&lt;"), { async: false }) as string; // raw HTML from the model is shown as text

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const chat = $("chat"), input = $<HTMLTextAreaElement>("input"), statusEl = $("status"), dot = $("dot"), costEl = $("cost"), sessionsEl = $("sessions"), settingsEl = $("settings"), selEl = $("sel").lastElementChild as HTMLElement, stopBtn = $("btn-stop"), footer = document.querySelector("footer")!, empty = $("empty");
const modelSel = $<HTMLSelectElement>("model"), effortSel = $<HTMLSelectElement>("effort");

let ctx = { fileId: "", fileName: "", pageId: "", pageName: "", selection: [] as NodeRef[] };
let ws: WebSocket | undefined;
let sessions: SessionRecord[] = [];
let pendingAsk: { id: string; answer: (text: string) => void; cancel: (reason?: string) => void } | undefined;
let opened: SessionRecord | undefined; // session shown via History → Open but not yet resumed
let health: Health | undefined;
let protocolReady = false;
let intentCounter = 0;
const view = new ConversationView();
const items = new Map<string, { element: HTMLElement; markdown: string }>();

const el = (tag: string, cls = "", text = "") => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
const icon = (id: string) => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.innerHTML = `<use href="#i-${id}"/>`; return s; };
const btn = (label: string, onClick: () => void, cls = "") => { const b = el("button", cls, label) as HTMLButtonElement; b.onclick = onClick; return b; };
// Offline card. Browser Figma cannot reach localhost; Electron token is the iframe's available desktop signal.
const INSTALL = "npm install -g @sesori/figma-review", START = "sesori-figma-review";
const offline = el("div", "card offline");
offline.innerHTML = /Electron/.test(navigator.userAgent)
  ? `<div class="q">The bridge is not running</div>` + [["Install once", INSTALL], ["Start it and keep the terminal open", START]].map(([label, command]) => `<div>${label}</div><div class="cmd"><code>${command}</code><button class="ghost" data-cmd="${command}">Copy</button></div>`).join("")
    + `<div class="hint">Needs Node 22+ and Claude Code signed in (run <code>claude</code> once) or <code>ANTHROPIC_API_KEY</code>.</div>`
  : `<div class="q">Sesori Review needs the Figma desktop app</div><div>The browser version of Figma cannot reach the bridge running on your machine.</div>`;
offline.querySelectorAll("button").forEach(button => button.onclick = () => { const textarea = document.createElement("textarea"); textarea.value = button.dataset.cmd!; document.body.append(textarea); textarea.select(); document.execCommand("copy"); textarea.remove(); });
const drift = el("div", "error");
const working = el("div", "typing"); working.append(el("i"), el("i"), el("i")); // re-appended on every busy=true, so clearing the chat is safe
const bubble = (cls: string, text = "") => { empty.remove(); const b = el("div", cls, text); chat.insertBefore(b, working.parentNode === chat ? working : null); chat.scrollTop = chat.scrollHeight; return b; };
const assistant = (html: string) => { const b = bubble("msg assistant"); const body = el("div", "body"); body.innerHTML = html; b.append(body); return body; };
const selText = () => ctx.selection.length ? ctx.selection.map(n => `${n.name} (${n.type} ${n.id})`).join(", ") : "none";
const clearChat = () => { items.clear(); chat.innerHTML = ""; pendingAsk = undefined; opened = undefined; };
const notifyCancelled = (count: number) => {
  if (count) toMain({ kind: "notify", text: `${count} queued message${count === 1 ? " was" : "s were"} cancelled.` });
};
const leaveView = (reason: string) => {
  notifyCancelled(view.leave({ reason }).length);
  send({ kind: "close", reason });
  pendingAsk = undefined; footer.hidden = false; items.clear();
};

/** Tool call → one readable chip. Node ids stay as-is (monospace); names are only known to the sandbox. */
function chip(name: string, input: Record<string, unknown>) {
  const short = name.replace(/^mcp__figma__/, ""), id = typeof input?.nodeId === "string" ? input.nodeId : "";
  const [ic, label] = ({
    get_flow: ["flow", "Read the prototype flow"], get_screen: ["eye", "Looked at"], focus: ["focus", "Focused"],
    annotate: ["note", input?.replace ? "Replaced annotations on" : "Annotated"], ask_user: ["ask", "Asked a question"],
  } as Record<string, [string, string]>)[short] ?? ["tool", name.startsWith("mcp__") ? name.replace(/^mcp__/, "").replace("__", ": ") : name];
  const c = bubble("chip"); c.append(icon(ic), label);
  if (id) c.append(el("code", "", id));
  else if (!(short in { get_flow: 1, ask_user: 1 })) c.append(el("code", "", Object.entries(input ?? {}).filter(([k]) => k !== "markdown").map(([, v]) => JSON.stringify(v)).join(" ").slice(0, 80)));
  return c;
}

// ---- sandbox (code.ts) ---------------------------------------------------
const toMain = (m: unknown) => parent.postMessage({ pluginMessage: m }, "*");
window.onmessage = (e: MessageEvent) => {
  const m = e.data?.pluginMessage;
  if (!m) return;
  if (m.kind === "context") { const first = !ctx.fileId; ctx = m; selEl.textContent = ctx.selection.length ? selText() : "No selection"; selEl.title = selText(); if (first) connect(); }
  if (m.kind === "reply") send({ kind: "reply", id: m.id, result: m.result });
};

// ---- bridge ---------------------------------------------------------------
function connect() {
  ws = new WebSocket(`ws://localhost:${BRIDGE_PORT}`);
  ws.onopen = () => {
    protocolReady = false;
    offline.remove(); setStatus("checking bridge protocol…", "warn");
    send({ kind: "hello", protocolVersion: PROTOCOL_VERSION, fileId: ctx.fileId, fileName: ctx.fileName });
  };
  ws.onclose = () => {
    protocolReady = false;
    view.disconnect({ reason: "Bridge disconnected" });
    pendingAsk = undefined; footer.hidden = false; renderBusy(false);
    chat.prepend(offline); setStatus("bridge offline", "bad"); setTimeout(connect, 2000);
  };
  ws.onerror = () => {};
  ws.onmessage = e => {
    let raw: unknown;
    try { raw = JSON.parse(e.data); } catch { return protocolMismatch(); }
    const message = decodeBridgeMessage(raw);
    if (!message || (!protocolReady && message.kind !== "connection")) return protocolMismatch();
    onDown(message);
  };
}
const send = (m: UpMsg) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
function setStatus(text: string, level: "ok" | "warn" | "bad") { statusEl.textContent = text; dot.className = `dot ${level}`; }
function protocolMismatch() {
  drift.textContent = `Plugin protocol ${PROTOCOL_VERSION} cannot use this bridge. Update with ${INSTALL}@latest, restart the bridge, then refresh the plugin in Figma.`;
  if (!drift.isConnected) chat.prepend(drift);
  setStatus("plugin/bridge protocol mismatch", "bad");
  ws?.close();
}
function renderBusy(busy: boolean) {
  stopBtn.hidden = !busy; $("btn-flow").hidden = busy;
  if (busy) { empty.remove(); chat.append(working); chat.scrollTop = chat.scrollHeight; } else working.remove();
}

function onDown(m: DownMsg) {
  switch (m.kind) {
    case "connection": {
      protocolReady = true;
      drift.remove();
      const previous = view.session;
      const reconciled = view.reconcile({ intentId: m.intentId, session: m.session });
      notifyCancelled(reconciled.cancelled.length);
      if (m.session?.sessionId) renderCost(m.session);
      for (const queued of reconciled.queued) send({ kind: "user", ...queued });
      renderBusy(m.busy);
      setStatus("connected to bridge", "warn");
      if (!m.session && !m.intentId && previous?.sessionId) {
        const intentId = `history-${Date.now().toString(36)}-${++intentCounter}`;
        const session = { provider: previous.provider, sessionId: previous.sessionId };
        view.beginHistory({ intentId, session });
        send({ kind: "open", intentId, fileId: ctx.fileId, fileName: ctx.fileName, session });
      }
      return;
    }
    case "health": return renderHealth(m.health);
    case "sessions": sessions = m.sessions; if (!sessionsEl.hidden) renderSessions(); return;
    case "started": {
      const queued = view.confirm({ intentId: m.intentId, session: m.session });
      if (!queued) return;
      renderCost(m.session);
      for (const input of queued) send({ kind: "user", ...input });
      return;
    }
    case "session": if (view.update(m.session)) renderCost(m.session); return;
    case "history": return showHistory(m);
    case "tool": return m.tool === "ask_user" ? askCard(m.id, m.args) : toMain(m);
    case "permission": return permissionCard(m.id, m.tool, m.input);
    case "cancel_request": view.cancelCard({ id: m.id, reason: m.reason }); return;
    case "event": return onEvent(m.event);
    case "busy": renderBusy(m.busy); return;
    case "error": if (view.starting) notifyCancelled(view.leave({ reason: "Start failed" }).length); bubble("error", m.message); return;
  }
}

function renderHealth(h: Health) {
  health = h;
  const providerId = view.session?.provider ?? h.selectedProvider;
  const provider = h.providers.find(item => item.provider === providerId);
  const mcp = h.figmaMcp === "up" ? "Figma MCP up" : "Figma MCP off";
  const failed = (h.servers ?? []).filter(s => s.status !== "connected").map(s => `${s.name}: ${s.status}${s.error ? ` (${s.error})` : ""}`);
  const providerName = providerId === "claude" ? "Claude" : "Codex";
  const error = h.error ?? provider?.error;
  setStatus(error ?? `${providerName} ${provider?.version ?? provider?.status ?? "starting…"}${provider?.model ? ` · ${provider.model.replace(/^claude-/, "")}` : ""} · ${mcp}`, error ? "bad" : h.figmaMcp === "up" && !failed.length ? "ok" : "warn");
  statusEl.title = [h.figmaMcp === "up" ? "" : "Figma desktop MCP server is off: Dev Mode → inspect panel → Enable desktop MCP server. The review still works without it.", ...failed].filter(Boolean).join("\n");
  const settings = h.settings.providers[providerId];
  const choices = providerSettingOptions({ health: provider, settings });
  modelSel.replaceChildren(...choices.models.map(model => new Option(model.label, model.value)));
  effortSel.replaceChildren(...choices.efforts.map(effort => new Option(effort.label, effort.value)));
  modelSel.value = settings.model; effortSel.value = settings.effort;
  $("about").textContent = `Sesori Review ${__VERSION__} · bridge ${h.bridge}${provider?.version ? ` · ${providerName} ${provider.version}` : ""}`;
  if (h.bridge !== __VERSION__ && !drift.isConnected) {
    drift.textContent = `Plugin ${__VERSION__} and bridge ${h.bridge} differ. Update bridge with ${INSTALL}@latest and refresh plugin from Figma.`;
    chat.prepend(drift);
  }
}
function renderCost(s: SessionRecord) {
  const k = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  const u = s.usage;
  costEl.textContent = `${sessionCostLabel({ session: s, precision: 3 })} · ${k(u.input + u.cacheRead + u.cacheWrite)} in / ${k(u.output)} out · ${s.turns} turn${s.turns === 1 ? "" : "s"}`;
  costEl.title = `provider ${s.provider}\ncost ${s.costStatus}\ninput ${u.input}\ncache read ${u.cacheRead}\ncache write ${u.cacheWrite}\noutput ${u.output}\nsession ${s.sessionId}`;
}

// ---- provider-neutral activity -------------------------------------------
function onEvent(event: ReviewEvent) {
  if (!eventBelongsToSession({ event, session: view.session })) return;
  if (event.type === "text_start") {
    const element = assistant(""); items.set(event.itemId, { element, markdown: "" });
  } else if (event.type === "text_delta") {
    const item = items.get(event.itemId);
    if (item) { item.markdown += event.text; item.element.innerHTML = md(item.markdown); chat.scrollTop = chat.scrollHeight; }
  } else if (event.type === "tool") {
    if (!items.has(event.itemId)) { const element = chip(event.name, event.input); items.set(event.itemId, { element, markdown: "" }); }
  } else if (event.type === "status") {
    if (!items.has(event.itemId)) { const element = bubble("chip", event.text); items.set(event.itemId, { element, markdown: "" }); }
  } else if (event.type === "error") {
    if (!items.has(event.itemId)) { const element = bubble("error", event.message); items.set(event.itemId, { element, markdown: "" }); }
  } else if (event.type === "turn_end") {
    if (event.outcome === "interrupted") bubble("chip stopped", "Stopped");
    if (event.outcome === "failed") bubble("error", event.message ?? "Turn failed");
  }
}

// ---- cards ---------------------------------------------------------------
/** Claude's question. The composer is hidden until it is answered, so there is exactly one place to reply. */
function askCard(id: string, args: Record<string, unknown>) {
  if (typeof args.nodeId === "string") toMain({ kind: "focus", nodeId: args.nodeId });
  pendingAsk?.cancel();
  const card = bubble("card");
  card.append(el("div", "q", typeof args.question === "string" ? args.question : "Question"));
  const ctl = el("div", "ctl");
  const close = (label: string) => { ctl.remove(); const a = el("div", "a"); a.append(icon("check"), label); card.append(a); view.finishCard(id); if (pendingAsk?.id === id) pendingAsk = undefined; footer.hidden = false; };
  const answer = (text: string) => { close(text); send({ kind: "reply", id, result: { content: [{ type: "text", text: `${text}\n\n[Current selection: ${selText()}]` }] } }); };
  const cancel = (reason = "No longer actionable") => close(`(${reason})`);
  pendingAsk = { id, answer, cancel }; view.addCard({ id, cancel });
  const options = Array.isArray(args.options) ? args.options.filter((option): option is string => typeof option === "string") : [];
  for (const option of options) ctl.append(btn(option, () => answer(option)));
  const ta = document.createElement("textarea"); ta.rows = 2; ta.placeholder = "Or type an answer… Enter to send";
  ta.onkeydown = e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (ta.value.trim()) answer(ta.value.trim()); } };
  ctl.append(ta); card.append(ctl);
  footer.hidden = true; ta.focus();
}

function permissionCard(id: string, tool: string, input: Record<string, unknown>) {
  if (typeof input.nodeId === "string") toMain({ kind: "focus", nodeId: input.nodeId });
  const card = bubble("card perm");
  card.append(el("div", "q", `Allow ${tool.replace(/^mcp__/, "").replace("__", ": ")}?`));
  const preview = typeof input.markdown === "string" ? input.markdown : JSON.stringify(input, null, 1);
  card.append(el("pre", "", preview.slice(0, 2000)));
  const ctl = el("div", "ctl");
  const done = (result: PermissionDecision | undefined, label: string) => {
    ctl.remove(); card.append(el("div", "a", label)); view.finishCard(id);
    if (result) send({ kind: "reply", id, result });
  };
  view.addCard({ id, cancel: reason => done(undefined, `Cancelled: ${reason}`) });
  ctl.append(btn("Allow", () => done({ behavior: "allow" }, "Allowed"), "primary"), btn("Deny", () => done({ behavior: "deny", message: "The user denied this in the plugin." }, "Denied")));
  card.append(ctl);
}

function renderSessions() {
  sessionsEl.innerHTML = "";
  sessionsEl.append(el("h4", "", "History"));
  if (!sessions.length) sessionsEl.append(el("div", "hint", "No sessions yet for this file."));
  for (const s of [...sessions].reverse()) {
    const row = el("div", "row"), title = el("div", "title");
    const provider = s.provider === "claude" ? "Claude" : "Codex";
    const cost = sessionCostLabel({ session: s, precision: 2 });
    title.append(el("b", "", s.title), el("span", "", `${provider} · ${s.pageName} · ${s.updatedAt.slice(0, 16).replace("T", " ")} · ${cost} · ${s.turns} turn${s.turns === 1 ? "" : "s"}`));
    row.append(title, btn("Open", () => {
      leaveView("Opened a History session");
      const intentId = `history-${Date.now().toString(36)}-${++intentCounter}`;
      const session = { provider: s.provider, sessionId: s.sessionId };
      view.beginHistory({ intentId, session });
      sessionsEl.hidden = true;
      send({ kind: "open", intentId, fileId: ctx.fileId, fileName: ctx.fileName, session });
    }));
    sessionsEl.append(row);
  }
}

// ---- settings --------------------------------------------------------------
const pushSettings = () => {
  if (!health) return;
  const provider = view.session?.provider ?? health.selectedProvider;
  const settings: Settings = {
    ...health.settings,
    providers: { ...health.settings.providers, [provider]: { model: modelSel.value, effort: effortSel.value } },
  };
  health.settings = settings;
  send({ kind: "settings", settings });
};
modelSel.onchange = effortSel.onchange = pushSettings;
$("btn-settings").onclick = () => { settingsEl.hidden = !settingsEl.hidden; sessionsEl.hidden = true; };

// ---- composer -------------------------------------------------------------
function start(anchor: Anchor, text: string, resume?: SessionRef) {
  if (view.starting) return;
  const intentId = `${Date.now().toString(36)}-${++intentCounter}`;
  view.begin({ intentId, retainSession: !!resume });
  if (!resume) clearChat();
  opened = undefined; settingsEl.hidden = sessionsEl.hidden = true;
  bubble("msg user", text);
  send({ kind: "start", intentId, fileId: ctx.fileId, fileName: ctx.fileName, pageId: ctx.pageId, pageName: ctx.pageName, anchor, resume, text, selection: ctx.selection });
}
/** History → Open: show the past conversation; the session itself is resumed by the next message. */
function showHistory(m: Extract<DownMsg, { kind: "history" }>) {
  if (!view.confirmHistory({ intentId: m.intentId, session: m.session })) return;
  clearChat();
  renderCost(m.session);
  opened = m.attached ? undefined : m.session;
  for (const h of m.messages) {
    if (h.role === "tool") h.name === "stopped" ? bubble("chip stopped", "Stopped") : chip(h.name, h.input);
    else if (h.role === "assistant") assistant(md(h.text));
    else bubble("msg user", h.text); // user message or ask_user answer
  }
  chat.scrollTop = chat.scrollHeight;
}
function submit() {
  const text = input.value.trim();
  if (!text) return;
  input.value = ""; autosize();
  if (view.starting) { bubble("msg user", text); view.queue({ text, selection: [...ctx.selection] }); return; }
  if (!view.session) return start({ type: "page", nodeIds: [] }, text);
  if (opened) return start(opened.anchor, text, { provider: opened.provider, sessionId: opened.sessionId });
  bubble("msg user", text);
  send({ kind: "user", text, selection: ctx.selection }); // delivered mid-turn as steering; Stop interrupts
}
const autosize = () => { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 120)}px`; };
input.oninput = autosize;

$("send").onclick = submit;
input.onkeydown = e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } };
$("btn-flow").onclick = () => start({ type: "flow", nodeIds: [] }, `Review the prototype flow on page "${ctx.pageName}" using the review-flow skill: the flow as a whole first, then screen by screen.`);
$("btn-selection").onclick = () => {
  if (!ctx.selection.length) return toMain({ kind: "notify", text: "Select something first" });
  start({ type: "selection", nodeIds: ctx.selection.map(n => n.id) }, `Review the selected node(s): ${selText()}. Focus each one, assess clarity and dev-readiness, and propose annotations.`);
};
$("btn-new").onclick = () => { leaveView("Started a new view"); clearChat(); chat.append(empty); costEl.textContent = ""; settingsEl.hidden = sessionsEl.hidden = true; input.focus(); };
$("btn-history").onclick = () => {
  sessionsEl.hidden = !sessionsEl.hidden; settingsEl.hidden = true;
  if (!sessionsEl.hidden) renderSessions();
};
stopBtn.onclick = () => send({ kind: "interrupt" });
