import type { ReviewEvent, SessionRecord } from "../../shared/protocol.ts";

/** Prevent late/interleaved native events from rendering into another provider session. */
export function eventBelongsToSession(args: { event: ReviewEvent; session?: SessionRecord }): boolean {
  if (!args.session?.sessionId) return true;
  return args.event.session.provider === args.session.provider && args.event.session.sessionId === args.session.sessionId;
}

export function sessionCostLabel(args: { session: SessionRecord; precision: number }): string {
  const prefix = args.session.costStatus === "estimated" ? "~$" : "$";
  return `${prefix}${args.session.costUsd.toFixed(args.precision)}`;
}
