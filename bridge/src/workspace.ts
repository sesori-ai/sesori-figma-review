// Per-Figma-file workspace under ~/.sesori-review/files/<fileId>/ plus the sessions index kept in it.
// The workspace is the agent's cwd: CLAUDE.md, .mcp.json and the review-flow skill are loaded from here,
// and notes/ is the only place it may write files. CLAUDE.md, settings and .mcp.json are written once and
// never overwritten, so teammates can edit them per file; the skill is ours and is refreshed on every start.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FIGMA_MCP_URL, type SessionRecord, type Settings, type Usage } from "../../shared/protocol.ts";
import { readClaudeTranscript } from "./providers/claude-history.ts";

export const HOME = process.env.SESORI_REVIEW_HOME ?? join(homedir(), ".sesori-review");

/** Tools that run without an Allow/Deny card. Per-file override: edit permissions.json in the workspace.
 *  (Not .claude/settings.json: the CLI ignores project permissions until the folder is trusted interactively.) */
const autoApprove = (dir: string) => [
  "Read", "Glob", "Grep", "Skill",
  `Edit(//${dir.replace(/^\//, "")}/notes/**)`, // Edit rules also govern Write
  "mcp__figma__get_flow", "mcp__figma__get_screen", "mcp__figma__focus", "mcp__figma__ask_user", "mcp__figma__annotate",
  "mcp__figma-desktop", // every tool of the local Figma MCP server
];

export function workspaceFor(fileId: string, fileName: string): string {
  const dir = join(HOME, "files", fileId);
  mkdirSync(join(dir, "notes"), { recursive: true });
  mkdirSync(join(dir, ".claude", "skills", "review-flow"), { recursive: true });
  writeIfMissing(join(dir, "CLAUDE.md"), claudeMd(fileName));
  writeIfMissing(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { "figma-desktop": { type: "http", url: FIGMA_MCP_URL } } }, null, 2) + "\n");
  writeIfMissing(join(dir, "permissions.json"), JSON.stringify({ allow: autoApprove(dir) }, null, 2) + "\n");
  writeFileSync(join(dir, ".claude", "skills", "review-flow", "SKILL.md"), SKILL);
  writeIfMissing(join(dir, "sessions.json"), "[]\n");
  return dir;
}
const writeIfMissing = (path: string, content: string) => { if (!existsSync(path)) writeFileSync(path, content); };
export const readAllow = (dir: string): string[] => JSON.parse(readFileSync(join(dir, "permissions.json"), "utf8")).allow;

/** Copy the built plugin next to the workspaces so Figma's "Import plugin from manifest" points at a path that
 *  survives npx cache changes and package upgrades. Returns the manifest path, or undefined if there is no build. */
export function installPlugin(): string | undefined {
  const src = fileURLToPath(new URL("../../plugin/", import.meta.url)); // same relative path from bridge/src (tsx) and bridge/dist (npm)
  if (!existsSync(join(src, "dist", "ui.html"))) return;
  const dst = join(HOME, "plugin");
  mkdirSync(join(dst, "dist"), { recursive: true });
  for (const f of ["manifest.json", "dist/code.js", "dist/ui.html"]) copyFileSync(join(src, f), join(dst, f));
  return join(dst, "manifest.json");
}

/** True when Claude Code has something to authenticate with (API key or a completed login). */
export const hasClaudeAuth = () => !!process.env.ANTHROPIC_API_KEY || existsSync(join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), ".credentials.json"));

/** Model/effort chosen in the plugin; one file for the whole machine (the bridge runs one conversation at a time anyway). */
const settingsPath = () => join(HOME, "settings.json");
export const readSettings = (): Settings => ({ model: "", effort: "", ...(existsSync(settingsPath()) ? JSON.parse(readFileSync(settingsPath(), "utf8")) : {}) });
export function saveSettings(s: Settings) { mkdirSync(HOME, { recursive: true }); writeFileSync(settingsPath(), JSON.stringify(s, null, 2) + "\n"); }

export const readSessions = (dir: string): SessionRecord[] => JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8"));
export function saveSession(dir: string, rec: SessionRecord) {
  const rest = readSessions(dir).filter(s => s.sessionId !== rec.sessionId);
  writeFileSync(join(dir, "sessions.json"), JSON.stringify([...rest, rec], null, 2) + "\n");
}

/** Legacy wrapper retained until normalized workflow activation. */
export const readTranscript = (dir: string, sessionId: string) => readClaudeTranscript({ dir, sessionId });

export const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
/** Add one turn's totals (the `usage` on the SDK result message; per-block assistant usage is not final). */
export const addUsage = (t: Usage, u: any): Usage => ({
  input: t.input + (u?.input_tokens ?? 0),
  output: t.output + (u?.output_tokens ?? 0),
  cacheRead: t.cacheRead + (u?.cache_read_input_tokens ?? 0),
  cacheWrite: t.cacheWrite + (u?.cache_creation_input_tokens ?? 0),
});

const claudeMd = (fileName: string) => `# Figma design review — ${fileName}

You review Figma designs from inside the Figma desktop app. The user talks to you through the
"Sesori Review" plugin panel and sees the canvas next to your messages. There is no terminal.

## What you are here for
1. Review the prototype flow as a whole (structure, dead ends, missing states), then each screen.
2. Answer questions about specific screens or components.
3. Make the design dev-ready: write Dev Mode annotations with implementation detail
   (behaviour, states, spacing/tokens, data, edge cases, accessibility) on the nodes they apply to.

## How to work
- The user follows you on the canvas. Call \`focus\` on a node **before** you say anything about it, every time,
  and talk about one screen at a time. A summary of many screens without focusing each is a failed review.
- Prefer \`ask_user\` over guessing when intent is unclear; offer 2-4 options when you can.
- Propose annotations first (one line each), then write them with \`annotate\`. Annotations append by default;
  pass \`replace: true\` only when the user asks to replace what is there. Never overwrite an annotation you did not write.
- Keep chat messages short; the detail belongs in annotations.
- Node ids look like \`12:34\`. The user's current selection is appended to every message; "this" means the selection.
- You may write scratch files only under \`notes/\` in this directory.
- If an app source directory is available (additional directory), read it so annotations match existing components and naming.

<!-- BEGIN tool-steering — delete this whole section if the Figma desktop MCP server is not used -->
## Tool steering: two Figma tool sets
- \`figma\` (plugin): \`get_flow\`, \`get_screen\`, \`focus\`, \`annotate\`, \`ask_user\`. Instant, unlimited, and the only way to move the user's view or write annotations.
- \`figma-desktop\` (Figma's local MCP server): \`get_design_context\`, \`get_metadata\`, \`get_variable_defs\`, \`get_screenshot\`, ... Richer (variables, Code Connect, generated code) but rate limited (roughly 10 calls/min, 200/day per seat).

To find node ids inside a screen use the layer tree that \`get_screen\` returns (ids, names, bounds, text); do not
call \`get_metadata\`/\`get_design_context\` on a whole board or section, the output is huge and gets spilled to disk.
Use \`get_flow\`/\`get_screen\` for overview and screenshots. Use \`figma-desktop\` only when you need variables/tokens,
component properties or code for a node you already focused; its \`get_screenshot\` does not move the user's canvas,
so it never replaces \`focus\` + \`get_screen\`. Pass node ids as \`12:34\`; if a tool rejects that, try \`12-34\`.
<!-- END tool-steering -->
`;

const SKILL = `---
name: review-flow
description: Structured review of a Figma prototype flow, screen by screen, ending with dev-ready annotations. Use when the user asks to review the flow, the page, or a set of screens.
---

# Review flow

## 1. The flow as a whole
\`get_flow\`. Summarize in at most 10 lines: entry points, main path, branches, dead ends, screens with no way back.
If there are more than ~8 screens, \`ask_user\` which ones matter most. Then go straight to step 2; do not review
screens in the summary.

## 2. Screen by screen — one screen per message
The user is following on the canvas, so this is a guided walk, not a report. For each screen in flow order:
1. \`focus\` the screen. Never describe a screen you have not just focused.
2. \`get_screen\` it (scale 0.5 for large frames). \`figma-desktop\` screenshots do not move the canvas.
3. Give at most 5 findings for this screen only, sorted by impact (clarity/consistency, missing states such as
   loading/empty/error, interaction gaps, accessibility, dev ambiguity), plus a one-line annotation proposal.
4. \`ask_user\` "Next screen?" with options like "Next", "Write the annotation first", "Stop here". Wait for the answer.
   Do not move to another screen before the user answers. Do not batch screens even if the user asked to be quick;
   be quick per screen instead.

## 3. Annotations
Write proposals the user accepted with \`annotate\` (focus the node first). Body layout:
**What** / **Behaviour** / **States** / **Tokens** / **Edge cases**; skip headings that do not apply.

## 4. Verdict
Finish with a dev-readiness verdict and the open questions.
`;
