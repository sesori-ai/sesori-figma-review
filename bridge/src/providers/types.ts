import type {
  CostStatus,
  HistoryItem,
  NodeRef,
  PermissionDecision,
  ProviderHealth,
  ProviderId,
  ProviderSettings,
  ReviewEvent,
  SessionRecord,
  ToolResult,
  Usage,
} from "../../../shared/protocol.ts";
import type { FigmaToolRequest } from "../figma-tools.ts";

export type ProviderRequestBoundary = {
  tool: (request: FigmaToolRequest) => Promise<ToolResult>;
  permission: (request: { tool: string; input: Record<string, unknown> }) => Promise<PermissionDecision>;
};

export type ProviderOutput =
  | { kind: "initialized"; sessionId: string; health: ProviderHealth; servers?: { name: string; status: string; error?: string }[] }
  | { kind: "event"; event: ReviewEvent }
  | { kind: "usage"; usage: Usage; cost: { usd: number; status: CostStatus }; turnCompleted: boolean };

export interface ReviewSession {
  readonly provider: ProviderId;
  readonly output: AsyncIterable<ProviderOutput>;
  send(args: { text: string; selection: NodeRef[]; context?: string }): void;
  interrupt(): Promise<void>;
  applySettings(args: { settings: ProviderSettings }): Promise<void>;
  close(): void;
}

export interface ReviewProvider {
  readonly id: ProviderId;
  health(args: { settings: ProviderSettings }): ProviderHealth;
  prepare(args: { fileId: string; dir: string; settings: ProviderSettings; boundary: ProviderRequestBoundary }): void;
  start(args: {
    fileId: string;
    dir: string;
    resume?: string;
    settings: ProviderSettings;
    boundary: ProviderRequestBoundary;
    baseRecord: SessionRecord;
  }): Promise<ReviewSession>;
  readHistory(args: { dir: string; sessionId: string }): HistoryItem[];
  dispose(): void;
}
