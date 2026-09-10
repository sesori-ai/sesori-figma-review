import type { ProviderHealth, ProviderSettings, ReviewEvent, SessionRecord } from "../../shared/protocol.ts";

/** Prevent late/interleaved native events from rendering into another provider session. */
export function eventBelongsToSession(args: { event: ReviewEvent; session?: SessionRecord }): boolean {
  if (!args.session?.sessionId) return false;
  return args.event.session.provider === args.session.provider && args.event.session.sessionId === args.session.sessionId;
}

export function sessionCostLabel(args: { session: SessionRecord; precision: number }): string {
  if (args.session.costStatus === "unavailable") return "Cost unavailable";
  const prefix = args.session.costStatus === "estimated" ? "~$" : "$";
  return `${prefix}${args.session.costUsd.toFixed(args.precision)}`;
}

/** Provider-owned model descriptors become generic selector choices; unknown saved values remain visible. */
export function providerSettingOptions(args: { health?: ProviderHealth; settings: ProviderSettings }) {
  const models = (args.health?.models ?? []).map(model => ({ value: model.value, label: model.label }));
  if (!models.some(model => model.value === args.settings.model)) {
    models.push({ value: args.settings.model, label: args.settings.model || "Default" });
  }
  const descriptor = args.health?.models.find(model => model.value === args.settings.model) ?? args.health?.models[0];
  const efforts = [...(descriptor?.efforts ?? [])];
  if (!efforts.includes(args.settings.effort)) efforts.push(args.settings.effort);
  return { models, efforts: efforts.map(effort => ({ value: effort, label: effort || "Default" })) };
}
