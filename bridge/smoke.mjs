// Fake plugin + real Claude: Stop an ask_user turn, then prove same-session focus and normalized text on follow-up.
// Costs a few cents. Run bridge with Haiku/low and bounded turns/spend, then `npm run smoke -w bridge`.
const port = Number(process.env.SESORI_REVIEW_PORT ?? 3055);
const ws = new WebSocket(`ws://127.0.0.1:${port}`);
const seen = [], startedText = new Map();
let phase = "interrupt", busy = false, sawCancelledAsk = false, sawLiveUsage = false, orphanDelta = false;
let confirmedCost, costRegressed = false;
const done = why => { console.log(`\n${why}`); for (const entry of seen) console.log(" ", entry); process.exit(why === "ok" ? 0 : 1); };
setTimeout(() => done("timeout"), 120_000);
const send = message => ws.send(JSON.stringify(message));

ws.addEventListener("open", () => {
  send({ kind: "hello", protocolVersion: 2, fileId: "smoke", fileName: "Smoke file" });
  setTimeout(() => send({
    kind: "start", fileId: "smoke", fileName: "Smoke file", pageId: "0:1", pageName: "Page 1", anchor: { type: "page", nodeIds: [] },
    text: "Call ask_user with question 'Continue?' and no nodeId. Do not do anything else until it returns.", selection: [],
  }), 3000);
});
ws.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  if (message.kind === "busy") busy = message.busy;
  if (message.kind === "tool") {
    seen.push(`tool call ${message.tool} ${JSON.stringify(message.args)}`);
    if (phase === "interrupt" && message.tool === "ask_user") return send({ kind: "interrupt" });
    if (phase === "follow-up" && message.tool === "focus") {
      return send({ kind: "reply", id: message.id, result: { content: [{ type: "text", text: 'Focused "Login" (FRAME 1:2)' }] } });
    }
  }
  if (message.kind === "cancel_request" && phase === "interrupt") sawCancelledAsk = true;
  if (message.kind === "health") {
    const claude = message.health.providers.find(provider => provider.provider === "claude");
    seen.push(`health claude=${claude?.version ?? claude?.status ?? "-"} figmaMcp=${message.health.figmaMcp} ${(message.health.servers ?? []).map(server => `${server.name}:${server.status}`).join(" ")}`);
  }
  if (message.kind === "session") {
    const tokens = Object.values(message.session.usage).reduce((sum, value) => sum + value, 0);
    if (!message.session.turns && busy && tokens > 0) sawLiveUsage = true;
    if (message.session.turns) {
      if (confirmedCost !== undefined && (message.session.costStatus !== "reported" || message.session.costUsd < confirmedCost)) costRegressed = true;
      confirmedCost = Math.max(confirmedCost ?? 0, message.session.costUsd);
      seen.push(`session $${message.session.costUsd.toFixed(4)} ${JSON.stringify(message.session.usage)} turns=${message.session.turns}`);
    }
  }
  if (message.kind === "event" && message.event.type === "text_start") startedText.set(message.event.itemId, "");
  if (message.kind === "event" && message.event.type === "text_delta") {
    if (!startedText.has(message.event.itemId)) orphanDelta = true;
    else startedText.set(message.event.itemId, startedText.get(message.event.itemId) + message.event.text);
  }
  if (message.kind === "event" && message.event.type === "turn_end") {
    if (phase === "interrupt") {
      if (message.event.outcome !== "interrupted") return done("first turn was not interrupted");
      phase = "follow-up";
      return setTimeout(() => send({ kind: "user", text: "Call focus with nodeId 1:2, then reply with the single word OK.", selection: [{ id: "1:2", name: "Login", type: "FRAME" }] }), 100);
    }
    setTimeout(() => {
      const rendered = [...startedText.values()].join("");
      const passed = message.event.outcome === "completed" && sawCancelledAsk && sawLiveUsage && !orphanDelta && !costRegressed
        && seen.some(entry => entry.startsWith("tool call focus")) && rendered.includes("OK");
      done(passed ? "ok" : `failed cancelled=${sawCancelledAsk} liveUsage=${sawLiveUsage} orphanDelta=${orphanDelta} costRegressed=${costRegressed} rendered=${JSON.stringify(rendered)}`);
    }, 300);
  }
  if (message.kind === "error") seen.push(`error: ${message.message}`);
});
