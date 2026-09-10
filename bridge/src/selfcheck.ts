// Self-check for the bridge's non-trivial pure logic: workspace provisioning and usage accounting.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SESORI_REVIEW_HOME = mkdtempSync(join(tmpdir(), "figma-review-"));
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "claude-config-"));
const { installPlugin, readAllow, readSessions, readSettings, saveSession, saveSettings, workspaceFor, zeroUsage } = await import("./workspace.ts");
const { addClaudeUsage, ClaudeCostTracker, ClaudeDisplayMapper, ClaudeUsageTracker, readClaudeTranscript } = await import("./providers/claude.ts");
const { FIGMA_TOOLS } = await import("./figma-tools.ts");
const { isOwnedByFile, isRegisteredFileSocket } = await import("./conversation-owner.ts");

assert.deepEqual(FIGMA_TOOLS.map(tool => tool.name), ["get_flow", "get_screen", "focus", "annotate", "ask_user"]);
assert.ok(FIGMA_TOOLS.every(tool => tool.description && tool.schema), "providers share neutral Figma descriptions and validated schemas");
const activeInA = { fileId: "file-a" }, startingInA = { fileId: "file-a", intentId: "start-a" };
assert.equal(isOwnedByFile({ resource: activeInA, fileId: "file-b" }), false, "file B close cannot end file A active conversation");
assert.equal(isOwnedByFile({ resource: startingInA, fileId: "file-b" }), false, "file B close cannot cancel file A startup");
assert.equal(isOwnedByFile({ resource: activeInA, fileId: "file-a" }), true, "own-file close ends active conversation");
assert.equal(isOwnedByFile({ resource: startingInA, fileId: "file-a" }), true, "own-file close cancels startup");
const registeredSocket = {}, replacedSocket = {};
assert.equal(isRegisteredFileSocket({ registeredSocket, requestSocket: replacedSocket }), false, "replaced socket cannot control current file");
assert.equal(isRegisteredFileSocket({ registeredSocket, requestSocket: registeredSocket }), true);
const manifest = installPlugin(); // needs a plugin build; tolerate its absence so `check` also runs before `build`
if (manifest) assert.ok(readFileSync(manifest, "utf8").includes('"main": "dist/code.js"') && readFileSync(join(process.env.SESORI_REVIEW_HOME, "plugin/dist/ui.html"), "utf8").includes("Sesori Review"), "plugin is copied next to the workspaces");

const defaults = { provider: "claude" as const, providers: { claude: { model: "", effort: "" }, codex: { model: "", effort: "" } } };
assert.deepEqual(readSettings(), defaults, "no settings file → Claude defaults and separate provider preferences");
writeFileSync(join(process.env.SESORI_REVIEW_HOME, "settings.json"), JSON.stringify({ model: "opus", effort: "low" }));
assert.deepEqual(readSettings(), { ...defaults, providers: { ...defaults.providers, claude: { model: "opus", effort: "low" } } }, "legacy settings migrate as Claude preferences");
saveSettings({ ...defaults, providers: { ...defaults.providers, claude: { model: "sonnet", effort: "high" } } });
assert.equal(readSettings().providers.claude.model, "sonnet");
writeFileSync(join(process.env.SESORI_REVIEW_HOME, "settings.json"), JSON.stringify({ ...defaults, provider: "future" }));
assert.throws(readSettings, /Unsupported provider "future"/, "unknown selected provider is not guessed as Claude");
saveSettings(defaults);

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

const rec = { provider: "claude" as const, sessionId: "s1", title: "t", anchor: { type: "flow" as const, nodeIds: [] }, pageId: "0:1", pageName: "Page 1", createdAt: "a", updatedAt: "a", turns: 1, costUsd: 0.5, costStatus: "reported" as const, usage: zeroUsage() };
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
assert.deepEqual(readClaudeTranscript({ dir, sessionId: "s1" }), [
  { role: "user", text: "Review the flow." },
  { role: "tool", name: "mcp__figma__ask_user", input: { question: "Next?" } },
  { role: "answer", text: "Next" },
  { role: "tool", name: "mcp__figma__focus", input: { nodeId: "1:1" } },
  { role: "assistant", text: "**Screen 1** looks fine." },
  { role: "tool", name: "stopped", input: {} },
]);
assert.deepEqual(readClaudeTranscript({ dir, sessionId: "missing" }), []);

// Legacy untagged records become Claude sessions with reported historical cost and keep native ids.
const legacy = { ...rec, provider: undefined, costStatus: undefined, sessionId: "legacy" };
writeFileSync(join(dir, "sessions.json"), JSON.stringify([legacy]));
assert.deepEqual(readSessions(dir).map(session => [session.provider, session.sessionId, session.costStatus]), [["claude", "legacy", "reported"]]);
writeFileSync(join(dir, "sessions.json"), JSON.stringify([{ provider: "future" }]));
assert.throws(() => readSessions(dir), /Unsupported provider "future"/, "provider validates before malformed records can be filtered and later erased");

// Live stream usage changes before result; final per-turn totals replace provisional values without double counting.
let usage = addClaudeUsage(zeroUsage(), { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 });
usage = addClaudeUsage(usage, { input_tokens: 1, output_tokens: 1 });
assert.deepEqual(usage, { input: 11, output: 21, cacheRead: 100, cacheWrite: 7 });
const usageTracker = new ClaudeUsageTracker({ committed: zeroUsage() });
assert.deepEqual(usageTracker.messageStart({ input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 50 }), { input: 10, output: 1, cacheRead: 50, cacheWrite: 0 });
assert.deepEqual(usageTracker.messageDelta({ output_tokens: 8 }), { input: 10, output: 8, cacheRead: 50, cacheWrite: 0 });
assert.deepEqual(usageTracker.messageDelta({ output_tokens: 20 }), { input: 10, output: 20, cacheRead: 50, cacheWrite: 0 }, "cumulative deltas replace the response total, including initial output");
assert.deepEqual(usageTracker.complete({ input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 50 }), { input: 10, output: 20, cacheRead: 50, cacheWrite: 0 });
assert.deepEqual(usageTracker.messageStart({ input_tokens: 2 }), { input: 12, output: 20, cacheRead: 50, cacheWrite: 0 });
assert.deepEqual(usageTracker.complete({ input_tokens: 2, output_tokens: 3 }), { input: 12, output: 23, cacheRead: 50, cacheWrite: 0 });
const multiResponse = new ClaudeUsageTracker({ committed: { input: 5, output: 7, cacheRead: 0, cacheWrite: 0 } });
multiResponse.messageStart({ input_tokens: 10, output_tokens: 1 });
multiResponse.messageDelta({ output_tokens: 4 });
assert.deepEqual(multiResponse.messageStart({ input_tokens: 12, output_tokens: 1 }), { input: 27, output: 12, cacheRead: 0, cacheWrite: 0 });
assert.deepEqual(multiResponse.messageDelta({ output_tokens: 6, cache_read_input_tokens: 3 }), { input: 27, output: 17, cacheRead: 3, cacheWrite: 0 });
assert.deepEqual(multiResponse.messageDelta({ output_tokens: 8 }), { input: 27, output: 19, cacheRead: 3, cacheWrite: 0 }, "successive responses accumulate once and absent usage fields persist");
assert.deepEqual(multiResponse.complete({ input_tokens: 22, output_tokens: 12, cache_read_input_tokens: 3 }), { input: 27, output: 19, cacheRead: 3, cacheWrite: 0 });
const resumedResults = new ClaudeUsageTracker({ committed: { input: 100, output: 50, cacheRead: 25, cacheWrite: 5 } });
assert.deepEqual(resumedResults.complete({ input_tokens: 10, output_tokens: 2 }), { input: 110, output: 52, cacheRead: 25, cacheWrite: 5 });
assert.deepEqual(resumedResults.complete({ input_tokens: 20, output_tokens: 3 }), { input: 130, output: 55, cacheRead: 25, cacheWrite: 5 }, "installed SDK result.usage is per-turn, so same-query results add once");
const resumedCost = new ClaudeCostTracker({ baseUsd: 1.5, baseStatus: "reported" });
assert.deepEqual(resumedCost.complete(0.1), { usd: 1.6, status: "reported" });
assert.deepEqual(resumedCost.complete(0.25), { usd: 1.75, status: "reported" }, "native query-cumulative cost always uses immutable resume baseline");

// Message id + block index, not changing stream-envelope UUID, correlates text across native responses.
const session = { provider: "claude" as const, sessionId: "s1" };
const display = new ClaudeDisplayMapper();
const map = (message: unknown) => display.map({ message, sessionId: "s1", interrupted: false });
assert.deepEqual(map({ type: "stream_event", uuid: "envelope-1", event: { type: "message_start", message: { id: "msg-a" } } }), []);
assert.deepEqual(map({ type: "stream_event", uuid: "envelope-2", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } }), [
  { type: "text_start", session, itemId: "s1:msg-a:0" },
]);
assert.deepEqual(map({ type: "stream_event", uuid: "envelope-3", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } } }), [
  { type: "text_delta", session, itemId: "s1:msg-a:0", text: "Hello" },
]);
assert.deepEqual(map({ type: "stream_event", uuid: "envelope-4", event: { type: "content_block_stop", index: 0 } }), [
  { type: "text_end", session, itemId: "s1:msg-a:0" },
]);
map({ type: "stream_event", uuid: "envelope-5", event: { type: "message_stop" } });
map({ type: "stream_event", uuid: "envelope-6", event: { type: "message_start", message: { id: "msg-b" } } });
assert.deepEqual(map({ type: "stream_event", uuid: "envelope-7", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } })[0],
  { type: "text_start", session, itemId: "s1:msg-b:0" });
map({ type: "stream_event", uuid: "envelope-8", event: { type: "message_stop" } });
map({ type: "stream_event", uuid: "envelope-9", event: { type: "message_start", message: { id: "msg-mixed" } } });
assert.deepEqual(map({ type: "stream_event", uuid: "envelope-10", event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } } }), []);
assert.deepEqual(map({ type: "stream_event", uuid: "envelope-11", event: { type: "content_block_stop", index: 0 } }), [], "thinking has no unmatched text_end");
assert.deepEqual(map({ type: "stream_event", uuid: "envelope-12", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use" } } }), []);
assert.deepEqual(map({ type: "stream_event", uuid: "envelope-13", event: { type: "content_block_stop", index: 1 } }), [], "tool use has no unmatched text_end");
assert.deepEqual(map({ type: "stream_event", uuid: "envelope-14", event: { type: "content_block_start", index: 2, content_block: { type: "text" } } }), [
  { type: "text_start", session, itemId: "s1:msg-mixed:2" },
]);
assert.deepEqual(map({ type: "assistant", message: { content: [{ type: "tool_use", id: "tool1", name: "mcp__figma__focus", input: { nodeId: "1:2" } }] } }), [
  { type: "tool", session, itemId: "tool1", name: "mcp__figma__focus", input: { nodeId: "1:2" } },
]);

console.log("selfcheck ok");
