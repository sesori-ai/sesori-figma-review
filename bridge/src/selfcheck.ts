// Self-check for the bridge's non-trivial pure logic: workspace provisioning and usage accounting.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FIGMA_REVIEW_HOME = mkdtempSync(join(tmpdir(), "figma-review-"));
const { readSessions, saveSession, sumUsage, workspaceFor, zeroUsage } = await import("./workspace.ts");

const dir = workspaceFor("file1", "Checkout redesign");
assert.ok(readFileSync(join(dir, "CLAUDE.md"), "utf8").includes("Checkout redesign"));
assert.ok(readFileSync(join(dir, "CLAUDE.md"), "utf8").includes("<!-- BEGIN tool-steering"), "steering section is delimited so it can be removed");
assert.equal(JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")).mcpServers["figma-desktop"].url, "http://127.0.0.1:3845/mcp");
assert.ok(readFileSync(join(dir, ".claude/skills/review-flow/SKILL.md"), "utf8").startsWith("---\nname: review-flow"));

writeFileSync(join(dir, "CLAUDE.md"), "edited by a teammate");
workspaceFor("file1", "Checkout redesign");
assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf8"), "edited by a teammate", "existing files are never overwritten");

const rec = { sessionId: "s1", title: "t", anchor: { type: "flow" as const, nodeIds: [] }, pageId: "0:1", pageName: "Page 1", createdAt: "a", updatedAt: "a", turns: 1, costUsd: 0.5, usage: zeroUsage() };
saveSession(dir, rec);
saveSession(dir, { ...rec, turns: 2, costUsd: 0.9 });
saveSession(dir, { ...rec, sessionId: "s2" });
assert.deepEqual(readSessions(dir).map(s => [s.sessionId, s.turns, s.costUsd]), [["s1", 2, 0.9], ["s2", 1, 0.5]], "upsert keeps one record per session");

// Claude Code emits one assistant message per content block with the same message.id: count each API response once.
const byId = new Map<string, any>();
byId.set("m1", { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 });
byId.set("m1", { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 });
byId.set("m2", { input_tokens: 1, output_tokens: 1 });
assert.deepEqual(sumUsage(byId, { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 }), { input: 1011, output: 21, cacheRead: 100, cacheWrite: 7 });
console.log("selfcheck ok");
