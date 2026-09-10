import { dirname, join, resolve, sep } from "node:path";

/** Fail closed unless smoke process and mutable home are owned artifacts inside this bridge workspace. */
export function assertOwnedSmokeTarget({ bridgeRoot, bridgePath, fixture }) {
  const root = resolve(bridgeRoot);
  const expectedBridge = join(root, "dist", "bridge.mjs");
  const ownedRoot = join(root, "dist") + sep;
  if (resolve(bridgePath) !== expectedBridge || !resolve(fixture).startsWith(ownedRoot)
    || !resolve(fixture).split(sep).at(-1)?.startsWith(".owned-smoke-")) {
    throw new Error("Refusing smoke: target bridge/home are not an explicitly owned isolated fixture");
  }
  if (dirname(resolve(fixture)) !== join(root, "dist")) throw new Error("Refusing nested or external smoke home");
}
