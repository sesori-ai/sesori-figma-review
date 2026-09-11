import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupOwnedArtifacts, cleanupSmoke, completeSmoke, deliverSmokeCallback, restartSmoke, stopOwnedProcess, withTimeout } from "./smoke-lifecycle.mjs";

class Child extends EventEmitter {
  exitCode = null;
  signalCode = null;
  signals = [];
  constructor(exitOnKill) { super(); this.exitOnKill = exitOnKill; }
  kill(signal) {
    this.signals.push(signal);
    if (this.exitOnKill) queueMicrotask(() => { this.signalCode = signal; this.emit("exit", null, signal); });
  }
}

assert.equal(await withTimeout({ promise: Promise.resolve(true), timeoutMs: 20, label: "resolved" }), true);
await assert.rejects(withTimeout({ promise: new Promise(() => {}), timeoutMs: 10, label: "startup" }), /startup timed out/);
const stopped = new Child(true);
assert.equal(await stopOwnedProcess({ child: stopped, timeoutMs: 20 }), true);
assert.deepEqual(stopped.signals, ["SIGTERM"]);
const hanging = new Child(false);
assert.equal(await stopOwnedProcess({ child: hanging, timeoutMs: 10 }), false);
assert.deepEqual(hanging.signals, ["SIGTERM", "SIGKILL"]);
const root = mkdtempSync(join(tmpdir(), "smoke-cleanup-")), fixture = join(root, "fixture"), nativeProject = join(root, "native");
mkdirSync(fixture); mkdirSync(nativeProject); const transcript = join(nativeProject, "owned.jsonl"); writeFileSync(transcript, "owned");
assert.equal(cleanupOwnedArtifacts({ terminated: false, fixture, nativeProject, nativeProjectExisted: false, transcript }).cleanupFailed, true);
assert.ok(existsSync(fixture) && existsSync(transcript), "unproven termination retains all artifacts");
assert.deepEqual(cleanupOwnedArtifacts({ terminated: true, fixture, nativeProject, nativeProjectExisted: false, transcript }), { nativeRemoved: true, cleanupFailed: false });
assert.ok(!existsSync(fixture) && !existsSync(nativeProject)); rmSync(root, { recursive: true, force: true });
const original = {}, exits = []; let current = original, finished = false, launches = 0, connects = 0, deletions = 0, dispatches = 0;
const stop = () => new Promise(resolve => exits.push(resolve));
const restarting = restartSmoke({ current: () => current, finished: () => finished, stop,
  launch: async () => { launches++; return current = {}; }, connect: async () => { connects++; } });
await Promise.resolve(); finished = true;
const cleaning = cleanupSmoke({ current: () => current, stop, cleanup: () => { deletions++; return "deleted"; } });
await Promise.resolve(); assert.equal(deletions, 0, "artifacts remain until captured process exit is observed");
for (const exit of exits) exit(true);
assert.deepEqual(await Promise.all([restarting, cleaning]), [false, "deleted"]);
assert.deepEqual([launches, connects, deletions], [0, 0, 1]);
assert.equal(deliverSmokeCallback({ finished: () => finished, deliver: () => { dispatches++; } }), false);
assert.equal(dispatches, 0, "queued post-terminal callback cannot dispatch protocol/model work");
const valid = JSON.stringify([{ provider: "claude", sessionId: "owned", turns: 3, costStatus: "reported", costUsd: 2,
  usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 } }]);
const finalCodes = [], finalErrors = [], finalReports = [];
for (const read of [
  () => readFileSync(join(root, "missing.json"), "utf8"), () => "not-json", () => "{}",
  () => valid.replace('"costUsd":2', '"costUsd":0'), () => valid,
]) {
  let finalFinished = false;
  const args = { finished: () => finalFinished, finish: () => { finalFinished = true; }, read, provider: "claude", sessionId: "owned",
    firstCost: 1, firstUsage: 1, observed: true, report: outcome => finalReports.push(outcome),
    reportError: error => finalErrors.push(String(error)), cleanup: async code => { finalCodes.push(code); } };
  assert.equal(await completeSmoke(args), true); assert.equal(await completeSmoke(args), false);
}
assert.deepEqual(finalCodes, [1, 1, 1, 1, 0]); assert.equal(finalErrors.length, 3); assert.deepEqual(finalReports.map(item => item.ok), [false, true]);
let finalDeleted = 0, finalFinished = false; const finalChild = {}; let releaseFinal;
const completing = completeSmoke({ finished: () => finalFinished, finish: () => { finalFinished = true; }, read: () => valid,
  provider: "claude", sessionId: "owned", firstCost: 1, firstUsage: 1, observed: true,
  report: () => {}, reportError: assert.fail, cleanup: code => cleanupSmoke({ current: () => finalChild,
    stop: () => new Promise(resolve => { releaseFinal = resolve; }), cleanup: () => { finalDeleted++; return code; } }) });
await Promise.resolve(); assert.equal(finalDeleted, 0); releaseFinal(true); assert.equal(await completing, true); assert.equal(finalDeleted, 1); assert.equal(finalFinished, true);
console.log("smoke lifecycle check ok");
