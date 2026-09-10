import assert from "node:assert/strict";
import type { ProviderSessionRecord } from "../../shared/protocol.ts";
import { activateProvider } from "./provider-activation.ts";
import type { ProviderOutput, ProviderRequestBoundary, ReviewProvider, ReviewSession } from "./providers/types.ts";

const output = async function* (): AsyncIterable<ProviderOutput> {};
class FakeSession implements ReviewSession {
  readonly provider = "claude" as const;
  readonly output = output();
  sent: string[] = [];
  interrupted = 0;
  settings: string[] = [];
  closed = 0;
  send(args: { text: string }) { this.sent.push(args.text); }
  async interrupt() { this.interrupted++; }
  async applySettings(args: { settings: { model: string } }) { this.settings.push(args.settings.model); }
  close() { this.closed++; }
}
class FakeProvider implements ReviewProvider {
  readonly id = "claude" as const;
  readonly sessions: FakeSession[] = [];
  release?: () => void;
  health() { return { provider: "claude" as const, status: "ready" as const, models: [] }; }
  prepare() {}
  async start() {
    await new Promise<void>(resolve => { this.release = resolve; });
    const session = new FakeSession(); this.sessions.push(session); return session;
  }
  readHistory() { return []; }
  dispose() {}
}
const baseRecord: ProviderSessionRecord = {
  provider: "claude", sessionId: "", title: "Review", anchor: { type: "page", nodeIds: [] }, pageId: "0:1",
  pageName: "Page", createdAt: "now", updatedAt: "now", turns: 0, costUsd: 0, costStatus: "unavailable",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const boundary: ProviderRequestBoundary = {
  tool: async () => ({ content: [{ type: "text", text: "ok" }] }),
  permission: async () => ({ behavior: "allow" }),
};
const start = { fileId: "file", dir: "/tmp", settings: { model: "haiku", effort: "low" }, boundary, baseRecord };
const provider = new FakeProvider();
let current = true, accepted: ReviewSession | undefined;
const activation = activateProvider({ provider, start, isCurrent: () => current, accept: session => { accepted = session; } });
await Promise.resolve();
provider.release!();
assert.equal(await activation, accepted, "current provider start reaches bridge owner");
accepted!.send({ text: "steer", selection: [] });
await accepted!.interrupt();
await accepted!.applySettings({ settings: { model: "sonnet", effort: "high" } });
assert.deepEqual(provider.sessions[0].sent, ["steer"]);
assert.equal(provider.sessions[0].interrupted, 1);
assert.deepEqual(provider.sessions[0].settings, ["sonnet"]);
const staleProvider = new FakeProvider();
const stale = activateProvider({ provider: staleProvider, start, isCurrent: () => current, accept: () => assert.fail("stale start accepted") });
await Promise.resolve();
current = false;
staleProvider.release!();
assert.equal(await stale, undefined);
assert.equal(staleProvider.sessions[0].closed, 1, "superseded native session closes instead of stealing ownership");
console.log("provider activation check ok");
