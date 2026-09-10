import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ToolResult } from "../../shared/protocol.ts";

/** Provider-neutral validated catalog. Codex can project each Zod schema to JSON Schema. */
export const FIGMA_TOOLS = [
  {
    name: "get_flow",
    description: "Prototype flow of the user's current Figma page: screens and transitions. Falls back to top-level frames when no flow exists.",
    schema: z.object({}),
  },
  {
    name: "get_screen",
    description: "PNG screenshot of a node plus its layer tree. Works for whole screens and single components.",
    schema: z.object({
      nodeId: z.string().describe("Node id such as 12:34"),
      scale: z.number().min(0.25).max(3).optional().describe("Export scale, default 1"),
    }),
  },
  {
    name: "focus",
    description: "Select a node and scroll/zoom the user's canvas to it before discussing it.",
    schema: z.object({ nodeId: z.string() }),
  },
  {
    name: "annotate",
    description: "Attach a Dev Mode annotation to a node, appended unless replacement was explicitly requested.",
    schema: z.object({
      nodeId: z.string(),
      markdown: z.string().describe("Annotation body, markdown"),
      replace: z.boolean().optional().describe("Replace existing annotations only when the user asked"),
    }),
  },
  {
    name: "ask_user",
    description: "Focus a design spot, ask a question in the plugin, and wait for the answer and current selection.",
    schema: z.object({ nodeId: z.string().optional(), question: z.string(), options: z.array(z.string()).max(4).optional() }),
  },
] as const;

export type FigmaToolName = typeof FIGMA_TOOLS[number]["name"];
export type FigmaToolRequest = { tool: FigmaToolName; args: Record<string, unknown> };
export type FigmaToolForwarder = (request: FigmaToolRequest) => Promise<ToolResult>;
export const FIGMA_TOOL_NAMES: readonly FigmaToolName[] = FIGMA_TOOLS.map(item => item.name);

/** Claude transport adaptation of shared catalog. */
export function createClaudeFigmaServer(args: { version: string; forward: FigmaToolForwarder }) {
  return createSdkMcpServer({
    name: "figma",
    version: args.version,
    tools: FIGMA_TOOLS.map(item => tool(item.name, item.description, item.schema.shape, input => args.forward({ tool: item.name, args: input }))),
  });
}
