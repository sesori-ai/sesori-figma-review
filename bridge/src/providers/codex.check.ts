import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { linkSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { z } from "zod";
import { CodexClient, CodexRpcError, type CodexChild } from "./codex-client.ts";
import { parseAccountResult, parseModelListResult, projectCodexModels } from "./codex-protocol.ts";
import { discoverCodexRuntime, qualifyCodexRuntime } from "./codex-qualification.ts";
import {
  CODEX_PERMISSION_PROFILE,
  assertCodexConfigIsolated,
  createCodexDiscoveryPolicy,
  createCodexExecutionPolicy,
  discoverCodexIsolation,
  type CodexExecutionPolicy,
} from "./codex-execution.ts";

class FakeChild extends EventEmitter implements CodexChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly sent: Record<string, unknown>[] = [];
  killed = false;
  private input = "";
  constructor(readonly onMessage?: (message: Record<string, unknown>, child: FakeChild) => void) {
    super();
    this.stdin.on("data", chunk => {
      this.input += String(chunk);
      for (;;) {
        const newline = this.input.indexOf("\n");
        if (newline < 0) break;
        const line = this.input.slice(0, newline); this.input = this.input.slice(newline + 1);
        const message: unknown = JSON.parse(line);
        assert.ok(message && typeof message === "object" && !Array.isArray(message));
        this.sent.push(message as Record<string, unknown>);
        this.onMessage?.(message as Record<string, unknown>, this);
      }
    });
  }
  send(value: unknown, splitAt?: number) {
    const line = `${JSON.stringify(value)}\n`;
    if (splitAt === undefined) this.stdout.write(line);
    else { this.stdout.write(line.slice(0, splitAt)); this.stdout.write(line.slice(splitAt)); }
  }
  kill() { this.killed = true; return true; }
}

const root = mkdtempSync(join(tmpdir(), "codex-step4-"));
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const dir = join(root, "workspace"), appRepo = join(root, "app");
mkdirSync(join(dir, "notes"), { recursive: true }); mkdirSync(appRepo);
writeFileSync(join(dir, "CLAUDE.md"), "user review instructions\n");
const emptyIsolation = { mcpServerNames: [], pluginNames: [], appNames: [] };
const policy = createCodexExecutionPolicy({ dir, appRepo, command: "/qualified/codex", isolation: emptyIsolation });
assert.deepEqual(
  [policy.command, policy.args.slice(0, 3), policy.thread.runtimeWorkspaceRoots, policy.thread.permissions],
  ["/qualified/codex", ["app-server", "--stdio", "--strict-config"], [policy.notesDir], CODEX_PERMISSION_PROFILE],
);
assert.equal("sandbox" in policy.thread, false);
const profileOverride = policy.args.find(value => value.startsWith(`permissions.${CODEX_PERMISSION_PROFILE}=`));
assert.ok(profileOverride?.includes(`${JSON.stringify(policy.appRepo)} = "read"`));
assert.ok(profileOverride?.includes(`${JSON.stringify(policy.notesDir)} = "write"`));
assert.ok(profileOverride?.includes("network = { enabled = false }"));
assert.equal(
  policy.args.some(value => value.startsWith(`permissions.${CODEX_PERMISSION_PROFILE}.filesystem.`)),
  false,
  "filesystem paths must stay TOML keys instead of becoming CLI dotted-path segments",
);
assert.ok(policy.args.includes("features.plugins=false"));
assert.ok(policy.args.includes("features.multi_agent=false"));
assert.ok(policy.args.some(value => value.startsWith("apps=") && value.includes('"_default" = { enabled = false }')));
mkdirSync(join(dir, "source"));
assert.throws(
  () => createCodexExecutionPolicy({ dir, appRepo: join(dir, "source"), isolation: emptyIsolation }),
  /must not overlap/,
);
assert.throws(() => createCodexDiscoveryPolicy({ dir: "relative" }), /must be absolute/);
assert.throws(() => parseAccountResult({ requiresOpenaiAuth: "yes", account: null }));
assert.throws(() => parseModelListResult({ data: [{ model: "partial" }] }));
assert.deepEqual(projectCodexModels(parseModelListResult({ data: [{
  id: "empty", model: "empty", displayName: "Empty", hidden: false, isDefault: true,
  inputModalities: ["text", "image"], supportedReasoningEfforts: [],
}] })), []);

const { provisionCodexWorkspace, readReviewFlowSkill } = await import("../workspace.ts");
const provisioned = provisionCodexWorkspace({ dir });
assert.match(
  readFileSync(provisioned.instructionsPath, "utf8"),
  /separately user-editable[\s\S]*user review instructions/,
);
writeFileSync(provisioned.instructionsPath, "user-owned Codex instructions\n");
writeFileSync(provisioned.skillPath, "stale bridge skill\n");
rmSync(join(dir, "CLAUDE.md"));
provisionCodexWorkspace({ dir });
assert.equal(readFileSync(provisioned.instructionsPath, "utf8"), "user-owned Codex instructions\n");
assert.equal(readFileSync(provisioned.skillPath, "utf8"), readReviewFlowSkill());
const unsafe = join(root, "unsafe");
mkdirSync(join(unsafe, "notes"), { recursive: true });
symlinkSync(unsafe, join(unsafe, ".agents"));
writeFileSync(join(unsafe, "CLAUDE.md"), "instructions");
assert.throws(() => provisionCodexWorkspace({ dir: unsafe }), /unsafe Codex skill directory/);
const unsafeNotes = join(root, "unsafe-notes"), outsideNotes = join(root, "outside-notes");
mkdirSync(unsafeNotes); mkdirSync(outsideNotes); writeFileSync(join(unsafeNotes, "CLAUDE.md"), "instructions");
symlinkSync(outsideNotes, join(unsafeNotes, "notes"));
assert.throws(() => provisionCodexWorkspace({ dir: unsafeNotes }), /unsafe Codex notes directory/);
assert.throws(() => createCodexDiscoveryPolicy({ dir: unsafeNotes }), /notes directory/);
const fileNotes = join(root, "file-notes"); mkdirSync(fileNotes); writeFileSync(join(fileNotes, "notes"), "not-dir");
assert.throws(() => createCodexDiscoveryPolicy({ dir: fileNotes }), /notes directory/);
const unsafeInstructions = join(root, "unsafe-instructions");
mkdirSync(join(unsafeInstructions, "notes"), { recursive: true });
writeFileSync(join(unsafeInstructions, "CLAUDE.md"), "instructions");
symlinkSync(join(root, "missing"), join(unsafeInstructions, "AGENTS.md"));
assert.throws(() => provisionCodexWorkspace({ dir: unsafeInstructions }), /unsafe Codex instructions file/);
const unsafeSeed = join(root, "unsafe-seed"), outsideSeed = join(root, "outside-seed");
mkdirSync(join(unsafeSeed, "notes"), { recursive: true }); writeFileSync(outsideSeed, "outside-secret");
symlinkSync(outsideSeed, join(unsafeSeed, "CLAUDE.md"));
assert.throws(() => provisionCodexWorkspace({ dir: unsafeSeed }), /unsafe Codex seed file/);
assert.equal(readFileSync(outsideSeed, "utf8"), "outside-secret");
const fifoRoot = join(root, "fifo-seed"), fifoSeed = join(fifoRoot, "CLAUDE.md");
mkdirSync(join(fifoRoot, "notes"), { recursive: true });
// Windows has no mkfifo; retain non-regular-source coverage there with a directory.
if (process.platform === "win32") mkdirSync(fifoSeed); else execFileSync("mkfifo", [fifoSeed]);
const workspaceUrl = JSON.stringify(new URL("../workspace.ts", import.meta.url).href);
const fifoScript = [
  `import { provisionCodexWorkspace as p } from ${workspaceUrl};`,
  `p({ dir: ${JSON.stringify(fifoRoot)} });`,
].join("");
const fifoResult = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", fifoScript],
  { encoding: "utf8", timeout: 2_000 });
assert.equal(fifoResult.error, undefined); assert.notEqual(fifoResult.status, 0);
assert.match(fifoResult.stderr, /unsafe Codex seed file/);
const hardlinkRoot = join(root, "hardlink-skill"), outsideSkill = join(root, "outside-skill");
mkdirSync(join(hardlinkRoot, "notes"), { recursive: true }); writeFileSync(join(hardlinkRoot, "CLAUDE.md"), "seed");
provisionCodexWorkspace({ dir: hardlinkRoot }); writeFileSync(outsideSkill, "outside-skill");
rmSync(join(hardlinkRoot, ".agents", "skills", "review-flow", "SKILL.md"));
linkSync(outsideSkill, join(hardlinkRoot, ".agents", "skills", "review-flow", "SKILL.md"));
assert.throws(() => provisionCodexWorkspace({ dir: hardlinkRoot }), /unsafe Codex skill file/);
assert.equal(readFileSync(outsideSkill, "utf8"), "outside-skill");

const wait = async () => new Promise<void>(resolve => setImmediate(resolve));
const logs: string[] = [], notifications: string[] = [], serverRequests: string[] = [];
let child: FakeChild | undefined, spawns = 0;
const client = new CodexClient({
  policy, clientVersion: "test", log: (...values) => logs.push(values.map(String).join(" ")),
  childFactory: () => { spawns++; return child = new FakeChild(); },
  onNotification: message => notifications.push(message.method),
  onRequest: async request => { serverRequests.push(request.method); return { accepted: true }; },
});
assert.equal(spawns, 0, "Codex child stays lazy");
const connecting = client.connect(); await wait();
assert.equal(spawns, 1); assert.equal(child?.sent[0]?.method, "initialize");
child!.send({
  id: 1,
  result: {
    userAgent: "codex_app_server/0.154.0", codexHome: "/owned", platformFamily: "unix", platformOs: "macos",
  },
}, 17);
assert.equal((await connecting).platformOs, "macos");
assert.equal(child!.sent[1]?.method, "initialized");
const echoed = client.request({
  method: "fixture/echo",
  params: { value: 1 },
  parse: value => z.object({ value: z.string() }).parse(value),
});
await wait();
const echoId = child!.sent.at(-1)?.id;
const coalesced = [
  { method: "fixture/event", params: { n: 1 } },
  { id: "server-1", method: "approval/request", params: {} },
  { id: echoId, result: { value: "ok" } },
].map(message => JSON.stringify(message)).join("\n");
child!.stdout.write(`${coalesced}\n`);
assert.deepEqual(await echoed, { value: "ok" }); await wait();
assert.deepEqual([notifications, serverRequests], [["fixture/event"], ["approval/request"]]);
assert.deepEqual(child!.sent.at(-1), { id: "server-1", result: { accepted: true } });
child!.stderr.write("diagnostic split"); child!.stderr.write(" line\n");
assert.ok(logs.some(line => line.includes("diagnostic split line")));
const rpcRejected = client.request({ method: "fixture/rejected", params: {}, parse: String });
await wait(); child!.send({ id: child!.sent.at(-1)?.id, error: { code: 410, message: "gone" } });
await assert.rejects(rpcRejected, error => error instanceof CodexRpcError && error.code === 410);
const malformedResult = client.request({
  method: "fixture/typed", params: {}, parse: value => z.object({ ok: z.boolean() }).parse(value),
});
await wait(); child!.send({ id: child!.sent.at(-1)?.id, result: { ok: "no" } });
await assert.rejects(malformedResult, /Invalid Codex fixture\/typed response/);
const recovered = client.request({
  method: "fixture/recovered", params: {}, parse: value => z.literal("yes").parse(value),
});
await wait(); child!.send({ id: child!.sent.at(-1)?.id, result: "yes" });
assert.equal(await recovered, "yes");
child!.stderr.write("diagnostic tail");
client.dispose(); assert.equal(child!.killed, true);
assert.ok(logs.some(line => line.includes("diagnostic tail")));
await assert.rejects(client.request({ method: "after/dispose", params: {}, parse: String }), /disposed/);

const unsupportedChild = new FakeChild();
const unsupported = new CodexClient({
  policy, clientVersion: "test", log: () => {}, childFactory: () => unsupportedChild,
});
const unsupportedConnect = unsupported.connect(); await wait();
unsupportedChild.send({
  id: 1,
  result: { userAgent: "codex/0.154.0", codexHome: "/owned", platformFamily: "unix", platformOs: "linux" },
});
await unsupportedConnect; unsupportedChild.send({ id: 77, method: "unknown/server", params: {} }); await wait();
assert.deepEqual(unsupportedChild.sent.at(-1), {
  id: 77,
  error: { code: -32601, message: "Unsupported server request: unknown/server" },
});
unsupported.dispose();

const retiredNotifications: string[] = [], retiredRequests: string[] = [];
const retirementChild = new FakeChild((message, server) => {
  if (message.method === "initialize") server.send({ id: message.id,
    result: { userAgent: "codex/0.154.0", codexHome: "/owned", platformFamily: "unix", platformOs: "linux" } });
});
let retirementClient: CodexClient;
retirementClient = new CodexClient({ policy, clientVersion: "test", log: () => {}, childFactory: () => retirementChild,
  onNotification: message => {
    retiredNotifications.push(message.method); if (message.method === "retire") retirementClient.dispose();
  }, onRequest: async request => { retiredRequests.push(request.method); return {}; } });
await retirementClient.connect();
retirementChild.stdout.write([
  { method: "retire", params: {} }, { method: "after-retirement", params: {} },
  { id: "late-server", method: "after-retirement/request", params: {} },
].map(message => JSON.stringify(message)).join("\n") + "\n");
await wait();
assert.deepEqual(retiredNotifications, ["retire"]); assert.deepEqual(retiredRequests, []);

async function connectedFixture(args?: { maxLineBytes?: number; maxOutputBytes?: number }) {
  const fixture = new FakeChild();
  const fixtureClient = new CodexClient({ policy, clientVersion: "test", log: () => {}, childFactory: () => fixture,
    maxLineBytes: args?.maxLineBytes, maxOutputBytes: args?.maxOutputBytes });
  const promise = fixtureClient.connect(); await wait();
  fixture.send({
    id: 1,
    result: { userAgent: "codex/0.154.0", codexHome: "/owned", platformFamily: "unix", platformOs: "linux" },
  });
  await promise; return { fixture, fixtureClient };
}
const fragmented = await connectedFixture();
const fragmentedPending = fragmented.fixtureClient.request({ method: "fragmented", params: {}, parse: String });
await wait();
const fragmentedResponse = { id: fragmented.fixture.sent.at(-1)?.id, result: "héllo" };
const fragmentedLine = Buffer.from(`${JSON.stringify(fragmentedResponse)}\r\n`);
for (const byte of fragmentedLine) fragmented.fixture.stdout.write(Buffer.from([byte]));
assert.equal(await fragmentedPending, "héllo");
const buffered = Reflect.get(fragmented.fixtureClient, "stdoutBuffer");
assert.ok(buffered && typeof buffered === "object"); assert.deepEqual(Reflect.get(buffered, "newlines"), []);
fragmented.fixtureClient.dispose();
const malformed = await connectedFixture();
const malformedPending = malformed.fixtureClient.request({ method: "pending", params: {}, parse: String });
await wait();
malformed.fixture.stdout.write("{not json}\n");
await assert.rejects(malformedPending, /Malformed Codex RPC message/); assert.equal(malformed.fixture.killed, true);
const incomplete = await connectedFixture();
const incompletePending = incomplete.fixtureClient.request({ method: "pending", params: {}, parse: String });
await wait();
incomplete.fixture.stdout.write("{\"id\":"); incomplete.fixture.stdout.end();
await assert.rejects(incompletePending, /incomplete RPC frame/);
const eof = await connectedFixture();
const eofPending = eof.fixtureClient.request({ method: "pending", params: {}, parse: String });
await wait(); eof.fixture.stdout.end();
await assert.rejects(eofPending, /stdout closed unexpectedly/);
const exited = await connectedFixture();
const exitPending = exited.fixtureClient.request({ method: "pending", params: {}, parse: String }); await wait();
exited.fixture.emit("exit", 9, null);
await assert.rejects(exitPending, /exited unexpectedly \(code 9\)/);
const timeoutFixture = new FakeChild((message, server) => {
  if (message.method === "initialize") server.send({
    id: message.id,
    result: { userAgent: "codex/0.154.0", codexHome: "/owned", platformFamily: "unix", platformOs: "linux" },
  });
});
const lateCallbacks: string[] = [];
const timedOut = new CodexClient({ policy, clientVersion: "test", log: () => {}, childFactory: () => timeoutFixture,
  requestTimeoutMs: 5, onNotification: message => lateCallbacks.push(message.method) });
await timedOut.connect();
await assert.rejects(timedOut.request({ method: "never/replies", params: {}, parse: String }), /timed out after 5ms/);
assert.equal(timeoutFixture.killed, true);
await assert.rejects(timedOut.request({ method: "after-timeout", params: {}, parse: String }), /timed out/);
timeoutFixture.send({ method: "late/event", params: {} }); assert.deepEqual(lateCallbacks, []);
const outbound = await connectedFixture({ maxLineBytes: 256 });
await assert.rejects(
  outbound.fixtureClient.request({ method: "too/large", params: { value: "x".repeat(300) }, parse: String }),
  /exceeds bounded line limit/,
);
outbound.fixtureClient.dispose();
const bounded = await connectedFixture({ maxLineBytes: 256 });
const boundPending = bounded.fixtureClient.request({ method: "pending", params: {}, parse: String }); await wait();
bounded.fixture.stdout.write("x".repeat(257));
await assert.rejects(boundPending, /bounded line limit/);
const stdinChild = new FakeChild();
const stdinClient = new CodexClient({ policy, clientVersion: "test", log: () => {}, childFactory: () => stdinChild });
const stdinPending = stdinClient.connect(); await wait();
setImmediate(() => stdinChild.stdin.emit("error", new Error("asynchronous EPIPE")));
await assert.rejects(stdinPending, /stdin failed: asynchronous EPIPE/); assert.equal(stdinChild.killed, true);
assert.doesNotThrow(() => stdinChild.stdin.emit("error", new Error("late EPIPE")));
for (const stream of ["stdout", "stderr"] as const) {
  const outputChild = new FakeChild();
  const outputClient = new CodexClient({ policy, clientVersion: "test", log: () => {}, childFactory: () => outputChild,
    onNativeOutput: () => { throw new Error(`${stream} observer failed`); } });
  const pending = outputClient.connect(); await wait(); outputChild[stream].write("x");
  await assert.rejects(pending, new RegExp(`${stream} observer failed`)); assert.equal(outputChild.killed, true);
}
const aggregate = await connectedFixture({ maxOutputBytes: 200 });
const aggregatePending = aggregate.fixtureClient.request({ method: "pending", params: {}, parse: String });
await wait(); aggregate.fixture.stderr.write("x".repeat(200));
await assert.rejects(aggregatePending, /bounded aggregate limit/);

const configFor = (selected: CodexExecutionPolicy): Record<string, unknown> => ({
  default_permissions: CODEX_PERMISSION_PROFILE,
  approvals_reviewer: "user",
  approval_policy: { granular: {
    sandbox_approval: true, rules: true, mcp_elicitations: false, request_permissions: true, skill_approval: false,
  } },
  web_search: "disabled",
  features: {
    apps: false, plugins: false, multi_agent: false, remote_plugin: false, hooks: false, goals: false, memories: false,
    web_search: false, web_search_cached: false, web_search_request: false, skill_mcp_dependency_install: false,
  },
  agents: { enabled: false }, feedback: { enabled: false }, apps: { _default: { enabled: false } }, plugins: {},
  mcp_servers: { "figma-desktop": { enabled: true, url: "http://127.0.0.1:3845/mcp" } },
  permissions: { [CODEX_PERMISSION_PROFILE]: {
    description: "Sesori Review: workspace read-only, notes write-only",
    filesystem: {
      ":minimal": "read", [selected.dir]: "read", [selected.notesDir]: "write", [selected.appRepo!]: "read",
    },
    network: { enabled: false },
  } },
});
const discoveryConfig = configFor(policy);
discoveryConfig.mcp_servers = { "owner.with.dot": { enabled: true }, 'owner"quote': { enabled: true } };
discoveryConfig.plugins = { "plugin.with.dot": { enabled: true } };
discoveryConfig.apps = { _default: { enabled: false }, 'app"quote': { enabled: true } };
const inventory = discoverCodexIsolation({ config: discoveryConfig, origins: {} });
assert.deepEqual(inventory, {
  mcpServerNames: ['owner"quote', "owner.with.dot"], pluginNames: ["plugin.with.dot"], appNames: ['app"quote'],
});
const isolatedPolicy = createCodexExecutionPolicy({ dir, appRepo, isolation: inventory });
const mcpOverride = isolatedPolicy.args.find(value => value.startsWith("mcp_servers="));
assert.ok(mcpOverride?.includes('"owner.with.dot" = { enabled = false }'));
assert.ok(mcpOverride?.includes('"owner\\\"quote" = { enabled = false }'));
assert.ok(isolatedPolicy.args.some(value => value.startsWith("plugins=")
  && value.includes('"plugin.with.dot" = { enabled = false }')));
assert.ok(isolatedPolicy.args.some(value => value.startsWith("apps=")
  && value.includes('"app\\\"quote" = { enabled = false }')));
assert.throws(
  () => createCodexExecutionPolicy({
    dir, appRepo, isolation: { ...emptyIsolation, mcpServerNames: ["figma-desktop"] },
  }),
  /collides/,
);
const unsafeApproval = configFor(policy);
unsafeApproval.approval_policy = "never";
assert.throws(
  () => assertCodexConfigIsolated({ result: { config: unsafeApproval, origins: {} }, policy }),
  /granular approval policy/,
);
const unsafeConfig = configFor(policy);
const unsafeProfile = (unsafeConfig.permissions as Record<string, Record<string, Record<string, unknown>>>)[
  CODEX_PERMISSION_PROFILE
];
unsafeProfile.filesystem[policy.appRepo!] = "write";
assert.throws(
  () => assertCodexConfigIsolated({ result: { config: unsafeConfig, origins: {} }, policy }),
  /differs from bridge-owned/,
);
const inheritedProfile = configFor(policy);
const inheritedPermission = (inheritedProfile.permissions as Record<string, Record<string, unknown>>)[
  CODEX_PERMISSION_PROFILE
];
inheritedPermission.extends = "full-access";
assert.throws(
  () => assertCodexConfigIsolated({ result: { config: inheritedProfile, origins: {} }, policy }),
  /permission profile differs/,
);
const inheritedNetwork = configFor(policy);
type TestPermission = Record<string, Record<string, unknown>>;
const inheritedNetworkProfiles = inheritedNetwork.permissions as Record<string, TestPermission>;
const inheritedNetworkProfile = inheritedNetworkProfiles[CODEX_PERMISSION_PROFILE];
inheritedNetworkProfile.network.proxy_url = "http://proxy.invalid";
assert.throws(
  () => assertCodexConfigIsolated({ result: { config: inheritedNetwork, origins: {} }, policy }),
  /permission profile differs/,
);
const defaultedConfig = configFor(policy);
const defaultedMcp = (defaultedConfig.mcp_servers as Record<string, Record<string, unknown>>)["figma-desktop"];
defaultedMcp.environment_id = "local";
defaultedMcp.tool_timeout_sec = null;
const defaultedProfile = (defaultedConfig.permissions as Record<string, Record<string, Record<string, unknown>>>)[
  CODEX_PERMISSION_PROFILE
];
defaultedProfile.filesystem.glob_scan_max_depth = null;
assert.doesNotThrow(() => assertCodexConfigIsolated({ result: { config: defaultedConfig, origins: {} }, policy }));
const collidingConfig = configFor(policy);
const collidingMcp = (collidingConfig.mcp_servers as Record<string, Record<string, unknown>>)["figma-desktop"];
collidingMcp.command = "inherited-command";
assert.throws(
  () => assertCodexConfigIsolated({ result: { config: collidingConfig, origins: {} }, policy }),
  /transport is not isolated/,
);
const discoveryPolicy = createCodexDiscoveryPolicy({ dir, appRepo, command: "/qualified/codex" });
const discoveryChild = new FakeChild((message, server) => {
  if (message.method === "initialize") server.send({
    id: message.id,
    result: { userAgent: "codex/0.154.0", codexHome: "/real", platformFamily: "unix", platformOs: "macos" },
  });
  if (message.method === "config/read") server.send({
    id: message.id, result: { config: discoveryConfig, origins: {}, layers: [] },
  });
});
assert.deepEqual(await discoverCodexRuntime({
  policy: discoveryPolicy,
  client: new CodexClient({
    policy: discoveryPolicy, clientVersion: "test", log: () => {}, childFactory: () => discoveryChild,
  }),
}), inventory);
assert.deepEqual(discoveryChild.sent.map(message => message.method), ["initialize", "initialized", "config/read"]);
const qualificationChild = new FakeChild((message, server) => {
  const id = message.id, method = message.method;
  if (method === "initialize") server.send({
    id,
    result: {
      userAgent: "codex_app_server/0.154.0", codexHome: "/real", platformFamily: "unix", platformOs: "macos",
    },
  });
  if (method === "account/read") server.send({
    id,
    result: { requiresOpenaiAuth: true, account: { type: "chatgpt", email: null, planType: "plus" } },
  });
  if (method === "model/list") server.send({ id, result: { data: [{
    id: "qualified", model: "qualified", displayName: "Qualified", hidden: false, isDefault: true,
    inputModalities: ["text", "image"], supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Low" }],
  }, {
    id: "no-effort", model: "no-effort", displayName: "No effort", hidden: false, isDefault: false,
    inputModalities: ["text", "image"], supportedReasoningEfforts: [],
  }] } });
  if (method === "permissionProfile/list") server.send({
    id, result: { data: [{ id: CODEX_PERMISSION_PROFILE, allowed: true }] },
  });
  if (method === "config/read") server.send({ id, result: { config: configFor(policy), origins: {} } });
});
const qualification = await qualifyCodexRuntime({
  policy,
  client: new CodexClient({ policy, clientVersion: "test", log: () => {}, childFactory: () => qualificationChild }),
});
assert.deepEqual(qualification, {
  version: "0.154.0", auth: "chatgpt", models: [{ value: "qualified", label: "Qualified", efforts: ["low"] }],
});
const noEffortChild = new FakeChild((message, server) => {
  if (message.method === "initialize") server.send({ id: message.id,
    result: { userAgent: "codex/0.154.0", codexHome: "/real", platformFamily: "unix", platformOs: "linux" } });
  if (message.method === "account/read") server.send({ id: message.id,
    result: { requiresOpenaiAuth: true, account: { type: "apiKey" } } });
  if (message.method === "model/list") server.send({ id: message.id, result: { data: [{
    id: "empty", model: "empty", displayName: "Empty", hidden: false, isDefault: true,
    inputModalities: ["text", "image"], supportedReasoningEfforts: [],
  }] } });
});
await assert.rejects(qualifyCodexRuntime({ policy,
  client: new CodexClient({ policy, clientVersion: "test", log: () => {}, childFactory: () => noEffortChild }),
}), /no qualified text\/image model/);
const leakingChild = new FakeChild((message, server) => {
  const id = message.id, method = message.method;
  if (method === "initialize") server.send({
    id,
    result: { userAgent: "codex/0.154.0", codexHome: "/real", platformFamily: "unix", platformOs: "linux" },
  });
  if (method === "account/read") server.send({
    id, result: { requiresOpenaiAuth: true, account: { type: "apiKey" } },
  });
  if (method === "model/list") server.send({ id, result: { data: [{
    id: "m", model: "m", displayName: "M", hidden: false, isDefault: true,
    inputModalities: ["text", "image"], supportedReasoningEfforts: [{ reasoningEffort: "low" }],
  }] } });
  if (method === "permissionProfile/list") server.send({
    id, result: { data: [{ id: CODEX_PERMISSION_PROFILE, allowed: true }] },
  });
  if (method === "config/read") {
    const config = configFor(policy);
    (config.mcp_servers as Record<string, unknown>).personal = { enabled: true };
    server.send({ id, result: { config, origins: {} } });
  }
});
await assert.rejects(qualifyCodexRuntime({
  policy, client: new CodexClient({ policy, clientVersion: "test", log: () => {}, childFactory: () => leakingChild }),
}), /unrelated MCP servers: figma-desktop, personal/);
console.log("codex transport and execution check ok");
