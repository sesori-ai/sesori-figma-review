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
    && item.supportedReasoningEfforts.length > 0)
  .map(item => ({
    value: item.model,
    label: item.displayName,
    efforts: item.supportedReasoningEfforts.map(option => option.reasoningEffort),
  }));
