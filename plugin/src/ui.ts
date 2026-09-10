// UI iframe: the only user-facing surface. WebSocket client to the bridge, chat renderer, and relay
// between the bridge and the sandbox (tool calls go down to code.ts, replies come back up).
import { marked } from "marked";
import { BRIDGE_PORT, type Anchor, type DownMsg, type Health, type NodeRef, type PermissionDecision, type SessionRecord, type UpMsg } from "../../shared/protocol.ts";

const md = (s: string) => marked.parse(s.replace(/</g, "&lt;"), { async: false }) as string; // raw HTML from the model is shown as text

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const chat = $("chat"), input = $<HTMLTextAreaElement>("input"), statusEl = $("status"), dot = $("dot"), costEl = $("cost"), sessionsEl = $("sessions"), selEl = $("sel"), stopBtn = $("btn-stop");

let ctx = { fileId: "", fileName: "", pageId: "", pageName: "", selection: [] as NodeRef[] };
let ws: WebSocket | undefined;
let live: SessionRecord | undefined; // current conversation (placeholder until the bridge confirms it)
let textEl: HTMLElement | undefined; // assistant text block currently being streamed
let textRaw = ""; // its markdown source so far; re-rendered on every delta (ponytail: fine for chat-sized messages)
let sessions: SessionRecord[] = [];

const el = (tag: string, cls = "", text = "") => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
const btn = (label: string, onClick: () => void, cls = "") => { const b = el("button", cls, label) as HTMLButtonElement; b.onclick = onClick; return b; };
const working = el("div", "chip", "thinking…"); // re-appended on every busy=true, so clearing the chat is safe
const bubble = (cls: string, text = "") => { const b = el("div", cls, text); chat.insertBefore(b, working.parentNode === chat ? working : null); chat.scrollTop = chat.scrollHeight; return b; };
const selText = () => ctx.selection.length ? ctx.selection.map(n => `${n.name} (${n.type} ${n.id})`).join(", ") : "none";
const toolLabel = (name: string) => name.replace(/^mcp__/, "").replace(/__/, ": ");

// ---- sandbox (code.ts) ---------------------------------------------------
const toMain = (m: unknown) => parent.postMessage({ pluginMessage: m }, "*");
window.onmessage = (e: MessageEvent) => {
  const m = e.data?.pluginMessage;
  if (!m) return;
  if (m.kind === "context") { const first = !ctx.fileId; ctx = m; selEl.textContent = `Selection: ${selText()}`; if (first) connect(); }
  if (m.kind === "reply") send({ kind: "reply", id: m.id, result: m.result });
};

// ---- bridge ---------------------------------------------------------------
function connect() {
  ws = new WebSocket(`ws://localhost:${BRIDGE_PORT}`);
  ws.onopen = () => { setStatus("connected to bridge", "warn"); send({ kind: "hello", fileId: ctx.fileId, fileName: ctx.fileName }); };
  ws.onclose = () => { setStatus("bridge offline — run `npm run bridge` and keep it running", "bad"); setTimeout(connect, 2000); };
  ws.onerror = () => {};
  ws.onmessage = e => onDown(JSON.parse(e.data));
}
const send = (m: UpMsg) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
function setStatus(text: string, level: "ok" | "warn" | "bad") { statusEl.textContent = text; dot.className = `dot ${level}`; }

function onDown(m: DownMsg) {
  switch (m.kind) {
    case "health": return renderHealth(m.health);
    case "sessions": sessions = m.sessions; if (!sessionsEl.hidden) renderSessions(); return;
    case "session": live = m.session; return renderCost(m.session);
    case "tool": return m.tool === "ask_user" ? askCard(m.id, m.args) : toMain(m);
    case "permission": return permissionCard(m.id, m.tool, m.input);
    case "sdk": return onSdk(m.msg);
    case "busy": stopBtn.hidden = !m.busy; if (m.busy) { chat.append(working); chat.scrollTop = chat.scrollHeight; } else working.remove(); return;
    case "error": bubble("error", m.message); return;
  }
}

function renderHealth(h: Health) {
  const mcp = h.figmaMcp === "up" ? "Figma MCP up" : "Figma MCP down (enable it in Dev Mode → inspect panel)";
  const failed = (h.servers ?? []).filter(s => s.status !== "connected").map(s => `${s.name}: ${s.status}${s.error ? ` (${s.error})` : ""}`);
  setStatus(h.error ?? `Claude ${h.claude ?? "starting…"}${h.model ? ` · ${h.model}` : ""} · ${mcp}`, h.error ? "bad" : h.figmaMcp === "up" && !failed.length ? "ok" : "warn");
  statusEl.title = failed.join("\n");
}
function renderCost(s: SessionRecord) {
  const k = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  const u = s.usage;
  costEl.textContent = `$${s.costUsd.toFixed(3)} · ${k(u.input + u.cacheRead + u.cacheWrite)} in / ${k(u.output)} out · ${s.turns} turn${s.turns === 1 ? "" : "s"}`;
  costEl.title = `input ${u.input}\ncache read ${u.cacheRead}\ncache write ${u.cacheWrite}\noutput ${u.output}\nsession ${s.sessionId}`;
}

// ---- Claude Agent SDK messages -------------------------------------------
function onSdk(msg: any) {
  if (msg.type === "stream_event" && !msg.parent_tool_use_id) {
    const ev = msg.event;
    if (ev.type === "content_block_start") { textEl = ev.content_block.type === "text" ? bubble("msg assistant") : undefined; textRaw = ""; }
    if (ev.type === "content_block_delta" && ev.delta.type === "text_delta" && textEl) { textRaw += ev.delta.text; textEl.innerHTML = md(textRaw); chat.scrollTop = chat.scrollHeight; }
  }
  if (msg.type === "assistant") {
    for (const b of msg.message.content) if (b.type === "tool_use") bubble("chip", `⚙ ${toolLabel(b.name)} ${summarize(b.input)}`);
    if (msg.error) bubble("error", `Claude error: ${msg.error}`);
  }
  if (msg.type === "result") {
    textEl = undefined;
    if (msg.is_error) bubble("error", msg.result ?? msg.subtype);
  }
  if (msg.type === "system" && msg.subtype === "status" && msg.status === "compacting") bubble("chip", "compacting context…");
}
const summarize = (input: Record<string, unknown>) =>
  Object.entries(input ?? {}).filter(([k]) => k !== "markdown").map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ").slice(0, 120);

// ---- cards ---------------------------------------------------------------
function askCard(id: string, args: any) {
  if (args.nodeId) toMain({ kind: "focus", nodeId: args.nodeId });
  const card = bubble("card");
  card.append(el("div", "q", args.question));
  const ctl = el("div", "ctl");
  const answer = (text: string) => {
    ctl.remove(); card.append(el("div", "a", text));
    send({ kind: "reply", id, result: { content: [{ type: "text", text: `${text}\n\n[Current selection: ${selText()}]` }] } });
  };
  for (const o of args.options ?? []) ctl.append(btn(o, () => answer(o)));
  const ta = document.createElement("textarea"); ta.rows = 2; ta.placeholder = "Or type an answer… Enter to send";
  ta.onkeydown = e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (ta.value.trim()) answer(ta.value.trim()); } };
  ctl.append(ta); card.append(ctl); ta.focus();
}

function permissionCard(id: string, tool: string, input: Record<string, unknown>) {
  if (typeof input.nodeId === "string") toMain({ kind: "focus", nodeId: input.nodeId });
  const card = bubble("card perm");
  card.append(el("div", "q", `Allow ${toolLabel(tool)}?`));
  const preview = typeof input.markdown === "string" ? input.markdown : JSON.stringify(input, null, 1);
  card.append(el("pre", "", preview.slice(0, 2000)));
  const ctl = el("div", "ctl");
  const done = (result: PermissionDecision, label: string) => { ctl.remove(); card.append(el("div", "a", label)); send({ kind: "reply", id, result }); };
  ctl.append(btn("Allow", () => done({ behavior: "allow" }, "Allowed"), "primary"), btn("Deny", () => done({ behavior: "deny", message: "The user denied this in the plugin." }, "Denied")));
  card.append(ctl);
}

function renderSessions() {
  sessionsEl.innerHTML = "";
  if (!sessions.length) sessionsEl.append(el("div", "muted", "No sessions yet for this file."));
  for (const s of [...sessions].reverse()) {
    const row = el("div", "row");
    row.append(el("span", "title", s.title), el("span", "muted", `${s.pageName} · ${s.updatedAt.slice(0, 16).replace("T", " ")} · $${s.costUsd.toFixed(2)}`));
    row.append(btn("Resume", () => { sessionsEl.hidden = true; start(s.anchor, "Resuming this review from Figma. Recap where we left off and what is still open.", s.sessionId); }));
    sessionsEl.append(row);
  }
}

// ---- composer -------------------------------------------------------------
function start(anchor: Anchor, text: string, resume?: string) {
  chat.innerHTML = ""; textEl = undefined; costEl.textContent = "";
  live = { sessionId: resume ?? "" } as SessionRecord; // placeholder until the bridge sends `session`
  bubble("msg user", text);
  send({ kind: "start", fileId: ctx.fileId, fileName: ctx.fileName, pageId: ctx.pageId, pageName: ctx.pageName, anchor, resume, text, selection: ctx.selection });
}
function submit() {
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  if (!live) return start({ type: "page", nodeIds: [] }, text);
  bubble("msg user", text);
  send({ kind: "user", text, selection: ctx.selection }); // delivered mid-turn as steering; Stop interrupts
}

$("send").onclick = submit;
input.onkeydown = e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } };
$("btn-flow").onclick = () => start({ type: "flow", nodeIds: [] }, `Review the prototype flow on page "${ctx.pageName}" using the review-flow skill: the flow as a whole first, then screen by screen.`);
$("btn-selection").onclick = () => {
  if (!ctx.selection.length) return toMain({ kind: "notify", text: "Select something first" });
  start({ type: "selection", nodeIds: ctx.selection.map(n => n.id) }, `Review the selected node(s): ${selText()}. Focus each one, assess clarity and dev-readiness, and propose annotations.`);
};
$("btn-new").onclick = () => { chat.innerHTML = ""; live = undefined; costEl.textContent = ""; input.focus(); };
$("btn-history").onclick = () => { sessionsEl.hidden = !sessionsEl.hidden; if (!sessionsEl.hidden) renderSessions(); };
stopBtn.onclick = () => send({ kind: "interrupt" });
