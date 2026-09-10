import type { NodeRef, SessionRecord } from "../../shared/protocol.ts";

export type QueuedInput = { text: string; selection: NodeRef[] };
type StartIntent = { id: string; inputs: QueuedInput[] };
const sameSession = (left: SessionRecord, right: SessionRecord) =>
  left.provider === right.provider && left.sessionId === right.sessionId;

/** Sole owner of current conversation view, in-flight start intent, and actionable cards. */
export class ConversationView {
  private intent?: StartIntent;
  private current?: SessionRecord;
  private readonly cards = new Map<string, (reason: string) => void>();

  get session(): SessionRecord | undefined { return this.current; }
  get starting(): boolean { return !!this.intent; }

  begin(args: { intentId: string; retainSession: boolean }) {
    this.cancelCards({ reason: "Session replaced" });
    this.intent = { id: args.intentId, inputs: [] };
    if (!args.retainSession) this.current = undefined;
  }

  queue(input: QueuedInput) { this.intent?.inputs.push(input); }

  confirm(args: { intentId: string; session: SessionRecord }): QueuedInput[] | undefined {
    if (this.intent?.id !== args.intentId) return;
    const queued = this.intent.inputs;
    this.intent = undefined;
    this.current = args.session;
    return queued;
  }

  update(session: SessionRecord): boolean {
    if (!this.current || !sameSession(this.current, session)) return false;
    this.current = session;
    return true;
  }

  showHistory(session: SessionRecord): boolean {
    if (this.intent) return false;
    this.current = session;
    return true;
  }
  addCard(args: { id: string; cancel: (reason: string) => void }) { this.cards.set(args.id, args.cancel); }
  finishCard(id: string) { this.cards.delete(id); }
  cancelCard(args: { id: string; reason: string }) { this.cards.get(args.id)?.(args.reason); this.cards.delete(args.id); }

  leave(args: { reason: string }): QueuedInput[] {
    const queued = this.intent?.inputs ?? [];
    this.intent = undefined;
    this.current = undefined;
    this.cancelCards(args);
    return queued;
  }

  private cancelCards(args: { reason: string }) {
    for (const cancel of this.cards.values()) cancel(args.reason);
    this.cards.clear();
  }
}
