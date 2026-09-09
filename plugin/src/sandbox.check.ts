// Runs code.ts in Node against a mock `figma` global: the tool executor, flow walk, screen tree, focus, annotate.
// It cannot prove rendering, but it fails if the sandbox logic breaks.
import assert from "node:assert/strict";

type N = any;
const nodes = new Map<string, N>();
const exports: any[] = [];
function mk(type: string, id: string, name: string, extra: Record<string, unknown> = {}, children: N[] = []): N {
  const n: N = {
    id, name, type, visible: true, width: 390, height: 844, reactions: [], annotations: [], parent: null,
    absoluteBoundingBox: { x: 0, y: 0, width: 390, height: 844 }, ...extra,
    findAll(pred: (x: N) => boolean) { const out: N[] = []; const walk = (c: N) => { for (const k of c.children ?? []) { if (pred(k)) out.push(k); walk(k); } }; walk(n); return out; },
    async exportAsync(s: unknown) { exports.push(s); return new Uint8Array([137, 80, 78, 71]); },
  };
  if (children.length || type === "FRAME" || type === "PAGE") n.children = children;
  for (const c of children) c.parent = n;
  nodes.set(id, n);
  return n;
}
const go = (to: string, navigation = "NAVIGATE") => ({ trigger: { type: "ON_CLICK" }, actions: [{ type: "NODE", destinationId: to, navigation }] });

const title = mk("TEXT", "1:2", "Title", { characters: "Welcome", absoluteBoundingBox: { x: 1020, y: 600, width: 200, height: 30 } });
const login = mk("FRAME", "1:1", "Login", { absoluteBoundingBox: { x: 1000, y: 500, width: 390, height: 844 } }, [title, mk("FRAME", "1:3", "Continue", { reactions: [go("1:4")] })]);
const home = mk("FRAME", "1:4", "Home", { reactions: [go("1:1", "BACK")] }, [mk("FRAME", "1:5", "Help", { reactions: [go("1:7", "OVERLAY")] }), mk("FRAME", "1:6", "Hidden", { visible: false })]);
const sheet = mk("FRAME", "1:7", "Help sheet", { reactions: [{ trigger: { type: "ON_CLICK" }, action: { type: "NODE", destinationId: "deleted" } }] });
const vector = mk("VECTOR", "1:8", "Icon"); delete vector.annotations;
const page1 = mk("PAGE", "0:1", "Page 1", { flowStartingPoints: [{ nodeId: "1:1", name: "Start" }], selection: [] }, [login, home, sheet, vector]);
const other = mk("FRAME", "2:1", "Settings");
const page2 = mk("PAGE", "0:2", "Page 2", { flowStartingPoints: [], selection: [] }, [other]);

const posted: any[] = [];
const events: Record<string, () => void> = {};
const shared: Record<string, string> = {};
const figma: any = {
  root: { name: "Mock file", getSharedPluginData: (_: string, k: string) => shared[k] ?? "", setSharedPluginData: (_: string, k: string, v: string) => { shared[k] = v; } },
  currentPage: page1,
  ui: { postMessage: (m: unknown) => posted.push(m), onmessage: undefined as any },
  viewport: { zoomed: [] as N[], scrollAndZoomIntoView(ns: N[]) { this.zoomed = ns; } },
  showUI() {}, notify() {}, on(ev: string, cb: () => void) { events[ev] = cb; },
  getNodeByIdAsync: async (id: string) => nodes.get(id) ?? null,
  setCurrentPageAsync: async (p: N) => { figma.currentPage = p; },
  base64Encode: (b: Uint8Array) => Buffer.from(b).toString("base64"),
};
Object.assign(globalThis, { figma, __html__: "" });
await import("./code.ts");

const call = async (tool: string, args: Record<string, unknown> = {}) => {
  const id = `${tool}-${posted.length}`;
  await figma.ui.onmessage({ kind: "tool", id, tool, args });
  return posted.find(p => p.kind === "reply" && p.id === id).result;
};
const text = (r: any) => r.content.find((c: any) => c.type === "text").text;

// init: context posted, file id minted and persisted
assert.equal(posted[0].kind, "context");
assert.ok(posted[0].fileId && shared.fileId === posted[0].fileId, "file id stored in shared plugin data");
assert.equal(posted[0].pageName, "Page 1");

// get_flow: cycle, nested trigger, overlay, legacy `action`, dangling destination
const flow = JSON.parse(text(await call("get_flow")));
assert.deepEqual(flow.screens.map((s: any) => s.id), ["1:1", "1:4", "1:7"]);
assert.equal(flow.transitions.length, 4);
assert.deepEqual(flow.transitions[0], { from: "1:1", to: "1:4", via: "Continue", trigger: "ON_CLICK", navigation: "NAVIGATE" });
assert.equal(flow.transitions.find((t: any) => t.to === "1:7").navigation, "OVERLAY");
assert.ok(flow.transitions.some((t: any) => t.to === "deleted"), "legacy single action is read; dangling target does not crash");

// get_screen: image + tree with relative bounds, text, hidden nodes skipped, scale forwarded
const screen = await call("get_screen", { nodeId: "1:1", scale: 2 });
assert.equal(screen.content[0].type, "image");
assert.equal(screen.content[0].data, "iVBORw==");
assert.equal(exports[exports.length - 1].constraint.value, 2);
const tree = JSON.parse(screen.content[1].text);
assert.equal(tree.children.length, 2);
assert.deepEqual([tree.children[0].text, tree.children[0].x, tree.children[0].y], ["Welcome", 20, 100]);
assert.deepEqual(JSON.parse(text(await call("get_screen", { nodeId: "1:4" }))).children.map((c: any) => c.name), ["Help"], "hidden node skipped");

// focus: selection + viewport, page switch, bad id
assert.match(text(await call("focus", { nodeId: "2:1" })), /Focused "Settings"/);
assert.equal(figma.currentPage, page2);
assert.deepEqual(figma.viewport.zoomed, [other]);
assert.deepEqual(page2.selection, [other]);
const bad = await call("focus", { nodeId: "9:9" });
assert.ok(bad.isError && /No node/.test(text(bad)));

// get_flow fallback on a page without a prototype
const fallback = JSON.parse(text(await call("get_flow")));
assert.deepEqual([fallback.screens.map((s: any) => s.id), fallback.transitions], [["2:1"], []]);
assert.match(fallback.note, /no prototype flow/);

// annotate: append, replace, unsupported node, reported in the tree
await call("annotate", { nodeId: "1:2", markdown: "**What** first" });
await call("annotate", { nodeId: "1:2", markdown: "**What** second" });
assert.equal(title.annotations.length, 2);
await call("annotate", { nodeId: "1:2", markdown: "**What** only", replace: true });
assert.deepEqual(title.annotations, [{ labelMarkdown: "**What** only" }]);
assert.ok((await call("annotate", { nodeId: "1:8", markdown: "x" })).isError, "VECTOR without annotations mixin errors");
assert.deepEqual(JSON.parse(text(await call("get_screen", { nodeId: "1:2" }))).annotations, ["**What** only"]);

// unknown tool, UI-initiated focus, selection events
assert.ok((await call("nope")).isError);
await figma.ui.onmessage({ kind: "focus", nodeId: "1:1" });
await new Promise(r => setTimeout(r));
assert.equal(figma.currentPage, page1);
events.selectionchange();
assert.deepEqual(posted[posted.length - 1].selection.map((n: any) => n.name), ["Login"]);
console.log("sandbox.check ok");
