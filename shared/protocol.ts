// Wire protocol between the Figma plugin (WebSocket client) and the bridge (WebSocket server).
// Both packages import this file directly; there is no build step for it.

export type NodeRef = { id: string; name: string; type: string };

/** Where a conversation starts. Stored with the session so it can be resumed later. */
export type Anchor = { type: "flow" | "selection" | "page"; nodeIds: string[] };

/** MCP tool-result content the plugin returns for a forwarded tool call. */
export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: "image/png" };
export type ToolResult = { content: ToolContent[]; isError?: boolean };

export type PermissionDecision = { behavior: "allow" } | { behavior: "deny"; message: string };

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };

export type SessionRecord = {
  sessionId: string;
  title: string;
  anchor: Anchor;
  pageId: string;
  pageName: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
  costUsd: number;
  usage: Usage;
};

// ---- plugin -> bridge -------------------------------------------------------

export type UpMsg =
  /** Sent on every (re)connect. Bridge answers with `health` + `sessions` and pre-warms a session. */
  | { kind: "hello"; fileId: string; fileName: string }
  /** Start a conversation (new, or `resume` an existing session id) with its first user message. */
  | {
      kind: "start";
      fileId: string;
      fileName: string;
      pageId: string;
      pageName: string;
      anchor: Anchor;
      resume?: string;
      text: string;
      selection: NodeRef[];
    }
  /** Follow-up message. Delivered mid-turn as steering; the bridge never queues it. */
  | { kind: "user"; text: string; selection: NodeRef[] }
  /** History → Open: bridge answers with `history` (past messages). The session is resumed on the next `start`. */
  | { kind: "open"; fileId: string; fileName: string; sessionId: string }
  /** Answer to a `tool` (ToolResult) or `permission` (PermissionDecision) request. */
  | { kind: "reply"; id: string; result: ToolResult | PermissionDecision }
  /** Stop button: interrupt the running turn. */
  | { kind: "interrupt" }
  /** Re-run the health probe. */
  | { kind: "health" };

// ---- bridge -> plugin -------------------------------------------------------

export type Health = {
  bridge: string;
  figmaMcp: "up" | "down";
  claude?: string;
  model?: string;
  servers?: { name: string; status: string; error?: string }[];
  error?: string;
};

/** One rendered item of a past conversation, read from the Claude Code transcript. */
export type HistoryItem =
  | { role: "user" | "assistant" | "answer"; text: string }
  | { role: "tool"; name: string; input: Record<string, unknown> };

export type DownMsg =
  | { kind: "health"; health: Health }
  | { kind: "sessions"; sessions: SessionRecord[] }
  /** Past messages of an opened session; `attached` when that session is the one currently running. */
  | { kind: "history"; session: SessionRecord; messages: HistoryItem[]; attached: boolean }
  /** Current session created or updated (cost, tokens, turns). */
  | { kind: "session"; session: SessionRecord }
  /** Run a Figma tool and reply with a ToolResult. `ask_user` is handled by the plugin UI. */
  | { kind: "tool"; id: string; tool: string; args: Record<string, unknown> }
  /** Ask the user to allow or deny a tool call; reply with a PermissionDecision. */
  | { kind: "permission"; id: string; tool: string; input: Record<string, unknown> }
  /** Raw Claude Agent SDK message (stream_event, assistant, result, system). */
  | { kind: "sdk"; msg: any }
  | { kind: "busy"; busy: boolean }
  | { kind: "error"; message: string };

export const BRIDGE_PORT = 3055;
export const FIGMA_MCP_URL = "http://127.0.0.1:3845/mcp";
