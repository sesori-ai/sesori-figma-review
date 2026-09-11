import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupOwnedArtifacts, stopOwnedProcess, withTimeout } from "./smoke-lifecycle.mjs";

class Child extends EventEmitter {
  exitCode = null;
  signalCode = null;
  killed = 0;
  constructor(exitOnKill) { super(); this.exitOnKill = exitOnKill; }
  kill() {
    this.killed++;
    if (this.exitOnKill) queueMicrotask(() => { this.signalCode = "SIGTERM"; this.emit("exit", null, "SIGTERM"); });
  }
}

assert.equal(await withTimeout({ promise: Promise.resolve(true), timeoutMs: 20, label: "resolved" }), true);
await assert.rejects(withTimeout({ promise: new Promise(() => {}), timeoutMs: 10, label: "startup" }), /startup timed out/);
const stopped = new Child(true);
assert.equal(await stopOwnedProcess({ child: stopped, timeoutMs: 20 }), true);
assert.equal(stopped.killed, 1);
const hanging = new Child(false);
assert.equal(await stopOwnedProcess({ child: hanging, timeoutMs: 10 }), false);
assert.equal(hanging.killed, 2);
const root = mkdtempSync(join(tmpdir(), "smoke-cleanup-")), fixture = join(root, "fixture"), nativeProject = join(root, "native");
mkdirSync(fixture); mkdirSync(nativeProject); const transcript = join(nativeProject, "owned.jsonl"); writeFileSync(transcript, "owned");
assert.equal(cleanupOwnedArtifacts({ terminated: false, fixture, nativeProject, nativeProjectExisted: false, transcript }).cleanupFailed, true);
assert.ok(existsSync(fixture) && existsSync(transcript), "unproven termination retains all artifacts");
assert.deepEqual(cleanupOwnedArtifacts({ terminated: true, fixture, nativeProject, nativeProjectExisted: false, transcript }), { nativeRemoved: true, cleanupFailed: false });
assert.ok(!existsSync(fixture) && !existsSync(nativeProject)); rmSync(root, { recursive: true, force: true });
console.log("smoke lifecycle check ok");
