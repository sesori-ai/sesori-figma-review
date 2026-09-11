// Owned fake-plugin + real Claude activation smoke. Isolated home/free port; Haiku/low, <=4 turns/process, <=$0.10/process.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bridgePath = join(here, "dist", "bridge.mjs");
if (!existsSync(bridgePath) || relative(here, bridgePath).startsWith("..")) throw new Error("Smoke bridge must be built inside bridge/");
const fixture = join(here, "dist", `.owned-smoke-${process.pid}-${Date.now()}`);
if (relative(join(here, "dist"), fixture).startsWith("..")) throw new Error("Unsafe smoke fixture");
mkdirSync(fixture, { recursive: true });
writeFileSync(join(fixture, "settings.json"), `${JSON.stringify({
  provider: "claude", providers: { claude: { model: "haiku", effort: "low" }, codex: { model: "", effort: "" } },
})}\n`);
const workspace = join(fixture, "files", "smoke");
const claudeRoot = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const nativeProject = join(claudeRoot, "projects", workspace.replace(/[^a-zA-Z0-9]/g, "-"));
const nativeProjectExisted = existsSync(nativeProject);
if (nativeProjectExisted) {
  rmSync(fixture, { recursive: true, force: true });
  throw new Error("Unique smoke native project path already exists; ownership is not provable");
}
let port = 0;
let child, ws, timeout, finished = false, bridgeOutput = "";
const seen = [], text = new Map();
let phase = "steer", ref, steerCard, stoppedCard, sawSteeredFocus = false, sawCancelledCard = false;
let firstProcessUsage = 0, firstProcessCost = 0, restartCount = 0, reconnectChecked = false, stopEnded = false;

function launch() {
  bridgeOutput = "";
  child = spawn(process.execPath, [bridgePath], {
    env: { ...process.env, APP_REPO: "", SESORI_REVIEW_PORT: "0", SESORI_REVIEW_HOME: fixture,
      SESORI_REVIEW_MAX_TURNS: "4", SESORI_REVIEW_MAX_BUDGET_USD: "0.10" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", chunk => { bridgeOutput += String(chunk); });
  return new Promise((resolve, reject) => {
    child.stdout.on("data", chunk => {
      bridgeOutput += String(chunk);
      const match = bridgeOutput.match(/listening on ws:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { port = Number(match[1]); port === 3055 ? reject(new Error("OS assigned protected bridge port 3055")) : resolve(); }
    });
    child.once("error", reject);
    child.once("exit", code => { if (!finished && phase !== "restarting") fail(`bridge exited ${code}: ${bridgeOutput.slice(-1000)}`); });
  });
}
const send = message => ws.send(JSON.stringify(message));
function rejectLegacyProtocol() {
  return new Promise((resolve, reject) => {
    const legacy = new WebSocket(`ws://127.0.0.1:${port}`); let actionable = false;
    legacy.addEventListener("open", () => legacy.send(JSON.stringify({ kind: "hello", fileId: "legacy", fileName: "Legacy" })));
    legacy.addEventListener("message", event => { const message = JSON.parse(event.data); actionable ||= message.kind === "error" && message.message.includes("protocol mismatch"); });
    legacy.addEventListener("close", () => actionable ? resolve() : reject(new Error("Legacy plugin did not receive protocol mismatch guidance")));
    legacy.addEventListener("error", reject, { once: true });
  });
}
function connect() {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.addEventListener("open", () => { send({ kind: "hello", protocolVersion: 3, fileId: "smoke", fileName: "Smoke" }); resolve(); }, { once: true });
    ws.addEventListener("error", () => reject(new Error(`WebSocket connect failed on ${port}: ${bridgeOutput.slice(-1000)}`)), { once: true });
    ws.addEventListener("message", onMessage);
  });
}
async function cleanup(code) {
  clearTimeout(timeout);
  try { ws?.close(); } catch {}
  if (child?.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await new Promise(resolve => child.once("exit", resolve));
    console.log("owned bridge process cleanup ok");
  }
  let cleanupFailed = false;
  const transcript = ref?.sessionId ? join(nativeProject, `${ref.sessionId}.jsonl`) : undefined;
  if (transcript && existsSync(transcript)) {
    rmSync(nativeProject, { recursive: true, force: true });
    console.log("owned native artifact cleanup ok");
  }
  else if (existsSync(nativeProject)) { cleanupFailed = true; console.log("owned native cleanup unproven; project retained"); }
  rmSync(fixture, { recursive: true, force: true });
  if (existsSync(nativeProject) && !nativeProjectExisted) cleanupFailed = true;
  process.exitCode = code || cleanupFailed ? 1 : 0;
}
function fail(reason) {
  if (finished) return; finished = true;
  console.log(`\n${reason}`); for (const item of seen) console.log(" ", item);
  void cleanup(1);
}
function pass() {
  if (finished) return; finished = true;
  const records = JSON.parse(readFileSync(join(fixture, "files", "smoke", "sessions.json"), "utf8"));
  const record = records.find(item => item.provider === "claude" && item.sessionId === ref.sessionId);
  const usage = record ? Object.values(record.usage).reduce((sum, value) => sum + value, 0) : 0;
  const ok = record?.turns === 3 && record.costStatus === "reported" && record.costUsd > firstProcessCost
    && usage > firstProcessUsage && sawSteeredFocus && sawCancelledCard && reconnectChecked && restartCount === 1;
  console.log(`\n${ok ? "ok" : "failed persisted resume accounting"}`);
  seen.push(`resume turns=${record?.turns} cost=${record?.costUsd} usage=${usage}`);
  for (const item of seen) console.log(" ", item);
  void cleanup(ok ? 0 : 1);
}

async function restartAndResume() {
  phase = "restarting"; restartCount++;
  ws.close(); child.kill("SIGTERM");
  await new Promise(resolve => child.once("exit", resolve));
  await launch(); await connect();
}
function startFirst() {
  send({ kind: "start", intentId: "first", fileId: "smoke", fileName: "Smoke", pageId: "0:1", pageName: "Page",
    anchor: { type: "page", nodeIds: [] }, selection: [],
    text: "Call ask_user with question 'Direction?' and options ['Keep','Change']. After the answer, follow any new instruction exactly." });
}

function onMessage(event) {
  const message = JSON.parse(event.data);
  if (message.kind === "connection") {
    if (phase === "steer") return startFirst();
    if (phase === "reconnect") {
      reconnectChecked = !!message.session && message.session.sessionId === ref.sessionId && !message.busy;
      phase = "restarting"; return void restartAndResume().catch(error => fail(String(error)));
    }
    if (phase === "restarting") {
      phase = "resume";
      send({ kind: "open", intentId: "history", fileId: "smoke", fileName: "Smoke", session: ref });
    }
  }
  if (message.kind === "history" && phase === "resume") {
    const hasPriorTool = message.messages.some(item => item.role === "tool" && item.name.endsWith("focus"));
    if (!hasPriorTool) return fail("native history missing pre-restart focus tool");
    text.clear();
    send({ kind: "start", intentId: "resume", fileId: "smoke", fileName: "Smoke", pageId: "0:1", pageName: "Page",
      anchor: message.session.anchor, resume: ref, selection: [], text: "Reply with the single word RESUMED." });
  }
  if (message.kind === "started") {
    const started = { provider: message.session.provider, sessionId: message.session.sessionId };
    if (ref && (started.provider !== ref.provider || started.sessionId !== ref.sessionId)) return fail("resume changed native session identity");
    ref = started;
  }
  if (message.kind === "tool") {
    seen.push(`tool ${message.tool}`);
    if (phase === "steer" && message.tool === "ask_user") {
      steerCard = message.id;
      send({ kind: "user", text: "After this answer, call focus with nodeId 1:2, then reply STEERED.", selection: [] });
      return send({ kind: "reply", id: message.id, result: { content: [{ type: "text", text: "Keep\n\n[Current selection: none]" }] } });
    }
    if (phase === "steer" && message.tool === "focus") {
      sawSteeredFocus = true;
      return send({ kind: "reply", id: message.id, result: { content: [{ type: "text", text: "Focused Login (1:2)" }] } });
    }
    if (phase === "stop" && message.tool === "ask_user") {
      stoppedCard = message.id; return send({ kind: "interrupt" });
    }
    return fail(`unexpected tool ${message.tool} in ${phase}`);
  }
  if (message.kind === "cancel_request" && phase === "stop" && message.id === stoppedCard) sawCancelledCard = true;
  if (message.kind === "event" && ref && (message.event.session.provider !== ref.provider || message.event.session.sessionId !== ref.sessionId)) return fail("event escaped active session");
  if (message.kind === "event" && message.event.type === "text_start") text.set(message.event.itemId, "");
  if (message.kind === "event" && message.event.type === "text_delta" && text.has(message.event.itemId)) text.set(message.event.itemId, text.get(message.event.itemId) + message.event.text);
  if (message.kind === "session" && message.session.turns === 2 && phase === "stop") {
    firstProcessUsage = Object.values(message.session.usage).reduce((sum, value) => sum + value, 0);
    firstProcessCost = message.session.costUsd;
    if (stopEnded) { phase = "reconnect"; send({ kind: "hello", protocolVersion: 3, fileId: "smoke", fileName: "Smoke" }); }
  }
  if (message.kind === "event" && message.event.type === "turn_end") {
    if (phase === "steer") {
      if (!sawSteeredFocus || message.event.outcome !== "completed") return fail("busy steering failed");
      phase = "stop";
      return send({ kind: "user", text: "Call ask_user with question 'Stop now?' and wait for its answer.", selection: [] });
    }
    if (phase === "stop") {
      if (message.event.outcome !== "interrupted" || !sawCancelledCard) return fail("Stop/card cancellation failed");
      stopEnded = true; return;
    }
    if (phase === "resume") {
      const rendered = [...text.values()].join("");
      if (message.event.outcome !== "completed" || !rendered.includes("RESUMED")) return fail(`resume response failed: ${rendered}`);
      return setTimeout(pass, 200);
    }
  }
  if (message.kind === "error") seen.push(`error ${message.message}`);
}

try {
  await launch(); await rejectLegacyProtocol(); await connect();
  timeout = setTimeout(() => fail(`timeout phase=${phase}`), 180_000);
} catch (error) { fail(String(error)); }
