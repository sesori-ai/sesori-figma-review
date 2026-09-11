// UI iframe: the only user-facing surface. WebSocket client to the bridge, chat renderer, and relay
// between the bridge and the sandbox (tool calls go down to code.ts, replies come back up).
import { marked } from "marked";
import { BRIDGE_PORT, PROTOCOL_VERSION, type Anchor, type DownMsg, type Health, type NodeRef, type PermissionDecision, type ReviewEvent, type SessionRecord, type SessionRef, type UpMsg } from "../../shared/protocol.ts";
import { eventBelongsToSession, providerSettingOptions, sessionCostLabel } from "./ui-events.ts";
import { ConnectionAdmission, SettingsControl } from "./ui-state.ts";
import { ConversationView } from "./view-control.ts";
import { decodeBridgeMessage } from "./wire.ts";

declare const __VERSION__: string; // injected by build.mjs from package.json
const md = (s: string) => marked.parse(s.replace(/</g, "&lt;"), { async: false }) as string; // raw HTML from the model is shown as text

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const chat = $("chat"), input = $<HTMLTextAreaElement>("input"), statusEl = $("status"), dot = $("dot"), costEl = $("cost"), sessionsEl = $("sessions"), settingsEl = $("settings"), selEl = $("sel").lastElementChild as HTMLElement, stopBtn = $("btn-stop"), footer = document.querySelector("footer")!, empty = $("empty");
const modelSel = $<HTMLSelectElement>("model"), effortSel = $<HTMLSelectElement>("effort");
modelSel.disabled = effortSel.disabled = true;

let ctx = { fileId: "", fileName: "", pageId: "", pageName: "", selection: [] as NodeRef[] };
let ws: WebSocket | undefined;
let sessions: SessionRecord[] = [];
let pendingAsk: { id: string; answer: (text: string) => void; cancel: (reason?: string) => void } | undefined;
let opened: SessionRecord | undefined;
let health: Health | undefined;
let settingsNotice: HTMLElement | undefined;
let busy = false;
let intentCounter = 0;
const admission = new ConnectionAdmission();
const settingsControl = new SettingsControl();
const view = new ConversationView();
const items = new Map<string, { element: HTMLElement; markdown: string; completed?: boolean }>();

const el = (tag: string, cls = "", text = "") => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
const icon = (id: string) => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.innerHTML = `<use href="#i-${id}"/>`; return s; };
const btn = (label: string, onClick: () => void, cls = "") => { const b = el("button", cls, label) as HTMLButtonElement; b.onclick = onClick; return b; };
// Offline card. The plugin can only see whether the bridge answers on localhost, not whether it is installed, so it
// shows both commands. The browser build of Figma cannot reach localhost at all; the desktop app is Electron, and
// its UA token is the only Electron signal visible from inside the plugin iframe.
const INSTALL = "npm install -g @sesori/figma-review", START = "sesori-figma-review";
const offline = el("div", "card offline");
offline.innerHTML = /Electron/.test(navigator.userAgent)
  ? `<div class="q">The bridge is not running</div>` + [["Install once", INSTALL], ["Start it and keep the terminal open", START]].map(([l, c]) => `<div>${l}</div><div class="cmd"><code>${c}</code><button class="ghost" data-cmd="${c}">Copy</button></div>`).join("")
    + `<div class="hint">Needs Node 22+ and Claude Code signed in (run <code>claude</code> once) or <code>ANTHROPIC_API_KEY</code>.</div>`
  : `<div class="q">Sesori Review needs the Figma desktop app</div><div>The browser version of Figma cannot reach the bridge running on your machine.</div>`;
offline.querySelectorAll("button").forEach(b => b.onclick = () => { const ta = document.createElement("textarea"); ta.value = b.dataset.cmd!; document.body.append(ta); ta.select(); document.execCommand("copy"); ta.remove(); }); // ponytail: clipboard API is blocked in the plugin iframe
const drift = el("div", "error"); // plugin/bridge version mismatch notice, shown once per page load
const working = el("div", "typing"); working.append(el("i"), el("i"), el("i")); // re-appended on every busy=true, so clearing the chat is safe
const bubble = (cls: string, text = "") => { empty.remove(); const b = el("div", cls, text); chat.insertBefore(b, working.parentNode === chat ? working : null); chat.scrollTop = chat.scrollHeight; return b; };
const assistant = (html: string) => { const b = bubble("msg assistant"); const body = el("div", "body"); body.innerHTML = html; b.append(body); return body; };
const selText = () => ctx.selection.length ? ctx.selection.map(n => `${n.name} (${n.type} ${n.id})`).join(", ") : "none";
const clearChat = (preserveCards = false) => {
  const cards = preserveCards ? Array.from(chat.querySelectorAll<HTMLElement>(".actionable")) : [];
  items.clear(); chat.innerHTML = "";
  if (!preserveCards) pendingAsk = undefined;
  opened = undefined; return cards;
};
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
    admission.opened();
    offline.remove(); setStatus("checking bridge protocol…", "warn");
    send({ kind: "hello", protocolVersion: PROTOCOL_VERSION, fileId: ctx.fileId, fileName: ctx.fileName });
  };
  ws.onclose = () => {
    admission.disconnected(); modelSel.disabled = effortSel.disabled = true;
    if (settingsControl.disconnected()) settingsNotice = bubble("error", "Settings change was sent but not confirmed. Reconnecting will show the saved setting.");
    view.disconnect({ reason: "Bridge disconnected" });
    pendingAsk = undefined; footer.hidden = false; renderBusy(false);
    chat.prepend(offline); setStatus("bridge offline", "bad"); setTimeout(connect, 2000);
  };
  ws.onerror = () => {};
  ws.onmessage = e => {
    let raw: unknown;
    try { raw = JSON.parse(e.data); } catch { return protocolMismatch(); }
    const message = decodeBridgeMessage(raw);
    if (!message || (!admission.ready && message.kind !== "connection")) return protocolMismatch();
    onDown(message);
  };
}
const send = (m: UpMsg) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
const admit = (message: string) => admission.admit({
  socketReady: ws?.readyState === WebSocket.OPEN,
  onBlocked: () => toMain({ kind: "notify", text: message }),
});
function setStatus(text: string, level: "ok" | "warn" | "bad") { statusEl.textContent = text; dot.className = `dot ${level}`; }
function protocolMismatch() {
  drift.textContent = `Plugin protocol ${PROTOCOL_VERSION} cannot use this bridge. Update with ${INSTALL}@latest, restart the bridge, then refresh the plugin in Figma.`;
  if (!drift.isConnected) chat.prepend(drift);
  setStatus("plugin/bridge protocol mismatch", "bad");
  ws?.close();
}
function renderBusy(value: boolean) {
  busy = value; stopBtn.hidden = !busy; $("btn-flow").hidden = busy;
  if (busy) { empty.remove(); chat.append(working); chat.scrollTop = chat.scrollHeight; } else working.remove();
}

function onDown(m: DownMsg) {
  switch (m.kind) {
    case "connection": {
      admission.acknowledge(); drift.remove();
      const previous = view.session;
      const reconciled = view.reconcile({ intentId: m.intentId, session: m.session, activeText: m.activeText });
      notifyCancelled(reconciled.cancelled.length);
      if (reconciled.cancelledStart) bubble("error", "The pending start was cancelled before the bridge accepted it. Send it again if needed.");
      if (m.session?.sessionId) renderCost(m.session);
      renderBusy(m.busy); setStatus("connected to bridge", "warn");
      const attachedChanged = m.session?.sessionId && (!previous || previous.provider !== m.session.provider || previous.sessionId !== m.session.sessionId);
      if (reconciled.historyRetry) send({ kind: "open", intentId: reconciled.historyRetry.intentId, fileId: ctx.fileId, fileName: ctx.fileName, session: reconciled.historyRetry.session });
      else if (reconciled.restoreHistory && m.session) requestHistory({ session: m.session, attached: true, retainSession: true, activeText: m.activeText, inputs: reconciled.queued });
      else {
        for (const queued of reconciled.queued) send({ kind: "user", ...queued });
        if (attachedChanged) requestHistory({ session: m.session!, attached: true, retainSession: true, activeText: m.activeText });
        else if (!m.session && !m.intentId && previous?.sessionId) requestHistory({ session: previous, attached: false, retainSession: true, activeText: m.activeText });
      }
      return;
    }
    case "health": return renderHealth(m.health);
    case "sessions": sessions = m.sessions; if (!sessionsEl.hidden) renderSessions(); return;
    case "started": {
      const confirmed = view.confirm({ intentId: m.intentId, session: m.session });
      if (!confirmed) return;
      renderCost(m.session);
      if (confirmed.adopted) requestHistory({ session: m.session, attached: true, retainSession: true, inputs: confirmed.inputs });
      else for (const queued of confirmed.inputs) send({ kind: "user", ...queued });
      return;
    }
    case "session": if (view.update(m.session)) renderCost(m.session); return;
    case "history": return showHistory(m);
    case "tool": return m.tool === "ask_user" ? askCard(m.id, m.args) : toMain(m);
    case "permission": return permissionCard(m.id, m.tool, m.input);
    case "cancel_request": view.cancelCard({ id: m.id, reason: m.reason }); return;
    case "event": return onEvent(m.event);
    case "busy": renderBusy(m.busy); return;
    case "error": {
      if (m.intentId) {
        const failedStart = view.failStart(m.intentId);
        if (failedStart) {
          notifyCancelled(failedStart.inputs.length); opened = failedStart.session;
          bubble("error", m.message); return;
        }
        const failed = view.failHistory(m.intentId);
        if (!failed) return;
        notifyCancelled(failed.inputs.length); opened = failed.attached ? undefined : failed.session; renderCost(failed.session);
      } else if (view.starting) notifyCancelled(view.leave({ reason: "Start failed" }).length);
      bubble("error", m.message); return;
    }
  }
}

function renderHealth(h: Health) {
  health = h; settingsNotice?.remove(); settingsNotice = undefined;
  const providerId = view.session?.provider ?? h.selectedProvider;
  const settingState = settingsControl.acceptHealth({ health: h, provider: providerId });
  if (settingState.error) bubble("error", `Settings update failed: ${settingState.error}`);
  const provider = h.providers.find(item => item.provider === providerId);
  const mcp = h.figmaMcp === "up" ? "Figma MCP up" : "Figma MCP off";
  const failed = (h.servers ?? []).filter(s => s.status !== "connected").map(s => `${s.name}: ${s.status}${s.error ? ` (${s.error})` : ""}`);
  const providerName = providerId === "claude" ? "Claude" : "Codex";
  const error = h.error ?? provider?.error;
  setStatus(error ?? `${providerName} ${provider?.version ?? provider?.status ?? "starting…"}${provider?.model ? ` · ${provider.model.replace(/^claude-/, "")}` : ""} · ${mcp}`, error ? "bad" : h.figmaMcp === "up" && !failed.length ? "ok" : "warn");
  statusEl.title = [h.figmaMcp === "up" ? "" : "Figma desktop MCP server is off: Dev Mode → inspect panel → Enable desktop MCP server. The review still works without it.", ...failed].filter(Boolean).join("\n");
  const settings = settingState.settings;
  const choices = providerSettingOptions({ health: provider, settings });
  modelSel.replaceChildren(...choices.models.map(model => new Option(model.label, model.value)));
  effortSel.replaceChildren(...choices.efforts.map(effort => new Option(effort.label, effort.value)));
  modelSel.value = settings.model; effortSel.value = settings.effort;
  modelSel.disabled = effortSel.disabled = !(admission.ready && ws?.readyState === WebSocket.OPEN);
  $("about").textContent = `Sesori Review ${__VERSION__} · bridge ${h.bridge}${provider?.version ? ` · ${providerName} ${provider.version}` : ""}`;
  if (h.bridge !== __VERSION__ && !drift.isConnected) { drift.textContent = `Plugin ${__VERSION__} and bridge ${h.bridge} differ. Update bridge with ${INSTALL}@latest and refresh plugin from Figma.`; chat.prepend(drift); }
}
function renderCost(s: SessionRecord) {
  const k = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  const u = s.usage;
  costEl.textContent = `${sessionCostLabel({ session: s, precision: 3 })} · ${k(u.input + u.cacheRead + u.cacheWrite)} in / ${k(u.output)} out · ${s.turns} turn${s.turns === 1 ? "" : "s"}`;
  costEl.title = `provider ${s.provider}\ncost ${s.costStatus}\ninput ${u.input}\ncache read ${u.cacheRead}\ncache write ${u.cacheWrite}\noutput ${u.output}\nsession ${s.sessionId}`;
}

// ---- provider-neutral activity -------------------------------------------
function onEvent(event: ReviewEvent) {
  if (view.bufferEvent(event) || !eventBelongsToSession({ event, session: view.session }) || items.get(event.itemId)?.completed) return;
  if (event.type === "text_start") {
    if (!items.has(event.itemId)) items.set(event.itemId, { element: assistant(""), markdown: "" });
  } else if (event.type === "text_delta") {
    const item = items.get(event.itemId);
    if (item) { item.markdown += event.text; item.element.innerHTML = md(item.markdown); chat.scrollTop = chat.scrollHeight; }
  } else if (event.type === "tool") {
    if (!items.has(event.itemId)) items.set(event.itemId, { element: chip(event.name, event.input), markdown: "" });
  } else if (event.type === "status") {
    if (!items.has(event.itemId)) items.set(event.itemId, { element: bubble("chip", event.text), markdown: "" });
  } else if (event.type === "error") {
    if (!items.has(event.itemId)) items.set(event.itemId, { element: bubble("error", event.message), markdown: "" });
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
  const card = bubble("card actionable");
  card.append(el("div", "q", typeof args.question === "string" ? args.question : "Question"));
  const ctl = el("div", "ctl");
  let settled = false;
  const close = (label: string) => {
    if (settled) return false;
    settled = true; card.classList.remove("actionable"); ctl.remove();
    const a = el("div", "a"); a.append(icon("check"), label); card.append(a);
    view.finishCard(id); if (pendingAsk?.id === id) pendingAsk = undefined; footer.hidden = false; return true;
  };
  const answer = (text: string) => { if (close(text)) send({ kind: "reply", id, result: { content: [{ type: "text", text: `${text}\n\n[Current selection: ${selText()}]` }] } }); };
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
  const card = bubble("card perm actionable");
  card.append(el("div", "q", `Allow ${tool.replace(/^mcp__/, "").replace("__", ": ")}?`));
  const preview = typeof input.markdown === "string" ? input.markdown : JSON.stringify(input, null, 1);
  card.append(el("pre", "", preview.slice(0, 2000)));
  const ctl = el("div", "ctl");
  let settled = false;
  const done = (result: PermissionDecision | undefined, label: string) => {
    if (settled) return;
    settled = true; card.classList.remove("actionable"); ctl.remove(); card.append(el("div", "a", label)); view.finishCard(id);
    if (result) send({ kind: "reply", id, result });
  };
  view.addCard({ id, cancel: reason => done(undefined, `Cancelled: ${reason}`) });
  ctl.append(btn("Allow", () => done({ behavior: "allow" }, "Allowed"), "primary"), btn("Deny", () => done({ behavior: "deny", message: "The user denied this in the plugin." }, "Denied")));
  card.append(ctl);
}

function requestHistory(args: { session: SessionRecord; attached: boolean; retainSession?: boolean; activeText?: Extract<DownMsg, { kind: "connection" }>["activeText"]; inputs?: { text: string; selection: NodeRef[] }[] }) {
  const intentId = `history-${Date.now().toString(36)}-${++intentCounter}`;
  view.beginHistory({ intentId, ...args });
  send({ kind: "open", intentId, fileId: ctx.fileId, fileName: ctx.fileName, session: args.session });
}

function renderSessions() {
  sessionsEl.innerHTML = "";
  sessionsEl.append(el("h4", "", "History"));
  if (!sessions.length) sessionsEl.append(el("div", "hint", "No sessions yet for this file."));
  for (const s of [...sessions].reverse()) {
    const row = el("div", "row"), title = el("div", "title");
    const provider = s.provider === "claude" ? "Claude" : "Codex";
    title.append(el("b", "", s.title), el("span", "", `${provider} · ${s.pageName} · ${s.updatedAt.slice(0, 16).replace("T", " ")} · ${sessionCostLabel({ session: s, precision: 2 })} · ${s.turns} turn${s.turns === 1 ? "" : "s"}`));
    row.append(title, btn("Open", () => {
      if (!admit("History was not opened because the bridge is not connected.")) return;
      const disposition = view.historyRow({ session: s });
      if (disposition === "retain") { sessionsEl.hidden = true; return; }
      const attached = !opened && disposition === "attached";
      if (!attached) leaveView("Opened a History session");
      requestHistory({ session: s, attached, retainSession: attached }); sessionsEl.hidden = true;
    }));
    sessionsEl.append(row);
  }
}

// ---- settings --------------------------------------------------------------
const pushSettings = () => {
  if (!health) return;
  const provider = view.session?.provider ?? health.selectedProvider;
  if (!admit("Settings were not changed because the bridge is not connected.")) return renderHealth(health);
  send(settingsControl.request({ provider, settings: { model: modelSel.value, effort: effortSel.value } }));
};
modelSel.onchange = effortSel.onchange = pushSettings;
$("btn-settings").onclick = () => { settingsEl.hidden = !settingsEl.hidden; sessionsEl.hidden = true; };

// ---- composer -------------------------------------------------------------
function start(anchor: Anchor, text: string, resume?: SessionRef) {
  if (!admit("Wait for the bridge connection, then send again.")) return;
  if (view.starting) return;
  if (view.readingHistory) { toMain({ kind: "notify", text: "Wait for History to finish loading, then send." }); return; }
  const intentId = `${Date.now().toString(36)}-${++intentCounter}`;
  view.begin({ intentId, retainSession: !!resume });
  if (!resume) clearChat();
  opened = undefined; settingsEl.hidden = sessionsEl.hidden = true;
  bubble("msg user", text);
  send({ kind: "start", intentId, fileId: ctx.fileId, fileName: ctx.fileName, pageId: ctx.pageId, pageName: ctx.pageName, anchor, resume, text, selection: ctx.selection });
}
/** History → Open: show the past conversation; the session itself is resumed by the next message. */
function showHistory(m: Extract<DownMsg, { kind: "history" }>) {
  const confirmed = view.confirmHistory({ intentId: m.intentId, session: m.session, attached: m.attached });
  if (!confirmed) return;
  const cards = clearChat(true);
  renderCost(confirmed.session);
  opened = m.attached ? undefined : confirmed.session;
  const historyIds = new Set<string>();
  for (const h of m.messages) {
    if (h.role === "tool") {
      const element = h.name === "stopped" ? bubble("chip stopped", "Stopped") : chip(h.name, h.input);
      if (h.itemId) { historyIds.add(h.itemId); items.set(h.itemId, { element, markdown: "", completed: true }); }
    } else if (h.role === "assistant") {
      const element = assistant(md(h.text));
      if (h.itemId) { historyIds.add(h.itemId); items.set(h.itemId, { element, markdown: h.text, completed: true }); }
    } else bubble("msg user", h.text); // user message or ask_user answer
  }
  for (const snapshot of confirmed.activeText) if (!historyIds.has(snapshot.itemId)
    && eventBelongsToSession({ event: { type: "text_start", ...snapshot }, session: view.session })) {
    items.set(snapshot.itemId, { element: assistant(md(snapshot.text)), markdown: snapshot.text });
  }
  for (const event of confirmed.events) if (!historyIds.has(event.itemId)) onEvent(event);
  if (confirmed.attached) for (const queued of confirmed.inputs) bubble("msg user", queued.text);
  else notifyCancelled(confirmed.inputs.length);
  for (const card of cards) chat.append(card);
  if (busy) chat.append(working);
  if (confirmed.attached) for (const queued of confirmed.inputs) send({ kind: "user", ...queued });
  chat.scrollTop = chat.scrollHeight;
}
function submit() {
  const text = input.value.trim();
  if (!text) return;
  if (!admit("Still connecting to the bridge. Your message is kept here.")) return;
  if (view.readingHistory) { toMain({ kind: "notify", text: "History is still loading. Your message is kept here." }); return; }
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
$("btn-new").onclick = () => {
  if (!admit("New was not started because the bridge is not connected.")) return;
  leaveView("Started a new view"); clearChat(); chat.append(empty); costEl.textContent = "";
  settingsEl.hidden = sessionsEl.hidden = true; input.focus();
};
$("btn-history").onclick = () => { sessionsEl.hidden = !sessionsEl.hidden; settingsEl.hidden = true; if (!sessionsEl.hidden) renderSessions(); };
stopBtn.onclick = () => send({ kind: "interrupt" });
