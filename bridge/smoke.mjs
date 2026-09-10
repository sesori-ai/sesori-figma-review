// Fake plugin + real Claude: Stop an ask_user turn, then prove same-session focus and normalized text on follow-up.
// Costs a few cents. Run bridge with Haiku/low and bounded turns/spend, then `npm run smoke -w bridge`.
const port = Number(process.env.SESORI_REVIEW_PORT ?? 3055);
const ws = new WebSocket(`ws://127.0.0.1:${port}`);
const seen = [], startedText = new Map();
let phase = "protocol", busy = false, sawCancelledAsk = false, sawLiveUsage = false, orphanDelta = false;
let protocolProbe = "idle", originalSession, wrongSession = false, followupFocusEvent = false;
let latestSettings, sentCodexSelection = false, sawResumedClaudeHealth = false;
let confirmedCost, costRegressed = false, finalChecksPassed = false, followupTextOk = false;
const done = why => { console.log(`\n${why}`); for (const entry of seen) console.log(" ", entry); process.exit(why === "ok" ? 0 : 1); };
setTimeout(() => done("timeout"), 120_000);
const send = message => ws.send(JSON.stringify(message));

ws.addEventListener("open", () => send({ kind: "hello", protocolVersion: 2, fileId: "smoke", fileName: "Smoke file" }));

function probeOldPluginReconnect() {
  protocolProbe = "waiting-for-rejection";
  const incompatible = new WebSocket(`ws://127.0.0.1:${port}`);
  let rejected = false;
  incompatible.addEventListener("open", () => incompatible.send(JSON.stringify({ kind: "hello", protocolVersion: 1, fileId: "smoke", fileName: "Old plugin" })));
  incompatible.addEventListener("message", event => { const message = JSON.parse(event.data); rejected ||= message.kind === "error" && message.message.includes("protocol mismatch"); });
  incompatible.addEventListener("close", () => {
    if (!rejected) return done("old plugin was not rejected");
    protocolProbe = "waiting-for-healthy-response";
    send({ kind: "health" });
  });
}

function startReview() {
  phase = "interrupt";
  send({
    kind: "start", intentId: "smoke-start", fileId: "smoke", fileName: "Smoke file", pageId: "0:1", pageName: "Page 1", anchor: { type: "page", nodeIds: [] },
    text: "Call ask_user with question 'Continue?' and no nodeId. Do not do anything else until it returns.", selection: [],
  });
}
ws.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  if (message.kind === "busy") {
    busy = message.busy;
    if (phase === "idle-reconnect") return done(finalChecksPassed && !message.busy ? "ok" : "idle reconnect reported busy");
  }
  if (message.kind === "tool") {
    seen.push(`tool call ${message.tool} ${JSON.stringify(message.args)}`);
    if (phase === "interrupt" && message.tool === "ask_user") return send({ kind: "interrupt" });
    if (phase === "follow-up" && message.tool === "focus") {
      return send({ kind: "reply", id: message.id, result: { content: [{ type: "text", text: 'Focused "Login" (FRAME 1:2)' }] } });
    }
    send({ kind: "reply", id: message.id, result: { content: [{ type: "text", text: `Unexpected tool ${message.tool}` }], isError: true } });
    return done(`unexpected tool ${message.tool}`);
  }
  if (message.kind === "cancel_request" && phase === "interrupt") sawCancelledAsk = true;
  if (message.kind === "health") {
    latestSettings = message.health.settings;
    const claude = message.health.providers.find(provider => provider.provider === "claude");
    if (message.health.selectedProvider === "codex" && message.health.liveProvider === "claude" && !message.health.error && claude?.status === "ready") sawResumedClaudeHealth = true;
    seen.push(`health claude=${claude?.version ?? claude?.status ?? "-"} figmaMcp=${message.health.figmaMcp} ${(message.health.servers ?? []).map(server => `${server.name}:${server.status}`).join(" ")}`);
    if (protocolProbe === "idle") return probeOldPluginReconnect();
    if (protocolProbe === "waiting-for-healthy-response") { protocolProbe = "passed"; return startReview(); }
  }
  if (message.kind === "started" && message.intentId === "smoke-start") {
    originalSession = { provider: message.session.provider, sessionId: message.session.sessionId };
    if (!sentCodexSelection && latestSettings) {
      sentCodexSelection = true;
      send({ kind: "settings", settings: { ...latestSettings, provider: "codex" } });
    }
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
  if (message.kind === "event" && (phase === "follow-up" || phase === "final-text")) {
    wrongSession ||= !originalSession || message.event.session.provider !== originalSession.provider || message.event.session.sessionId !== originalSession.sessionId;
    if (phase === "follow-up" && message.event.type === "tool" && message.event.name.endsWith("focus")) followupFocusEvent = true;
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
      startedText.clear();
      return setTimeout(() => send({ kind: "user", text: "Call focus with nodeId 1:2, then reply with the single word OK.", selection: [{ id: "1:2", name: "Login", type: "FRAME" }] }), 100);
    }
    setTimeout(() => {
      const rendered = [...startedText.values()].join("");
      if (phase === "follow-up") {
        followupTextOk = rendered.includes("OK");
        if (message.event.outcome !== "completed" || !followupTextOk) return done(`follow-up failed rendered=${JSON.stringify(rendered)}`);
        phase = "final-text";
        startedText.clear();
        return send({ kind: "user", text: "Reply with the single word Z.", selection: [] });
      }
      const passed = protocolProbe === "passed" && message.event.outcome === "completed" && sawCancelledAsk && sawLiveUsage
        && !orphanDelta && !costRegressed && !wrongSession && followupFocusEvent && followupTextOk && sawResumedClaudeHealth
        && seen.some(entry => entry.startsWith("tool call focus")) && rendered.includes("Z");
      if (!passed) return done(`failed protocol=${protocolProbe} cancelled=${sawCancelledAsk} liveUsage=${sawLiveUsage} orphanDelta=${orphanDelta} costRegressed=${costRegressed} wrongSession=${wrongSession} focusEvent=${followupFocusEvent} followupText=${followupTextOk} resumedClaudeHealth=${sawResumedClaudeHealth} rendered=${JSON.stringify(rendered)}`);
      finalChecksPassed = true;
      phase = "idle-reconnect";
      send({ kind: "hello", protocolVersion: 2, fileId: "smoke", fileName: "Smoke file" });
    }, 300);
  }
  if (message.kind === "error") seen.push(`error: ${message.message}`);
});
