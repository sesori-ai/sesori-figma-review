// Owned fake-plugin + real Claude smoke. Builds must exist first. This script always starts and cleans an isolated
// bridge/home; it never connects fixture traffic to the user's normal bridge. Cost bounds: Haiku/low, 4 turns, $0.10.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertOwnedSmokeTarget } from "./smoke-policy.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bridgePath = join(here, "dist", "bridge.mjs");
if (!existsSync(bridgePath)) throw new Error("Missing bridge/dist/bridge.mjs; run npm run build first");
const fixture = join(here, "dist", `.owned-smoke-${process.pid}-${Date.now()}`);
assertOwnedSmokeTarget({ bridgeRoot: here, bridgePath, fixture });
mkdirSync(fixture, { recursive: true });
writeFileSync(join(fixture, "settings.json"), `${JSON.stringify({
  provider: "claude",
  providers: { claude: { model: "haiku", effort: "low" }, codex: { model: "", effort: "" } },
})}\n`);

const requestedPort = process.env.SESORI_REVIEW_PORT ? Number(process.env.SESORI_REVIEW_PORT) : 0;
const port = await new Promise((resolve, reject) => {
  const reservation = createServer();
  reservation.once("error", reject);
  reservation.listen(requestedPort, "127.0.0.1", () => {
    const address = reservation.address();
    if (!address || typeof address === "string") return reject(new Error("Could not reserve smoke port"));
    reservation.close(error => error ? reject(error) : resolve(address.port));
  });
});

const bridge = spawn(process.execPath, [bridgePath], {
  env: {
    ...process.env,
    SESORI_REVIEW_PORT: String(port),
    SESORI_REVIEW_HOME: fixture,
    SESORI_REVIEW_MAX_TURNS: "4",
    SESORI_REVIEW_MAX_BUDGET_USD: "0.10",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let bridgeOutput = "", ws, timer, finishing = false;
const seen = [], startedText = new Map();
let phase = "protocol", busy = false, sawCancelledAsk = false, sawLiveUsage = false, orphanDelta = false;
let probeIndex = 0, protocolProbe = "idle", originalSession, wrongSession = false, followupFocusEvent = false;
let latestSettings, sentCodexSelection = false, sawResumedClaudeHealth = false;
let confirmedCost, costRegressed = false, finalChecksPassed = false, followupTextOk = false;

const cleanup = exitCode => {
  clearTimeout(timer);
  try { if (ws?.readyState === WebSocket.OPEN) send({ kind: "close", reason: "Owned smoke complete" }); } catch {}
  setTimeout(() => {
    try { ws?.close(); } catch {}
    bridge.kill("SIGTERM");
    rmSync(fixture, { recursive: true, force: true });
    process.exitCode = exitCode;
  }, 100);
};
const done = why => {
  if (finishing) return;
  finishing = true;
  let result = why;
  if (why === "ok") {
    try {
      const records = JSON.parse(readFileSync(join(fixture, "files", "smoke", "sessions.json"), "utf8"));
      const settings = JSON.parse(readFileSync(join(fixture, "settings.json"), "utf8"));
      const session = records.at(-1);
      if (!session || session.provider !== "claude" || session.turns !== 3 || session.costStatus !== "reported"
        || session.costUsd <= 0 || settings.provider !== "codex") result = "owned fixture persistence failed";
      else seen.push(`owned fixture ${session.turns} turns $${session.costUsd} tokens=${Object.values(session.usage).reduce((a, b) => a + b, 0)}`);
    } catch (error) { result = `owned fixture read failed: ${error}`; }
  }
  console.log(`\n${result}`);
  for (const entry of seen) console.log(" ", entry);
  cleanup(result === "ok" ? 0 : 1);
};
timer = setTimeout(() => done("timeout"), 120_000);
bridge.on("exit", code => { if (!finishing) done(`owned bridge exited ${code}\n${bridgeOutput.slice(-2000)}`); });
bridge.stderr.on("data", chunk => { bridgeOutput += String(chunk); });
const ready = new Promise((resolve, reject) => {
  bridge.stdout.on("data", chunk => {
    bridgeOutput += String(chunk);
    if (bridgeOutput.includes(`listening on ws://127.0.0.1:${port}`)) resolve();
  });
  bridge.once("error", reject);
});
await ready;
ws = new WebSocket(`ws://127.0.0.1:${port}`);
const send = message => ws.send(JSON.stringify(message));
ws.addEventListener("open", () => send({ kind: "hello", protocolVersion: 3, fileId: "smoke", fileName: "Smoke file" }));

function probeOldPluginReconnect() {
  const versions = [1, 2];
  const version = versions[probeIndex++];
  protocolProbe = `waiting-v${version}`;
  const incompatible = new WebSocket(`ws://127.0.0.1:${port}`);
  let rejected = false;
  incompatible.addEventListener("open", () => incompatible.send(JSON.stringify({ kind: "hello", protocolVersion: version, fileId: "smoke", fileName: "Old plugin" })));
  incompatible.addEventListener("message", event => { const message = JSON.parse(event.data); rejected ||= message.kind === "error" && message.message.includes("protocol mismatch"); });
  incompatible.addEventListener("close", () => {
    if (!rejected) return done(`plugin protocol ${version} was not rejected`);
    if (probeIndex < versions.length) return probeOldPluginReconnect();
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
  if (message.kind === "connection" && phase === "idle-reconnect") {
    return done(finalChecksPassed && !message.busy ? "ok" : "idle reconnect reported busy");
  }
  if (message.kind === "busy") {
    busy = message.busy;
  }
  if (message.kind === "tool") {
    seen.push(`tool call ${message.tool} ${JSON.stringify(message.args)}`);
    if (phase === "interrupt" && message.tool === "ask_user") return send({ kind: "interrupt" });
    if (phase === "follow-up" && message.tool === "focus") return send({ kind: "reply", id: message.id, result: { content: [{ type: "text", text: 'Focused "Login" (FRAME 1:2)' }] } });
    send({ kind: "reply", id: message.id, result: { content: [{ type: "text", text: `Unexpected tool ${message.tool}` }], isError: true } });
    return done(`unexpected tool ${message.tool}`);
  }
  if (message.kind === "cancel_request" && phase === "interrupt") sawCancelledAsk = true;
  if (message.kind === "health") {
    latestSettings = message.health.settings;
    const claude = message.health.providers.find(provider => provider.provider === "claude");
    if (message.health.selectedProvider === "codex" && message.health.liveProvider === "claude" && !message.health.error && claude?.status === "ready") sawResumedClaudeHealth = true;
    seen.push(`health claude=${claude?.version ?? claude?.status ?? "-"} figmaMcp=${message.health.figmaMcp}`);
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
      phase = "follow-up"; startedText.clear();
      return setTimeout(() => send({ kind: "user", text: "Call focus with nodeId 1:2, then reply with the single word OK.", selection: [{ id: "1:2", name: "Login", type: "FRAME" }] }), 100);
    }
    setTimeout(() => {
      const rendered = [...startedText.values()].join("");
      if (phase === "follow-up") {
        followupTextOk = rendered.includes("OK");
        if (message.event.outcome !== "completed" || !followupTextOk) return done(`follow-up failed rendered=${JSON.stringify(rendered)}`);
        phase = "final-text"; startedText.clear();
        return send({ kind: "user", text: "Reply with the single word Z.", selection: [] });
      }
      const passed = protocolProbe === "passed" && message.event.outcome === "completed" && sawCancelledAsk && sawLiveUsage
        && !orphanDelta && !costRegressed && !wrongSession && followupFocusEvent && followupTextOk && sawResumedClaudeHealth
        && seen.some(entry => entry.startsWith("tool call focus")) && rendered.includes("Z");
      if (!passed) return done(`failed protocol=${protocolProbe} cancelled=${sawCancelledAsk} liveUsage=${sawLiveUsage} orphanDelta=${orphanDelta} costRegressed=${costRegressed} wrongSession=${wrongSession} focusEvent=${followupFocusEvent} followupText=${followupTextOk} resumedClaudeHealth=${sawResumedClaudeHealth} rendered=${JSON.stringify(rendered)}`);
      finalChecksPassed = true; phase = "idle-reconnect";
      send({ kind: "hello", protocolVersion: 3, fileId: "smoke", fileName: "Smoke file" });
    }, 300);
  }
  if (message.kind === "error") seen.push(`error: ${message.message}`);
});
