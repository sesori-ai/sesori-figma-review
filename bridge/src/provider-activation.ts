import type { ReviewProvider, ReviewSession } from "./providers/types.ts";

type StartArgs = Parameters<ReviewProvider["start"]>[0];

/** Resolve one asynchronous provider start without letting a superseded start claim conversation ownership. */
export async function activateProvider(args: {
  provider: ReviewProvider;
  start: StartArgs;
  isCurrent: () => boolean;
  reconcile?: (session: ReviewSession) => Promise<void>;
  accept: (session: ReviewSession) => void;
}): Promise<ReviewSession | undefined> {
  const session = await args.provider.start(args.start);
  if (!args.isCurrent()) { session.close(); return; }
  try { await args.reconcile?.(session); }
  catch (error) { session.close(); throw error; }
  if (!args.isCurrent()) { session.close(); return; }
  args.accept(session);
  return session;
}
