import { createSdkMcpServer, query, startup, tool, type Options, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  FIGMA_MCP_URL,
  type CostStatus,
  type HistoryItem,
  type NodeRef,
  type ProviderHealth,
  type ProviderSessionRecord,
  type ProviderSettings,
  type ReviewEvent,
  type SessionRef,
  type Usage,
} from "../../../shared/protocol.ts";
import { FIGMA_TOOLS } from "../figma-tools.ts";
import { readAllow } from "../workspace.ts";
import { readClaudeTranscript } from "./claude-history.ts";
import type { ProviderOutput, ProviderRequestBoundary, ReviewProvider, ReviewSession } from "./types.ts";

type NativeServerStatus = { name: string; status: string; error?: string };
type NativeQuery = AsyncIterable<unknown> & {
  interrupt(): Promise<void>;
  setModel(model?: string): Promise<void>;
  applyFlagSettings(settings: { effortLevel: string | null }): Promise<void>;
  mcpServerStatus(): Promise<NativeServerStatus[]>;
  close(): void;
};
type NativeWarmQuery = { query(prompt: AsyncIterable<SDKUserMessage>): NativeQuery; close(): void };
type NativeFactory = {
  cold(args: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): NativeQuery;
  warm(args: { options: Options }): Promise<NativeWarmQuery>;
};
const wrapQuery = (sdkQuery: Query): NativeQuery => ({
  [Symbol.asyncIterator]: () => sdkQuery[Symbol.asyncIterator](),
  interrupt: async () => { await sdkQuery.interrupt(); },
  setModel: model => sdkQuery.setModel(model),
  applyFlagSettings: settings => sdkQuery.applyFlagSettings({
    effortLevel: settings.effortLevel as Parameters<Query["applyFlagSettings"]>[0]["effortLevel"],
  }),
  mcpServerStatus: () => sdkQuery.mcpServerStatus(),
  close: () => sdkQuery.close(),
});
const DEFAULT_NATIVE: NativeFactory = {
  cold: args => wrapQuery(query(args)),
  warm: args => startup(args).then(warm => ({
    query: prompt => wrapQuery(warm.query(prompt)),
    close: () => warm.close(),
  })),
};

const CLAUDE_EFFORTS = ["", "low", "medium", "high", "xhigh", "max"];
const CLAUDE_MODELS: readonly (readonly [value: string, label: string])[] = [
  ["", "Default"], ["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"],
];

const SYSTEM = `You are a senior product designer and front-end lead doing a design review inside Figma, through a plugin chat panel.
The user watches the canvas while you talk: call focus on a node before discussing it, and cover one screen per message.
Be concrete and brief in chat; put implementation detail into annotations. When something is ambiguous, ask with ask_user instead of assuming.`;

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const number = (value: unknown): number => typeof value === "number" ? value : 0;
const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
export const addClaudeUsage = (total: Usage, value: unknown): Usage => {
  const usage = object(value);
  return {
    input: total.input + number(usage?.input_tokens),
    output: total.output + number(usage?.output_tokens),
    cacheRead: total.cacheRead + number(usage?.cache_read_input_tokens),
    cacheWrite: total.cacheWrite + number(usage?.cache_creation_input_tokens),
  };
};
const MCP_STATUS_TIMEOUT_MS = 1000;
const serverStatuses = (value: unknown): { name: string; status: string; error?: string }[] =>
  (Array.isArray(value) ? value : []).flatMap(item => {
    const server = object(item);
    if (typeof server?.name !== "string" || typeof server.status !== "string") return [];
    return [{ name: server.name, status: server.status, error: typeof server.error === "string" ? server.error : undefined }];
  });
async function refreshServerStatuses(args: {
  query: NativeQuery;
  fallback: NativeServerStatus[];
  timeoutMs: number;
  log: (...values: unknown[]) => void;
}): Promise<NativeServerStatus[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return serverStatuses(await Promise.race([
      args.query.mcpServerStatus(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Claude MCP status timed out after ${args.timeoutMs}ms`)), args.timeoutMs);
      }),
    ]));
  } catch (error) {
    args.log("failed to refresh Claude MCP status; using init snapshot", error);
    return args.fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const sumUsage = (left: Usage, right: Usage): Usage => ({
  input: left.input + right.input,
  output: left.output + right.output,
  cacheRead: left.cacheRead + right.cacheRead,
  cacheWrite: left.cacheWrite + right.cacheWrite,
});

/** Live stream values are provisional per turn; final result usage commits once without double counting. */
/** SDK contract: result.usage is per-turn for streaming-input sessions. */
export class ClaudeUsageTracker {
  private turn = zeroUsage();
  private response = zeroUsage();
  private committed: Usage;
  constructor(args: { committed: Usage }) { this.committed = args.committed; }
  messageStart(value: unknown): Usage {
    this.turn = sumUsage(this.turn, this.response);
    this.response = addClaudeUsage(zeroUsage(), value);
    return this.snapshot();
  }
  messageDelta(value: unknown): Usage {
    const usage = object(value);
    // Messages API delta usage is cumulative for this response; omitted fields retain their last value.
    this.response = {
      input: typeof usage?.input_tokens === "number" ? usage.input_tokens : this.response.input,
      output: typeof usage?.output_tokens === "number" ? usage.output_tokens : this.response.output,
      cacheRead: typeof usage?.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : this.response.cacheRead,
      cacheWrite: typeof usage?.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : this.response.cacheWrite,
    };
    return this.snapshot();
  }
  complete(value: unknown): Usage {
    this.committed = addClaudeUsage(this.committed, value);
    this.turn = zeroUsage(); this.response = zeroUsage();
    return this.snapshot();
  }
  snapshot(): Usage { return sumUsage(this.committed, sumUsage(this.turn, this.response)); }
}

export class ClaudeCostTracker {
  private readonly baseUsd: number;
  private current: { usd: number; status: CostStatus };
  private readonly validStatus: CostStatus;
  constructor(args: { baseUsd: number; baseStatus: CostStatus; resumed: boolean }) {
    this.baseUsd = args.baseUsd;
    this.validStatus = args.resumed ? args.baseStatus : "reported";
    this.current = { usd: args.baseUsd, status: args.baseStatus };
  }
  complete(nativeCumulativeUsd: unknown) {
    if (typeof nativeCumulativeUsd !== "number" || !Number.isFinite(nativeCumulativeUsd) || nativeCumulativeUsd < 0) {
      this.current = { usd: this.current.usd, status: "unavailable" };
      return this.snapshot();
    }
    this.current = { usd: this.baseUsd + nativeCumulativeUsd, status: this.validStatus };
    return this.snapshot();
  }
  snapshot() { return { ...this.current }; }
}

function userMessage(args: { text: string; selection: NodeRef[]; context?: string }): SDKUserMessage {
  const selection = args.selection.length ? args.selection.map(n => `${n.name} (${n.type} ${n.id})`).join(", ") : "none";
  const parts = [args.text, `[Current selection: ${selection}]`];
  if (args.context) parts.unshift(`[${args.context}]`);
  return { type: "user", message: { role: "user", content: parts.join("\n") }, parent_tool_use_id: null };
}

function inputStream() {
  const buffer: (SDKUserMessage | null)[] = [];
  let wake = () => {};
  async function* generate() {
    for (;;) {
      while (buffer.length) {
        const message = buffer.shift()!;
        if (message === null) return;
        yield message;
      }
      await new Promise<void>(resolve => (wake = resolve));
    }
  }
  return { stream: generate(), push: (message: SDKUserMessage | null) => { buffer.push(message); wake(); } };
}

const createClaudeFigmaServer = (args: { version: string; boundary: ProviderRequestBoundary }) => createSdkMcpServer({
  name: "figma",
  version: args.version,
  tools: FIGMA_TOOLS.map(item => tool(item.name, item.description, item.schema.shape,
    input => args.boundary.tool({ tool: item.name, args: input }))),
});

function optionalEnvLimit(args: {
  name: "SESORI_REVIEW_MAX_TURNS" | "SESORI_REVIEW_MAX_BUDGET_USD";
  integer: boolean;
}) {
  const raw = process.env[args.name];
  if (raw === undefined) return undefined;
  const normalized = raw.trim();
  const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized);
  const value = numeric ? Number(normalized) : Number.NaN;
  const valid = Number.isFinite(value) && value > 0 && (!args.integer || Number.isSafeInteger(value));
  if (!valid) {
    const expected = args.integer ? "a positive safe integer" : "a finite positive number";
    throw new Error(`${args.name} must be ${expected}; received ${JSON.stringify(raw)}`);
  }
  return value;
}

function options(args: {
  version: string;
  dir: string;
  resume?: string;
  settings: ProviderSettings;
  boundary: ProviderRequestBoundary;
  allowedTools: string[];
  log: (...values: unknown[]) => void;
}): Options {
  const appRepo = process.env.APP_REPO;
  const maxTurns = optionalEnvLimit({ name: "SESORI_REVIEW_MAX_TURNS", integer: true });
  const maxBudgetUsd = optionalEnvLimit({ name: "SESORI_REVIEW_MAX_BUDGET_USD", integer: false });
  return {
    cwd: args.dir,
    resume: args.resume,
    settingSources: ["project"],
    additionalDirectories: appRepo ? [appRepo] : [],
    systemPrompt: SYSTEM,
    mcpServers: {
      figma: createClaudeFigmaServer({ version: args.version, boundary: args.boundary }),
      "figma-desktop": { type: "http", url: FIGMA_MCP_URL },
    },
    strictMcpConfig: true,
    tools: ["Read", "Glob", "Grep", "Write", "Edit", "Skill"],
    allowedTools: args.allowedTools,
    disallowedTools: ["AskUserQuestion"],
    permissionMode: "default",
    canUseTool: async (toolName, input) => {
      const normalized = object(input) ?? {};
      const decision = await args.boundary.permission({ tool: toolName, input: normalized });
      return decision.behavior === "allow" ? { behavior: "allow", updatedInput: input } : decision;
    },
    includePartialMessages: true,
    maxTurns,
    maxBudgetUsd,
    model: args.settings.model || undefined,
    effort: (args.settings.effort || undefined) as Options["effort"],
    stderr: data => args.log("[claude]", data.trim()),
  };
}

function ref(args: { sessionId: string }): SessionRef { return { provider: "claude", sessionId: args.sessionId }; }

export class ClaudeDisplayMapper {
  private messageId?: string;
  private readonly textBlocks = new Set<number>();

  map(args: { message: unknown; sessionId: string; interrupted: boolean }): ReviewEvent[] {
    const message = object(args.message);
    if (!message || !args.sessionId) return [];
    const session = ref({ sessionId: args.sessionId });
    const type = message.type;
    if (type === "stream_event" && !message.parent_tool_use_id) {
      const event = object(message.event);
      const eventType = event?.type;
      if (eventType === "message_start") {
        const id = object(event?.message)?.id;
        this.messageId = typeof id === "string" ? id : undefined;
        this.textBlocks.clear();
        return [];
      }
      if (eventType === "message_stop") { this.messageId = undefined; this.textBlocks.clear(); return []; }
      if (!this.messageId) return [];
      const index = number(event?.index);
      const itemId = `${args.sessionId}:${this.messageId}:${index}`;
      if (eventType === "content_block_start" && object(event?.content_block)?.type === "text") {
        this.textBlocks.add(index);
        return [{ type: "text_start", session, itemId }];
      }
      const delta = object(event?.delta);
      if (eventType === "content_block_delta" && this.textBlocks.has(index) && delta?.type === "text_delta" && typeof delta.text === "string") {
        return [{ type: "text_delta", session, itemId, text: delta.text }];
      }
      if (eventType === "content_block_stop" && this.textBlocks.delete(index)) return [{ type: "text_end", session, itemId }];
    }
    if (type === "assistant") {
      const content = object(message.message)?.content;
      const events: ReviewEvent[] = [];
      for (const blockValue of Array.isArray(content) ? content : []) {
        const block = object(blockValue);
        if (block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
          events.push({ type: "tool", session, itemId: block.id, name: block.name, input: object(block.input) ?? {} });
        }
      }
      if (message.error) events.push({ type: "error", session, itemId: `error:${Date.now()}`, message: `Claude error: ${String(message.error)}` });
      return events;
    }
    if (type === "system" && message.subtype === "status" && message.status === "compacting") {
      return [{ type: "status", session, itemId: `status:${Date.now()}`, text: "Compacting context…" }];
    }
    if (type === "result") {
      const failed = message.is_error === true;
      return [{
        type: "turn_end",
        session,
        itemId: `turn:${Date.now()}`,
        outcome: args.interrupted ? "interrupted" : failed ? "failed" : "completed",
        message: failed && !args.interrupted ? String(message.result ?? message.subtype ?? "Claude turn failed") : undefined,
      }];
    }
    return [];
  }
}

class ClaudeSession implements ReviewSession {
  readonly provider = "claude" as const;
  readonly output: AsyncIterable<ProviderOutput>;
  private activeTurn?: { interrupted: boolean };
  private effectiveSettings: ProviderSettings;
  private settingsQueue = Promise.resolve();
  private closed = false;

  constructor(args: {
    query: NativeQuery;
    push: (message: SDKUserMessage | null) => void;
    baseRecord: ProviderSessionRecord;
    settings: ProviderSettings;
    resumed: boolean;
    mcpStatusTimeoutMs: number;
    log: (...values: unknown[]) => void;
  }) {
    this.query = args.query;
    this.push = args.push;
    this.effectiveSettings = { ...args.settings };
    this.log = args.log;
    const self = this;
    this.output = (async function* () {
      let sessionId = "";
      const usage = new ClaudeUsageTracker({ committed: { ...args.baseRecord.usage } });
      const cost = new ClaudeCostTracker({
        baseUsd: args.baseRecord.costUsd,
        baseStatus: args.baseRecord.costStatus,
        resumed: args.resumed,
      });
      const display = new ClaudeDisplayMapper();
      for await (const sdkMessage of self.query) {
        const message = object(sdkMessage);
        const streamEvent = message?.type === "stream_event" ? object(message.event) : undefined;
        if (streamEvent?.type === "message_start") self.activeTurn ??= { interrupted: false };
        const completedTurn = message?.type === "result" ? self.activeTurn : undefined;
        if (message?.type === "result") self.activeTurn = undefined;
        if (message?.type === "system" && message.subtype === "init" && typeof message.session_id === "string") {
          sessionId = message.session_id;
          const servers = await refreshServerStatuses({
            query: self.query,
            fallback: serverStatuses(message.mcp_servers),
            timeoutMs: args.mcpStatusTimeoutMs,
            log: args.log,
          });
          yield {
            kind: "initialized",
            sessionId,
            health: {
              provider: "claude",
              status: "ready",
              version: typeof message.claude_code_version === "string" ? message.claude_code_version : undefined,
              model: typeof message.model === "string" ? message.model : undefined,
              models: claudeModels(),
            },
            servers,
          };
        }
        for (const event of display.map({
          message: sdkMessage,
          sessionId,
          interrupted: (completedTurn ?? self.activeTurn)?.interrupted ?? false,
        })) yield { kind: "event", event };
        if (message?.type === "stream_event") {
          const event = object(message.event);
          const streamUsage = event?.type === "message_start" ? object(event.message)?.usage : event?.type === "message_delta" ? event.usage : undefined;
          if (streamUsage) {
            const snapshot = event?.type === "message_start" ? usage.messageStart(streamUsage) : usage.messageDelta(streamUsage);
            yield { kind: "usage", usage: snapshot, cost: cost.snapshot(), turnCompleted: false };
          }
        }
        if (message?.type === "result") {
          args.log("[claude-accounting]", JSON.stringify({ resultUsage: message.usage, totalCostUsd: message.total_cost_usd }));
          yield {
            kind: "usage",
            usage: usage.complete(message.usage),
            cost: cost.complete(message.total_cost_usd),
            turnCompleted: true,
          };
        }
      }
    })();
  }

  private readonly query: NativeQuery;
  private readonly push: (message: SDKUserMessage | null) => void;
  private readonly log: (...values: unknown[]) => void;

  send(args: { text: string; selection: NodeRef[]; context?: string }) {
    if (this.closed) throw new Error("Claude session is closed");
    this.activeTurn ??= { interrupted: false };
    this.push(userMessage(args));
  }
  async interrupt() {
    const turn = this.activeTurn;
    if (this.closed || !turn || turn.interrupted) return;
    turn.interrupted = true;
    try { await this.query.interrupt(); }
    catch (error) {
      if (this.activeTurn === turn) turn.interrupted = false;
      throw error;
    }
  }
  applySettings(args: { settings: ProviderSettings }): Promise<void> {
    const requested = { ...args.settings };
    const update = this.settingsQueue.then(async () => {
      if (this.closed) throw new Error("Claude session is closed");
      const previous = this.effectiveSettings;
      try {
        await this.query.setModel(requested.model || undefined);
        await this.query.applyFlagSettings({ effortLevel: requested.effort || null });
        this.effectiveSettings = requested;
      } catch (error) {
        try {
          await this.query.setModel(previous.model || undefined);
          await this.query.applyFlagSettings({ effortLevel: previous.effort || null });
        } catch (rollbackError) {
          this.close();
          throw new Error(`Claude settings update failed and rollback failed; session closed: ${String(rollbackError)}`, { cause: error });
        }
        throw error;
      }
    });
    this.settingsQueue = update.catch(error => this.log("Claude settings update failed", error));
    return update;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.push(null);
    this.query.close();
  }
}

const claudeModels = () => CLAUDE_MODELS.map(([value, label]) => ({ value, label, efforts: [...CLAUDE_EFFORTS] }));

type BoundaryDelegate = { current: ProviderRequestBoundary; boundary: ProviderRequestBoundary };
export const createClaudeBoundaryDelegate = (initial: ProviderRequestBoundary): BoundaryDelegate => {
  const delegate: BoundaryDelegate = {
    current: initial,
    boundary: {
      tool: request => delegate.current.tool(request),
      permission: request => delegate.current.permission(request),
    },
  };
  return delegate;
};
type WarmEntry = {
  fileId: string;
  dir: string;
  settings: ProviderSettings;
  allowedTools: string[];
  delegate: BoundaryDelegate;
  query: Promise<NativeWarmQuery>;
};
const matchesWarm = (entry: WarmEntry, args: {
  fileId: string;
  dir: string;
  settings: ProviderSettings;
  boundary: ProviderRequestBoundary;
  allowedTools: string[];
}) => entry.fileId === args.fileId && entry.dir === args.dir
  && entry.settings.model === args.settings.model && entry.settings.effort === args.settings.effort
  && entry.allowedTools.length === args.allowedTools.length
  && entry.allowedTools.every((toolName, index) => toolName === args.allowedTools[index]);

export class ClaudeProvider implements ReviewProvider {
  readonly id = "claude" as const;
  private warm?: WarmEntry;
  private runtime?: { owner: WarmEntry; prepared?: boolean; error?: string };
  private readonly native: NativeFactory;

  constructor(private readonly args: {
    version: string;
    log: (...values: unknown[]) => void;
    onPrepared: () => void;
    native?: NativeFactory;
    mcpStatusTimeoutMs?: number;
  }) { this.native = args.native ?? DEFAULT_NATIVE; }

  health(args: { settings: ProviderSettings }): ProviderHealth {
    return {
      provider: "claude",
      status: this.runtime?.error ? "unavailable" : this.runtime?.prepared ? "ready" : "starting",
      model: args.settings.model || undefined,
      models: claudeModels(),
      error: this.runtime?.error,
    };
  }

  private closeResolvedWarm(query: NativeWarmQuery, reason: string) {
    try { query.close(); }
    catch (error) { this.args.log(`${reason}: failed to close warm query`, error); }
  }

  private closeWarm(entry: WarmEntry, reason: string) {
    entry.query.then(query => this.closeResolvedWarm(query, reason))
      .catch(error => this.args.log(`${reason}: warm query failed before close`, error));
  }

  prepare(args: { fileId: string; dir: string; settings: ProviderSettings; boundary: ProviderRequestBoundary }) {
    const preparedArgs = { ...args, allowedTools: [...readAllow(args.dir)] };
    if (this.warm && matchesWarm(this.warm, preparedArgs)) {
      this.warm.delegate.current = args.boundary;
      return;
    }
    const previous = this.warm;
    this.warm = undefined;
    if (previous) this.closeWarm(previous, "replaced warm query");
    const delegate = createClaudeBoundaryDelegate(args.boundary);
    const entry: WarmEntry = {
      fileId: args.fileId,
      dir: args.dir,
      settings: { ...args.settings },
      allowedTools: preparedArgs.allowedTools,
      delegate,
      query: this.native.warm({
        options: options({ ...preparedArgs, boundary: delegate.boundary, version: this.args.version, log: this.args.log }),
      }),
    };
    this.warm = entry;
    this.runtime = { owner: entry };
    entry.query.then(() => {
      if (this.warm !== entry || this.runtime?.owner !== entry) return;
      this.runtime = { owner: entry, prepared: true };
      this.args.onPrepared();
    }, error => {
      if (this.warm !== entry || this.runtime?.owner !== entry) return;
      this.runtime = { owner: entry, error: `Claude failed to start: ${error instanceof Error ? error.message : String(error)}` };
      this.warm = undefined;
      this.args.onPrepared();
    });
  }

  async start(args: {
    fileId: string;
    dir: string;
    resume?: string;
    settings: ProviderSettings;
    boundary: ProviderRequestBoundary;
    baseRecord: ProviderSessionRecord;
  }): Promise<ReviewSession> {
    const input = inputStream();
    const startArgs = { ...args, allowedTools: [...readAllow(args.dir)] };
    let nativeQuery: NativeQuery | undefined;
    const warm = this.warm;
    if (warm && (!args.resume && matchesWarm(warm, startArgs))) {
      warm.delegate.current = args.boundary;
      this.warm = undefined;
      let resolved: NativeWarmQuery | undefined;
      try {
        resolved = await warm.query;
        if (this.runtime?.owner === warm) {
          nativeQuery = resolved.query(input.stream);
          this.runtime = { owner: warm, prepared: true };
          this.args.onPrepared();
        } else {
          this.closeResolvedWarm(resolved, "stale consumed warm query");
          this.args.log("discarded stale consumed warm query");
        }
      } catch (error) {
        if (resolved) this.closeResolvedWarm(resolved, "unusable consumed warm query");
        if (this.runtime?.owner === warm) {
          this.runtime = undefined;
          this.args.onPrepared();
        }
        this.args.log("pre-warmed query unusable, starting cold", error);
      }
    } else if (warm) {
      this.warm = undefined;
      if (this.runtime?.owner === warm) {
        this.runtime = undefined;
        this.args.onPrepared();
      }
      this.closeWarm(warm, "incompatible warm query");
    }
    if (!warm && this.runtime?.error) {
      this.runtime = undefined;
      this.args.onPrepared();
    }
    nativeQuery ??= this.native.cold({
      prompt: input.stream,
      options: options({ ...startArgs, version: this.args.version, log: this.args.log }),
    });
    return new ClaudeSession({
      query: nativeQuery,
      push: input.push,
      baseRecord: args.baseRecord,
      settings: args.settings,
      resumed: !!args.resume,
      mcpStatusTimeoutMs: this.args.mcpStatusTimeoutMs ?? MCP_STATUS_TIMEOUT_MS,
      log: this.args.log,
    });
  }

  readHistory(args: { dir: string; sessionId: string }): HistoryItem[] { return readClaudeTranscript(args); }
  dispose() {
    const warm = this.warm;
    this.warm = undefined;
    this.runtime = undefined;
    if (warm) this.closeWarm(warm, "disposed warm query");
    this.args.onPrepared();
  }
}

export { readClaudeTranscript } from "./claude-history.ts";
export { zeroUsage as zeroClaudeUsage };
