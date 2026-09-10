import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ToolResult } from "../../shared/protocol.ts";

export type FigmaToolName = "get_flow" | "get_screen" | "focus" | "annotate" | "ask_user";
export type FigmaToolRequest = { tool: FigmaToolName; args: Record<string, unknown> };
export type FigmaToolForwarder = (request: FigmaToolRequest) => Promise<ToolResult>;

const catalog = [
  {
    name: "get_flow",
    description: "Prototype flow of the user's current Figma page: screens and transitions. Falls back to top-level frames when no flow exists.",
    shape: {},
  },
  {
    name: "get_screen",
    description: "PNG screenshot of a node plus its layer tree. Works for whole screens and single components.",
    shape: {
      nodeId: z.string().describe("Node id such as 12:34"),
      scale: z.number().min(0.25).max(3).optional().describe("Export scale, default 1"),
    },
  },
  {
    name: "focus",
    description: "Select a node and scroll/zoom the user's canvas to it before discussing it.",
    shape: { nodeId: z.string() },
  },
  {
    name: "annotate",
    description: "Attach a Dev Mode annotation to a node, appended unless replacement was explicitly requested.",
    shape: {
      nodeId: z.string(),
      markdown: z.string().describe("Annotation body, markdown"),
      replace: z.boolean().optional().describe("Replace existing annotations only when the user asked"),
    },
  },
  {
    name: "ask_user",
    description: "Focus a design spot, ask a question in the plugin, and wait for the answer and current selection.",
    shape: { nodeId: z.string().optional(), question: z.string(), options: z.array(z.string()).max(4).optional() },
  },
] as const;

export const FIGMA_TOOL_NAMES: readonly FigmaToolName[] = catalog.map(item => item.name);

/** Claude-specific exposure of provider-neutral catalog. Codex will consume same catalog in Step 4. */
export function createClaudeFigmaServer(args: { version: string; forward: FigmaToolForwarder }) {
  return createSdkMcpServer({
    name: "figma",
    version: args.version,
    tools: catalog.map(item => tool(item.name, item.description, item.shape, input => args.forward({ tool: item.name, args: input }))),
  });
}
