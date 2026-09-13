import { z } from "zod";
import type { ModelDescriptor } from "../../../shared/protocol.ts";

// Consumed projection from `codex app-server generate-json-schema --experimental` at 0.154.0.
// Generated bulk schema is inspection evidence only; these validators do not claim native policy enforcement.
export type JsonRpcId = string | number;
export type CodexServerRequest = { id: JsonRpcId; method: string; params?: unknown };
export type CodexNotification = { method: string; params?: unknown };
export type CodexAccountRoute = "apiKey" | "chatgpt";
export type CodexQualification = {
  version: string;
  auth: CodexAccountRoute;
  models: ModelDescriptor[];
};

const record = z.record(z.string(), z.unknown());
const rpcId = z.union([z.string(), z.number().int().safe()]);
const rpcMessage = z.object({
  id: rpcId.optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number().int(), message: z.string(), data: z.unknown().optional() }).optional(),
}).passthrough();

export type CodexRpcMessage = z.infer<typeof rpcMessage>;
export const parseCodexRpcMessage = (value: unknown): CodexRpcMessage => rpcMessage.parse(value);

const initializeResult = z.object({
  userAgent: z.string().min(1),
  codexHome: z.string().min(1),
  platformFamily: z.string().min(1),
  platformOs: z.string().min(1),
}).passthrough();
export type CodexInitializeResult = z.infer<typeof initializeResult>;
export const parseInitializeResult = (value: unknown): CodexInitializeResult => initializeResult.parse(value);

const accountResult = z.object({
  requiresOpenaiAuth: z.boolean(),
  account: z.discriminatedUnion("type", [
    z.object({ type: z.literal("apiKey") }).passthrough(),
    z.object({ type: z.literal("chatgpt") }).passthrough(),
    z.object({ type: z.literal("amazonBedrock") }).passthrough(),
  ]).nullable(),
}).passthrough();
export type CodexAccountResult = z.infer<typeof accountResult>;
export const parseAccountResult = (value: unknown): CodexAccountResult => accountResult.parse(value);

const model = z.object({
  id: z.string().min(1),
  model: z.string().min(1),
  displayName: z.string().min(1),
  hidden: z.boolean(),
  isDefault: z.boolean(),
  defaultReasoningEffort: z.string().min(1),
  inputModalities: z.array(z.enum(["text", "image", "audio"])).default(["text", "image"]),
  supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string().min(1) }).passthrough()),
}).passthrough();
const modelListResult = z.object({ data: z.array(model), nextCursor: z.string().nullable().optional() }).passthrough();
export type CodexModelListResult = z.infer<typeof modelListResult>;
export const parseModelListResult = (value: unknown): CodexModelListResult => modelListResult.parse(value);

const permissionProfileListResult = z.object({
  data: z.array(z.object({ id: z.string().min(1), allowed: z.boolean() }).passthrough()),
  nextCursor: z.string().nullable().optional(),
}).passthrough();
export type CodexPermissionProfileListResult = z.infer<typeof permissionProfileListResult>;
export const parsePermissionProfileListResult = (value: unknown): CodexPermissionProfileListResult =>
  permissionProfileListResult.parse(value);

const configReadResult = z.object({
  config: record,
  origins: record,
  layers: z.array(z.unknown()).nullable().optional(),
}).passthrough();
export type CodexConfigReadResult = z.infer<typeof configReadResult>;
export const parseConfigReadResult = (value: unknown): CodexConfigReadResult => configReadResult.parse(value);

export const projectCodexModels = (result: CodexModelListResult): ModelDescriptor[] => result.data
  .filter(item => !item.hidden && item.inputModalities.includes("text") && item.inputModalities.includes("image")
    && item.supportedReasoningEfforts.some(option => option.reasoningEffort === item.defaultReasoningEffort))
  .map(item => ({
    value: item.model,
    label: item.displayName,
    efforts: item.supportedReasoningEfforts.map(option => option.reasoningEffort),
    isDefault: item.isDefault,
    defaultEffort: item.defaultReasoningEffort,
  }));

const identifier = z.string().min(1);
const userInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).passthrough(),
  z.object({ type: z.literal("image"), url: z.string() }).passthrough(),
  z.object({ type: z.literal("localImage"), path: z.string() }).passthrough(),
  z.object({ type: z.literal("skill"), name: z.string(), path: z.string() }).passthrough(),
]);
const fileChange = z.object({ path: z.string(), kind: z.unknown(), diff: z.string() }).passthrough();
const dynamicContent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("inputText"), text: z.string() }),
  z.object({ type: z.literal("inputImage"), imageUrl: z.string() }),
  z.object({ type: z.literal("inputAudio"), audioUrl: z.string() }),
]);
const knownThreadItemTypes = new Set([
  "userMessage", "agentMessage", "dynamicToolCall", "commandExecution", "fileChange", "mcpToolCall", "contextCompaction",
]);
const knownThreadItem = z.discriminatedUnion("type", [
  z.object({ type: z.literal("userMessage"), id: identifier, content: z.array(userInput) }).passthrough(),
  z.object({ type: z.literal("agentMessage"), id: identifier, text: z.string() }).passthrough(),
  z.object({ type: z.literal("dynamicToolCall"), id: identifier, tool: identifier, arguments: z.unknown(),
    status: z.string(), contentItems: z.array(dynamicContent).nullable().optional(), success: z.boolean().nullable().optional() }).passthrough(),
  z.object({ type: z.literal("commandExecution"), id: identifier, command: z.string(), cwd: z.string(),
    status: z.string() }).passthrough(),
  z.object({ type: z.literal("fileChange"), id: identifier, changes: z.array(fileChange), status: z.string() }).passthrough(),
  z.object({ type: z.literal("mcpToolCall"), id: identifier, server: identifier, tool: identifier,
    arguments: z.unknown(), status: z.string() }).passthrough(),
  z.object({ type: z.literal("contextCompaction"), id: identifier }).passthrough(),
]);
export const codexThreadItem = z.union([
  knownThreadItem,
  z.object({ type: z.string().refine(type => !knownThreadItemTypes.has(type)), id: identifier }).passthrough()
    .transform(value => ({ type: "ignored" as const, id: value.id })),
]);
export type CodexThreadItem = z.infer<typeof codexThreadItem>;
const turn = z.object({ id: identifier, items: z.array(codexThreadItem), status: z.enum([
  "completed", "interrupted", "failed", "inProgress",
]), error: z.object({ message: z.string() }).passthrough().nullable().optional() }).passthrough();
const threadEnvironment = z.object({
  environmentId: z.literal("local"), cwd: z.string(), runtimeWorkspaceRoots: z.array(z.string()),
});
const thread = z.object({
  id: identifier, turns: z.array(turn), environments: z.array(threadEnvironment).nullable().optional(),
}).passthrough();
const threadStartResult = z.object({
  thread, model: identifier, cwd: z.string(), runtimeWorkspaceRoots: z.array(z.string()),
  approvalsReviewer: z.enum(["user", "auto_review"]), approvalPolicy: record,
  activePermissionProfile: z.object({ id: identifier, extends: z.string().nullable().optional() }).passthrough().nullable(),
  reasoningEffort: z.string().nullable(), serviceTier: z.string().nullable(),
}).passthrough();
export type CodexThreadStartResult = z.infer<typeof threadStartResult>;
export const parseThreadStartResult = (value: unknown): CodexThreadStartResult => threadStartResult.parse(value);
export const parseThreadReadResult = (value: unknown) => z.object({ thread }).passthrough().parse(value);
export const parseTurnStartResult = (value: unknown) => z.object({ turn }).passthrough().parse(value);
export const parseEmptyResult = (value: unknown) => z.object({}).passthrough().parse(value);
export const parseTurnSteerResult = (value: unknown) => z.object({ turnId: identifier }).passthrough().parse(value);
export const parseTurnSettingsResult = (value: unknown) => z.object({
  status: z.enum(["applied", "targetUnavailable"]),
}).passthrough().parse(value);

const envelope = { threadId: identifier, turnId: identifier };
const turnNotification = z.object({ threadId: identifier, turn });
const itemNotification = z.object({ ...envelope, item: codexThreadItem });
const deltaNotification = z.object({ ...envelope, itemId: identifier, delta: z.string() });
const threadSettingsNotification = z.object({
  threadId: identifier, threadSettings: z.object({
    model: identifier, effort: z.string().nullable(), serviceTier: z.string().nullable(), cwd: z.string(),
  }).passthrough(),
});
const usageNotification = z.object({
  ...envelope,
  tokenUsage: z.object({ total: z.object({
    inputTokens: z.number().int().nonnegative().safe(), cachedInputTokens: z.number().int().nonnegative().safe(),
    cacheWriteInputTokens: z.number().int().nonnegative().safe().default(0),
    outputTokens: z.number().int().nonnegative().safe(), reasoningOutputTokens: z.number().int().nonnegative().safe(),
  }).passthrough() }).passthrough(),
});
export type CodexConsumedNotification =
  | { method: "turn/started"; params: z.infer<typeof turnNotification> }
  | { method: "turn/completed"; params: z.infer<typeof turnNotification> }
  | { method: "item/started"; params: z.infer<typeof itemNotification> }
  | { method: "item/completed"; params: z.infer<typeof itemNotification> }
  | { method: "item/agentMessage/delta"; params: z.infer<typeof deltaNotification> }
  | { method: "thread/settings/updated"; params: z.infer<typeof threadSettingsNotification> }
  | { method: "thread/tokenUsage/updated"; params: z.infer<typeof usageNotification> };
export const parseCodexNotification = (notification: CodexNotification): CodexConsumedNotification | undefined => {
  switch (notification.method) {
    case "turn/started": return { method: "turn/started", params: turnNotification.parse(notification.params) };
    case "turn/completed": return { method: "turn/completed", params: turnNotification.parse(notification.params) };
    case "item/started": return { method: "item/started", params: itemNotification.parse(notification.params) };
    case "item/completed": return { method: "item/completed", params: itemNotification.parse(notification.params) };
    case "item/agentMessage/delta": return { method: notification.method, params: deltaNotification.parse(notification.params) };
    case "thread/settings/updated": return { method: notification.method,
      params: threadSettingsNotification.parse(notification.params) };
    case "thread/tokenUsage/updated": return { method: notification.method, params: usageNotification.parse(notification.params) };
    default: return undefined;
  }
};

const turnRequestBase = z.object({ threadId: identifier, turnId: identifier }).passthrough();
const requestBase = turnRequestBase.extend({ itemId: identifier });
export const parseDynamicToolRequest = (value: unknown) => turnRequestBase.extend({
  callId: identifier, namespace: z.string().nullable().optional(), tool: identifier, arguments: z.unknown(),
}).parse(value);
const commandApprovalDecision = z.union([
  z.enum(["accept", "acceptForSession", "decline", "cancel"]),
  z.strictObject({ acceptWithExecpolicyAmendment: z.strictObject({ execpolicy_amendment: z.array(z.string()) }) }),
  z.strictObject({ applyNetworkPolicyAmendment: z.strictObject({
    network_policy_amendment: z.strictObject({ host: z.string(), action: z.enum(["allow", "deny"]) }),
  }) }),
]);
export const parseCommandApprovalRequest = (value: unknown) => requestBase.extend({
  kind: z.enum(["command", "writeStdin"]).default("command"), command: z.string().nullable().optional(),
  cwd: z.string().nullable().optional(), reason: z.string().nullable().optional(),
  networkApprovalContext: z.unknown().nullable().optional(),
  additionalPermissions: record.nullable().optional(), proposedExecpolicyAmendment: z.unknown().nullable().optional(),
  proposedNetworkPolicyAmendments: z.unknown().nullable().optional(),
  availableDecisions: z.array(commandApprovalDecision).nullable().optional(),
}).parse(value);
export const parseFileApprovalRequest = (value: unknown) => requestBase.extend({
  reason: z.string().nullable().optional(), grantRoot: z.string().nullable().optional(),
}).parse(value);
export const parsePermissionsApprovalRequest = (value: unknown) => requestBase.extend({
  cwd: z.string(), reason: z.string().nullable(), permissions: record,
}).parse(value);
export const parseUserInputRequest = (value: unknown) => requestBase.extend({
  isBlocking: z.boolean(), questions: z.array(z.object({
    id: identifier, question: z.string(), options: z.array(z.object({ label: z.string() }).passthrough()).nullable(),
  }).passthrough()),
}).parse(value);

const accountUsage = z.object({ threadUsage: z.object({
  threadId: identifier,
  estimatedUsageUsdMicros: z.number().int().nonnegative().safe().nullable(),
  estimatedUsageCreditsMicros: z.number().int().nonnegative().safe().nullable().optional(),
}).passthrough().nullable().optional() }).passthrough();
export const parseAccountUsageResult = (value: unknown) => accountUsage.parse(value);
export type CodexUsageAvailability = {
  threadUsagePresent: boolean; threadMatches: boolean; usdPresent: boolean; creditsPresent: boolean;
};
export const codexUsageAvailability = (
  result: ReturnType<typeof parseAccountUsageResult>, expectedThreadId: string,
): CodexUsageAvailability => ({
  threadUsagePresent: result.threadUsage != null,
  threadMatches: result.threadUsage?.threadId === expectedThreadId,
  usdPresent: result.threadUsage?.estimatedUsageUsdMicros != null,
  creditsPresent: result.threadUsage?.estimatedUsageCreditsMicros != null,
});
