// Self-check for the bridge's non-trivial pure logic: workspace provisioning and usage accounting.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SESORI_REVIEW_HOME = mkdtempSync(join(tmpdir(), "figma-review-"));
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "claude-config-"));
const { addUsage, readAllow, readSessions, readSettings, readTranscript, saveSession, saveSettings, workspaceFor, zeroUsage } = await import("./workspace.ts");

assert.deepEqual(readSettings(), { model: "", effort: "" }, "no settings file → Claude Code defaults");
saveSettings({ model: "opus", effort: "low" });
assert.deepEqual(readSettings(), { model: "opus", effort: "low" });

const dir = workspaceFor("file1", "Checkout redesign");
assert.ok(readFileSync(join(dir, "CLAUDE.md"), "utf8").includes("Checkout redesign"));
assert.ok(readFileSync(join(dir, "CLAUDE.md"), "utf8").includes("<!-- BEGIN tool-steering"), "steering section is delimited so it can be removed");
assert.equal(JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")).mcpServers["figma-desktop"].url, "http://127.0.0.1:3845/mcp");
assert.ok(readFileSync(join(dir, ".claude/skills/review-flow/SKILL.md"), "utf8").startsWith("---\nname: review-flow"));
const allow = readAllow(dir);
assert.ok(allow.includes("mcp__figma__annotate") && allow.includes(`Edit(/${dir}/notes/**)`), "auto-approve list lives in the workspace");

writeFileSync(join(dir, "CLAUDE.md"), "edited by a teammate");
writeFileSync(join(dir, ".claude/skills/review-flow/SKILL.md"), "stale skill");
workspaceFor("file1", "Checkout redesign");
assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf8"), "edited by a teammate", "user-owned files are never overwritten");
assert.ok(readFileSync(join(dir, ".claude/skills/review-flow/SKILL.md"), "utf8").startsWith("---"), "the skill is refreshed on every start");

const rec = { sessionId: "s1", title: "t", anchor: { type: "flow" as const, nodeIds: [] }, pageId: "0:1", pageName: "Page 1", createdAt: "a", updatedAt: "a", turns: 1, costUsd: 0.5, usage: zeroUsage() };
saveSession(dir, rec);
saveSession(dir, { ...rec, turns: 2, costUsd: 0.9 });
saveSession(dir, { ...rec, sessionId: "s2" });
assert.deepEqual(readSessions(dir).map(s => [s.sessionId, s.turns, s.costUsd]), [["s1", 2, 0.9], ["s2", 1, 0.5]], "upsert keeps one record per session");

// History → Open reads Claude Code's transcript: our context lines stripped, ask_user answers kept, tool results/meta/thinking dropped.
const slug = join(process.env.CLAUDE_CONFIG_DIR!, "projects", dir.replace(/[^a-zA-Z0-9]/g, "-"));
mkdirSync(slug, { recursive: true });
writeFileSync(join(slug, "s1.jsonl"), [
  { type: "user", message: { content: '[Figma file "F", page "P" (0:1). Anchor: flow]\nReview the flow.\n[Current selection: none]' } },
  { type: "user", isMeta: true, message: { content: [{ type: "text", text: "skill body" }] } },
  { type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }, { type: "tool_use", id: "t1", name: "mcp__figma__ask_user", input: { question: "Next?" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "Next\n\n[Current selection: none]" }] }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "mcp__figma__focus", input: { nodeId: "1:1" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "Focused" }] } },
  { type: "assistant", message: { content: [{ type: "text", text: "**Screen 1** looks fine." }] } },
  { type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } },
  "not json",
].map(l => typeof l === "string" ? l : JSON.stringify(l)).join("\n"));
assert.deepEqual(readTranscript(dir, "s1"), [
  { role: "user", text: "Review the flow." },
  { role: "tool", name: "mcp__figma__ask_user", input: { question: "Next?" } },
  { role: "answer", text: "Next" },
  { role: "tool", name: "mcp__figma__focus", input: { nodeId: "1:1" } },
  { role: "assistant", text: "**Screen 1** looks fine." },
  { role: "tool", name: "stopped", input: {} },
]);
assert.deepEqual(readTranscript(dir, "missing"), []);

// Per-turn totals from the result message are accumulated on the session record; missing fields count as 0.
let u = addUsage(zeroUsage(), { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 });
u = addUsage(u, { input_tokens: 1, output_tokens: 1 });
assert.deepEqual(u, { input: 11, output: 21, cacheRead: 100, cacheWrite: 7 });
console.log("selfcheck ok");
