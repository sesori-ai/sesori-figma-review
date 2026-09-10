/// <reference types="@figma/plugin-typings" />
// Main-thread (sandbox) side of the plugin: owns the document. Executes tool calls forwarded by the UI
// and streams file/page/selection context to it. No network access here; the UI iframe talks to the bridge.
import { walkFlow, type FlowNode } from "./flow.ts";
import type { NodeRef, ToolResult } from "../../shared/protocol.ts";

const NS = "sesori_review"; // shared plugin data namespaces allow only [A-Za-z0-9_.]
figma.showUI(__html__, { width: 440, height: 720, themeColors: true });

// Stable per-file id. figma.fileKey is only exposed to private org plugins, so we mint our own once.
let fileId = figma.root.getSharedPluginData(NS, "fileId");
if (!fileId) {
  fileId = Date.now().toString(36) + Math.random().toString(36).slice(2, 10); // ponytail: not a UUID, unique enough for a folder name
  figma.root.setSharedPluginData(NS, "fileId", fileId);
}

const ref = (n: BaseNode): NodeRef => ({ id: n.id, name: n.name, type: n.type });
const context = () => ({
  kind: "context",
  fileId,
  fileName: figma.root.name,
  pageId: figma.currentPage.id,
  pageName: figma.currentPage.name,
  selection: figma.currentPage.selection.map(ref),
});
figma.ui.postMessage(context());
figma.on("selectionchange", () => figma.ui.postMessage(context()));
figma.on("currentpagechange", () => figma.ui.postMessage(context()));

// ---- tools ---------------------------------------------------------------

const text = (s: string): ToolResult => ({ content: [{ type: "text", text: s }] });

async function sceneNode(id: string): Promise<SceneNode> {
  const n = await figma.getNodeByIdAsync(id);
  if (!n || n.type === "DOCUMENT" || n.type === "PAGE") throw new Error(`No node with id "${id}" (ids look like "12:34")`);
  return n as SceneNode;
}

async function focus(id: string): Promise<SceneNode> {
  const n = await sceneNode(id);
  let p = n.parent;
  while (p && p.type !== "PAGE") p = p.parent;
  if (p && p !== figma.currentPage) await figma.setCurrentPageAsync(p as PageNode);
  figma.currentPage.selection = [n];
  figma.viewport.scrollAndZoomIntoView([n]);
  return n;
}

type Tree = { id: string; name: string; type: string; x: number; y: number; w: number; h: number; text?: string; annotations?: string[]; children?: Tree[] };

function tree(n: SceneNode, origin: { x: number; y: number }, budget: { left: number }): Tree | undefined {
  if (!n.visible || budget.left-- <= 0) return; // ponytail: 300-node cap; the agent can get_screen a child for more detail
  const b = ("absoluteBoundingBox" in n && n.absoluteBoundingBox) || { x: origin.x, y: origin.y, width: 0, height: 0 };
  const t: Tree = { id: n.id, name: n.name, type: n.type, x: Math.round(b.x - origin.x), y: Math.round(b.y - origin.y), w: Math.round(b.width), h: Math.round(b.height) };
  if (n.type === "TEXT") t.text = n.characters;
  if ("annotations" in n && n.annotations.length) t.annotations = n.annotations.map(a => a.labelMarkdown ?? a.label ?? "");
  if ("children" in n) t.children = n.children.map(c => tree(c, origin, budget)).filter((c): c is Tree => !!c);
  return t;
}

async function getScreen(nodeId: string, scale = 1): Promise<ToolResult> {
  const n = await sceneNode(nodeId);
  const png = await n.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: scale } });
  const origin = ("absoluteBoundingBox" in n && n.absoluteBoundingBox) || { x: 0, y: 0 };
  return {
    content: [
      { type: "image", data: figma.base64Encode(png), mimeType: "image/png" },
      { type: "text", text: JSON.stringify(tree(n, origin, { left: 300 })) },
    ],
  };
}

async function getFlow(): Promise<ToolResult> {
  const page = figma.currentPage;
  const starts = page.flowStartingPoints.map(f => f.nodeId);
  if (!starts.length) {
    const frames = page.children.filter(c => c.type === "FRAME" || c.type === "COMPONENT" || c.type === "SECTION");
    return text(JSON.stringify({
      page: page.name,
      note: "This page has no prototype flow starting points; these are its top-level frames.",
      screens: frames.map(f => ({ id: f.id, name: f.name, width: f.width, height: f.height })),
      transitions: [],
    }));
  }
  const wrap = (x: SceneNode): FlowNode =>
    ({ id: x.id, name: x.name, width: x.width, height: x.height, reactions: "reactions" in x ? x.reactions : [], descendants: [] });
  const flow = await walkFlow(starts, async id => {
    const n = await figma.getNodeByIdAsync(id);
    if (!n || !("width" in n)) return null;
    const interactive = "findAll" in n ? n.findAll(x => "reactions" in x && x.reactions.length > 0) : [];
    return { ...wrap(n as SceneNode), descendants: interactive.map(wrap) };
  });
  return text(JSON.stringify({ page: page.name, startingPoints: page.flowStartingPoints, ...flow }));
}

async function annotate(nodeId: string, markdown: string, replace = false): Promise<ToolResult> {
  const n = await sceneNode(nodeId);
  if (!("annotations" in n)) throw new Error(`${n.type} nodes cannot hold annotations`);
  // Figma returns existing annotations with both `label` and `labelMarkdown` but rejects setting both back.
  const keep = replace ? [] : n.annotations.map(({ label, ...a }) => (a.labelMarkdown ? a : { label, ...a }));
  n.annotations = [...keep, { labelMarkdown: markdown }];
  return text(`Annotated "${n.name}" (${n.id}); it now has ${n.annotations.length} annotation(s).`);
}

const tools: Record<string, (a: any) => Promise<ToolResult>> = {
  get_flow: () => getFlow(),
  get_screen: a => getScreen(a.nodeId, a.scale),
  focus: async a => { const n = await focus(a.nodeId); return text(`Focused "${n.name}" (${n.type} ${n.id})`); },
  annotate: a => annotate(a.nodeId, a.markdown, a.replace),
};

figma.ui.onmessage = async (msg: any) => {
  if (msg.kind === "tool") {
    let result: ToolResult;
    try {
      const run = tools[msg.tool];
      if (!run) throw new Error(`Unknown tool ${msg.tool}`);
      result = await run(msg.args ?? {});
    } catch (e) {
      result = { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
    figma.ui.postMessage({ kind: "reply", id: msg.id, result });
  }
  if (msg.kind === "focus") focus(msg.nodeId).catch(() => {}); // UI-initiated: ask_user cards and annotation previews
  if (msg.kind === "notify") figma.notify(msg.text);
};
