import type { NodeRef, ReviewEvent, SessionRecord, SessionRef, TextSnapshot } from "../../shared/protocol.ts";

export type QueuedInput = { text: string; selection: NodeRef[] };
type StartIntent = { kind: "start"; id: string; inputs: QueuedInput[]; adopted: boolean };
type HistoryIntent = { kind: "history"; id: string; session: SessionRecord; events: ReviewEvent[]; activeText: TextSnapshot[]; inputs: QueuedInput[]; attached: boolean; latest?: SessionRecord };
type ViewIntent = StartIntent | HistoryIntent;
const sameSession = (left: SessionRef, right: SessionRef) =>
  left.provider === right.provider && left.sessionId === right.sessionId;

/** Sole owner of current conversation view, ephemeral connection intent, and actionable cards. */
export class ConversationView {
  private intent?: ViewIntent;
  private current?: SessionRecord;
  private restoreOnConnect = false;
  private readonly cards = new Map<string, (reason: string) => void>();

  get session(): SessionRecord | undefined { return this.current; }
  get starting(): boolean { return this.intent?.kind === "start"; }
  get readingHistory(): boolean { return this.intent?.kind === "history"; }
  historyRow(args: { session: SessionRef }): "retain" | "attached" | "replace" {
    if (this.intent?.kind === "history" && sameSession(this.intent.session, args.session)) return "retain";
    return !this.intent && !!this.current && sameSession(this.current, args.session) ? "attached" : "replace";
  }

  begin(args: { intentId: string; retainSession: boolean }) {
    this.cancelCards({ reason: "Session replaced" });
    this.intent = { kind: "start", id: args.intentId, inputs: [], adopted: false };
    if (!args.retainSession) this.current = undefined;
  }
  beginHistory(args: { intentId: string; session: SessionRecord; attached: boolean; retainSession?: boolean; activeText?: TextSnapshot[]; inputs?: QueuedInput[] }) {
    this.restoreOnConnect = false;
    this.intent = { kind: "history", id: args.intentId, session: args.session, events: [], activeText: args.activeText ?? [], inputs: args.inputs ?? [], attached: args.attached };
    if (!args.retainSession) this.current = undefined;
  }
  queue(input: QueuedInput) { if (this.intent?.kind === "start") this.intent.inputs.push(input); }
  confirm(args: { intentId: string; session: SessionRecord }): { inputs: QueuedInput[]; adopted: boolean } | undefined {
    if (this.intent?.kind !== "start" || this.intent.id !== args.intentId) return;
    const result = { inputs: this.intent.inputs, adopted: this.intent.adopted };
    this.intent = undefined;
    this.current = args.session;
    return result;
  }
  confirmHistory(args: { intentId: string; session: SessionRecord; attached: boolean }): { events: ReviewEvent[]; activeText: TextSnapshot[]; inputs: QueuedInput[]; session: SessionRecord; attached: boolean } | undefined {
    if (this.intent?.kind !== "history" || this.intent.id !== args.intentId) return;
    const result = { events: this.intent.events, activeText: this.intent.activeText, inputs: this.intent.inputs, session: this.intent.latest ?? args.session, attached: args.attached };
    this.intent = undefined;
    this.current = result.session;
    return result;
  }
  bufferEvent(event: ReviewEvent): boolean {
    if (this.intent?.kind !== "history" || !this.current || event.session.provider !== this.current.provider
      || event.session.sessionId !== this.current.sessionId) return false;
    this.intent.events.push(event);
    return true;
  }
  /** Reconcile one authoritative connection snapshot without retrying lost work. */
  reconcile(args: { intentId?: string; session?: SessionRecord; activeText?: TextSnapshot[] }): {
    queued: QueuedInput[];
    cancelled: QueuedInput[];
    adoptedStart: boolean;
    cancelledStart: boolean;
    historyRetry?: { intentId: string; session: SessionRef };
    restoreHistory: boolean;
  } {
    const result: {
      queued: QueuedInput[]; cancelled: QueuedInput[]; adoptedStart: boolean; cancelledStart: boolean;
      historyRetry?: { intentId: string; session: SessionRef }; restoreHistory: boolean;
    } = { queued: [], cancelled: [], adoptedStart: false, cancelledStart: false, restoreHistory: false };
    if (this.intent?.kind === "start") {
      if (args.intentId === this.intent.id) {
        if (!args.session?.sessionId) return result;
        const confirmed = this.confirm({ intentId: this.intent.id, session: args.session });
        result.queued = confirmed?.inputs ?? [];
        result.restoreHistory = true;
        return result;
      }
      result.cancelled.push(...this.intent.inputs);
      result.cancelledStart = true;
      this.intent = undefined;
    } else if (this.intent?.kind === "history") {
      const snapshotSession = args.session;
      this.intent.attached = !!snapshotSession && sameSession(snapshotSession, this.intent.session);
      if (args.activeText && snapshotSession && sameSession(snapshotSession, this.intent.session)) {
        const activeText = args.activeText.filter(item => sameSession(item.session, snapshotSession));
        const covered = new Set(activeText.map(item => item.itemId));
        this.intent.events = this.intent.events.filter(event => !sameSession(event.session, snapshotSession) || !covered.has(event.itemId));
        this.intent.activeText = activeText;
      }
      if (snapshotSession && sameSession(snapshotSession, this.intent.session)) {
        this.current = snapshotSession; this.intent.latest = snapshotSession;
      }
      result.historyRetry = { intentId: this.intent.id, session: this.intent.session };
      this.restoreOnConnect = false;
      return result;
    }
    if (args.session?.sessionId) {
      result.restoreHistory = this.restoreOnConnect && !!this.current && sameSession(this.current, args.session);
      this.current = args.session; this.restoreOnConnect = false;
    } else if (args.intentId) {
      this.current = undefined;
      this.intent = { kind: "start", id: args.intentId, inputs: [], adopted: true };
      result.adoptedStart = true;
    }
    return result;
  }
  update(session: SessionRecord): boolean {
    if (!this.current || !sameSession(this.current, session)) return false;
    this.current = session;
    if (this.intent?.kind === "history") this.intent.latest = session;
    return true;
  }
  disconnect(args: { reason: string }) { this.restoreOnConnect ||= !!this.current; this.cancelCards(args); }
  failStart(intentId: string): { session?: SessionRecord; inputs: QueuedInput[] } | undefined {
    if (this.intent?.kind !== "start" || this.intent.id !== intentId) return;
    const result = { session: this.current, inputs: this.intent.inputs };
    this.intent = undefined; return result;
  }
  failHistory(intentId: string): { session: SessionRecord; inputs: QueuedInput[]; attached: boolean } | undefined {
    if (this.intent?.kind !== "history" || this.intent.id !== intentId) return;
    const result = { session: this.intent.latest ?? this.intent.session, inputs: this.intent.inputs, attached: this.intent.attached };
    this.intent = undefined; this.current = result.session; return result;
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
