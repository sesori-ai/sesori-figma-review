import assert from "node:assert/strict";
import { PROTOCOL_VERSION } from "../../shared/protocol.ts";
import { decodeBridgeMessage } from "./wire.ts";

assert.equal(PROTOCOL_VERSION, 3, "start/started/close connection contract is protocol v3");
assert.equal(decodeBridgeMessage({ kind: "health", health: { bridge: "old" } }), undefined,
  "new plugin rejects old bridge health before provider/settings dereference");
assert.equal(decodeBridgeMessage({ kind: "connection", protocolVersion: 2, busy: false }), undefined,
  "new plugin rejects a v2 connection snapshot");
assert.deepEqual(decodeBridgeMessage({ kind: "connection", protocolVersion: 3, busy: false }),
  { kind: "connection", protocolVersion: 3, busy: false });
assert.ok(decodeBridgeMessage({ kind: "health", health: {
  protocolVersion: 3, bridge: "0.3.0", selectedProvider: "claude", providers: [{ provider: "claude", status: "ready" }],
  figmaMcp: "up", settings: { provider: "claude", providers: { claude: { model: "haiku", effort: "low" }, codex: { model: "", effort: "" } } },
} }), "new bridge health passes required-shape guard");
assert.equal(decodeBridgeMessage({ kind: "event", event: { type: "text_delta", itemId: "x" } }), undefined,
  "event needs provider-qualified session identity");
console.log("wire check ok");
