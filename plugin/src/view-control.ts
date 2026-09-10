import type { NodeRef, SessionRecord, SessionRef } from "../../shared/protocol.ts";

export type QueuedInput = { text: string; selection: NodeRef[] };
type StartIntent = { kind: "start"; id: string; inputs: QueuedInput[] };
type HistoryIntent = { kind: "history"; id: string; session: SessionRef };
type ViewIntent = StartIntent | HistoryIntent;
const sameSession = (left: SessionRecord, right: SessionRecord) =>
  left.provider === right.provider && left.sessionId === right.sessionId;

/** Sole owner of current conversation view, ephemeral connection intent, and actionable cards. */
export class ConversationView {
  private intent?: ViewIntent;
  private current?: SessionRecord;
  private readonly cards = new Map<string, (reason: string) => void>();

  get session(): SessionRecord | undefined { return this.current; }
  get starting(): boolean { return this.intent?.kind === "start"; }

  begin(args: { intentId: string; retainSession: boolean }) {
    this.cancelCards({ reason: "Session replaced" });
    this.intent = { kind: "start", id: args.intentId, inputs: [] };
    if (!args.retainSession) this.current = undefined;
  }
  beginHistory(args: { intentId: string; session: SessionRef }) {
    this.intent = { kind: "history", id: args.intentId, session: args.session };
    this.current = undefined;
  }
  queue(input: QueuedInput) { if (this.intent?.kind === "start") this.intent.inputs.push(input); }
  confirm(args: { intentId: string; session: SessionRecord }): QueuedInput[] | undefined {
    if (this.intent?.kind !== "start" || this.intent.id !== args.intentId) return;
    const queued = this.intent.inputs;
    this.intent = undefined;
    this.current = args.session;
    return queued;
  }
  confirmHistory(args: { intentId: string; session: SessionRecord }): boolean {
    if (this.intent?.kind !== "history" || this.intent.id !== args.intentId) return false;
    this.intent = undefined;
    this.current = args.session;
    return true;
  }
  /** Reconcile one authoritative connection snapshot without retrying lost work. */
  reconcile(args: { intentId?: string; session?: SessionRecord }): { queued: QueuedInput[]; cancelled: QueuedInput[] } {
    const cancelled: QueuedInput[] = [];
    if (this.intent?.kind === "start") {
      if (args.intentId === this.intent.id) {
        if (!args.session?.sessionId) return { queued: [], cancelled };
        return { queued: this.confirm({ intentId: this.intent.id, session: args.session }) ?? [], cancelled };
      }
      cancelled.push(...this.intent.inputs);
      this.intent = undefined;
    } else if (this.intent?.kind === "history") this.intent = undefined;
    if (args.session?.sessionId) this.current = args.session;
    else if (args.intentId && args.session) {
      this.current = undefined;
      this.intent = { kind: "start", id: args.intentId, inputs: [] };
    }
    return { queued: [], cancelled };
  }
  update(session: SessionRecord): boolean {
    if (!this.current || !sameSession(this.current, session)) return false;
    this.current = session;
    return true;
  }
  disconnect(args: { reason: string }) { this.cancelCards(args); }
  addCard(args: { id: string; cancel: (reason: string) => void }) { this.cards.set(args.id, args.cancel); }
  finishCard(id: string) { this.cards.delete(id); }
  cancelCard(args: { id: string; reason: string }) { this.cards.get(args.id)?.(args.reason); this.cards.delete(args.id); }
  leave(args: { reason: string }): QueuedInput[] {
    const queued = this.intent?.kind === "start" ? this.intent.inputs : [];
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
