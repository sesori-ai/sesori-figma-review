import { query, startup, type Options, type Query, type SDKUserMessage, type WarmQuery } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  FIGMA_MCP_URL,
  type HistoryItem,
  type NodeRef,
  type ProviderHealth,
  type ProviderSettings,
  type ReviewEvent,
  type SessionRef,
  type Usage,
} from "../../../shared/protocol.ts";
import { createClaudeFigmaServer } from "../figma-tools.ts";
import { readAllow } from "../workspace.ts";
import type { ProviderOutput, ProviderRequestBoundary, ReviewProvider, ReviewSession } from "./types.ts";

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

function options(args: {
  version: string;
  dir: string;
  resume?: string;
  settings: ProviderSettings;
  boundary: ProviderRequestBoundary;
  log: (...values: unknown[]) => void;
}): Options {
  const appRepo = process.env.APP_REPO;
  const maxTurns = Number(process.env.SESORI_REVIEW_MAX_TURNS ?? 0) || undefined;
  const maxBudgetUsd = Number(process.env.SESORI_REVIEW_MAX_BUDGET_USD ?? 0) || undefined;
  return {
    cwd: args.dir,
    resume: args.resume,
    settingSources: ["project"],
    additionalDirectories: appRepo ? [appRepo] : [],
    systemPrompt: SYSTEM,
    mcpServers: {
      figma: createClaudeFigmaServer({ version: args.version, forward: request => args.boundary.tool(request) }),
      "figma-desktop": { type: "http", url: FIGMA_MCP_URL },
    },
    strictMcpConfig: true,
    tools: ["Read", "Glob", "Grep", "Write", "Edit", "Skill"],
    allowedTools: readAllow(args.dir),
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

function displayEvents(args: { message: unknown; sessionId: string; interrupted: boolean }): ReviewEvent[] {
  const message = object(args.message);
  if (!message || !args.sessionId) return [];
  const session = ref({ sessionId: args.sessionId });
  const type = message.type;
  if (type === "stream_event" && !message.parent_tool_use_id) {
    const event = object(message.event);
    const eventType = event?.type;
    const index = number(event?.index);
    const itemId = `${typeof message.uuid === "string" ? message.uuid : "stream"}:${index}`;
    if (eventType === "content_block_start" && object(event?.content_block)?.type === "text") return [{ type: "text_start", session, itemId }];
    const delta = object(event?.delta);
    if (eventType === "content_block_delta" && delta?.type === "text_delta" && typeof delta.text === "string") {
      return [{ type: "text_delta", session, itemId, text: delta.text }];
    }
    if (eventType === "content_block_stop") return [{ type: "text_end", session, itemId }];
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

class ClaudeSession implements ReviewSession {
  readonly provider = "claude" as const;
  readonly output: AsyncIterable<ProviderOutput>;
  private interrupted = false;

  constructor(private readonly query: Query, private readonly push: (message: SDKUserMessage | null) => void, baseUsage: Usage, baseCost: number) {
    const self = this;
    this.output = (async function* () {
      let sessionId = "";
      let usage = baseUsage;
      for await (const sdkMessage of self.query) {
        const message = object(sdkMessage);
        if (message?.type === "system" && message.subtype === "init" && typeof message.session_id === "string") {
          sessionId = message.session_id;
          const servers = await self.query.mcpServerStatus().catch(() => []);
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
            servers: servers.map(server => ({ name: server.name, status: server.status, error: server.error })),
          };
        }
        for (const event of displayEvents({ message: sdkMessage, sessionId, interrupted: self.interrupted })) yield { kind: "event", event };
        if (message?.type === "result") {
          usage = addClaudeUsage(usage, message.usage);
          yield {
            kind: "usage",
            usage,
            cost: { usd: baseCost + number(message.total_cost_usd), status: "reported" },
            turnCompleted: true,
          };
          self.interrupted = false;
        }
      }
    })();
  }

  send(args: { text: string; selection: NodeRef[]; context?: string }) { this.push(userMessage(args)); }
  async interrupt() { this.interrupted = true; await this.query.interrupt(); }
  async applySettings(args: { settings: ProviderSettings }) {
    await this.query.setModel(args.settings.model || undefined);
    await this.query.applyFlagSettings({ effortLevel: (args.settings.effort || null) as Parameters<Query["applyFlagSettings"]>[0]["effortLevel"] });
  }
  close() { this.push(null); this.query.close(); }
}

const claudeModels = () => CLAUDE_MODELS.map(([value, label]) => ({ value, label, efforts: [...CLAUDE_EFFORTS] }));

export class ClaudeProvider implements ReviewProvider {
  readonly id = "claude" as const;
  private warm?: { dir: string; query: Promise<WarmQuery> };
  private runtime?: { prepared?: boolean; error?: string };

  constructor(private readonly args: { version: string; log: (...values: unknown[]) => void; onPrepared: () => void }) {}

  health(args: { settings: ProviderSettings }): ProviderHealth {
    return {
      provider: "claude",
      status: this.runtime?.error ? "unavailable" : this.runtime?.prepared ? "ready" : "starting",
      model: args.settings.model || undefined,
      models: claudeModels(),
      error: this.runtime?.error,
    };
  }

  prepare(args: { fileId: string; dir: string; settings: ProviderSettings; boundary: ProviderRequestBoundary }) {
    if (this.warm?.dir === args.dir) return;
    this.warm?.query.then(query => query.close()).catch(() => {});
    const warmQuery = startup({ options: options({ ...args, version: this.args.version, log: this.args.log }) });
    this.warm = { dir: args.dir, query: warmQuery };
    warmQuery.then(() => {
      this.runtime = { prepared: true };
      this.args.onPrepared();
    }, error => {
      this.runtime = { error: `Claude failed to start: ${error instanceof Error ? error.message : String(error)}` };
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
    baseRecord: { usage: Usage; costUsd: number };
  }): Promise<ReviewSession> {
    const input = inputStream();
    let sdkQuery: Query | undefined;
    if (!args.resume && this.warm?.dir === args.dir) {
      const warm = this.warm;
      this.warm = undefined;
      try { sdkQuery = (await warm.query).query(input.stream); } catch (error) { this.args.log("pre-warmed query unusable, starting cold", error); }
    }
    sdkQuery ??= query({ prompt: input.stream, options: options({ ...args, version: this.args.version, log: this.args.log }) });
    return new ClaudeSession(sdkQuery, input.push, args.baseRecord.usage, args.baseRecord.costUsd);
  }

  readHistory(args: { dir: string; sessionId: string }): HistoryItem[] { return readClaudeTranscript(args); }
  dispose() { this.warm?.query.then(query => query.close()).catch(() => {}); this.warm = undefined; }
}

/** Claude Code native transcript projection. Hidden reasoning and screenshot bytes are excluded. */
export function readClaudeTranscript(args: { dir: string; sessionId: string }): HistoryItem[] {
  const root = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const path = join(root, "projects", args.dir.replace(/[^a-zA-Z0-9]/g, "-"), `${args.sessionId}.jsonl`);
  if (!existsSync(path)) return [];
  const out: HistoryItem[] = [];
  const toolNames = new Map<string, string>();
  const strip = (text: string) => text.split("\n").filter(line => !/^\[(Figma file |Current selection: )/.test(line)).join("\n").trim();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    const record = object(parsed);
    const content = object(record?.message)?.content;
    if (record?.type === "user" && !record.isMeta) {
      if (typeof content === "string") out.push({ role: "user", text: strip(content) });
      for (const blockValue of Array.isArray(content) ? content : []) {
        const block = object(blockValue);
        if (block?.type === "text" && typeof block.text === "string" && /^\[Request interrupted/.test(block.text)) {
          out.push({ role: "tool", name: "stopped", input: {} });
        } else if (block?.type === "tool_result" && typeof block.tool_use_id === "string" && toolNames.get(block.tool_use_id) === "mcp__figma__ask_user") {
          const values = Array.isArray(block.content) ? block.content : [];
          const answer = typeof block.content === "string" ? block.content : values.map(value => object(value)?.text ?? "").join("");
          out.push({ role: "answer", text: strip(String(answer)) });
        }
      }
    }
    if (record?.type === "assistant") for (const blockValue of Array.isArray(content) ? content : []) {
      const block = object(blockValue);
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) out.push({ role: "assistant", text: block.text });
      if (block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        toolNames.set(block.id, block.name);
        out.push({ role: "tool", name: block.name, input: object(block.input) ?? {} });
      }
    }
  }
  return out;
}

export { displayEvents as normalizeClaudeDisplayEvents, zeroUsage as zeroClaudeUsage };
