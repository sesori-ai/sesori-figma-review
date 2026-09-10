export type FileOwned = { fileId: string };

/** View-only controls may affect only resources owned by their registered Figma file. */
export function isOwnedByFile(args: { resource?: FileOwned; fileId: string }): boolean {
  return args.resource?.fileId === args.fileId;
}

export function isRegisteredFileSocket(args: { registeredSocket: unknown; requestSocket: unknown }): boolean {
  return args.registeredSocket === args.requestSocket;
}
