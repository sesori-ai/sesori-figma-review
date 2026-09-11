// Per-Figma-file workspace under ~/.sesori-review/files/<fileId>/ plus the sessions index kept in it.
// The workspace is the agent's cwd: CLAUDE.md, .mcp.json and the review-flow skill are loaded from here,
// and notes/ is the only place it may write files. CLAUDE.md, settings and .mcp.json are written once and
// never overwritten, so teammates can edit them per file; the skill is ours and is refreshed on every start.
import { randomUUID } from "node:crypto";
import {
  closeSync, constants, copyFileSync, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FIGMA_MCP_URL, type ProviderId, type SessionRecord, type Settings, type Usage } from "../../shared/protocol.ts";

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
  writeFileSync(join(dir, ".claude", "skills", "review-flow", "SKILL.md"), REVIEW_FLOW_SKILL);
  writeIfMissing(join(dir, "sessions.json"), "[]\n");
  return dir;
}
const writeIfMissing = (path: string, content: string) => { if (!existsSync(path)) writeFileSync(path, content); };

const CODEX_INSTRUCTIONS_NOTE = [
  "<!-- Seeded once from CLAUDE.md by Sesori Review.",
  "AGENTS.md and CLAUDE.md are separately user-editable. -->\n\n",
].join(" ");
const writeOwnedIfMissing = (path: string, content: string) => {
  try { writeFileSync(path, content, { flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
};
const replaceOwnedFile = (path: string, content: string) => {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const entry = fstatSync(fd);
    if (!entry.isFile() || entry.nlink !== 1) throw new Error(`Refusing unsafe Codex owned file: ${path}`);
    ftruncateSync(fd); writeFileSync(fd, content);
  } finally { closeSync(fd); }
};
const readSeedFile = (path: string) => {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { throw new Error(`Refusing unsafe Codex seed file: ${path}`, { cause: error }); }
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`Refusing unsafe Codex seed file: ${path}`);
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
};
const lstatIfPresent = (path: string) => {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
};
const ensureOwnedDirectory = (path: string) => {
  const entry = lstatIfPresent(path);
  if (entry) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`Refusing unsafe Codex skill directory: ${path}`);
    }
    return;
  }
  mkdirSync(path);
};
/** Add Codex scaffolding only when explicitly prepared. Seed instructions once; refresh bridge-owned skill. */
export function provisionCodexWorkspace(args: { dir: string }) {
  if (lstatSync(args.dir).isSymbolicLink()) throw new Error(`Refusing unsafe Codex workspace: ${args.dir}`);
  const agents = join(args.dir, ".agents"), skills = join(agents, "skills"), reviewFlow = join(skills, "review-flow");
  const notes = join(args.dir, "notes");
  if (!existsSync(notes) || lstatSync(notes).isSymbolicLink() || !lstatSync(notes).isDirectory()) {
    throw new Error(`Refusing unsafe Codex notes directory: ${notes}`);
  }
  ensureOwnedDirectory(agents); ensureOwnedDirectory(skills); ensureOwnedDirectory(reviewFlow);
  const instructionsPath = join(args.dir, "AGENTS.md"), skillPath = join(reviewFlow, "SKILL.md");
  const instructions = lstatIfPresent(instructionsPath);
  if (instructions && (instructions.isSymbolicLink() || !instructions.isFile())) {
    throw new Error(`Refusing unsafe Codex instructions file: ${instructionsPath}`);
  }
  if (!instructions) {
    const sourcePath = join(args.dir, "CLAUDE.md");
    writeOwnedIfMissing(instructionsPath, CODEX_INSTRUCTIONS_NOTE + readSeedFile(sourcePath));
  }
  const skill = lstatIfPresent(skillPath);
  if (skill && (skill.isSymbolicLink() || !skill.isFile() || skill.nlink !== 1)) {
    throw new Error(`Refusing unsafe Codex skill file: ${skillPath}`);
  }
  replaceOwnedFile(skillPath, REVIEW_FLOW_SKILL);
  return { instructionsPath, skillPath };
}
export const readReviewFlowSkill = () => REVIEW_FLOW_SKILL;
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

/** Provider-keyed preferences. Legacy `{ model, effort }` files are Claude preferences. */
const settingsPath = () => join(HOME, "settings.json");
const blankSettings = (): Settings => ({
  provider: "claude",
  providers: { claude: { model: "", effort: "" }, codex: { model: "", effort: "" } },
});
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown): string => typeof value === "string" ? value : "";
const providerId = (value: unknown, source: string): ProviderId => {
  if (value === undefined || value === "claude") return "claude";
  if (value === "codex") return "codex";
  throw new Error(`Unsupported provider ${JSON.stringify(value)} in ${source}`);
};

export function readSettings(): Settings {
  if (!existsSync(settingsPath())) return blankSettings();
  const raw = object(JSON.parse(readFileSync(settingsPath(), "utf8")));
  if (!raw) return blankSettings();
  const providers = object(raw.providers);
  if (!providers) {
    if (raw.provider !== undefined && raw.provider !== "claude") throw new Error("Provider-keyed settings are missing");
    return { ...blankSettings(), providers: { ...blankSettings().providers, claude: { model: text(raw.model), effort: text(raw.effort) } } };
  }
  const claude = object(providers.claude), codex = object(providers.codex);
  return {
    provider: providerId(raw.provider, "settings.json"),
    providers: {
      claude: { model: text(claude?.model), effort: text(claude?.effort) },
      codex: { model: text(codex?.model), effort: text(codex?.effort) },
    },
  };
}
export type SettingsIo = {
  write: (path: string, content: string) => void;
  rename: (source: string, destination: string) => void;
  remove: (path: string) => void;
};
export function saveSettings(args: { settings: Settings; io?: SettingsIo }) {
  mkdirSync(HOME, { recursive: true });
  const path = settingsPath(), temporary = `${path}.${randomUUID()}.tmp`;
  const io = args.io ?? { write: writeFileSync, rename: renameSync, remove: path => rmSync(path, { force: true }) };
  try { io.write(temporary, JSON.stringify(args.settings, null, 2) + "\n"); io.rename(temporary, path); }
  catch (error) {
    try { io.remove(temporary); } catch (cleanupError) { console.error("Failed to remove settings temporary file", cleanupError); }
    throw error;
  }
}

function decodeSession(value: unknown): SessionRecord | undefined {
  const raw = object(value);
  if (!raw) return;
  const provider = providerId(raw.provider, "sessions.json");
  const anchor = object(raw.anchor), usage = object(raw.usage);
  if (!anchor || !usage || typeof raw.sessionId !== "string") return;
  return {
    provider,
    sessionId: raw.sessionId,
    title: text(raw.title),
    anchor: {
      type: anchor.type === "selection" || anchor.type === "page" ? anchor.type : "flow",
      nodeIds: Array.isArray(anchor.nodeIds) ? anchor.nodeIds.filter((id): id is string => typeof id === "string") : [],
    },
    pageId: text(raw.pageId), pageName: text(raw.pageName), createdAt: text(raw.createdAt), updatedAt: text(raw.updatedAt),
    turns: typeof raw.turns === "number" ? raw.turns : 0,
    costUsd: typeof raw.costUsd === "number" ? raw.costUsd : 0,
    costStatus: raw.costStatus === "estimated" || raw.costStatus === "unavailable" ? raw.costStatus : "reported",
    usage: {
      input: typeof usage.input === "number" ? usage.input : 0,
      output: typeof usage.output === "number" ? usage.output : 0,
      cacheRead: typeof usage.cacheRead === "number" ? usage.cacheRead : 0,
      cacheWrite: typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0,
    },
  };
}
export const readSessions = (dir: string): SessionRecord[] => {
  const raw: unknown = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8"));
  return Array.isArray(raw) ? raw.map(decodeSession).filter((session): session is SessionRecord => !!session) : [];
};
export function saveSession(dir: string, rec: SessionRecord) {
  const rest = readSessions(dir).filter(item => item.provider !== rec.provider || item.sessionId !== rec.sessionId);
  writeFileSync(join(dir, "sessions.json"), JSON.stringify([...rest, rec], null, 2) + "\n");
}
export const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

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

const REVIEW_FLOW_SKILL = `---
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
