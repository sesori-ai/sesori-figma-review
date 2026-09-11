import type { ProviderHealth, ProviderSettings, ReviewEvent, SessionRecord } from "../../shared/protocol.ts";

export function eventBelongsToSession(args: { event: ReviewEvent; session?: SessionRecord }): boolean {
  return !!args.session?.sessionId && args.event.session.provider === args.session.provider
    && args.event.session.sessionId === args.session.sessionId;
}
export function sessionCostLabel(args: { session: SessionRecord; precision: number }): string {
  if (args.session.costStatus === "unavailable") return "Cost unavailable";
  return `${args.session.costStatus === "estimated" ? "~$" : "$"}${args.session.costUsd.toFixed(args.precision)}`;
}
export function providerSettingOptions(args: { health?: ProviderHealth; settings: ProviderSettings }) {
  const models = (args.health?.models ?? []).map(model => ({ value: model.value, label: model.label }));
  if (!models.some(model => model.value === args.settings.model)) models.push({ value: args.settings.model, label: args.settings.model || "Default" });
  const descriptor = args.health?.models.find(model => model.value === args.settings.model) ?? args.health?.models[0];
  const efforts = [...(descriptor?.efforts ?? [])];
  if (!efforts.includes(args.settings.effort)) efforts.push(args.settings.effort);
  return { models, efforts: efforts.map(effort => ({ value: effort, label: effort || "Default" })) };
}
