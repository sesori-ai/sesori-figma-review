import { PROTOCOL_VERSION, type DownMsg } from "../../shared/protocol.ts";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const optional = (value: unknown, valid: (value: unknown) => boolean) => value === undefined || valid(value);
const string = (value: unknown) => typeof value === "string";
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value);
const strings = (value: unknown) => Array.isArray(value) && value.every(string);
const providerId = (value: unknown) => value === "claude" || value === "codex";
const sessionRef = (value: unknown) => {
  const item = object(value); return !!item && providerId(item.provider) && string(item.sessionId);
};
const usage = (value: unknown) => {
  const item = object(value); return !!item && number(item.input) && number(item.output)
    && number(item.cacheRead) && number(item.cacheWrite);
};
const anchor = (value: unknown) => {
  const item = object(value); return !!item && (item.type === "flow" || item.type === "selection" || item.type === "page")
    && strings(item.nodeIds);
};
const sessionRecord = (value: unknown) => {
  const item = object(value); return !!item && sessionRef(item) && string(item.title) && anchor(item.anchor)
    && string(item.pageId) && string(item.pageName) && string(item.createdAt) && string(item.updatedAt)
    && number(item.turns) && number(item.costUsd)
    && (item.costStatus === "reported" || item.costStatus === "estimated" || item.costStatus === "unavailable")
    && usage(item.usage);
};
const model = (value: unknown) => {
  const item = object(value); return !!item && string(item.value) && string(item.label) && strings(item.efforts);
};
const providerHealth = (value: unknown) => {
  const item = object(value); return !!item && providerId(item.provider)
    && (item.status === "starting" || item.status === "ready" || item.status === "unavailable")
    && optional(item.version, string) && optional(item.model, string) && Array.isArray(item.models) && item.models.every(model)
    && optional(item.error, string);
};
const settings = (value: unknown) => {
  const item = object(value), providers = object(item?.providers);
  const setting = (raw: unknown) => { const entry = object(raw); return !!entry && string(entry.model) && string(entry.effort); };
  return !!item && providerId(item.provider) && !!providers && setting(providers.claude) && setting(providers.codex);
};
const historyItem = (value: unknown) => {
  const item = object(value);
  if (!item) return false;
  if (item.role === "user" || item.role === "answer") return string(item.text);
  if (item.role === "assistant") return string(item.text) && optional(item.itemId, string);
  return item.role === "tool" && string(item.name) && !!object(item.input) && optional(item.itemId, string);
};
const reviewEvent = (value: unknown) => {
  const event = object(value);
  if (!event || !string(event.itemId) || !sessionRef(event.session)) return false;
  if (event.type === "text_start" || event.type === "text_end") return true;
  if (event.type === "text_delta" || event.type === "status") return string(event.text);
  if (event.type === "tool") return string(event.name) && !!object(event.input);
  if (event.type === "error") return string(event.message);
  return event.type === "turn_end" && (event.outcome === "completed" || event.outcome === "interrupted" || event.outcome === "failed")
    && optional(event.message, string);
};
const health = (value: unknown) => {
  const item = object(value), result = object(item?.settingsResult);
  return !!item && item.protocolVersion === PROTOCOL_VERSION && string(item.bridge)
    && (item.figmaMcp === "up" || item.figmaMcp === "down") && providerId(item.selectedProvider)
    && optional(item.liveProvider, providerId) && settings(item.settings)
    && Array.isArray(item.providers) && item.providers.every(providerHealth)
    && optional(item.servers, value => Array.isArray(value) && value.every(raw => {
      const server = object(raw); return !!server && string(server.name) && string(server.status) && optional(server.error, string);
    }))
    && (item.settingsResult === undefined || (!!result && string(result.requestId) && typeof result.accepted === "boolean"
      && optional(result.error, string))) && optional(item.error, string);
};

/** Reject legacy/malformed envelopes before UI state or provider dereferences. */
export function decodeBridgeMessage(raw: unknown): DownMsg | undefined {
  const message = object(raw);
  if (!message || !string(message.kind)) return;
  let valid = false;
  switch (message.kind) {
    case "connection": valid = message.protocolVersion === PROTOCOL_VERSION && typeof message.busy === "boolean"
      && optional(message.intentId, string) && optional(message.session, sessionRecord)
      && optional(message.activeText, value => Array.isArray(value) && value.every(raw => {
        const item = object(raw); return !!item && sessionRef(item.session) && string(item.itemId) && string(item.text);
      })); break;
    case "health": valid = health(message.health); break;
    case "sessions": valid = Array.isArray(message.sessions) && message.sessions.every(sessionRecord); break;
    case "history": valid = string(message.intentId) && sessionRecord(message.session)
      && Array.isArray(message.messages) && message.messages.every(historyItem) && typeof message.attached === "boolean"; break;
    case "started": valid = string(message.intentId) && sessionRecord(message.session); break;
    case "session": valid = sessionRecord(message.session); break;
    case "tool": valid = string(message.id) && string(message.tool) && !!object(message.args); break;
    case "permission": valid = string(message.id) && string(message.tool) && !!object(message.input); break;
    case "cancel_request": valid = string(message.id) && string(message.reason); break;
    case "event": valid = reviewEvent(message.event); break;
    case "busy": valid = typeof message.busy === "boolean"; break;
    case "error": valid = string(message.message) && optional(message.intentId, string); break;
  }
  return valid ? message as DownMsg : undefined;
}
