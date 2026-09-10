// Wire protocol between the Figma plugin (WebSocket client) and the bridge (WebSocket server).
// Both packages import this file directly; there is no build step for it.

export const PROTOCOL_VERSION = 3;
export const BRIDGE_PORT = 3055;
export const FIGMA_MCP_URL = "http://127.0.0.1:3845/mcp";

export type ProviderId = "claude" | "codex";
export type SessionRef = { provider: ProviderId; sessionId: string };
export type NodeRef = { id: string; name: string; type: string };

/** Where a conversation starts. Stored with the session so it can be resumed later. */
export type Anchor = { type: "flow" | "selection" | "page"; nodeIds: string[] };

/** Tool-result content the plugin returns for a forwarded tool call. */
export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: "image/png" };
export type ToolResult = { content: ToolContent[]; isError?: boolean };

export type PermissionDecision = { behavior: "allow" } | { behavior: "deny"; message: string };
export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type CostStatus = "reported" | "estimated" | "unavailable";

export type SessionRecord = {
  provider: ProviderId;
  sessionId: string;
  title: string;
  anchor: Anchor;
  pageId: string;
  pageName: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
  costUsd: number;
  costStatus: CostStatus;
  usage: Usage;
};

export type ProviderSettings = { model: string; effort: string };
export type Settings = {
  /** Provider used only for new sessions. Existing sessions remain bound to their provider. */
  provider: ProviderId;
  providers: Record<ProviderId, ProviderSettings>;
};

export type ModelDescriptor = { value: string; label: string; efforts: string[] };
export type ProviderHealth = {
  provider: ProviderId;
  status: "starting" | "ready" | "unavailable";
  version?: string;
  model?: string;
  models: ModelDescriptor[];
  error?: string;
};
export type Health = {
  bridge: string;
  protocolVersion: number;
  figmaMcp: "up" | "down";
  selectedProvider: ProviderId;
  liveProvider?: ProviderId;
  settings: Settings;
  providers: ProviderHealth[];
  servers?: { name: string; status: string; error?: string }[];
  error?: string;
};

/** Provider-neutral rendered activity. Provider SDK/RPC payloads never cross the wire. */
export type ReviewEvent =
  | { type: "text_start"; session: SessionRef; itemId: string }
  | { type: "text_delta"; session: SessionRef; itemId: string; text: string }
  | { type: "text_end"; session: SessionRef; itemId: string }
  | { type: "tool"; session: SessionRef; itemId: string; name: string; input: Record<string, unknown> }
  | { type: "status"; session: SessionRef; itemId: string; text: string }
  | { type: "error"; session: SessionRef; itemId: string; message: string }
  | { type: "turn_end"; session: SessionRef; itemId: string; outcome: "completed" | "interrupted" | "failed"; message?: string };

/** One rendered item of a past native conversation. */
export type HistoryItem =
  | { role: "user" | "assistant" | "answer"; text: string }
  | { role: "tool"; name: string; input: Record<string, unknown> };

// ---- plugin -> bridge -------------------------------------------------------

export type UpMsg =
  | { kind: "hello"; protocolVersion: number; fileId: string; fileName: string }
  | {
      kind: "start";
      fileId: string;
      fileName: string;
      pageId: string;
      pageName: string;
      anchor: Anchor;
      intentId: string;
      resume?: SessionRef;
      text: string;
      selection: NodeRef[];
    }
  | { kind: "user"; text: string; selection: NodeRef[] }
  | { kind: "open"; intentId: string; fileId: string; fileName: string; session: SessionRef }
  | { kind: "reply"; id: string; result: ToolResult | PermissionDecision }
  | { kind: "interrupt" }
  | { kind: "close"; reason: string }
  | { kind: "settings"; settings: Settings }
  | { kind: "health" };

// ---- bridge -> plugin -------------------------------------------------------

export type DownMsg =
  | { kind: "connection"; protocolVersion: number; intentId?: string; session?: SessionRecord; busy: boolean }
  | { kind: "health"; health: Health }
  | { kind: "sessions"; sessions: SessionRecord[] }
  | { kind: "history"; intentId: string; session: SessionRecord; messages: HistoryItem[]; attached: boolean }
  | { kind: "started"; intentId: string; session: SessionRecord }
  | { kind: "session"; session: SessionRecord }
  | { kind: "tool"; id: string; tool: string; args: Record<string, unknown> }
  | { kind: "permission"; id: string; tool: string; input: Record<string, unknown> }
  | { kind: "cancel_request"; id: string; reason: string }
  | { kind: "event"; event: ReviewEvent }
  | { kind: "busy"; busy: boolean }
  | { kind: "error"; message: string };
