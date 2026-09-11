import { existsSync, rmSync } from "node:fs";

export function withTimeout({ promise, timeoutMs, label }) {
  let timer;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs); });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

export async function stopOwnedProcess({ child, timeoutMs }) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  const exited = new Promise(resolve => child.once("exit", resolve));
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    try { child.kill(signal); } catch { return false; }
    try {
      await withTimeout({ promise: exited, timeoutMs, label: `owned bridge ${signal} termination` });
      return true;
    } catch {}
  }
  return false;
}

export async function restartSmoke(args) {
  const owned = args.current();
  if (!owned || !await args.stop(owned)) throw new Error("owned bridge restart termination timed out");
  if (args.finished() || args.current() !== owned) return false;
  const replacement = await args.launch();
  if (args.finished() || args.current() !== replacement) { if (!await args.stop(replacement)) throw new Error("replacement termination timed out"); return false; }
  await args.connect(); return !args.finished() && args.current() === replacement;
}
export async function cleanupSmoke(args) {
  const owned = args.current(), terminated = !owned || await args.stop(owned);
  if (!terminated || args.current() !== owned) return;
  return args.cleanup();
}
export function deliverSmokeCallback(args) { if (args.finished()) return false; args.deliver(); return true; }

export async function completeSmoke(args) {
  if (args.finished()) return false;
  args.finish();
  let outcome;
  try {
    const records = JSON.parse(args.read());
    const record = records.find(item => item.provider === args.provider && item.sessionId === args.sessionId);
    const usage = record ? Object.values(record.usage).reduce((sum, value) => sum + value, 0) : 0;
    const ok = record?.turns === 3 && record.costStatus === "reported" && record.costUsd > args.firstCost
      && usage > args.firstUsage && args.observed;
    outcome = { ok, record, usage }; args.report(outcome);
  } catch (error) { args.reportError(error); }
  finally { await args.cleanup(outcome?.ok ? 0 : 1); }
  return true;
}

export function cleanupOwnedArtifacts(args) {
  if (!args.terminated) return { nativeRemoved: false, cleanupFailed: true };
  let nativeRemoved = false;
  if (args.transcript && existsSync(args.transcript)) {
    rmSync(args.nativeProject, { recursive: true, force: true }); nativeRemoved = true;
  }
  const cleanupFailed = existsSync(args.nativeProject) && !args.nativeProjectExisted;
  rmSync(args.fixture, { recursive: true, force: true });
  return { nativeRemoved, cleanupFailed };
}
