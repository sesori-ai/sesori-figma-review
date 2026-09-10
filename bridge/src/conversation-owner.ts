export type FileOwned = { fileId: string };

/** View-only controls may affect only resources owned by their registered Figma file. */
export function isOwnedByFile(args: { resource?: FileOwned; fileId: string }): boolean {
  return args.resource?.fileId === args.fileId;
}

export function isRegisteredFileSocket(args: { registeredSocket: unknown; requestSocket: unknown }): boolean {
  return args.registeredSocket === args.requestSocket;
}

export async function applyForCurrentConversation<T>(args: {
  captured: T;
  current: () => T | undefined;
  apply: () => Promise<void>;
  commit: () => void;
  onStaleError: (error: unknown) => void;
}) {
  try { await args.apply(); }
  catch (error) {
    if (args.current() === args.captured) throw error;
    args.onStaleError(error);
  }
  if (args.current() === args.captured) args.commit();
}
