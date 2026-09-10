import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewProvider } from "./types.ts";

process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "claude-adapter-"));
const {
  addClaudeUsage,
  ClaudeCostTracker,
  ClaudeDisplayMapper,
  ClaudeProvider,
  ClaudeUsageTracker,
  readClaudeTranscript,
  zeroClaudeUsage,
} = await import("./claude.ts");
const { FIGMA_TOOLS } = await import("../figma-tools.ts");

assert.deepEqual(FIGMA_TOOLS.map(tool => tool.name), ["get_flow", "get_screen", "focus", "annotate", "ask_user"]);
assert.ok(FIGMA_TOOLS.every(tool => tool.description && tool.schema));
assert.equal(FIGMA_TOOLS.find(tool => tool.name === "get_screen")!.schema.safeParse({ nodeId: 4 }).success, false);

let preparedCallbacks = 0;
const provider: ReviewProvider = new ClaudeProvider({ version: "test", log: () => {}, onPrepared: () => preparedCallbacks++ });
assert.deepEqual(provider.health({ settings: { model: "haiku", effort: "low" } }).models.map(model => model.value),
  ["", "opus", "sonnet", "haiku"]);
provider.dispose();
assert.equal(preparedCallbacks, 1);
assert.equal(provider.health({ settings: { model: "haiku", effort: "low" } }).status, "starting");

let usage = addClaudeUsage(zeroClaudeUsage(), {
  input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 7,
});
usage = addClaudeUsage(usage, { input_tokens: 1, output_tokens: 1 });
assert.deepEqual(usage, { input: 11, output: 21, cacheRead: 100, cacheWrite: 7 });
const tracker = new ClaudeUsageTracker({ committed: zeroClaudeUsage() });
assert.deepEqual(tracker.messageStart({ input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 50 }),
  { input: 10, output: 1, cacheRead: 50, cacheWrite: 0 });
assert.deepEqual(tracker.messageDelta({ output_tokens: 8 }), { input: 10, output: 8, cacheRead: 50, cacheWrite: 0 });
assert.deepEqual(tracker.messageDelta({ output_tokens: 20 }), { input: 10, output: 20, cacheRead: 50, cacheWrite: 0 });
assert.deepEqual(tracker.complete({ input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 50 }),
  { input: 10, output: 20, cacheRead: 50, cacheWrite: 0 });
assert.deepEqual(tracker.complete({ input_tokens: 2, output_tokens: 3 }),
  { input: 12, output: 23, cacheRead: 50, cacheWrite: 0 }, "per-turn results add once");
const responses = new ClaudeUsageTracker({ committed: { input: 5, output: 7, cacheRead: 0, cacheWrite: 0 } });
responses.messageStart({ input_tokens: 10, output_tokens: 1 });
responses.messageDelta({ output_tokens: 4 });
assert.deepEqual(responses.messageStart({ input_tokens: 12, output_tokens: 1 }),
  { input: 27, output: 12, cacheRead: 0, cacheWrite: 0 });
assert.deepEqual(responses.messageDelta({ output_tokens: 8, cache_read_input_tokens: 3 }),
  { input: 27, output: 19, cacheRead: 3, cacheWrite: 0 });
assert.deepEqual(responses.complete({ input_tokens: 22, output_tokens: 12, cache_read_input_tokens: 3 }),
  { input: 27, output: 19, cacheRead: 3, cacheWrite: 0 });
const resumedCost = new ClaudeCostTracker({ baseUsd: 1.5, baseStatus: "reported" });
assert.deepEqual(resumedCost.complete(0.1), { usd: 1.6, status: "reported" });
assert.deepEqual(resumedCost.complete(0.25), { usd: 1.75, status: "reported" }, "cost uses immutable resume baseline");

const session = { provider: "claude" as const, sessionId: "s1" };
const display = new ClaudeDisplayMapper();
const map = (message: unknown) => display.map({ message, sessionId: "s1", interrupted: false });
assert.deepEqual(map({ type: "stream_event", uuid: "a", event: { type: "message_start", message: { id: "msg" } } }), []);
assert.deepEqual(map({ type: "stream_event", uuid: "b", event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } } }), []);
assert.deepEqual(map({ type: "stream_event", uuid: "c", event: { type: "content_block_stop", index: 0 } }), []);
assert.deepEqual(map({ type: "stream_event", uuid: "d", event: { type: "content_block_start", index: 1, content_block: { type: "text" } } }),
  [{ type: "text_start", session, itemId: "s1:msg:1" }]);
assert.deepEqual(map({ type: "stream_event", uuid: "e", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hi" } } }),
  [{ type: "text_delta", session, itemId: "s1:msg:1", text: "Hi" }]);
assert.deepEqual(map({ type: "stream_event", uuid: "f", event: { type: "content_block_stop", index: 1 } }),
  [{ type: "text_end", session, itemId: "s1:msg:1" }]);
assert.deepEqual(map({ type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "mcp__figma__focus", input: { nodeId: "1:2" } }] } }),
  [{ type: "tool", session, itemId: "t", name: "mcp__figma__focus", input: { nodeId: "1:2" } }]);

const dir = join(tmpdir(), "adapter workspace");
const transcriptDir = join(process.env.CLAUDE_CONFIG_DIR, "projects", dir.replace(/[^a-zA-Z0-9]/g, "-"));
mkdirSync(transcriptDir, { recursive: true });
writeFileSync(join(transcriptDir, "s1.jsonl"), [
  { type: "user", message: { content: "[Figma file F]\nReview.\n[Current selection: none]" } },
  { type: "assistant", message: { content: [{ type: "thinking", thinking: "hidden" }, { type: "tool_use", id: "q", name: "mcp__figma__ask_user", input: { question: "Next?" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "q", content: "Next\n[Current selection: none]" }] } },
  { type: "assistant", message: { content: [{ type: "text", text: "Done" }] } },
].map(value => JSON.stringify(value)).join("\n"));
assert.deepEqual(readClaudeTranscript({ dir, sessionId: "s1" }), [
  { role: "user", text: "Review." },
  { role: "tool", name: "mcp__figma__ask_user", input: { question: "Next?" } },
  { role: "answer", text: "Next" },
  { role: "assistant", text: "Done" },
]);
assert.deepEqual(readClaudeTranscript({ dir, sessionId: "missing" }), []);

console.log("claude adapter check ok");
