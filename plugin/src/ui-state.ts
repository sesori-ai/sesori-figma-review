import type { Health, ProviderId, ProviderSettings, UpMsg } from "../../shared/protocol.ts";

export class ConnectionAdmission {
  private acknowledged = false;
  get ready() { return this.acknowledged; }
  admit(args: { onBlocked: () => void }): boolean {
    if (this.acknowledged) return true;
    args.onBlocked(); return false;
  }
  opened() { this.acknowledged = false; }
  acknowledge() { this.acknowledged = true; }
  disconnected() { this.acknowledged = false; }
}

type PendingSetting = { requestId: string; provider: ProviderId; settings: ProviderSettings };
export class SettingsControl {
  private pending?: PendingSetting;
  private sequence = 0;

  request(args: {
    provider: ProviderId;
    settings: ProviderSettings;
    selectedProvider?: ProviderId;
  }): Extract<UpMsg, { kind: "settings" }> {
    const pending = { requestId: `settings-${++this.sequence}`, provider: args.provider, settings: { ...args.settings } };
    this.pending = pending;
    return { kind: "settings", ...pending, selectedProvider: args.selectedProvider };
  }

  acceptHealth(args: { health: Health; provider: ProviderId }): { settings: ProviderSettings; error?: string } {
    const result = args.health.settingsResult;
    const isLatest = !!result && result.requestId === this.pending?.requestId;
    const error = result && !result.accepted ? result.error ?? "Settings update failed" : undefined;
    if (isLatest) this.pending = undefined;
    return {
      settings: this.pending?.provider === args.provider
        ? this.pending.settings
        : args.health.settings.providers[args.provider],
      error,
    };
  }
}
