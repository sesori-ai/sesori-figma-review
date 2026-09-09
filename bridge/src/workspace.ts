// Per-Figma-file workspace under ~/.figma-review/files/<fileId>/ plus the sessions index kept in it.
// The workspace is the agent's cwd: CLAUDE.md, .mcp.json and the review-flow skill are loaded from here,
// and notes/ is the only place it may write files. Files are written once and never overwritten, so
// teammates can edit CLAUDE.md per file.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FIGMA_MCP_URL, type SessionRecord, type Usage } from "../../shared/protocol.ts";

export const HOME = process.env.FIGMA_REVIEW_HOME ?? join(homedir(), ".figma-review");

export function workspaceFor(fileId: string, fileName: string): string {
  const dir = join(HOME, "files", fileId);
  mkdirSync(join(dir, "notes"), { recursive: true });
  mkdirSync(join(dir, ".claude", "skills", "review-flow"), { recursive: true });
  writeIfMissing(join(dir, "CLAUDE.md"), claudeMd(fileName));
  writeIfMissing(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { "figma-desktop": { type: "http", url: FIGMA_MCP_URL } } }, null, 2) + "\n");
  writeIfMissing(join(dir, ".claude", "skills", "review-flow", "SKILL.md"), SKILL);
  writeIfMissing(join(dir, "sessions.json"), "[]\n");
  return dir;
}
const writeIfMissing = (path: string, content: string) => { if (!existsSync(path)) writeFileSync(path, content); };

export const readSessions = (dir: string): SessionRecord[] => JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8"));
export function saveSession(dir: string, rec: SessionRecord) {
  const rest = readSessions(dir).filter(s => s.sessionId !== rec.sessionId);
  writeFileSync(join(dir, "sessions.json"), JSON.stringify([...rest, rec], null, 2) + "\n");
}

export const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
/** Claude Code emits one `assistant` message per content block, all sharing message.id; sum each API response once. */
export function sumUsage(byMessageId: Map<string, any>, base: Usage = zeroUsage()): Usage {
  const t = { ...base };
  for (const u of byMessageId.values()) {
    t.input += u?.input_tokens ?? 0;
    t.output += u?.output_tokens ?? 0;
    t.cacheRead += u?.cache_read_input_tokens ?? 0;
    t.cacheWrite += u?.cache_creation_input_tokens ?? 0;
  }
  return t;
}

const claudeMd = (fileName: string) => `# Figma design review — ${fileName}

You review Figma designs from inside the Figma desktop app. The user talks to you through the
"AI Review" plugin panel and sees the canvas next to your messages. There is no terminal.

## What you are here for
1. Review the prototype flow as a whole (structure, dead ends, missing states), then each screen.
2. Answer questions about specific screens or components.
3. Make the design dev-ready: write Dev Mode annotations with implementation detail
   (behaviour, states, spacing/tokens, data, edge cases, accessibility) on the nodes they apply to.

## How to work
- Before discussing a node, call \`focus\` so the user is looking at it.
- Prefer \`ask_user\` over guessing when intent is unclear; offer 2-4 options when you can.
- Propose annotations first (one line each), then write them with \`annotate\`. Every write is approved by the user in the plugin.
- Keep chat messages short; the detail belongs in annotations.
- Node ids look like \`12:34\`. The user's current selection is appended to every message; "this" means the selection.
- You may write scratch files only under \`notes/\` in this directory.
- If an app source directory is available (additional directory), read it so annotations match existing components and naming.

<!-- BEGIN tool-steering — delete this whole section if the Figma desktop MCP server is not used -->
## Tool steering: two Figma tool sets
- \`figma\` (plugin): \`get_flow\`, \`get_screen\`, \`focus\`, \`annotate\`, \`ask_user\`. Instant, unlimited, and the only way to move the user's view or write annotations.
- \`figma-desktop\` (Figma's local MCP server): \`get_design_context\`, \`get_metadata\`, \`get_variable_defs\`, \`get_screenshot\`, ... Richer (variables, Code Connect, generated code) but rate limited (roughly 10 calls/min, 200/day per seat).

Use \`get_flow\`/\`get_screen\` for overview and screenshots. Use \`figma-desktop\` only when you need variables/tokens,
component properties or code for a node you already focused. Pass node ids as \`12:34\`; if a tool rejects that, try \`12-34\`.
<!-- END tool-steering -->
`;

const SKILL = `---
name: review-flow
description: Structured review of a Figma prototype flow, screen by screen, ending with dev-ready annotations. Use when the user asks to review the flow, the page, or a set of screens.
---

# Review flow

1. \`get_flow\`. Summarize in at most 10 lines: entry points, main path, branches, dead ends, screens with no way back.
   If there are more than ~8 screens, \`ask_user\` which ones matter most.
2. For each screen in flow order: \`focus\` it, \`get_screen\` it, then give at most 5 findings sorted by impact
   (clarity/consistency, missing states such as loading/empty/error, interaction gaps, accessibility, dev ambiguity).
   End each screen with "Next screen?" and wait, unless the user asked for the whole walk-through at once.
3. Collect annotation proposals as you go: node id + one-line summary.
4. After the walk-through, list the proposals and write them with \`annotate\`. Annotation body layout:
   **What** / **Behaviour** / **States** / **Tokens** / **Edge cases**. Skip headings that do not apply.
5. Finish with a dev-readiness verdict and the open questions.
`;
