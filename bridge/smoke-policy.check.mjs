import assert from "node:assert/strict";
import { assertOwnedSmokeTarget } from "./smoke-policy.mjs";

assert.doesNotThrow(() => assertOwnedSmokeTarget({
  bridgeRoot: "/repo/bridge", bridgePath: "/repo/bridge/dist/bridge.mjs", fixture: "/repo/bridge/dist/.owned-smoke-1",
}));
for (const unsafe of [
  { bridgeRoot: "/repo/bridge", bridgePath: "/tmp/bridge.mjs", fixture: "/repo/bridge/dist/.owned-smoke-1" },
  { bridgeRoot: "/repo/bridge", bridgePath: "/repo/bridge/dist/bridge.mjs", fixture: "/home/user/.sesori-review" },
  { bridgeRoot: "/repo/bridge", bridgePath: "/repo/bridge/dist/bridge.mjs", fixture: "/repo/bridge/dist/not-owned" },
]) assert.throws(() => assertOwnedSmokeTarget(unsafe), /Refusing smoke/);
console.log("smoke policy check ok");
