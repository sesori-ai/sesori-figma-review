import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type {
  HistoryItem, NodeRef, ProviderHealth, ProviderSessionRecord, ProviderSettings, ReviewEvent, ToolResult, Usage,
} from "../../../shared/protocol.ts";
import { FIGMA_TOOLS, FIGMA_TOOL_NAMES, type FigmaToolName } from "../figma-tools.ts";
import { provisionCodexWorkspace, readReviewFlowSkill } from "../workspace.ts";
import { CodexClient, CodexRpcError, type CodexChildFactory } from "./codex-client.ts";
import {
  CODEX_PERMISSION_PROFILE, createCodexDiscoveryPolicy, createCodexExecutionPolicy, type CodexExecutionPolicy,
} from "./codex-execution.ts";
import {
  codexUsageAvailability, parseAccountUsageResult, parseCodexNotification, parseCommandApprovalRequest, parseDynamicToolRequest,
  parseEmptyResult, parseFileApprovalRequest, parsePermissionsApprovalRequest, parseThreadReadResult,
  parseThreadStartResult, parseTurnSettingsResult, parseTurnStartResult, parseTurnSteerResult,
  parseUserInputRequest, type CodexNotification, type CodexQualification, type CodexServerRequest,
  type CodexThreadItem, type CodexThreadStartResult,
} from "./codex-protocol.ts";
import { discoverCodexRuntime, qualifyCodexRuntime } from "./codex-qualification.ts";
import type { ProviderHistory, ProviderOutput, ProviderRequestBoundary, ReviewProvider, ReviewSession } from "./types.ts";

const SYSTEM = `You are a senior product designer and front-end lead reviewing a design inside Figma. The user watches the
canvas while you talk. Focus each node before discussing it, cover one screen per message, keep chat brief, put
implementation detail in annotations, and ask the user instead of guessing.`;
const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const containedBy = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};
const canonicalRequested = (path: string, cwd: string): string | undefined => {
  let requested = path;
  if (requested.startsWith("file:")) {
    try { requested = fileURLToPath(requested); } catch { return; }
  }
  const absolute = isAbsolute(requested) ? resolve(requested) : resolve(cwd, requested);
  const suffix: string[] = [];
  let cursor = absolute;
  for (;;) {
    try { return join(realpathSync(cursor), ...suffix.reverse()); }
    catch {
      const parent = dirname(cursor);
      if (parent === cursor) return absolute;
      suffix.push(basename(cursor)); cursor = parent;
    }
  }
};
const selectionText = (nodes: NodeRef[]) => nodes.length
  ? nodes.map(node => `${node.name} (${node.type} ${node.id})`).join(", ") : "none";
const userText = (args: { text: string; selection: NodeRef[]; context?: string }) => [
  ...(args.context ? [`[${args.context}]`] : []), args.text, `[Current selection: ${selectionText(args.selection)}]`,
].join("\n");
const stripUserContext = (text: string) => text.split("\n")
  .filter(line => !/^\[(Figma file |Current selection: )/.test(line)).join("\n").trim();

class OutputQueue implements AsyncIterable<ProviderOutput> {
  private values: ProviderOutput[] = [];
  private waiters: { resolve: (value: IteratorResult<ProviderOutput>) => void; reject: (error: unknown) => void }[] = [];
  private terminal?: { error?: unknown };
  push(value: ProviderOutput) {
    if (this.terminal) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false }); else this.values.push(value);
  }
  finish(error?: unknown) {
    if (this.terminal) return;
    this.terminal = { error };
    for (const waiter of this.waiters.splice(0)) error ? waiter.reject(error) : waiter.resolve({ value: undefined, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<ProviderOutput> {
    return { next: async () => {
      const value = this.values.shift();
      if (value) return { value, done: false };
      if (this.terminal?.error) throw this.terminal.error;
      if (this.terminal) return { value: undefined, done: true };
      return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    } };
  }
}

type RpcClient = Pick<CodexClient, "connect" | "request" | "requestOptionalAccounting" | "dispose" | "disposeAndWait">;
type ClientFactory = (args: {
  policy: CodexExecutionPolicy;
  onRequest?: (request: CodexServerRequest) => Promise<unknown>;
  onNotification?: (notification: CodexNotification) => void;
  onTerminal?: (error: Error) => void;
}) => RpcClient;

type Prepared = {
  key: string;
  policy: CodexExecutionPolicy;
  client: RpcClient;
  qualification: CodexQualification;
};

const mapUsage = (total: {
  inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; outputTokens: number;
}): Usage => ({
  input: Math.max(0, total.inputTokens - total.cachedInputTokens - total.cacheWriteInputTokens),
  cacheRead: total.cachedInputTokens,
  cacheWrite: total.cacheWriteInputTokens,
  output: total.outputTokens,
});
export const resolveCodexSettings = (args: {
  qualification: CodexQualification;
  settings: ProviderSettings;
}): ProviderSettings => {
  const fallback = args.qualification.models.find(model => model.isDefault) ?? args.qualification.models[0];
  const model = args.settings.model || fallback?.value;
  const descriptor = args.qualification.models.find(item => item.value === model);
  if (!descriptor) throw new Error(`Codex model ${JSON.stringify(model)} is unavailable`);
  const effort = args.settings.effort || descriptor.defaultEffort || descriptor.efforts[0];
  if (!effort || !descriptor.efforts.includes(effort)) {
    throw new Error(`Codex effort ${JSON.stringify(effort)} is not supported by ${model}`);
  }
  return { model, effort };
};
const costFrom = (result: ReturnType<typeof parseAccountUsageResult>, previous: number, threadId: string) => {
  const availability = codexUsageAvailability(result, threadId);
  if (availability.threadUsagePresent && !availability.threadMatches) throw new Error("Codex usage response thread mismatch");
  const micros = result.threadUsage?.estimatedUsageUsdMicros;
  return micros == null ? { usd: previous, status: "unavailable" as const }
    : { usd: micros / 1_000_000, status: "estimated" as const };
};

export type CodexThreadPolicyField = "threadId" | "cwd" | "runtimeWorkspaceRoots" | "environmentSelection" | "approvalsReviewer"
  | "approvalPolicy" | "activePermissionProfile.id" | "activePermissionProfile.extends" | "model"
  | "reasoningEffort" | "serviceTier";
export type CodexThreadPolicyDiagnostics = { matches: boolean; fields: CodexThreadPolicyField[] };
export function diagnoseCodexThreadPolicy(args: {
  result: CodexThreadStartResult; resume?: string; policy: CodexExecutionPolicy; model: string; effort: string;
}): CodexThreadPolicyDiagnostics {
  const fields: CodexThreadPolicyField[] = [];
  if (args.resume && args.result.thread.id !== args.resume) fields.push("threadId");
  if (args.result.cwd !== args.policy.thread.cwd) fields.push("cwd");
  const expectedRoots = args.policy.thread.runtimeWorkspaceRoots;
  if (args.result.runtimeWorkspaceRoots.length !== expectedRoots.length
    || args.result.runtimeWorkspaceRoots.some((path, index) => path !== expectedRoots[index])) {
    fields.push("runtimeWorkspaceRoots");
  }
  if (!isDeepStrictEqual(args.result.thread.environments, [args.policy.thread.defaultEnvironment])) {
    fields.push("environmentSelection");
  }
  if (args.result.approvalsReviewer !== "user") fields.push("approvalsReviewer");
  if (!isDeepStrictEqual(args.result.approvalPolicy, args.policy.thread.approvalPolicy)) fields.push("approvalPolicy");
  if (args.result.activePermissionProfile?.id !== CODEX_PERMISSION_PROFILE) fields.push("activePermissionProfile.id");
  if (args.result.activePermissionProfile?.extends != null) fields.push("activePermissionProfile.extends");
  if (args.result.model !== args.model) fields.push("model");
  if (args.result.reasoningEffort !== args.effort) fields.push("reasoningEffort");
  if (args.result.serviceTier !== "default") fields.push("serviceTier");
  return { matches: fields.length === 0, fields };
}
export class CodexThreadPolicyMismatchError extends Error {
  readonly code = "CODEX_THREAD_POLICY_MISMATCH";
  constructor(readonly fields: CodexThreadPolicyField[]) {
    super(`Codex thread policy mismatch: ${fields.join(", ")}`); this.name = "CodexThreadPolicyMismatchError";
  }
}
export type CodexResumeFailure = "thread-closing" | "thread-not-found" | "config-load" | "resume-read"
  | "resume-create" | "internal" | "rpc-error";
export class CodexResumeError extends Error {
  readonly code = "CODEX_RESUME_FAILED";
  constructor(readonly category: CodexResumeFailure) {
    super(`Codex native resume failed: ${category}`); this.name = "CodexResumeError";
  }
}
const safeResumeError = (error: CodexRpcError) => new CodexResumeError(
  /^thread .+ is closing(?:;|$)/.test(error.message) ? "thread-closing"
    : error.message.startsWith("no rollout found for thread id ") ? "thread-not-found"
      : error.message.startsWith("failed to load configuration: ") ? "config-load"
        : error.message.startsWith("failed to read thread: ") ? "resume-read"
          : error.message.startsWith("error resuming thread: ") ? "resume-create"
            : error.code === -32603 ? "internal" : "rpc-error",
);
export type CodexSettingsFailure = "target-unavailable" | "confirmation" | "native-rejected" | "rollback" | "closed";
export class CodexSettingsError extends Error {
  readonly code = "CODEX_SETTINGS_FAILED";
  constructor(readonly category: CodexSettingsFailure, readonly definitelyUnchanged = false) {
    super(`Codex settings update failed: ${category}`); this.name = "CodexSettingsError";
  }
}
const safeSettingsError = (error: unknown) => error instanceof CodexSettingsError
  ? error : new CodexSettingsError("native-rejected");
const dynamicResult = (result: ToolResult) => ({
  contentItems: result.content.map(item => item.type === "text"
    ? { type: "inputText" as const, text: item.text }
    : { type: "inputImage" as const, imageUrl: `data:${item.mimeType};base64,${item.data}` }),
  success: !result.isError,
});
const itemInput = (item: CodexThreadItem): Record<string, unknown> => {
  if (item.type === "dynamicToolCall" || item.type === "mcpToolCall") {
    return item.arguments && typeof item.arguments === "object" && !Array.isArray(item.arguments)
      ? item.arguments as Record<string, unknown> : {};
  }
  if (item.type === "commandExecution") return { command: item.command, cwd: item.cwd, status: item.status };
  if (item.type === "fileChange") return { changes: item.changes, status: item.status };
  return {};
};
const itemToolName = (item: CodexThreadItem) => item.type === "dynamicToolCall" ? item.tool
  : item.type === "mcpToolCall" ? `${item.server}/${item.tool}` : item.type === "commandExecution" ? "command"
    : item.type === "fileChange" ? "file_change" : undefined;

export function projectCodexHistory(turns: { id: string; items: CodexThreadItem[]; status: string;
  error?: { message: string } | null }[]): HistoryItem[] {
  const out: HistoryItem[] = [];
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type === "userMessage") for (const input of item.content) {
        if (input.type !== "text") continue;
        const text = stripUserContext(input.text);
        if (text) out.push({ role: "user", text });
      }
      if (item.type === "agentMessage" && item.text.trim()) out.push({ role: "assistant", text: item.text, itemId: item.id });
      const tool = itemToolName(item);
      if (tool) out.push({ role: "tool", name: tool, input: itemInput(item), itemId: item.id });
      if (item.type === "dynamicToolCall" && item.tool === "ask_user") {
        const answer = stripUserContext(item.contentItems
          ?.flatMap(content => content.type === "inputText" ? [content.text] : []).join("\n") ?? "");
        if (answer) out.push({ role: "answer", text: answer });
      }
    }
    if (turn.status === "interrupted") out.push({ role: "tool", name: "stopped", input: {}, itemId: turn.id });
    if (turn.status === "failed" && turn.error?.message) {
      out.push({ role: "tool", name: "error", input: { message: turn.error.message }, itemId: turn.id });
    }
  }
  return out;
}

type TurnStartLifecycle = {
  responseSettled: boolean; started: boolean; completed: boolean; settingsObserved: boolean;
  turnId?: string; model: string; effort: string;
};

class CodexSession implements ReviewSession {
  readonly provider = "codex" as const;
  readonly output: AsyncIterable<ProviderOutput>;
  private readonly queue = new OutputQueue();
  private activeTurn?: string;
  private settingsQueue = Promise.resolve();
  private sendQueue = Promise.resolve();
  private settings: ProviderSettings;
  private usage: Usage;
  private cost: { usd: number; status: "reported" | "estimated" | "unavailable" };
  private firstInput: boolean;
  private turnStart?: TurnStartLifecycle;
  private closed = false;
  private generation = 0;
  private interruptionGeneration = 0;
  private readonly completedTurns = new Set<string>();
  private costReadSequence = 0;
  private readonly changes = new Map<string, unknown[]>();
  private futureSettings?: {
    model: string; effort: string; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>;
  };

  constructor(private readonly args: {
    client: RpcClient;
    policy: CodexExecutionPolicy;
    qualification: CodexQualification;
    threadId: string;
    model: string;
    effort: string;
    fresh: boolean;
    skillPath: string;
    boundary: ProviderRequestBoundary;
    baseRecord: ProviderSessionRecord;
    health: ProviderHealth;
    onClose: (session: CodexSession, nativeTurnPending: boolean) => void;
    log: (...values: unknown[]) => void;
  }) {
    this.output = this.queue;
    this.settings = { model: args.model, effort: args.effort };
    this.usage = args.fresh ? zeroUsage() : { ...args.baseRecord.usage };
    this.cost = args.fresh ? { usd: 0, status: "unavailable" } : {
      usd: args.baseRecord.costUsd, status: args.baseRecord.costStatus,
    };
    this.firstInput = args.fresh;
    this.queue.push({ kind: "initialized", sessionId: args.threadId, health: args.health });
  }

  send(args: { text: string; selection: NodeRef[]; context?: string }) {
    if (this.closed) throw new Error("Codex session is closed");
    const input: Record<string, unknown>[] = [{ type: "text", text: userText(args), textElements: [] }];
    if (this.firstInput) input.push({ type: "skill", name: "review-flow", path: this.args.skillPath });
    this.firstInput = false;
    const settingsBarrier = this.settingsQueue;
    const dispatch = this.sendQueue.then(async () => {
      await settingsBarrier;
      if (this.closed) throw new Error("Codex session is closed");
      const turnId = this.activeTurn;
      if (!turnId) { await this.startTurn(input); return; }
      try {
        await this.args.client.request({
          method: "turn/steer", params: { threadId: this.args.threadId, expectedTurnId: turnId, input },
          parse: parseTurnSteerResult,
        });
      } catch (error) {
        const explicitStale = error instanceof CodexRpcError
          && /stale|no (?:matching |)active turn|does not match|target.*unavailable/i.test(error.message);
        if (!explicitStale || this.activeTurn !== turnId) throw error;
        this.activeTurn = undefined;
        await this.startTurn(input);
      }
    });
    this.sendQueue = dispatch.catch(error => { this.fail(error); this.close(); });
  }

  async interrupt() {
    await this.sendQueue;
    const turnId = this.activeTurn;
    if (this.closed || !turnId) return;
    this.interruptionGeneration++;
    await this.args.client.request({
      method: "turn/interrupt", params: { threadId: this.args.threadId, turnId }, parse: parseEmptyResult,
    });
  }

  applySettings(args: { settings: ProviderSettings }): Promise<void> {
    const requested = this.resolveSettings(args.settings);
    const sendBarrier = this.sendQueue;
    const update = this.settingsQueue.then(async () => {
      await sendBarrier;
      if (this.closed) throw new Error("Codex session is closed");
      const previous = this.settings;
      if (requested.model === previous.model && requested.effort === previous.effort) return;
      try {
        await this.updateFuture(requested);
        const turnId = this.activeTurn;
        if (turnId) {
          const result = await this.args.client.request({ method: "turn/settings/update", params: {
            threadId: this.args.threadId, turnId, model: requested.model, effort: requested.effort,
          }, parse: parseTurnSettingsResult });
          if (result.status !== "applied") throw new CodexSettingsError("target-unavailable");
        }
        this.settings = requested;
      } catch (error) {
        if (this.closed || (error instanceof CodexSettingsError && error.definitelyUnchanged)) {
          throw safeSettingsError(error);
        }
        try { await this.updateFuture(previous); }
        catch (rollbackError) {
          this.close();
          throw new CodexSettingsError("rollback");
        }
        throw safeSettingsError(error);
      }
    });
    this.settingsQueue = update.catch(error => this.args.log("Codex settings update failed", error));
    return update;
  }

  private resolveSettings(settings: ProviderSettings): ProviderSettings {
    return resolveCodexSettings({ qualification: this.args.qualification, settings });
  }
  private async startTurn(input: Record<string, unknown>[]) {
    if (this.turnStart) throw new Error("Codex turn start is already pending");
    const lifecycle: TurnStartLifecycle = this.turnStart = {
      responseSettled: false, started: false, completed: false, settingsObserved: false,
      model: this.settings.model, effort: this.settings.effort,
    };
    const started = await this.args.client.request({
      method: "turn/start", params: {
        threadId: this.args.threadId, input, environments: this.args.policy.thread.turnEnvironments,
      }, parse: parseTurnStartResult,
    });
    if (this.closed) throw new Error("Codex session is closed");
    if (lifecycle.turnId && lifecycle.turnId !== started.turn.id) {
      throw new Error("Codex turn start response does not match the started turn");
    }
    lifecycle.turnId = started.turn.id; lifecycle.responseSettled = true;
    if (!lifecycle.completed) this.activeTurn = started.turn.id;
    if (lifecycle.started && this.turnStart === lifecycle) this.turnStart = undefined;
  }
  private async updateFuture(settings: ProviderSettings) {
    if (this.futureSettings) throw new Error("Codex future settings update is already pending");
    let resolve!: () => void, reject!: (error: Error) => void;
    const confirmed = new Promise<void>((accept, decline) => { resolve = accept; reject = decline; });
    const timer = setTimeout(() => reject(new CodexSettingsError("confirmation")), 10_000);
    const pending = this.futureSettings = { ...settings, resolve, reject, timer };
    try {
      const request = this.args.client.request({ method: "thread/settings/update", params: {
        threadId: this.args.threadId, model: settings.model, effort: settings.effort,
        cwd: this.args.policy.thread.cwd, permissions: this.args.policy.thread.permissions,
        approvalsReviewer: this.args.policy.thread.approvalsReviewer,
        approvalPolicy: this.args.policy.thread.approvalPolicy,
      }, parse: parseEmptyResult }).catch(error => {
        if (error instanceof CodexRpcError && error.code === -32602) {
          throw new CodexSettingsError("native-rejected", true);
        }
        throw error;
      });
      await Promise.all([request, confirmed]);
    } finally {
      clearTimeout(timer);
      if (this.futureSettings === pending) this.futureSettings = undefined;
    }
  }

  notification(notification: CodexNotification) {
    if (this.closed) return;
    let parsed: ReturnType<typeof parseCodexNotification>;
    try { parsed = parseCodexNotification(notification); }
    catch (error) {
      this.fail(new Error(`Invalid Codex ${notification.method} notification`, { cause: error })); this.close(); return;
    }
    if (!parsed) return;
    if (parsed.params.threadId !== this.args.threadId) {
      if (parsed.method === "thread/settings/updated") {
        this.fail(new Error("Codex settings notification belongs to another thread")); this.close();
      }
      return;
    }
    if (parsed.method === "turn/started") {
      const lifecycle = this.turnStart;
      if (lifecycle) {
        if (lifecycle.turnId && lifecycle.turnId !== parsed.params.turn.id) {
          this.fail(new Error("Codex started a different turn than requested")); this.close(); return;
        }
        lifecycle.turnId = parsed.params.turn.id; lifecycle.started = true;
        if (lifecycle.responseSettled && this.turnStart === lifecycle) this.turnStart = undefined;
      }
      this.activeTurn = parsed.params.turn.id;
    }
    if (parsed.method === "thread/settings/updated") {
      const lifecycle = this.turnStart, pending = this.futureSettings, applied = parsed.params.threadSettings;
      if (lifecycle && !lifecycle.started && !lifecycle.settingsObserved) {
        if (applied.model !== lifecycle.model || applied.effort !== lifecycle.effort
          || applied.serviceTier !== "default") {
          this.fail(new Error("Codex initial turn settings differ from the selected settings")); this.close(); return;
        }
        lifecycle.settingsObserved = true;
      } else if (pending) {
        if (applied.model === pending.model && applied.effort === pending.effort && applied.serviceTier === "default") {
          pending.resolve();
        } else pending.reject(new CodexSettingsError("confirmation"));
      } else {
        this.fail(new Error("Unexpected Codex settings notification")); this.close(); return;
      }
    }
    if (parsed.method === "item/started" || parsed.method === "item/completed") {
      const item = parsed.params.item;
      if (item.type === "fileChange") this.changes.set(item.id, item.changes);
      for (const event of this.itemEvents(item, parsed.method === "item/completed")) this.emit(event);
    }
    if (parsed.method === "item/agentMessage/delta") {
      this.emit({ type: "text_delta", session: this.ref(), itemId: parsed.params.itemId, text: parsed.params.delta });
    }
    if (parsed.method === "thread/tokenUsage/updated") {
      this.usage = mapUsage(parsed.params.tokenUsage.total);
      this.queue.push({ kind: "usage", usage: this.usage, cost: this.cost, turnCompleted: false });
    }
    if (parsed.method === "turn/completed") this.completeTurn(parsed.params.turn);
  }

  private itemEvents(item: CodexThreadItem, completed: boolean): ReviewEvent[] {
    if (item.type === "agentMessage") return [{
      type: completed ? "text_end" : "text_start", session: this.ref(), itemId: item.id,
    }];
    if (!completed && item.type === "contextCompaction") return [{
      type: "status", session: this.ref(), itemId: item.id, text: "Compacting context…",
    }];
    const name = itemToolName(item);
    return !completed && name ? [{ type: "tool", session: this.ref(), itemId: item.id, name, input: itemInput(item) }] : [];
  }
  private completeTurn(turn: { id: string; status: string; error?: { message: string } | null }) {
    if (this.completedTurns.has(turn.id)) return;
    this.completedTurns.add(turn.id);
    if (this.turnStart?.turnId === turn.id) this.turnStart.completed = true;
    if (this.activeTurn === turn.id) this.activeTurn = undefined;
    const outcome = turn.status === "interrupted" ? "interrupted" : turn.status === "failed" ? "failed" : "completed";
    this.emit({ type: "turn_end", session: this.ref(), itemId: turn.id, outcome,
      ...(turn.error?.message ? { message: turn.error.message } : {}) });
    this.queue.push({ kind: "usage", usage: this.usage, cost: this.cost, turnCompleted: true });
    const generation = this.generation, sequence = ++this.costReadSequence;
    void this.readCost().then(cost => {
      if (this.closed || generation !== this.generation || sequence !== this.costReadSequence) return;
      this.cost = cost;
      this.queue.push({ kind: "usage", usage: this.usage, cost, turnCompleted: false, accountingCheckpoint: true });
    }, error => {
      this.args.log("Codex thread cost read failed", error);
      if (this.closed || generation !== this.generation || sequence !== this.costReadSequence) return;
      this.cost = { usd: this.cost.usd, status: "unavailable" };
      this.queue.push({ kind: "usage", usage: this.usage, cost: this.cost, turnCompleted: false,
        accountingCheckpoint: true });
    });
  }
  private async readCost() {
    const result = await this.args.client.requestOptionalAccounting({ method: "account/usage/read", params: {
      threadId: this.args.threadId,
    }, parse: parseAccountUsageResult });
    return result ? costFrom(result, this.cost.usd, this.args.threadId)
      : { usd: this.cost.usd, status: "unavailable" as const };
  }

  async request(request: CodexServerRequest): Promise<unknown> {
    if (this.closed) throw new Error("Codex session is closed");
    if (request.method === "item/tool/call") {
      const params = parseDynamicToolRequest(request.params);
      this.assertOwner(params);
      if (params.namespace != null || !FIGMA_TOOL_NAMES.includes(params.tool as FigmaToolName)) {
        return dynamicResult({ content: [{ type: "text", text: `Unsupported dynamic tool ${params.tool}` }], isError: true });
      }
      const definition = FIGMA_TOOLS.find(item => item.name === params.tool)!;
      const parsed = definition.schema.parse(params.arguments);
      const result = await this.args.boundary.tool({ tool: params.tool as FigmaToolName, args: parsed });
      return dynamicResult(result);
    }
    if (request.method === "item/commandExecution/requestApproval") {
      const params = parseCommandApprovalRequest(request.params); this.assertOwner(params);
      if (!params.command || !params.cwd || params.kind !== "command") return { decision: "decline" };
      const network = params.proposedNetworkPolicyAmendments;
      const networkEscalation = params.networkApprovalContext != null
        || network != null && (!Array.isArray(network) || network.length > 0);
      if (networkEscalation || this.unsafePermissions(params.additionalPermissions, params.cwd)) {
        return { decision: "decline" };
      }
      const decision = await this.args.boundary.permission({ tool: "codex_command", input: {
        command: params.command, cwd: params.cwd, reason: params.reason,
        additionalPermissions: params.additionalPermissions,
      } });
      return { decision: decision.behavior === "allow" ? "accept" : "decline" };
    }
    if (request.method === "item/fileChange/requestApproval") {
      const params = parseFileApprovalRequest(request.params); this.assertOwner(params);
      const changes = this.changes.get(params.itemId);
      if (params.grantRoot || !changes || !this.changesStayInNotes(changes)) return { decision: "decline" };
      const decision = await this.args.boundary.permission({ tool: "codex_file_change", input: {
        cwd: this.args.policy.dir, reason: params.reason, changes,
      } });
      return { decision: decision.behavior === "allow" ? "accept" : "decline" };
    }
    if (request.method === "item/permissions/requestApproval") {
      const params = parsePermissionsApprovalRequest(request.params); this.assertOwner(params);
      if (this.unsafePermissions(params.permissions, params.cwd)) return { permissions: {}, scope: "turn" };
      const decision = await this.args.boundary.permission({ tool: "codex_permission_scope", input: {
        cwd: params.cwd, reason: params.reason, permissions: params.permissions, scope: "turn",
      } });
      return { permissions: decision.behavior === "allow" ? params.permissions : {}, scope: "turn" };
    }
    if (request.method === "item/tool/requestUserInput") {
      const params = parseUserInputRequest(request.params); this.assertOwner(params);
      const interruptionGeneration = this.interruptionGeneration;
      const answers: Record<string, { answers: string[] }> = {};
      for (const question of params.questions) {
        const result = await this.args.boundary.tool({ tool: "ask_user", args: {
          question: question.question, options: question.options?.map(option => option.label),
        } });
        if (interruptionGeneration !== this.interruptionGeneration) {
          throw new Error("Codex user input request was interrupted");
        }
        this.assertOwner(params);
        const text = result.content.flatMap(item => item.type === "text" ? [item.text] : []).join("\n");
        answers[question.id] = { answers: [text] };
      }
      return { answers };
    }
    throw new Error(`Unsupported Codex server request: ${request.method}`);
  }

  private assertOwner(params: { threadId: string; turnId: string }) {
    if (params.threadId !== this.args.threadId || params.turnId !== this.activeTurn) {
      throw new Error("Codex request no longer belongs to the active thread/turn");
    }
  }
  private unsafePermissions(value: unknown, requestCwd: string): boolean {
    if (value == null) return false;
    if (typeof value !== "object" || Array.isArray(value) || !isAbsolute(requestCwd)) return true;
    const permissions = value as Record<string, unknown>;
    if (Object.keys(permissions).some(key => !["fileSystem", "network"].includes(key)) || permissions.network != null) {
      return true;
    }
    const fileSystem = permissions.fileSystem;
    if (fileSystem == null) return false;
    if (typeof fileSystem !== "object" || Array.isArray(fileSystem)) return true;
    const filesystem = fileSystem as Record<string, unknown>;
    if (Object.keys(filesystem).some(key => !["write", "read", "entries"].includes(key))) return true;
    const allowed = (path: unknown, access: "read" | "write") => {
      if (typeof path !== "string") return false;
      const canonical = canonicalRequested(path, requestCwd);
      if (!canonical) return false;
      if (access === "write") return containedBy(this.args.policy.notesDir, canonical);
      return containedBy(this.args.policy.dir, canonical)
        || !!this.args.policy.appRepo && containedBy(this.args.policy.appRepo, canonical);
    };
    for (const access of ["write", "read"] as const) {
      const paths = filesystem[access];
      if (paths !== undefined && (!Array.isArray(paths) || paths.some(path => !allowed(path, access)))) return true;
    }
    if (filesystem.entries === undefined) return false;
    if (!Array.isArray(filesystem.entries)) return true;
    return filesystem.entries.some(value => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return true;
      const entry = value as Record<string, unknown>;
      if (!Object.keys(entry).every(key => ["access", "path"].includes(key))
        || (entry.access !== "read" && entry.access !== "write")
        || !entry.path || typeof entry.path !== "object" || Array.isArray(entry.path)) return true;
      const descriptor = entry.path as Record<string, unknown>;
      return !Object.keys(descriptor).every(key => ["type", "path"].includes(key))
        || descriptor.type !== "path" || !allowed(descriptor.path, entry.access);
    });
  }
  private changesStayInNotes(changes: unknown[]): boolean {
    return changes.every(change => {
      if (!change || typeof change !== "object" || typeof (change as { path?: unknown }).path !== "string") return false;
      const typed = change as { path: string; kind?: unknown };
      const path = canonicalRequested(typed.path, this.args.policy.dir);
      if (!path || !containedBy(this.args.policy.notesDir, path)) return false;
      if (!typed.kind || typeof typed.kind !== "object" || Array.isArray(typed.kind)) return false;
      const kind = typed.kind as Record<string, unknown>;
      if (kind.type === "add" || kind.type === "delete") return Object.keys(kind).length === 1;
      if (kind.type !== "update" || !Object.keys(kind).every(key => ["type", "move_path"].includes(key))) return false;
      if (kind.move_path == null) return true;
      const movePath = typeof kind.move_path === "string"
        ? canonicalRequested(kind.move_path, this.args.policy.dir) : undefined;
      return !!movePath && containedBy(this.args.policy.notesDir, movePath);
    });
  }
  private ref() { return { provider: "codex" as const, sessionId: this.args.threadId }; }
  private emit(event: ReviewEvent) { this.queue.push({ kind: "event", event }); }
  fail(error: unknown) { this.queue.finish(error); }
  close() {
    if (this.closed) return;
    const nativeTurnPending = this.turnStart !== undefined || this.activeTurn !== undefined;
    this.closed = true; this.generation++; this.turnStart = undefined;
    this.futureSettings?.reject(new CodexSettingsError("closed"));
    this.args.onClose(this, nativeTurnPending); this.queue.finish();
  }
}

export class CodexProvider implements ReviewProvider {
  readonly id = "codex" as const;
  private prepared?: Promise<Prepared>;
  private preparedKey?: string;
  private runtime?: { status: "starting" | "ready" | "unavailable"; qualification?: CodexQualification; error?: string };
  private client?: RpcClient;
  private active?: CodexSession;
  private generation = 0;
  private startSequence = 0;
  private readonly ownedClients = new Set<RpcClient>();
  private readonly retirements = new WeakMap<object, Promise<void>>();
  private retirement: Promise<void> = Promise.resolve();
  private retirementFailure?: unknown;
  private readonly createClient: ClientFactory;

  constructor(private readonly args: {
    version: string;
    log: (...values: unknown[]) => void;
    onPrepared: () => void;
    command?: string;
    childFactory?: CodexChildFactory;
    clientFactory?: ClientFactory;
  }) {
    this.createClient = args.clientFactory ?? (clientArgs => new CodexClient({
      ...clientArgs, clientVersion: args.version, childFactory: args.childFactory, log: args.log,
    }));
  }

  health(args: { settings: ProviderSettings }): ProviderHealth {
    const qualification = this.runtime?.qualification;
    return {
      provider: "codex", status: this.runtime?.status ?? "starting", version: qualification?.version,
      model: args.settings.model || qualification?.models.find(model => model.isDefault)?.value
        || qualification?.models[0]?.value, models: qualification?.models ?? [],
      error: this.runtime?.error,
    };
  }

  prepare(args: { fileId: string; dir: string; settings: ProviderSettings; boundary: ProviderRequestBoundary }) {
    if (this.active) return;
    void this.ensurePrepared(args).catch(() => {});
  }

  async start(args: {
    fileId: string; dir: string; resume?: string; settings: ProviderSettings; boundary: ProviderRequestBoundary;
    baseRecord: ProviderSessionRecord;
  }): Promise<ReviewSession> {
    const startSequence = ++this.startSequence;
    this.active?.close();
    const prepared = await this.ensurePrepared(args);
    if (startSequence !== this.startSequence) throw new Error("Codex session start was superseded");
    const selected = this.resolveSettings(prepared.qualification, args.settings);
    const scaffold = provisionCodexWorkspace({ dir: args.dir });
    const common = {
      model: selected.model, config: { model_reasoning_effort: selected.effort,
        project_doc_max_bytes: prepared.policy.thread.projectDocMaxBytes }, serviceTier: "default",
      cwd: prepared.policy.thread.cwd,
      runtimeWorkspaceRoots: prepared.policy.thread.runtimeWorkspaceRoots,
      approvalPolicy: prepared.policy.thread.approvalPolicy,
      approvalsReviewer: prepared.policy.thread.approvalsReviewer,
      permissions: prepared.policy.thread.permissions,
      baseInstructions: readFileSync(scaffold.instructionsPath, "utf8"), developerInstructions: SYSTEM,
      selectedCapabilityRoots: prepared.policy.thread.selectedCapabilityRoots,
      allowProviderModelFallback: prepared.policy.thread.allowProviderModelFallback,
    };
    let result: CodexThreadStartResult;
    try { result = await prepared.client.request({ method: args.resume ? "thread/resume" : "thread/start",
      params: args.resume ? { threadId: args.resume, model: common.model, config: common.config,
        serviceTier: common.serviceTier, cwd: common.cwd, runtimeWorkspaceRoots: common.runtimeWorkspaceRoots,
        approvalPolicy: common.approvalPolicy, approvalsReviewer: common.approvalsReviewer,
        permissions: common.permissions, baseInstructions: common.baseInstructions,
        developerInstructions: common.developerInstructions }
        : { ...common, allowProviderModelFallback: prepared.policy.thread.allowProviderModelFallback,
          dynamicTools: FIGMA_TOOLS.map(tool => ({ type: "function", name: tool.name,
            description: tool.description, inputSchema: z.toJSONSchema(tool.schema) })) },
      parse: parseThreadStartResult });
    } catch (error) {
      if (args.resume && error instanceof CodexRpcError) throw safeResumeError(error);
      throw error;
    }
    const diagnostics = diagnoseCodexThreadPolicy({
      result, resume: args.resume, policy: prepared.policy, model: selected.model, effort: selected.effort,
    });
    if (!diagnostics.matches) throw new CodexThreadPolicyMismatchError(diagnostics.fields);
    const health: ProviderHealth = {
      provider: "codex", status: "ready", version: prepared.qualification.version, model: result.model,
      models: prepared.qualification.models,
    };
    const session = new CodexSession({
      client: prepared.client, policy: prepared.policy, qualification: prepared.qualification,
      threadId: result.thread.id, model: result.model, effort: result.reasoningEffort ?? selected.effort,
      fresh: !args.resume, skillPath: scaffold.skillPath, boundary: args.boundary, baseRecord: args.baseRecord, health,
      onClose: (target, nativeTurnPending) => this.sessionClosed(target, nativeTurnPending), log: this.args.log,
    });
    if (startSequence !== this.startSequence) {
      session.close();
      return session;
    }
    this.active?.close(); this.active = session;
    return session;
  }

  async readHistory(args: {
    fileId: string; dir: string; sessionId: string; settings: ProviderSettings; boundary: ProviderRequestBoundary;
    baseRecord: ProviderSessionRecord;
  }): Promise<ProviderHistory> {
    const prepared = await this.ensurePrepared(args, { advisory: true });
    const result = await prepared.client.request({
      method: "thread/read", params: { threadId: args.sessionId, includeTurns: true }, parse: parseThreadReadResult,
    });
    if (result.thread.id !== args.sessionId) throw new Error("Codex read a different native thread");
    let cost = { usd: args.baseRecord.costUsd, status: args.baseRecord.costStatus };
    try {
      const usage = await prepared.client.requestOptionalAccounting({ method: "account/usage/read", params: {
        threadId: args.sessionId,
      }, parse: parseAccountUsageResult });
      cost = usage ? costFrom(usage, cost.usd, args.sessionId) : { usd: cost.usd, status: "unavailable" };
    } catch (error) {
      this.args.log("Codex history cost read failed", error); cost = { usd: cost.usd, status: "unavailable" };
    }
    return { messages: projectCodexHistory(result.thread.turns), cost };
  }

  private resolveSettings(qualification: CodexQualification, settings: ProviderSettings) {
    return resolveCodexSettings({ qualification, settings });
  }

  private ensurePrepared(args: {
    fileId: string; dir: string; settings: ProviderSettings; boundary: ProviderRequestBoundary;
  }, options: { advisory?: boolean } = {}): Promise<Prepared> {
    provisionCodexWorkspace({ dir: args.dir });
    const key = JSON.stringify([args.fileId, args.dir, process.env.APP_REPO ?? "", args.settings]);
    if (this.prepared && (this.preparedKey === key || options.advisory && this.active)) return this.prepared;
    if (options.advisory && this.active) return Promise.reject(new Error("Active Codex runtime is unavailable"));
    this.disposeRuntime();
    const generation = ++this.generation;
    this.preparedKey = key; this.runtime = { status: "starting" }; this.notify();
    const promise = this.prepareRuntime({ dir: args.dir, generation });
    this.prepared = promise;
    promise.then(prepared => {
      if (generation !== this.generation) {
        void this.retire(prepared.client).catch(error => this.args.log("Stale Codex retirement uncertain", error));
        return;
      }
      this.client = prepared.client; this.runtime = { status: "ready", qualification: prepared.qualification }; this.notify();
    }, error => {
      if (generation !== this.generation) return;
      this.runtime = { status: "unavailable", error: `Codex failed to prepare: ${error instanceof Error ? error.message : String(error)}` };
      this.prepared = undefined; this.notify();
    });
    return promise;
  }

  private async prepareRuntime(args: { dir: string; generation: number }): Promise<Prepared> {
    await this.retirement;
    if (this.retirementFailure !== undefined) throw this.retirementFailure;
    if (args.generation !== this.generation) throw new Error("Codex preparation was superseded before spawn");
    const appRepo = process.env.APP_REPO;
    const discoveryPolicy = createCodexDiscoveryPolicy({ dir: args.dir, appRepo, command: this.args.command });
    const discovery = this.own(this.createClient({ policy: discoveryPolicy }));
    let isolation;
    try { isolation = await discoverCodexRuntime({ client: discovery as CodexClient, policy: discoveryPolicy }); }
    finally { await this.retire(discovery); }
    if (args.generation !== this.generation) throw new Error("Codex preparation was superseded");
    const policy = createCodexExecutionPolicy({ dir: args.dir, appRepo, command: this.args.command, isolation });
    let client!: RpcClient;
    client = this.own(this.createClient({
      policy,
      onNotification: notification => this.active?.notification(notification),
      onRequest: request => this.active?.request(request) ?? Promise.reject(new Error("No active Codex session")),
      onTerminal: error => {
        if (client !== this.client || args.generation !== this.generation) return;
        const active = this.active; this.active = undefined;
        active?.fail(error); active?.close();
        this.client = undefined; this.prepared = undefined; this.preparedKey = undefined; this.generation++;
        void this.retire(client).catch(retirementError => this.args.log("Codex terminal retirement uncertain", retirementError));
        this.runtime = { status: "unavailable", error: `Codex App Server failed: ${error.message}` }; this.notify();
      },
    }));
    try {
      const qualification = await qualifyCodexRuntime({ client: client as CodexClient, policy });
      return { key: this.preparedKey!, policy, client, qualification };
    } catch (error) { await this.retire(client); throw error; }
  }

  private own<T extends RpcClient>(client: T): T { this.ownedClients.add(client); return client; }
  private retire(client: RpcClient): Promise<void> {
    const existing = this.retirements.get(client as object);
    if (existing) return existing;
    this.ownedClients.delete(client);
    const retirement = this.retirement.then(() => client.disposeAndWait({ timeoutMs: 5_000 }));
    this.retirements.set(client as object, retirement);
    this.retirement = retirement.then(() => {}, error => { this.retirementFailure ??= error; });
    return retirement;
  }
  private notify() { try { this.args.onPrepared(); } catch (error) { this.args.log("Codex readiness notification failed", error); } }
  private sessionClosed(session: CodexSession, nativeTurnPending: boolean) {
    if (this.active !== session) return;
    this.active = undefined;
    if (!nativeTurnPending) return;
    const client = this.client;
    this.client = undefined; this.prepared = undefined; this.preparedKey = undefined; this.runtime = undefined; this.generation++;
    if (client) void this.retire(client).catch(error => this.args.log("Codex active-turn retirement uncertain", error));
    this.notify();
  }
  private disposeRuntime() {
    const active = this.active; this.active = undefined; active?.close();
    const clients = new Set(this.ownedClients);
    if (this.client) clients.add(this.client);
    this.client = undefined;
    for (const client of clients) void this.retire(client).catch(error => this.args.log("Codex retirement uncertain", error));
    this.prepared = undefined; this.preparedKey = undefined;
  }
  dispose() { this.generation++; this.startSequence++; this.disposeRuntime(); this.runtime = undefined; this.notify(); }
}
