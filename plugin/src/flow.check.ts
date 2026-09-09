// Self-check for the flow walker: cycles, overlays reached through nested buttons, dead destinations.
import assert from "node:assert/strict";
import { walkFlow, type FlowNode } from "./flow.ts";

const node = (id: string, name: string, reactions: FlowNode["reactions"] = [], descendants: FlowNode[] = []): FlowNode =>
  ({ id, name, width: 390, height: 844, reactions, descendants });
const go = (to: string, navigation = "NAVIGATE") =>
  ({ trigger: { type: "ON_CLICK" }, actions: [{ type: "NODE", destinationId: to, navigation }] });

const graph: Record<string, FlowNode> = {
  login: node("login", "Login", [], [node("btn", "Continue", [go("home")])]),
  home: node("home", "Home", [go("login", "BACK_NAV")], [node("help", "Help", [go("sheet", "OVERLAY")])]),
  sheet: node("sheet", "Help sheet", [{ trigger: { type: "ON_CLICK" }, action: { type: "NODE", destinationId: "deleted" } }]),
};

const flow = await walkFlow(["login"], async id => graph[id] ?? null);
assert.deepEqual(flow.screens.map(s => s.id), ["login", "home", "sheet"], "reaches every screen once despite the cycle");
assert.equal(flow.transitions.length, 4, "one transition per NODE action, including the dangling one");
assert.deepEqual(flow.transitions[0], { from: "login", to: "home", via: "Continue", trigger: "ON_CLICK", navigation: "NAVIGATE" });
assert.equal(flow.transitions.find(t => t.to === "sheet")?.navigation, "OVERLAY");
assert.ok(flow.transitions.some(t => t.to === "deleted"), "legacy single `action` shape is read");
console.log("flow.check ok");
