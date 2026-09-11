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
