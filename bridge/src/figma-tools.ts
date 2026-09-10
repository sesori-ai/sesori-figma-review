import { z } from "zod";

/** Provider-neutral validated catalog. Codex can project each Zod schema to JSON Schema. */
export const FIGMA_TOOLS = [
  {
    name: "get_flow",
    description: "Prototype flow of the user's current Figma page: screens (id, name, size) and transitions (from, to, trigger, navigation, via which element). Falls back to listing top-level frames when the page has no prototype flow.",
    schema: z.object({}),
  },
  {
    name: "get_screen",
    description: "PNG screenshot of a node plus its layer tree (ids, names, types, bounds relative to the node, text, existing annotations). Works for whole screens and for single components.",
    schema: z.object({
      nodeId: z.string().describe("Node id such as 12:34"),
      scale: z.number().min(0.25).max(3).optional().describe("Export scale, default 1; use 2 for small components"),
    }),
  },
  {
    name: "focus",
    description: "Select a node and scroll/zoom the user's canvas to it. Call it before discussing a node so the user sees what you mean.",
    schema: z.object({ nodeId: z.string() }),
  },
  {
    name: "annotate",
    description: "Attach a Dev Mode annotation (markdown) to a node, appended to what is already there.",
    schema: z.object({
      nodeId: z.string(),
      markdown: z.string().describe("Annotation body, markdown"),
      replace: z.boolean().optional().describe("Replace the node's existing annotations instead of appending; only when the user asked for it"),
    }),
  },
  {
    name: "ask_user",
    description: "Ask the user a question about a specific spot in the design. Focuses their canvas on nodeId (if given), shows the question with optional choice buttons in the plugin, and waits for the answer. Returns the answer and the user's current selection.",
    schema: z.object({ nodeId: z.string().optional(), question: z.string(), options: z.array(z.string()).max(4).optional() }),
  },
] as const;

export type FigmaToolName = typeof FIGMA_TOOLS[number]["name"];
export type FigmaToolRequest = { tool: FigmaToolName; args: Record<string, unknown> };
export const FIGMA_TOOL_NAMES: readonly FigmaToolName[] = FIGMA_TOOLS.map(item => item.name);
