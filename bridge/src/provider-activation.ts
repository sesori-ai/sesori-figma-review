import type { ReviewProvider, ReviewSession } from "./providers/types.ts";

type StartArgs = Parameters<ReviewProvider["start"]>[0];

/** Resolve one asynchronous provider start without letting a superseded start claim conversation ownership. */
export async function activateProvider(args: {
  provider: ReviewProvider;
  start: StartArgs;
  isCurrent: () => boolean;
  capture: (session: ReviewSession) => void;
  reconcile?: (session: ReviewSession) => Promise<void>;
  accept: (session: ReviewSession) => void;
}): Promise<ReviewSession | undefined> {
  const session = await args.provider.start(args.start);
  args.capture(session);
  if (!args.isCurrent()) return;
  await args.reconcile?.(session);
  if (!args.isCurrent()) return;
  args.accept(session);
  return session;
}
