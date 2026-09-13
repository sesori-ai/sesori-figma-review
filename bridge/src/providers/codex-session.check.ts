import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ProviderOutput, ProviderRequestBoundary } from "./types.ts";
import type { ProviderSettings, ToolResult } from "../../../shared/protocol.ts";
import { CodexRpcError } from "./codex-client.ts";
import { assertCodexLocalDefaults, CODEX_PERMISSION_PROFILE, type CodexExecutionPolicy } from "./codex-execution.ts";
import {
  codexThreadItem, codexUsageAvailability, parseAccountUsageResult, parseCodexNotification, parseDynamicToolRequest,
  parseModelListResult, parseThreadStartResult, projectCodexModels, type CodexNotification,
  type CodexServerRequest, type CodexThreadStartResult,
} from "./codex-protocol.ts";
import {
  CodexProvider, CodexResumeError, CodexSettingsError, CodexThreadPolicyMismatchError, diagnoseCodexThreadPolicy,
  projectCodexHistory, resolveCodexSettings,
  type CodexThreadPolicyField,
} from "./codex.ts";

assert.doesNotThrow(() => parseDynamicToolRequest({ threadId: "thread", turnId: "turn", callId: "call", tool: "focus",
  arguments: {} }), "native dynamic-tool requests do not carry itemId");
assert.doesNotThrow(() => parseCodexNotification({ method: "turn/started", params: {
  threadId: "thread", turn: { id: "turn", items: [], status: "inProgress" },
} }), "native turn lifecycle notifications carry turn id inside turn");
assert.throws(() => codexThreadItem.parse({ type: "agentMessage", id: "malformed" }),
  "malformed known items cannot fall through to ignored history");
assert.deepEqual(codexThreadItem.parse({ type: "futureItem", id: "forward-compatible", private: true }),
  { type: "ignored", id: "forward-compatible" });
const reorderedModels = projectCodexModels(parseModelListResult({ data: [{
  id: "first", model: "first", displayName: "First", hidden: false, isDefault: false,
  defaultReasoningEffort: "low", inputModalities: ["text", "image"],
  supportedReasoningEfforts: [{ reasoningEffort: "low" }],
}, {
  id: "default", model: "default", displayName: "Default", hidden: false, isDefault: true,
  defaultReasoningEffort: "medium", inputModalities: ["text", "image"],
  supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }],
}] }));
assert.deepEqual(resolveCodexSettings({ qualification: { version: "test", auth: "chatgpt", models: reorderedModels },
  settings: { model: "", effort: "" } }), { model: "default", effort: "medium" },
"blank Codex settings honor advertised model and effort defaults rather than catalog order");

const root = mkdtempSync(join(tmpdir(), "codex-session-"));
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const dir = join(root, "workspace"), appRepo = join(root, "app");
mkdirSync(join(dir, "notes"), { recursive: true }); mkdirSync(appRepo);
const codexHome = join(root, "codex-home"); mkdirSync(codexHome); process.env.CODEX_HOME = codexHome;
assert.doesNotThrow(assertCodexLocalDefaults);
writeFileSync(join(codexHome, "environments.toml"), "default = 'local'");
assert.throws(assertCodexLocalDefaults, /requires an absent environment manifest/);
rmSync(join(codexHome, "environments.toml"));
process.env.CODEX_EXEC_SERVER_URL = "remote";
assert.throws(assertCodexLocalDefaults, /blocked by environment registration input/);
delete process.env.CODEX_EXEC_SERVER_URL;
writeFileSync(join(dir, "CLAUDE.md"), "User instructions\n");
writeFileSync(join(dir, "permissions.json"), JSON.stringify({ allow: [] }));
writeFileSync(join(dir, "sessions.json"), "[]\n");
process.env.APP_REPO = appRepo;

const effectiveConfig = (policy: CodexExecutionPolicy) => ({
  default_permissions: CODEX_PERMISSION_PROFILE,
  approvals_reviewer: "user",
  approval_policy: { granular: {
    sandbox_approval: false, rules: true, mcp_elicitations: false, request_permissions: true, skill_approval: false,
  } },
  web_search: "disabled",
  features: {
    apps: false, plugins: false, multi_agent: false, remote_plugin: false, hooks: false, goals: false, memories: false,
    web_search: false, web_search_cached: false, web_search_request: false, skill_mcp_dependency_install: false,
    request_permissions_tool: true, step_model_switching: true,
  },
  agents: { enabled: false }, feedback: { enabled: false }, apps: { _default: { enabled: false } }, plugins: {},
  mcp_servers: { "figma-desktop": { enabled: true, url: "http://127.0.0.1:3845/mcp" } },
  permissions: { [CODEX_PERMISSION_PROFILE]: {
    description: "Sesori Review: workspace read-only, notes write-only",
    filesystem: {
      ":minimal": "read", [policy.dir]: "read", [policy.notesDir]: "write", [policy.appRepo!]: "read",
    },
    network: { enabled: false },
  } },
});

type RpcArgs<T> = { method: string; params: unknown; parse: (value: unknown) => T; waitForSlot?: boolean };
type Call = { method: string; params: unknown };
class FakeClient {
  calls: Call[] = [];
  disposed = 0;
  responses = new Map<string, unknown>();
  responseQueues = new Map<string, Promise<unknown>[]>();
  ackGates = new Map<string, Promise<void>>();
  failures = new Map<string, Error>();
  confirmSettings = true;
  initialSettingsNotifications = 0;
  turnStartOrder: "none" | "settings-before-response" | "settings-response-started" | "response-settings-started"
    | "settings-started-response" | "settings-started-completed-response" | "response-started-settings"
    = "settings-before-response";
  nativeSettings = { model: "codex-cheap", effort: "low", serviceTier: "default" as const };
  retirementGate?: Promise<void>;
  constructor(readonly args: {
    policy: CodexExecutionPolicy;
    onRequest?: (request: CodexServerRequest) => Promise<unknown>;
    onNotification?: (notification: CodexNotification) => void;
    onTerminal?: (error: Error) => void;
  }, readonly kind: "discovery" | "runtime") {}
  async connect() {
    this.calls.push({ method: "initialize", params: {} });
    return { userAgent: "codex_app_server/0.154.0", codexHome: "/owned", platformFamily: "unix", platformOs: "macos" };
  }
  async request<T>(args: RpcArgs<T>): Promise<T> {
    this.calls.push({ method: args.method, params: args.params });
    const failure = this.failures.get(args.method);
    if (failure) { this.failures.delete(args.method); throw failure; }
    const queued = this.responseQueues.get(args.method)?.shift();
    let response = queued ? await queued : this.responses.get(args.method);
    if (response === undefined) response = this.defaultResponse(args.method, args.params);
    if (args.method === "thread/settings/update" && this.confirmSettings) {
      const settings = args.params as { threadId: string; model: string; effort: string };
      this.nativeSettings = { model: settings.model, effort: settings.effort, serviceTier: "default" };
      this.notify("thread/settings/updated", { threadId: settings.threadId, threadSettings: this.nativeSettings });
    }
    if (args.method === "turn/start") {
      const turn = args.params as { threadId: string }, turnId = (response as { turn: { id: string } }).turn.id;
      const settings = () => { this.initialSettingsNotifications++;
        this.notify("thread/settings/updated", { threadId: turn.threadId, threadSettings: this.nativeSettings }); };
      const started = () => this.notify("turn/started", { threadId: turn.threadId, turnId,
        turn: { id: turnId, items: [], status: "inProgress" } });
      if (this.turnStartOrder.startsWith("settings-")) settings();
      if (["settings-started-response", "settings-started-completed-response"].includes(this.turnStartOrder)) started();
      if (this.turnStartOrder === "settings-started-completed-response") {
        this.notify("turn/completed", { threadId: turn.threadId,
          turn: { id: turnId, items: [], status: "completed" } });
      }
      if (this.turnStartOrder === "settings-response-started") setImmediate(started);
      if (this.turnStartOrder === "response-settings-started") setImmediate(() => { settings(); started(); });
      if (this.turnStartOrder === "response-started-settings") setImmediate(() => { started(); settings(); });
    }
    await this.ackGates.get(args.method);
    return args.parse(response);
  }
  private optionalAccountingPending = false;
  private optionalAccountingDrain?: Promise<void>;
  private resolveOptionalAccounting?: () => void;
  async requestOptionalAccounting<T>(args: RpcArgs<T>): Promise<T | undefined> {
    if (this.optionalAccountingPending) {
      if (!args.waitForSlot || !this.optionalAccountingDrain) return undefined;
      await this.optionalAccountingDrain;
      if (this.optionalAccountingPending) return undefined;
    }
    this.optionalAccountingPending = true;
    this.optionalAccountingDrain = new Promise(resolve => { this.resolveOptionalAccounting = resolve; });
    try { return await this.request(args); }
    finally {
      this.optionalAccountingPending = false; this.resolveOptionalAccounting?.();
      this.optionalAccountingDrain = undefined; this.resolveOptionalAccounting = undefined;
    }
  }
  private defaultResponse(method: string, params: unknown): unknown {
    if (method === "config/read") {
      const config = effectiveConfig(this.args.policy);
      return { config: this.kind === "discovery" ? { ...config, mcp_servers: {} } : config, origins: {} };
    }
    if (method === "account/read") return { requiresOpenaiAuth: true, account: { type: "chatgpt" } };
    if (method === "model/list") return { data: [{
      id: "catalog-first", model: "catalog-first", displayName: "Catalog First", hidden: false, isDefault: false,
      defaultReasoningEffort: "low", inputModalities: ["text", "image"],
      supportedReasoningEfforts: [{ reasoningEffort: "low" }],
    }, {
      id: "codex-cheap", model: "codex-cheap", displayName: "Codex Cheap", hidden: false, isDefault: true,
      defaultReasoningEffort: "medium", inputModalities: ["text", "image"],
      supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }],
    }] };
    if (method === "permissionProfile/list") return { data: [{ id: CODEX_PERMISSION_PROFILE, allowed: true }] };
    if (method === "thread/start" || method === "thread/resume") {
      const values = params as { threadId?: string; cwd: string; runtimeWorkspaceRoots: string[];
        config: { model_reasoning_effort: string; project_doc_max_bytes: number } };
      return { thread: { id: values.threadId ?? "thread-new", turns: [],
        environments: [this.args.policy.thread.defaultEnvironment] },
        model: "codex-cheap", cwd: values.cwd, runtimeWorkspaceRoots: values.runtimeWorkspaceRoots,
        approvalsReviewer: "user",
        approvalPolicy: this.args.policy.thread.approvalPolicy,
        activePermissionProfile: { id: CODEX_PERMISSION_PROFILE },
        reasoningEffort: values.config.model_reasoning_effort, serviceTier: "default" };
    }
    if (method === "turn/start") return { turn: { id: "turn-new", items: [], status: "inProgress" } };
    if (method === "turn/steer") return { turnId: "turn-new" };
    if (method === "turn/settings/update") return { status: "applied" };
    if (method === "account/usage/read") return { threadUsage: {
      threadId: (params as { threadId: string }).threadId, estimatedUsageUsdMicros: 125_000,
    } };
    return {};
  }
  dispose() { this.disposed++; }
  async disposeAndWait() { this.dispose(); await this.retirementGate; }
  notify(method: string, params: unknown) { this.args.onNotification?.({ method, params }); }
  terminate(error: Error) { this.args.onTerminal?.(error); }
  server(method: string, params: unknown, id: number = 1) {
    assert.ok(this.args.onRequest); return this.args.onRequest!({ id, method, params });
  }
}

const clients: FakeClient[] = [];
const toolCalls: { tool: string; args: Record<string, unknown> }[] = [];
const permissionCalls: { tool: string; input: Record<string, unknown> }[] = [];
let toolGate: Promise<ToolResult> | undefined, permissionBehavior: "allow" | "deny" = "allow";
const boundary: ProviderRequestBoundary = {
  tool: async request => {
    toolCalls.push(request);
    if (toolGate) return toolGate;
    if (request.tool === "get_screen") return { content: [
      { type: "text", text: "screen tree" }, { type: "image", mimeType: "image/png", data: "cG5n" },
    ] };
    return { content: [{ type: "text", text: request.tool === "ask_user" ? "Next" : "ok" }] };
  },
  permission: async request => { permissionCalls.push(request); return permissionBehavior === "allow"
    ? { behavior: "allow" } : { behavior: "deny", message: "fixture denial" }; },
};
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
};
async function waitUntil(args: { predicate: () => boolean; label: string; timeoutMs?: number }) {
  const deadline = Date.now() + (args.timeoutMs ?? 2_000);
  while (!args.predicate() && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.equal(args.predicate(), true, `${args.label} timed out`);
}
const unsafeDir = join(root, "unsafe-workspace"), unsafeTarget = join(root, "unsafe-target");
mkdirSync(unsafeDir); mkdirSync(unsafeTarget); symlinkSync(unsafeTarget, join(unsafeDir, ".agents"));
let unsafeClients = 0, unsafeNotifications = 0;
const unsafeProvider = new CodexProvider({ version: "test", log: () => {}, onPrepared: () => unsafeNotifications++,
  clientFactory: args => { unsafeClients++; return new FakeClient(args, "discovery"); } });
unsafeProvider.prepare({ fileId: "unsafe", dir: unsafeDir,
  settings: { model: "codex-cheap", effort: "low" }, boundary });
await waitUntil({ predicate: () => unsafeProvider.health({ settings: { model: "", effort: "" } }).status === "unavailable",
  label: "unsafe workspace readiness" });
assert.deepEqual([unsafeClients, unsafeNotifications, unsafeProvider.health({ settings: { model: "", effort: "" } }).status],
  [0, 1, "unavailable"], "synchronous unsafe-workspace failure publishes unavailable health without spawning");
unsafeProvider.dispose();

const logs: string[] = [], prepared: string[] = [];
const provider = new CodexProvider({
  version: "test", log: (...values) => logs.push(values.map(String).join(" ")), onPrepared: () => prepared.push("changed"),
  clientFactory: args => {
    const client = new FakeClient(args, clients.length % 2 === 0 ? "discovery" : "runtime"); clients.push(client); return client;
  },
});
const settings: ProviderSettings = { model: "codex-cheap", effort: "low" };
provider.prepare({ fileId: "file", dir, settings, boundary });
await waitUntil({ predicate: () => provider.health({ settings }).status !== "starting", label: "Codex preparation" });
assert.equal(provider.health({ settings }).status, "ready", JSON.stringify(provider.health({ settings })));
assert.equal(provider.health({ settings: { model: "", effort: "" } }).model, "codex-cheap");
assert.equal(clients.length, 2);
assert.equal(clients[0].disposed, 1, "discovery process retires before isolated runtime");
assert.deepEqual(clients[0].calls.map(call => call.method), ["initialize", "config/read"]);
assert.equal(clients[1].calls.some(call => call.method.startsWith("thread/")), false, "prepare creates no empty thread");

const baseRecord = {
  provider: "codex" as const, sessionId: "", title: "Review", anchor: { type: "page" as const, nodeIds: [] },
  pageId: "0:1", pageName: "Page", createdAt: "now", updatedAt: "now", turns: 0,
  costUsd: 0, costStatus: "unavailable" as const, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const session = await provider.start({ fileId: "file", dir, settings, boundary, baseRecord });
let runtime = clients[1];
const iterator = session.output[Symbol.asyncIterator]();
const initialized = (await iterator.next()).value as ProviderOutput;
assert.equal(initialized.kind === "initialized" && initialized.sessionId, "thread-new");
const startCall = runtime.calls.find(call => call.method === "thread/start")!;
const startParams = startCall.params as Record<string, unknown>;
assert.equal((startParams.dynamicTools as unknown[]).length, 5);
assert.deepEqual((startParams.dynamicTools as { name: string }[]).map(tool => tool.name),
  ["get_flow", "get_screen", "focus", "annotate", "ask_user"]);
assert.equal(startParams.permissions, CODEX_PERMISSION_PROFILE);
assert.equal(startParams.allowProviderModelFallback, false);
assert.equal("environments" in startParams, false, "qualified local-only default supplies thread environment");
assert.equal(startParams.serviceTier, "default", "initial turn cannot inherit fast service mode");
assert.equal("effort" in startParams, false, "0.154 thread/start has no effort field");
assert.deepEqual(startParams.config, { model_reasoning_effort: "low", project_doc_max_bytes: 0 });
assert.match(String(startParams.baseInstructions), /User instructions/);

const retainedPolicy = parseThreadStartResult({
  thread: { id: "thread-new", turns: [], environments: [runtime.args.policy.thread.defaultEnvironment] },
  model: "codex-cheap", cwd: runtime.args.policy.thread.cwd,
  runtimeWorkspaceRoots: runtime.args.policy.thread.runtimeWorkspaceRoots, approvalsReviewer: "user",
  approvalPolicy: runtime.args.policy.thread.approvalPolicy,
  activePermissionProfile: { id: CODEX_PERMISSION_PROFILE, extends: null },
  reasoningEffort: "low", serviceTier: "default",
});
const diagnosticArgs = { policy: runtime.args.policy, model: "codex-cheap", effort: "low" };
const assertMismatch = (field: CodexThreadPolicyField, result: CodexThreadStartResult, resume?: string) =>
  assert.deepEqual(diagnoseCodexThreadPolicy({ result, resume, ...diagnosticArgs }),
    { matches: false, fields: [field] }, `privacy-safe diagnostic for ${field}`);
assert.deepEqual(diagnoseCodexThreadPolicy({ result: retainedPolicy, ...diagnosticArgs }), { matches: true, fields: [] });
assertMismatch("threadId", retainedPolicy, "other");
assertMismatch("cwd", { ...retainedPolicy, cwd: `${dir}/other` });
assertMismatch("runtimeWorkspaceRoots", { ...retainedPolicy, runtimeWorkspaceRoots: [dir] });
assertMismatch("environmentSelection", { ...retainedPolicy,
  thread: { ...retainedPolicy.thread, environments: [] } });
assertMismatch("approvalsReviewer", { ...retainedPolicy, approvalsReviewer: "auto_review" });
assertMismatch("approvalPolicy", { ...retainedPolicy, approvalPolicy: { granular: { rules: false } } });
assertMismatch("activePermissionProfile.id", { ...retainedPolicy, activePermissionProfile: { id: ":read-only" } });
assertMismatch("activePermissionProfile.extends", { ...retainedPolicy,
  activePermissionProfile: { id: CODEX_PERMISSION_PROFILE, extends: ":read-only" } });
assertMismatch("model", { ...retainedPolicy, model: "other" });
assertMismatch("reasoningEffort", { ...retainedPolicy, reasoningEffort: "medium" });
assertMismatch("serviceTier", { ...retainedPolicy, serviceTier: null });
const safeMismatch = new CodexThreadPolicyMismatchError(["reasoningEffort"]);
assert.deepEqual({ code: safeMismatch.code, fields: safeMismatch.fields }, {
  code: "CODEX_THREAD_POLICY_MISMATCH", fields: ["reasoningEffort"],
});
assert.equal(safeMismatch.message.includes("medium"), false, "diagnostic contains no observed value");

session.send({ text: "Review this", selection: [{ id: "1:2", name: "Screen", type: "FRAME" }], context: "Figma file X" });
await new Promise(resolve => setImmediate(resolve));
assert.equal(runtime.initialSettingsNotifications, 1,
  "source-supported settings snapshot before turn/start response is accepted without a pending settings update");
assert.equal(Reflect.get(session, "closed"), false);
const firstTurn = runtime.calls.find(call => call.method === "turn/start")!;
const firstInput = (firstTurn.params as { input: { type: string; text?: string }[] }).input;
assert.match(firstInput[0].text!, /Review this[\s\S]*Current selection: Screen \(FRAME 1:2\)/);
assert.deepEqual(firstInput.map(input => input.type), ["text", "skill"]);
assert.deepEqual((firstTurn.params as { environments: unknown }).environments,
  runtime.args.policy.thread.turnEnvironments, "fresh turns select only the reserved local executor");
runtime.notify("turn/started", { threadId: "thread-new", turnId: "turn-new",
  turn: { id: "turn-new", items: [], status: "inProgress" } });
runtime.notify("item/started", { threadId: "thread-new", turnId: "turn-new",
  item: { type: "agentMessage", id: "message-1", text: "" } });
runtime.notify("item/agentMessage/delta", {
  threadId: "thread-new", turnId: "turn-new", itemId: "message-1", delta: "Hello",
});
runtime.notify("item/completed", { threadId: "thread-new", turnId: "turn-new",
  item: { type: "agentMessage", id: "message-1", text: "Hello" } });
assert.deepEqual((await iterator.next()).value, { kind: "event", event: {
  type: "text_start", session: { provider: "codex", sessionId: "thread-new" }, itemId: "message-1",
} });
assert.equal(((await iterator.next()).value as { event: { text: string } }).event.text, "Hello");
assert.equal(((await iterator.next()).value as { event: { type: string } }).event.type, "text_end");

const imageResult = await runtime.server("item/tool/call", {
  threadId: "thread-new", turnId: "turn-new", itemId: "tool-item", callId: "call", namespace: null,
  tool: "get_screen", arguments: { nodeId: "1:2", scale: 2 },
});
assert.deepEqual(imageResult, { success: true, contentItems: [
  { type: "inputText", text: "screen tree" }, { type: "inputImage", imageUrl: "data:image/png;base64,cG5n" },
] });
await assert.rejects(runtime.server("item/tool/call", {
  threadId: "thread-new", turnId: "turn-new", itemId: "bad", callId: "bad", namespace: null,
  tool: "get_screen", arguments: { nodeId: 4 },
}), /expected string/);
assert.deepEqual(await runtime.server("item/tool/call", {
  threadId: "thread-new", turnId: "turn-new", itemId: "unsupported", callId: "unsupported", namespace: "other",
  tool: "get_screen", arguments: { nodeId: "1:2" },
}), { success: false, contentItems: [{ type: "inputText", text: "Unsupported dynamic tool get_screen" }] });

assert.deepEqual(await runtime.server("item/commandExecution/requestApproval", {
  threadId: "thread-new", turnId: "turn-new", itemId: "cmd", startedAtMs: 1, kind: "command",
  command: "ls", cwd: dir, reason: "inspect", availableDecisions: ["accept", "decline"],
}), { decision: "accept" });
assert.deepEqual(permissionCalls.at(-1), { tool: "codex_command", input: {
  command: "ls", cwd: dir, reason: "inspect", additionalPermissions: undefined,
} });
const callsBeforeNetworkAmendments = permissionCalls.length;
for (const escalation of [
  { proposedNetworkPolicyAmendments: [{ host: "example.com" }] },
  { proposedNetworkPolicyAmendments: { enabled: true } },
  { networkApprovalContext: { host: "example.com", protocol: "https" } },
]) {
  assert.deepEqual(await runtime.server("item/commandExecution/requestApproval", {
    threadId: "thread-new", turnId: "turn-new", itemId: "network-command", startedAtMs: 1, kind: "command",
    command: "curl example.com", cwd: dir, ...escalation, availableDecisions: ["accept", "decline"],
  }), { decision: "decline" });
}
assert.equal(permissionCalls.length, callsBeforeNetworkAmendments,
  "network amendments and one-shot contexts are declined before publishing a permission card");
const notesGrant = { fileSystem: { entries: [{ path: { type: "path", path: join(dir, "notes", "proof.txt") },
  access: "write" }] } };
assert.deepEqual(await runtime.server("item/permissions/requestApproval", {
  threadId: "thread-new", turnId: "turn-new", itemId: "notes-scope", startedAtMs: 1, cwd: join(dir, "notes"),
  reason: "confirm notes", permissions: notesGrant,
}), { permissions: notesGrant, scope: "turn" });
assert.deepEqual(permissionCalls.at(-1), { tool: "codex_permission_scope", input: {
  cwd: join(dir, "notes"), reason: "confirm notes", permissions: notesGrant, scope: "turn",
} });
permissionBehavior = "deny";
assert.deepEqual(await runtime.server("item/permissions/requestApproval", {
  threadId: "thread-new", turnId: "turn-new", itemId: "notes-deny", startedAtMs: 1, cwd: join(dir, "notes"),
  reason: "deny extra grant", permissions: notesGrant,
}), { permissions: {}, scope: "turn" }, "denial withholds only the requested extra grant");
permissionBehavior = "allow";
for (const write of ["./relative.txt", pathToFileURL(join(dir, "notes", "uri.txt")).href]) {
  const grant = { fileSystem: { write: [write] } };
  assert.deepEqual(await runtime.server("item/permissions/requestApproval", {
    threadId: "thread-new", turnId: "turn-new", itemId: "notes-relative", startedAtMs: 1,
    cwd: join(dir, "notes"), reason: "write notes", permissions: grant,
  }), { permissions: grant, scope: "turn" }, "relative and local-file URI writes resolve inside request cwd");
}
const configuredPolicyAppRepo = runtime.args.policy.appRepo;
for (const configuredAppRepo of [configuredPolicyAppRepo, undefined]) {
  runtime.args.policy.appRepo = configuredAppRepo;
  for (const [cwd, write] of [
    [dir, appRepo], [dir, join(appRepo, "new", "file")], [dir, join(appRepo, "..")],
    [appRepo, "./relative-app.ts"], [dir, pathToFileURL(join(appRepo, "uri.ts")).href],
    [dir, join(root, "outside.ts")],
  ]) {
    assert.deepEqual(await runtime.server("item/permissions/requestApproval", {
      threadId: "thread-new", turnId: "turn-new", itemId: "scope", startedAtMs: 1, cwd, reason: "write outside notes",
      permissions: { fileSystem: { write: [write] } },
    }), { permissions: {}, scope: "turn" }, "all writes outside notes are denied even without APP_REPO");
  }
  assert.deepEqual(await runtime.server("item/permissions/requestApproval", { threadId: "thread-new", turnId: "turn-new",
    itemId: "network-scope", startedAtMs: 1, cwd: dir, reason: "network", permissions: { network: { enabled: true } } }),
  { permissions: {}, scope: "turn" }, "disabled network cannot be widened with or without APP_REPO");
}
runtime.args.policy.appRepo = configuredPolicyAppRepo;
for (const permissions of [{ futureGrant: true }, { fileSystem: { write: "not-an-array" } },
  { fileSystem: { entries: [{ access: "write", path: { type: "future", path: join(dir, "notes") } }] } }]) {
  assert.deepEqual(await runtime.server("item/permissions/requestApproval", {
    threadId: "thread-new", turnId: "turn-new", itemId: "malformed-scope", startedAtMs: 1,
    cwd: dir, reason: "unknown", permissions,
  }), { permissions: {}, scope: "turn" }, "malformed or unknown permission grants fail closed");
}
runtime.notify("item/started", { threadId: "thread-new", turnId: "turn-new", item: {
  type: "fileChange", id: "patch", status: "inProgress",
  changes: [{ path: join(appRepo, "owned.ts"), kind: { type: "add" }, diff: "+bad" }],
} });
assert.equal(((await iterator.next()).value as { event: { name: string } }).event.name, "file_change");
assert.deepEqual(await runtime.server("item/fileChange/requestApproval", {
  threadId: "thread-new", turnId: "turn-new", itemId: "patch", startedAtMs: 1, reason: "write",
}), { decision: "decline" });
runtime.args.policy.appRepo = undefined;
runtime.notify("item/started", { threadId: "thread-new", turnId: "turn-new", item: {
  type: "fileChange", id: "patch-without-app", status: "inProgress",
  changes: [{ path: join(appRepo, "without-app.ts"), kind: { type: "add" }, diff: "+bad" }],
} });
assert.equal(((await iterator.next()).value as { event: { name: string } }).event.name, "file_change");
assert.deepEqual(await runtime.server("item/fileChange/requestApproval", {
  threadId: "thread-new", turnId: "turn-new", itemId: "patch-without-app", startedAtMs: 1, reason: "write",
}), { decision: "decline" }, "file changes outside notes are denied without APP_REPO");
runtime.args.policy.appRepo = configuredPolicyAppRepo;
for (const [itemId, changes, decision] of [
  ["notes-patch", [{ path: "notes/owned.ts", kind: { type: "update", move_path: "notes/moved.ts" }, diff: "+ok" }],
    "accept"],
  ["outside-patch", [{ path: join(root, "outside.ts"), kind: { type: "add" }, diff: "+bad" }], "decline"],
  ["outside-move", [{ path: "notes/owned.ts", kind: { type: "update", move_path: join(appRepo, "moved.ts") },
    diff: "+bad" }], "decline"],
  ["fabricated-move", [{ path: "notes/owned.ts", kind: { type: "update", movePath: "notes/moved.ts" }, diff: "+bad" }],
    "decline"],
] as const) {
  runtime.notify("item/started", { threadId: "thread-new", turnId: "turn-new",
    item: { type: "fileChange", id: itemId, status: "inProgress", changes } });
  assert.equal(((await iterator.next()).value as { event: { name: string } }).event.name, "file_change");
  assert.deepEqual(await runtime.server("item/fileChange/requestApproval", {
    threadId: "thread-new", turnId: "turn-new", itemId, startedAtMs: 1, reason: "write",
  }), { decision });
}

const slow = new Promise<ToolResult>(resolve => setImmediate(() => resolve({ content: [{ type: "text", text: "Free text" }] })));
toolGate = slow;
assert.deepEqual(await runtime.server("item/tool/requestUserInput", {
  threadId: "thread-new", turnId: "turn-new", itemId: "question", isBlocking: true,
  questions: [{ id: "q1", header: "Choice", question: "Continue?", options: [{ label: "Yes", description: "" }] }],
}), { answers: { q1: { answers: ["Free text"] } } });
toolGate = undefined;
assert.deepEqual(toolCalls.at(-1), { tool: "ask_user", args: { question: "Continue?", options: ["Yes"] } });
const interruptedQuestion = deferred<ToolResult>(), toolCallsBeforeInterrupt = toolCalls.length;
toolGate = interruptedQuestion.promise;
const interruptedQuestions = runtime.server("item/tool/requestUserInput", {
  threadId: "thread-new", turnId: "turn-new", itemId: "questions", isBlocking: true,
  questions: [
    { id: "first", header: "First", question: "First?", options: null },
    { id: "second", header: "Second", question: "Second?", options: null },
  ],
});
await waitUntil({ predicate: () => toolCalls.length === toolCallsBeforeInterrupt + 1, label: "first native question" });
await session.interrupt();
interruptedQuestion.resolve({ content: [{ type: "text", text: "stopped" }], isError: true });
await assert.rejects(interruptedQuestions, /user input request was interrupted/);
assert.equal(toolCalls.length, toolCallsBeforeInterrupt + 1, "Stop during first question cannot publish a second card");
toolGate = undefined;

session.send({ text: "Steer", selection: [] }); await new Promise(resolve => setImmediate(resolve));
assert.equal(runtime.calls.filter(call => call.method === "turn/steer").length, 1);
runtime.confirmSettings = false;
let settingsSettled = false;
const settingsUpdate = session.applySettings({ settings: { model: "codex-cheap", effort: "medium" } })
  .then(() => { settingsSettled = true; });
await new Promise(resolve => setImmediate(resolve));
assert.equal(settingsSettled, false, "queued thread ACK is not an applied future-settings confirmation");
runtime.confirmSettings = true;
runtime.notify("thread/settings/updated", { threadId: "thread-new",
  threadSettings: { model: "codex-cheap", effort: "low", serviceTier: "default" } });
await assert.rejects(settingsUpdate,
  error => error instanceof CodexSettingsError && error.category === "confirmation");
assert.equal(settingsSettled, false, "incorrect explicit settings confirmation is rejected");
assert.deepEqual(runtime.calls.slice(-2).map(call => call.method), ["thread/settings/update", "thread/settings/update"],
  "incorrect explicit confirmation restores the last confirmed settings");
await session.applySettings({ settings: { model: "codex-cheap", effort: "medium" } });
assert.deepEqual(runtime.calls.slice(-2).map(call => call.method), ["thread/settings/update", "turn/settings/update"]);
const callsAfterSettings = runtime.calls.length;
await session.applySettings({ settings: { model: "codex-cheap", effort: "medium" } });
assert.equal(runtime.calls.length, callsAfterSettings, "unchanged settings need no duplicate native notification");
runtime.failures.set("thread/settings/update", new CodexRpcError(-32602, "private rejected path"));
await assert.rejects(session.applySettings({ settings: { model: "codex-cheap", effort: "low" } }),
  error => error instanceof CodexSettingsError && error.definitelyUnchanged && !error.message.includes("private"));
assert.equal(runtime.calls.length, callsAfterSettings + 1, "definite pre-mutation rejection needs no no-op rollback");
runtime.confirmSettings = true;
runtime.failures.set("turn/settings/update", new CodexRpcError(-32602, "private native path"));
await assert.rejects(session.applySettings({ settings: { model: "codex-cheap", effort: "low" } }),
  error => error instanceof CodexSettingsError && error.category === "native-rejected"
    && !error.message.includes("private"));
assert.deepEqual(runtime.calls.slice(-3).map(call => call.method),
  ["thread/settings/update", "turn/settings/update", "thread/settings/update"], "failed live update rolls future settings back");
await session.interrupt(); assert.equal(runtime.calls.at(-1)?.method, "turn/interrupt");

runtime.notify("thread/tokenUsage/updated", { threadId: "thread-new", turnId: "turn-new", tokenUsage: { total: {
  totalTokens: 100, inputTokens: 70, cachedInputTokens: 20, cacheWriteInputTokens: 5,
  outputTokens: 30, reasoningOutputTokens: 9,
}, last: {}, modelContextWindow: 1000 } });
const usage = (await iterator.next()).value as Extract<ProviderOutput, { kind: "usage" }>;
assert.deepEqual(usage.usage, { input: 45, output: 30, cacheRead: 20, cacheWrite: 5 });
runtime.notify("turn/completed", { threadId: "thread-new", turnId: "turn-new",
  turn: { id: "turn-new", items: [], status: "interrupted" } });
assert.equal(((await iterator.next()).value as { event: { outcome: string } }).event.outcome, "interrupted");
const completed = (await iterator.next()).value as Extract<ProviderOutput, { kind: "usage" }>;
assert.deepEqual([completed.turnCompleted, completed.cost], [true, { usd: 0, status: "unavailable" }],
  "turn completion is committed before optional cost lookup");
const completedCost = (await iterator.next()).value as Extract<ProviderOutput, { kind: "usage" }>;
assert.deepEqual([completedCost.turnCompleted, completedCost.cost, completedCost.accountingCheckpoint],
  [false, { usd: 0.125, status: "estimated" }, true], "delayed cost checkpoint cannot increment turns twice");

const coalescedCost = deferred<unknown>();
const costCallsBeforeCoalescing = runtime.calls.filter(call => call.method === "account/usage/read").length;
runtime.responseQueues.set("account/usage/read", [coalescedCost.promise]);
for (const turnId of ["cost-older", "cost-newer"]) {
  runtime.notify("turn/started", { threadId: "thread-new", turnId,
    turn: { id: turnId, items: [], status: "inProgress" } });
  runtime.notify("turn/completed", { threadId: "thread-new", turnId,
    turn: { id: turnId, items: [], status: "completed" } });
  assert.equal(((await iterator.next()).value as { event: { type: string } }).event.type, "turn_end");
  assert.equal(((await iterator.next()).value as Extract<ProviderOutput, { kind: "usage" }>).turnCompleted, true);
}
assert.equal(runtime.calls.filter(call => call.method === "account/usage/read").length, costCallsBeforeCoalescing + 1,
  "fast completions share the session's one optional-accounting request");
coalescedCost.resolve({ threadUsage: { threadId: "thread-new", estimatedUsageUsdMicros: 300_000 } });
const newestCost = (await iterator.next()).value as Extract<ProviderOutput, { kind: "usage" }>;
assert.deepEqual([newestCost.turnCompleted, newestCost.cost, newestCost.accountingCheckpoint],
  [false, { usd: 0.3, status: "estimated" }, true], "latest completion consumes the shared valid accounting reply");
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual([Reflect.get(session, "cost"), Reflect.get(Reflect.get(session, "queue"), "values")],
  [{ usd: 0.3, status: "estimated" }, []], "shared accounting emits one latest checkpoint without stale regression");
const advisoryDir = join(root, "advisory-workspace");
mkdirSync(join(advisoryDir, "notes"), { recursive: true });
writeFileSync(join(advisoryDir, "CLAUDE.md"), "instructions");
provider.prepare({ fileId: "other-file", dir: advisoryDir, settings: { model: "codex-cheap", effort: "medium" }, boundary });
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual([clients.length, runtime.disposed, Reflect.get(session, "closed")], [2, 0, false],
  "other-file advisory preparation cannot replace an active runtime");
runtime.responses.set("thread/read", { thread: { id: "thread-new", turns: [] } });
await provider.readHistory({ fileId: "other-file", dir: advisoryDir, sessionId: "thread-new",
  settings: { model: "codex-cheap", effort: "medium" }, boundary, baseRecord: { ...baseRecord, sessionId: "thread-new" } });
assert.deepEqual([clients.length, runtime.disposed, Reflect.get(session, "closed")], [2, 0, false],
  "advisory history reuses the suitable active runtime after live settings change");
runtime.responses.delete("thread/read");

runtime.failures.set("turn/steer", new CodexRpcError(-32602, "expected turn id is stale"));
runtime.notify("turn/started", { threadId: "thread-new", turnId: "turn-stale",
  turn: { id: "turn-stale", items: [], status: "inProgress" } });
session.send({ text: "Race", selection: [] }); await new Promise(resolve => setImmediate(resolve));
assert.equal(runtime.calls.at(-1)?.method, "turn/start", "explicit stale steer retries once as a new turn");
runtime.notify("turn/started", { threadId: "thread-new",
  turn: { id: "turn-new", items: [], status: "inProgress" } });
await waitUntil({ predicate: () => Reflect.get(session, "turnStart") === undefined, label: "stale retry start event" });

runtime.confirmSettings = false;
const closingSettings = session.applySettings({ settings: { model: "codex-cheap", effort: "low" } });
await new Promise(resolve => setImmediate(resolve));
const callsBeforeClose = runtime.calls.length;
session.close();
await assert.rejects(closingSettings,
  error => error instanceof CodexSettingsError && error.category === "closed");
assert.equal(runtime.calls.length, callsBeforeClose, "session close cannot dispatch a rollback RPC after terminal fencing");
await waitUntil({ predicate: () => runtime.disposed === 1, label: "active-turn runtime retirement" });
provider.prepare({ fileId: "file", dir, settings, boundary });
await waitUntil({ predicate: () => clients.length === 4 && provider.health({ settings }).status === "ready",
  label: "preparation after active-turn close" });
runtime = clients[3];
assert.equal(clients[1]?.disposed, 1, "closing an active native turn retires its runtime before advisory recovery");
const historyTurns = [{ id: "h1", status: "completed", items: [
  { type: "userMessage", id: "u", content: [{ type: "text", text: "[Figma file X]\nQuestion\n[Current selection: none]" }] },
  { type: "agentMessage", id: "a", text: "Answer" },
  { type: "dynamicToolCall", id: "q", tool: "ask_user", arguments: { question: "Next?" }, status: "completed",
    contentItems: [{ type: "inputText", text: "Next\n[Current selection: Screen (FRAME 1:2)]" }], success: true },
  { type: "reasoning", id: "hidden", summary: ["secret"], content: ["secret"] },
], error: null }, { id: "h2", status: "interrupted", items: [], error: null },
{ id: "h3", status: "failed", items: [], error: null }];
assert.deepEqual(projectCodexHistory(historyTurns as Parameters<typeof projectCodexHistory>[0]), [
  { role: "user", text: "Question" }, { role: "assistant", text: "Answer", itemId: "a" },
  { role: "tool", name: "ask_user", input: { question: "Next?" }, itemId: "q" },
  { role: "answer", text: "Next" }, { role: "tool", name: "stopped", input: {}, itemId: "h2" },
  { role: "tool", name: "error", input: { message: "Turn failed" }, itemId: "h3" },
]);
runtime.responses.set("thread/read", { thread: { id: "thread-new", turns: historyTurns } });
runtime.responses.set("account/usage/read", { threadUsage: {
  threadId: "thread-new", estimatedUsageUsdMicros: null, estimatedUsageCreditsMicros: 10,
} });
assert.deepEqual(codexUsageAvailability(parseAccountUsageResult(runtime.responses.get("account/usage/read")), "thread-new"),
  { threadUsagePresent: true, threadMatches: true, usdPresent: false, creditsPresent: true });
const history = await provider.readHistory({ fileId: "file", dir, sessionId: "thread-new", settings, boundary, baseRecord: {
  ...baseRecord, sessionId: "thread-new", costUsd: 0.125, costStatus: "estimated",
} });
assert.deepEqual(history.cost, { usd: 0.125, status: "unavailable" });
assert.equal(history.messages.some(item => item.role === "assistant" && item.text === "Answer"), true);
assert.equal(runtime.calls.some(call => call.method === "thread/read"), true);
assert.equal(runtime.calls.filter(call => call.method === "thread/resume").length, 0,
  "history display does not resume native context");

runtime.responses.delete("account/usage/read");
runtime.failures.set("thread/resume", new CodexRpcError(-32603, "error resuming thread: /private/value"));
await assert.rejects(provider.start({ fileId: "file", dir, resume: "thread-new", settings, boundary, baseRecord: {
  ...baseRecord, sessionId: "thread-new",
} }), error => error instanceof CodexResumeError && error.category === "resume-create" && !error.message.includes("private"));
const resumed = await provider.start({ fileId: "file", dir, resume: "thread-new", settings, boundary, baseRecord: {
  ...baseRecord, sessionId: "thread-new",
} });
const resumeParams = runtime.calls.filter(call => call.method === "thread/resume").at(-1)!.params as Record<string, unknown>;
assert.deepEqual(resumeParams.config, { model_reasoning_effort: "low", project_doc_max_bytes: 0 });
for (const unsupported of ["environments", "selectedCapabilityRoots", "allowProviderModelFallback"]) {
  assert.equal(unsupported in resumeParams, false);
}
resumed.close(); provider.dispose();
await waitUntil({ predicate: () => runtime.disposed === 1, label: "runtime disposal" });
assert.ok(prepared.length >= 2);

const retirementDir = join(root, "retirement");
mkdirSync(join(retirementDir, "notes"), { recursive: true });
writeFileSync(join(retirementDir, "CLAUDE.md"), "instructions");
const retirementClients: FakeClient[] = [];
let releaseRetirement!: () => void;
const retirementGate = new Promise<void>(resolve => { releaseRetirement = resolve; });
const retirementProvider = new CodexProvider({ version: "test", log: () => {}, onPrepared: () => {},
  clientFactory: args => {
    const client = new FakeClient(args, retirementClients.length === 0 ? "discovery" : "runtime");
    if (!retirementClients.length) client.retirementGate = retirementGate;
    retirementClients.push(client); return client;
  } });
retirementProvider.prepare({ fileId: "retire", dir: retirementDir, settings, boundary });
await waitUntil({ predicate: () => !!retirementClients[0]?.disposed, label: "Codex discovery retirement" });
assert.equal(retirementClients.length, 1, "isolated runtime waits for observed discovery retirement");
retirementProvider.dispose();
await new Promise(resolve => setImmediate(resolve));
assert.equal(retirementClients.length, 1, "dispose captures in-progress discovery owner");
releaseRetirement(); await new Promise(resolve => setImmediate(resolve));
assert.equal(retirementClients.length, 1, "superseded preparation never spawns an isolated owner");

const failedRetirementDir = join(root, "failed-retirement");
mkdirSync(join(failedRetirementDir, "notes"), { recursive: true });
writeFileSync(join(failedRetirementDir, "CLAUDE.md"), "instructions");
const failedRetirementClients: FakeClient[] = [];
const failedRetirementProvider = new CodexProvider({ version: "test", log: () => {}, onPrepared: () => {},
  clientFactory: args => {
    const client = new FakeClient(args, failedRetirementClients.length === 2 ? "runtime" : "discovery");
    if (failedRetirementClients.length === 0) client.retirementGate = new Promise((_, reject) =>
      setImmediate(() => reject(new Error("retirement rejected"))));
    failedRetirementClients.push(client); return client;
  } });
failedRetirementProvider.prepare({ fileId: "failed-retirement", dir: failedRetirementDir, settings, boundary });
await waitUntil({ predicate: () => failedRetirementProvider.health({ settings }).status === "unavailable",
  label: "failed retirement preparation" });
failedRetirementProvider.prepare({ fileId: "blocked-retirement", dir: failedRetirementDir, settings, boundary });
assert.equal(failedRetirementProvider.health({ settings }).status, "starting");
await waitUntil({ predicate: () => failedRetirementProvider.health({ settings }).status === "unavailable",
  label: "preparation blocked by rejected retirement" });
assert.equal(failedRetirementClients.length, 1,
  "an unproved retirement remains latched and blocks every later spawn");
failedRetirementProvider.dispose();

const terminalDir = join(root, "terminal-recovery");
mkdirSync(join(terminalDir, "notes"), { recursive: true });
writeFileSync(join(terminalDir, "CLAUDE.md"), "instructions");
const terminalClients: FakeClient[] = [];
const terminalProvider = new CodexProvider({ version: "test", log: () => {}, onPrepared: () => {},
  clientFactory: args => {
    const client = new FakeClient(args, terminalClients.length % 2 === 0 ? "discovery" : "runtime");
    terminalClients.push(client); return client;
  } });
terminalProvider.prepare({ fileId: "terminal", dir: terminalDir, settings, boundary });
await waitUntil({ predicate: () => terminalProvider.health({ settings }).status === "ready", label: "terminal fixture preparation" });
const terminalSession = await terminalProvider.start({ fileId: "terminal", dir: terminalDir, settings, boundary, baseRecord });
terminalClients[1]!.terminate(new Error("native terminated"));
assert.deepEqual([terminalProvider.health({ settings }).status, Reflect.get(terminalSession, "closed")], ["unavailable", true]);
terminalProvider.prepare({ fileId: "terminal", dir: terminalDir, settings, boundary });
await waitUntil({ predicate: () => terminalProvider.health({ settings }).status === "ready",
  label: "advisory preparation after terminal retirement" });
assert.equal(terminalClients.length, 4, "advisory preparation creates a fresh pair after definite terminal retirement");
const recoveredSession = await terminalProvider.start({ fileId: "terminal", dir: terminalDir, settings, boundary, baseRecord });
assert.equal(terminalClients.length, 4, "explicit start reuses the recovered runtime");
assert.notEqual(recoveredSession, terminalSession);
recoveredSession.close(); terminalProvider.dispose();

const pendingCloseDir = join(root, "pending-close");
mkdirSync(join(pendingCloseDir, "notes"), { recursive: true });
writeFileSync(join(pendingCloseDir, "CLAUDE.md"), "instructions");
const pendingCloseClients: FakeClient[] = [];
const pendingCloseProvider = new CodexProvider({ version: "test", log: () => {}, onPrepared: () => {},
  clientFactory: args => {
    const client = new FakeClient(args, pendingCloseClients.length % 2 === 0 ? "discovery" : "runtime");
    pendingCloseClients.push(client); return client;
  } });
pendingCloseProvider.prepare({ fileId: "pending-close", dir: pendingCloseDir, settings, boundary });
await waitUntil({ predicate: () => pendingCloseProvider.health({ settings }).status === "ready",
  label: "pending-close fixture preparation" });
const pendingCloseSession = await pendingCloseProvider.start({
  fileId: "pending-close", dir: pendingCloseDir, settings, boundary, baseRecord,
});
const pendingTurn = deferred<unknown>();
pendingCloseClients[1]!.responseQueues.set("turn/start", [pendingTurn.promise]);
pendingCloseSession.send({ text: "pending native turn", selection: [] });
await waitUntil({ predicate: () => pendingCloseClients[1]!.calls.some(call => call.method === "turn/start"),
  label: "pending turn/start request" });
pendingCloseSession.close();
await waitUntil({ predicate: () => pendingCloseClients[1]!.disposed === 1, label: "pending turn runtime retirement" });
pendingCloseProvider.prepare({ fileId: "pending-close", dir: pendingCloseDir, settings, boundary });
await waitUntil({ predicate: () => pendingCloseProvider.health({ settings }).status === "ready",
  label: "replacement preparation after pending turn close" });
pendingTurn.resolve({ turn: { id: "late-old-turn", items: [], status: "inProgress" } });
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual([pendingCloseClients.length, Reflect.get(pendingCloseSession, "closed"),
  Reflect.get(pendingCloseSession, "activeTurn"), pendingCloseClients[3]!.disposed], [4, true, undefined, 0],
"late predecessor turn/start cannot continue into the replacement runtime");
pendingCloseProvider.dispose();

type TurnStartOrder = FakeClient["turnStartOrder"];
async function orderingFixture(label: string, options: { turnStartEventTimeoutMs?: number } = {}) {
  const fixtureDir = join(root, label); mkdirSync(join(fixtureDir, "notes"), { recursive: true });
  writeFileSync(join(fixtureDir, "CLAUDE.md"), "instructions");
  const fixtureClients: FakeClient[] = [];
  const fixtureProvider = new CodexProvider({ version: "test", log: () => {}, onPrepared: () => {}, ...options,
    clientFactory: args => { const client = new FakeClient(args, fixtureClients.length % 2 === 0 ? "discovery" : "runtime");
      fixtureClients.push(client); return client; } });
  fixtureProvider.prepare({ fileId: label, dir: fixtureDir, settings, boundary });
  await waitUntil({ predicate: () => fixtureProvider.health({ settings }).status === "ready", label: `${label} preparation` });
  const fixtureSession = await fixtureProvider.start({ fileId: label, dir: fixtureDir, settings, boundary, baseRecord });
  const fixtureIterator = fixtureSession.output[Symbol.asyncIterator]();
  assert.equal((await fixtureIterator.next()).value?.kind, "initialized");
  return { provider: fixtureProvider, session: fixtureSession, runtime: fixtureClients[1]!, clients: fixtureClients,
    iterator: fixtureIterator, dir: fixtureDir };
}
const rapidSettings = await orderingFixture("rapid-settings-send");
rapidSettings.runtime.turnStartOrder = "settings-response-started";
const rapidSettingsResponse = deferred<unknown>();
rapidSettings.runtime.responseQueues.set("thread/settings/update", [rapidSettingsResponse.promise]);
const rapidUpdate = rapidSettings.session.applySettings({ settings: { model: "codex-cheap", effort: "medium" } });
rapidSettings.session.send({ text: "after settings", selection: [] });
await waitUntil({ predicate: () => rapidSettings.runtime.calls.some(call => call.method === "thread/settings/update"),
  label: "rapid settings request" });
assert.equal(rapidSettings.runtime.calls.some(call => call.method === "turn/start"), false,
  "rapid send waits behind previously admitted settings update");
rapidSettingsResponse.resolve({}); await rapidUpdate;
await waitUntil({ predicate: () => Reflect.get(rapidSettings.session, "activeTurn") === "turn-new",
  label: "rapid send after settings" });
assert.deepEqual(Reflect.get(rapidSettings.session, "settings"), { model: "codex-cheap", effort: "medium" });
assert.equal(Reflect.get(rapidSettings.session, "closed"), false,
  "settings confirmation cannot be misclassified as stale initial snapshot");
rapidSettings.session.close(); rapidSettings.provider.dispose();
await waitUntil({ predicate: () => rapidSettings.runtime.disposed === 1, label: "rapid settings retirement" });

for (const order of ["settings-response-started", "response-settings-started", "settings-started-response"] as const) {
  const reciprocal = await orderingFixture(`send-settings-interleave-${order}`);
  reciprocal.runtime.turnStartOrder = order;
  const reciprocalStart = deferred<unknown>(); reciprocal.runtime.responseQueues.set("turn/start", [reciprocalStart.promise]);
  reciprocal.session.send({ text: "before settings", selection: [] });
  await waitUntil({ predicate: () => reciprocal.runtime.calls.some(call => call.method === "turn/start"),
    label: `${order} reciprocal turn request` });
  const reciprocalUpdate = reciprocal.session.applySettings({ settings: { model: "codex-cheap", effort: "medium" } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reciprocal.runtime.calls.some(call => call.method === "thread/settings/update"), false,
    `${order} settings admitted after send wait for complete owned turn-start lifecycle`);
  reciprocalStart.resolve({ turn: { id: "turn-new", items: [], status: "inProgress" } });
  await reciprocalUpdate;
  assert.deepEqual(reciprocal.runtime.calls.filter(call =>
    ["turn/start", "thread/settings/update", "turn/settings/update"].includes(call.method)).map(call => call.method),
  ["turn/start", "thread/settings/update", "turn/settings/update"], `${order} preserves reciprocal operation order`);
  assert.equal(Reflect.get(reciprocal.session, "closed"), false);
  reciprocal.session.close(); reciprocal.provider.dispose();
  await waitUntil({ predicate: () => reciprocal.runtime.disposed === 1, label: `${order} reciprocal retirement` });
}

const pendingStartStop = await orderingFixture("stop-pending-turn-start-ack");
pendingStartStop.runtime.turnStartOrder = "settings-started-response";
const startAck = deferred<void>(); pendingStartStop.runtime.ackGates.set("turn/start", startAck.promise);
pendingStartStop.session.send({ text: "start before stop", selection: [] });
await waitUntil({ predicate: () => Reflect.get(pendingStartStop.session, "activeTurn") === "turn-new",
  label: "started turn before delayed start ACK" });
await pendingStartStop.session.interrupt();
assert.deepEqual(pendingStartStop.runtime.calls.filter(call => call.method === "turn/interrupt").map(call => call.params), [{
  threadId: "thread-new", turnId: "turn-new",
}], "Stop interrupts exact started turn without waiting for turn/start ACK");
startAck.resolve();
await waitUntil({ predicate: () => Reflect.get(pendingStartStop.session, "turnStart") === undefined,
  label: "delayed start ACK settlement" });
pendingStartStop.session.close(); pendingStartStop.provider.dispose();
await waitUntil({ predicate: () => pendingStartStop.runtime.disposed === 1, label: "pending-start Stop retirement" });

const pendingSteerStop = await orderingFixture("stop-pending-steer-ack");
pendingSteerStop.runtime.turnStartOrder = "settings-response-started";
pendingSteerStop.session.send({ text: "initial", selection: [] });
await waitUntil({ predicate: () => Reflect.get(pendingSteerStop.session, "turnStart") === undefined,
  label: "pending-steer initial turn" });
const steerAck = deferred<unknown>(); pendingSteerStop.runtime.responseQueues.set("turn/steer", [steerAck.promise]);
pendingSteerStop.session.send({ text: "held steer", selection: [] });
await waitUntil({ predicate: () => pendingSteerStop.runtime.calls.some(call => call.method === "turn/steer"),
  label: "held steer admission" });
await pendingSteerStop.session.interrupt();
assert.equal(pendingSteerStop.runtime.calls.filter(call => call.method === "turn/interrupt").length, 1,
  "Stop bypasses pending turn/steer ACK");
pendingSteerStop.runtime.notify("turn/completed", { threadId: "thread-new",
  turn: { id: "turn-new", items: [], status: "interrupted" } });
steerAck.reject(new CodexRpcError(-32602, "no active turn matches expected turn"));
await new Promise(resolve => setImmediate(resolve));
assert.equal(pendingSteerStop.runtime.calls.filter(call => call.method === "turn/start").length, 1,
  "Stop generation fences stale steer retry after interruption");
pendingSteerStop.session.close(); pendingSteerStop.provider.dispose();
await waitUntil({ predicate: () => pendingSteerStop.runtime.disposed === 1, label: "pending-steer Stop retirement" });

const completedBeforeResponse = await orderingFixture("turn-completed-before-response");
completedBeforeResponse.runtime.turnStartOrder = "settings-started-completed-response";
completedBeforeResponse.session.send({ text: "fast completion", selection: [] });
assert.equal(((await completedBeforeResponse.iterator.next()).value as { event: { type: string } }).event.type, "turn_end");
assert.equal(((await completedBeforeResponse.iterator.next()).value as Extract<ProviderOutput, { kind: "usage" }>).turnCompleted,
  true);
await completedBeforeResponse.iterator.next();
await waitUntil({ predicate: () => Reflect.get(completedBeforeResponse.session, "turnStart") === undefined,
  label: "completed-before-response lifecycle" });
assert.deepEqual([Reflect.get(completedBeforeResponse.session, "activeTurn"),
  completedBeforeResponse.runtime.calls.filter(call => call.method === "turn/interrupt").length], [undefined, 0]);
await completedBeforeResponse.session.interrupt();
assert.equal(completedBeforeResponse.runtime.calls.filter(call => call.method === "turn/interrupt").length, 0,
  "late start response cannot resurrect a completed active turn");
completedBeforeResponse.session.close(); completedBeforeResponse.provider.dispose();
await waitUntil({ predicate: () => completedBeforeResponse.runtime.disposed === 1,
  label: "completed-before-response retirement" });

const completionSteer = await orderingFixture("turn-completes-during-steer");
completionSteer.runtime.turnStartOrder = "settings-response-started";
completionSteer.session.send({ text: "initial turn", selection: [] });
await waitUntil({ predicate: () => Reflect.get(completionSteer.session, "turnStart") === undefined,
  label: "steering boundary initial turn" });
const staleSteer = deferred<unknown>();
completionSteer.runtime.responseQueues.set("turn/steer", [staleSteer.promise]);
completionSteer.session.send({ text: "preserve this input", selection: [{ id: "1:2", name: "Frame", type: "FRAME" }] });
await waitUntil({ predicate: () => completionSteer.runtime.calls.some(call => call.method === "turn/steer"),
  label: "pending stale steer" });
completionSteer.runtime.notify("turn/completed", { threadId: "thread-new",
  turn: { id: "turn-new", items: [], status: "completed" } });
completionSteer.runtime.responses.set("turn/start", { turn: { id: "turn-retry", items: [], status: "inProgress" } });
staleSteer.reject(new CodexRpcError(-32602, "no active turn matches expected turn"));
await waitUntil({ predicate: () => Reflect.get(completionSteer.session, "turnStart") === undefined
    && Reflect.get(completionSteer.session, "activeTurn") === "turn-retry",
  label: "completion-before-stale steering retry" });
const steerCall = completionSteer.runtime.calls.find(call => call.method === "turn/steer")!;
const retryCall = completionSteer.runtime.calls.filter(call => call.method === "turn/start").at(-1)!;
assert.deepEqual((retryCall.params as { input: unknown }).input, (steerCall.params as { input: unknown }).input,
  "completion-before-stale retry preserves exact user input");
assert.deepEqual([completionSteer.runtime.calls.filter(call => call.method === "turn/steer").length,
  completionSteer.runtime.calls.filter(call => call.method === "turn/start").length,
  Reflect.get(completionSteer.session, "closed")], [1, 2, false],
"explicit stale rejection after normal completion retries once without duplicate steer admission");
completionSteer.session.close(); completionSteer.provider.dispose();
await waitUntil({ predicate: () => completionSteer.runtime.disposed === 1,
  label: "completion-before-stale retry retirement" });

const crossThreadCost = await orderingFixture("cross-thread-accounting");
crossThreadCost.runtime.turnStartOrder = "settings-response-started";
crossThreadCost.session.send({ text: "active A", selection: [] });
await waitUntil({ predicate: () => Reflect.get(crossThreadCost.session, "turnStart") === undefined,
  label: "cross-thread accounting active turn" });
const historyDir = join(root, "cross-thread-history"); mkdirSync(join(historyDir, "notes"), { recursive: true });
writeFileSync(join(historyDir, "CLAUDE.md"), "instructions");
crossThreadCost.runtime.responses.set("thread/read", { thread: { id: "history-b", turns: [] } });
const historyCost = deferred<unknown>(), activeCost = deferred<unknown>();
crossThreadCost.runtime.responseQueues.set("account/usage/read", [historyCost.promise, activeCost.promise]);
const historyRead = crossThreadCost.provider.readHistory({ fileId: "history-b", dir: historyDir, sessionId: "history-b",
  settings, boundary, baseRecord: { ...baseRecord, sessionId: "history-b" } });
await waitUntil({ predicate: () => crossThreadCost.runtime.calls.filter(call => call.method === "account/usage/read").length === 1,
  label: "history B accounting request" });
crossThreadCost.runtime.notify("turn/completed", { threadId: "thread-new",
  turn: { id: "turn-new", items: [], status: "completed" } });
assert.equal(((await crossThreadCost.iterator.next()).value as { event: { type: string } }).event.type, "turn_end");
assert.equal(((await crossThreadCost.iterator.next()).value as Extract<ProviderOutput, { kind: "usage" }>).turnCompleted,
  true, "active A completion does not wait for history B accounting");
assert.equal(crossThreadCost.runtime.calls.filter(call => call.method === "account/usage/read").length, 1,
  "active A cannot overlap history B wire accounting request");
historyCost.resolve({ threadUsage: { threadId: "history-b", estimatedUsageUsdMicros: 900_000 } });
assert.deepEqual((await historyRead).cost, { usd: 0.9, status: "estimated" });
await waitUntil({ predicate: () => crossThreadCost.runtime.calls.filter(call => call.method === "account/usage/read").length === 2,
  label: "trailing active A accounting request" });
assert.deepEqual(Reflect.get(crossThreadCost.session, "cost"), { usd: 0, status: "unavailable" },
  "history B USD cannot substitute for active A accounting");
activeCost.resolve({ threadUsage: { threadId: "thread-new", estimatedUsageUsdMicros: 400_000 } });
const activeCheckpoint = (await crossThreadCost.iterator.next()).value as Extract<ProviderOutput, { kind: "usage" }>;
assert.deepEqual([activeCheckpoint.cost, activeCheckpoint.turnCompleted, activeCheckpoint.accountingCheckpoint],
  [{ usd: 0.4, status: "estimated" }, false, true], "active A gets its exact trailing accounting checkpoint");
crossThreadCost.session.close(); crossThreadCost.provider.dispose();
await waitUntil({ predicate: () => crossThreadCost.runtime.disposed === 1, label: "cross-thread accounting retirement" });

const idleSettingsClose = await orderingFixture("idle-settings-close");
idleSettingsClose.runtime.turnStartOrder = "settings-response-started";
idleSettingsClose.session.send({ text: "become idle", selection: [] });
await waitUntil({ predicate: () => Reflect.get(idleSettingsClose.session, "turnStart") === undefined,
  label: "idle-settings initial turn" });
idleSettingsClose.runtime.notify("turn/completed", { threadId: "thread-new",
  turn: { id: "turn-new", items: [], status: "completed" } });
await idleSettingsClose.iterator.next(); await idleSettingsClose.iterator.next(); await idleSettingsClose.iterator.next();
const settingsAck = deferred<unknown>(), retirement = deferred<void>();
idleSettingsClose.runtime.responseQueues.set("thread/settings/update", [settingsAck.promise]);
idleSettingsClose.runtime.retirementGate = retirement.promise; idleSettingsClose.runtime.confirmSettings = false;
const pendingSettings = idleSettingsClose.session.applySettings({ settings: { model: "codex-cheap", effort: "medium" } });
await waitUntil({ predicate: () => idleSettingsClose.runtime.calls.some(call => call.method === "thread/settings/update"),
  label: "idle pending settings RPC" });
idleSettingsClose.session.close();
await assert.rejects(pendingSettings, error => error instanceof CodexSettingsError && error.category === "closed");
await waitUntil({ predicate: () => idleSettingsClose.runtime.disposed === 1, label: "idle settings retirement admission" });
idleSettingsClose.provider.prepare({ fileId: "idle-settings-close", dir: idleSettingsClose.dir, settings, boundary });
await new Promise(resolve => setImmediate(resolve));
assert.equal(idleSettingsClose.clients.length, 2, "replacement preparation waits for pending-settings runtime retirement");
idleSettingsClose.runtime.notify("thread/settings/updated", { threadId: "thread-new",
  threadSettings: { model: "codex-cheap", effort: "medium", serviceTier: "default" } });
retirement.resolve();
await waitUntil({ predicate: () => idleSettingsClose.clients.length === 4
    && idleSettingsClose.provider.health({ settings }).status === "ready",
  label: "replacement after idle settings retirement" });
const idleReplacement = await idleSettingsClose.provider.start({ fileId: "idle-settings-close", dir: idleSettingsClose.dir,
  settings, boundary, baseRecord });
idleSettingsClose.runtime.notify("thread/settings/updated", { threadId: "thread-new",
  threadSettings: { model: "codex-cheap", effort: "medium", serviceTier: "default" } });
assert.equal(Reflect.get(idleReplacement, "closed"), false,
  "late notification from retired settings runtime cannot close replacement");
settingsAck.resolve({}); idleReplacement.close(); idleSettingsClose.provider.dispose();
await waitUntil({ predicate: () => idleSettingsClose.clients[3]!.disposed === 1,
  label: "idle settings replacement retirement" });

const reversedStartDir = join(root, "reversed-provider-starts");
mkdirSync(join(reversedStartDir, "notes"), { recursive: true }); writeFileSync(join(reversedStartDir, "CLAUDE.md"), "instructions");
const reversedClients: FakeClient[] = [];
const reversedProvider = new CodexProvider({ version: "test", log: () => {}, onPrepared: () => {},
  clientFactory: args => { const client = new FakeClient(args, reversedClients.length % 2 === 0 ? "discovery" : "runtime");
    reversedClients.push(client); return client; } });
reversedProvider.prepare({ fileId: "reversed", dir: reversedStartDir, settings, boundary });
await waitUntil({ predicate: () => reversedProvider.health({ settings }).status === "ready", label: "reversed preparation" });
const reversedRuntime = reversedClients[1]!, olderStart = deferred<unknown>(), newerStart = deferred<unknown>();
reversedRuntime.responseQueues.set("thread/start", [olderStart.promise, newerStart.promise]);
const olderSessionPromise = reversedProvider.start({ fileId: "reversed", dir: reversedStartDir, settings, boundary, baseRecord });
await waitUntil({ predicate: () => reversedRuntime.calls.filter(call => call.method === "thread/start").length === 1,
  label: "older provider start" });
const newerSessionPromise = reversedProvider.start({ fileId: "reversed", dir: reversedStartDir, settings, boundary, baseRecord });
await waitUntil({ predicate: () => reversedRuntime.calls.filter(call => call.method === "thread/start").length === 2,
  label: "newer provider start" });
const threadStartResult = (threadId: string) => ({
  thread: { id: threadId, turns: [], environments: [reversedRuntime.args.policy.thread.defaultEnvironment] },
  model: "codex-cheap", cwd: reversedRuntime.args.policy.thread.cwd,
  runtimeWorkspaceRoots: reversedRuntime.args.policy.thread.runtimeWorkspaceRoots, approvalsReviewer: "user",
  approvalPolicy: reversedRuntime.args.policy.thread.approvalPolicy,
  activePermissionProfile: { id: CODEX_PERMISSION_PROFILE }, reasoningEffort: "low", serviceTier: "default",
});
newerStart.resolve(threadStartResult("thread-newer")); const newerSession = await newerSessionPromise;
olderStart.resolve(threadStartResult("thread-older")); const olderSession = await olderSessionPromise;
assert.deepEqual([Reflect.get(olderSession, "closed"), Reflect.get(newerSession, "closed"),
  Reflect.get(reversedProvider, "active") === newerSession], [true, false, true],
"reversed stale start completion cannot close or replace the newer session");
assert.equal(((await olderSession.output[Symbol.asyncIterator]().next()).value as Extract<ProviderOutput,
  { kind: "initialized" }>).sessionId, "thread-older", "stale returned thread identity remains observable");
newerSession.close(); reversedProvider.dispose();
await waitUntil({ predicate: () => reversedRuntime.disposed === 1, label: "reversed start retirement" });

const sourceOrders: TurnStartOrder[] = ["settings-response-started", "response-settings-started", "settings-started-response"];
for (const order of sourceOrders) {
  const fixture = await orderingFixture(`turn-order-${order}`); fixture.runtime.turnStartOrder = order;
  fixture.session.send({ text: order, selection: [] });
  await waitUntil({ predicate: () => fixture.runtime.initialSettingsNotifications === 1
      && Reflect.get(fixture.session, "turnStart") === undefined,
    label: `${order} lifecycle completion` });
  assert.deepEqual([fixture.runtime.initialSettingsNotifications, Reflect.get(fixture.session, "activeTurn"),
    Reflect.get(fixture.session, "closed")], [1, "turn-new", false], `${order} accepts one owned initial snapshot`);
  fixture.session.close(); fixture.provider.dispose();
  await waitUntil({ predicate: () => fixture.runtime.disposed === 1, label: `${order} retirement` });
}
const validInitialSettings = { model: "codex-cheap", effort: "low", serviceTier: "default" };
async function expectInitialFailure(label: string,
  act: (fixture: Awaited<ReturnType<typeof orderingFixture>>) => void | Promise<void>) {
  const fixture = await orderingFixture(label); await act(fixture);
  await assert.rejects(fixture.iterator.next(), /Codex|settings notification/);
  assert.equal(Reflect.get(fixture.session, "closed"), true);
  fixture.provider.dispose();
  await waitUntil({ predicate: () => fixture.runtime.disposed === 1, label: `${label} retirement` });
}
await expectInitialFailure("initial-before-start", fixture => fixture.runtime.notify("thread/settings/updated", {
  threadId: "thread-new", threadSettings: validInitialSettings,
}));
await expectInitialFailure("initial-wrong-thread", fixture => fixture.runtime.notify("thread/settings/updated", {
  threadId: "other-thread", threadSettings: validInitialSettings,
}));
await expectInitialFailure("initial-malformed", fixture => fixture.runtime.notify("thread/settings/updated", {
  threadId: "thread-new", threadSettings: { model: "codex-cheap", effort: "low" },
}));
for (const [label, threadSettings] of [
  ["model", { ...validInitialSettings, model: "other-model" }],
  ["effort", { ...validInitialSettings, effort: "medium" }],
  ["tier", { ...validInitialSettings, serviceTier: "priority" }],
] as const) {
  await expectInitialFailure(`initial-${label}-drift`, async fixture => {
    fixture.runtime.turnStartOrder = "none"; fixture.session.send({ text: label, selection: [] });
    await waitUntil({ predicate: () => Reflect.get(fixture.session, "turnStart") !== undefined,
      label: `${label} initial window` });
    fixture.runtime.notify("thread/settings/updated", { threadId: "thread-new", threadSettings });
  });
}
await expectInitialFailure("initial-excess", async fixture => {
  fixture.runtime.turnStartOrder = "settings-before-response"; fixture.session.send({ text: "excess", selection: [] });
  await waitUntil({ predicate: () => fixture.runtime.initialSettingsNotifications === 1, label: "initial snapshot admission" });
  fixture.runtime.notify("thread/settings/updated", { threadId: "thread-new", threadSettings: validInitialSettings });
});
await expectInitialFailure("initial-after-started", fixture => {
  fixture.runtime.turnStartOrder = "response-started-settings"; fixture.session.send({ text: "late", selection: [] });
});
const initialCannotConfirm = await orderingFixture("initial-cannot-confirm");
initialCannotConfirm.runtime.turnStartOrder = "none";
initialCannotConfirm.session.send({ text: "start", selection: [] });
await waitUntil({ predicate: () => Reflect.get(initialCannotConfirm.session, "turnStart") !== undefined,
  label: "initial-not-confirm lifecycle" });
const concurrentSettings = initialCannotConfirm.session.applySettings({ settings: { model: "codex-cheap", effort: "medium" } });
await new Promise(resolve => setImmediate(resolve));
assert.equal(initialCannotConfirm.runtime.calls.some(call => call.method === "thread/settings/update"), false,
  "explicit settings cannot enter the initial-snapshot window");
initialCannotConfirm.runtime.notify("thread/settings/updated", { threadId: "thread-new",
  threadSettings: { model: "codex-cheap", effort: "low", serviceTier: "default" } });
initialCannotConfirm.runtime.notify("turn/started", { threadId: "thread-new",
  turn: { id: "turn-new", items: [], status: "inProgress" } });
await concurrentSettings;
assert.deepEqual(Reflect.get(initialCannotConfirm.session, "settings"), { model: "codex-cheap", effort: "medium" },
  "initial snapshot and later explicit confirmation remain distinct");
initialCannotConfirm.session.close(); initialCannotConfirm.provider.dispose();
await waitUntil({ predicate: () => initialCannotConfirm.runtime.disposed === 1,
  label: "initial-not-confirm retirement" });
const failedStart = await orderingFixture("failed-turn-start");
const failedStartError = new Error("turn start failed"); failedStart.runtime.failures.set("turn/start", failedStartError);
const failedStartOutput = failedStart.iterator.next(); failedStart.session.send({ text: "fail", selection: [] });
await assert.rejects(failedStartOutput, error => error === failedStartError, "queued start keeps its original error");
await waitUntil({ predicate: () => failedStart.runtime.disposed === 1, label: "failed turn-start retirement" });
failedStart.runtime.notify("thread/settings/updated", { threadId: "thread-new", threadSettings: validInitialSettings });
assert.equal(Reflect.get(failedStart.session, "closed"), true, "failed/closed start cannot admit a late initial snapshot");
failedStart.provider.dispose();
const missingStarted = await orderingFixture("missing-turn-started", { turnStartEventTimeoutMs: 5 });
missingStarted.runtime.turnStartOrder = "settings-before-response";
const missingStartedOutput = missingStarted.iterator.next(); missingStarted.session.send({ text: "missing event", selection: [] });
await assert.rejects(missingStartedOutput, /turn start event timed out after 5ms/,
  "missing native turn/started event fails within the bounded lifecycle window");
await waitUntil({ predicate: () => missingStarted.runtime.disposed === 1, label: "missing event retirement" });
assert.equal(Reflect.get(missingStarted.session, "closed"), true);
missingStarted.provider.dispose();

const sendFailure = await orderingFixture("queued-send-failure");
sendFailure.runtime.turnStartOrder = "response-settings-started";
sendFailure.session.send({ text: "first", selection: [] });
await waitUntil({ predicate: () => Reflect.get(sendFailure.session, "activeTurn") === "turn-new",
  label: "queued-send active turn" });
const unexpectedSendError = new Error("unexpected steer failure");
const sendRetirement = deferred<void>(); sendFailure.runtime.retirementGate = sendRetirement.promise;
sendFailure.runtime.failures.set("turn/steer", unexpectedSendError);
const failedOutput = sendFailure.iterator.next(); sendFailure.session.send({ text: "second", selection: [] });
await assert.rejects(failedOutput, error => error === unexpectedSendError, "queued send preserves original failure");
await waitUntil({ predicate: () => sendFailure.runtime.disposed === 1, label: "queued send retirement admission" });
const replacement = sendFailure.provider.start({ fileId: "queued-send-failure", dir: sendFailure.dir,
  settings, boundary, baseRecord });
await new Promise(resolve => setImmediate(resolve));
assert.equal(sendFailure.clients.length, 2, "replacement cannot spawn before failed native owner retires");
sendRetirement.resolve(); const replacementSession = await replacement;
assert.equal(sendFailure.clients.length, 4, "replacement starts only after observed retirement");
replacementSession.close(); sendFailure.provider.dispose();
await waitUntil({ predicate: () => sendFailure.clients[3]!.disposed === 1, label: "replacement runtime retirement" });

console.log("codex session, replay, controls and accounting check ok");
