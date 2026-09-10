/** Request-owner policy shared by turn cancellation and permanent session teardown. */
export function applyRequestCancellation(args: { activeOwners: Set<string>; owner: string; scope: "turn" | "session" }) {
  if (args.scope === "session") args.activeOwners.delete(args.owner);
}

export function requestOwnerIsActive(args: { activeOwners: Set<string>; owner: string }): boolean {
  return args.activeOwners.has(args.owner);
}

export function canConsumeOwnedReply(args: {
  activeOwners: Set<string>;
  owner: string;
  requestSocket: unknown;
  replySocket: unknown;
}): boolean {
  return requestOwnerIsActive(args) && args.requestSocket === args.replySocket;
}
