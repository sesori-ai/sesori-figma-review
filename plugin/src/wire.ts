import { PROTOCOL_VERSION, type DownMsg } from "../../shared/protocol.ts";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const session = (value: unknown) => {
  const item = object(value);
  return !!item && (item.provider === "claude" || item.provider === "codex") && typeof item.sessionId === "string";
};

/** Minimal wire guard: reject legacy/malformed envelopes before UI state or provider dereferences. */
export function decodeBridgeMessage(raw: unknown): DownMsg | undefined {
  const message = object(raw);
  if (!message || typeof message.kind !== "string") return;
  let valid = false;
  switch (message.kind) {
    case "connection":
      valid = message.protocolVersion === PROTOCOL_VERSION && typeof message.busy === "boolean"
        && (message.intentId === undefined || typeof message.intentId === "string")
        && (message.session === undefined || session(message.session));
      break;
    case "health": {
      const health = object(message.health);
      const settings = object(health?.settings);
      const providers = object(settings?.providers);
      const claude = object(providers?.claude), codex = object(providers?.codex);
      valid = health?.protocolVersion === PROTOCOL_VERSION && typeof health.bridge === "string"
        && (health.selectedProvider === "claude" || health.selectedProvider === "codex")
        && Array.isArray(health.providers) && health.providers.every(item => {
          const provider = object(item);
          return (provider?.provider === "claude" || provider?.provider === "codex") && typeof provider.status === "string";
        })
        && !!settings && (settings.provider === "claude" || settings.provider === "codex")
        && typeof claude?.model === "string" && typeof claude.effort === "string"
        && typeof codex?.model === "string" && typeof codex.effort === "string";
      break;
    }
    case "sessions": valid = Array.isArray(message.sessions); break;
    case "history": valid = typeof message.intentId === "string" && session(message.session) && Array.isArray(message.messages) && typeof message.attached === "boolean"; break;
    case "started": valid = typeof message.intentId === "string" && session(message.session); break;
    case "session": valid = session(message.session); break;
    case "tool": valid = typeof message.id === "string" && typeof message.tool === "string" && !!object(message.args); break;
    case "permission": valid = typeof message.id === "string" && typeof message.tool === "string" && !!object(message.input); break;
    case "cancel_request": valid = typeof message.id === "string" && typeof message.reason === "string"; break;
    case "event": {
      const event = object(message.event);
      valid = typeof event?.type === "string" && typeof event.itemId === "string" && session(event.session);
      break;
    }
    case "busy": valid = typeof message.busy === "boolean"; break;
    case "error": valid = typeof message.message === "string"; break;
  }
  return valid ? message as DownMsg : undefined;
}
