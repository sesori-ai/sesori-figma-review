// Self-check for persisted migration, workspace preservation, and provider-qualified upserts.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SESORI_REVIEW_HOME = mkdtempSync(join(tmpdir(), "figma-review-"));
const { installPlugin, readAllow, readSessions, readSettings, readSettingsAdvisory, resolveHome, saveSession, saveSettings,
  workspaceFor, zeroUsage } = await import("./workspace.ts");
const { FIGMA_TOOLS } = await import("./figma-tools.ts");

// join() everywhere, so the expectations hold on Windows separators too.
const home = join("/home", "dev"), data = join("/data"), override = join("/override");
const underHome = join(home, ".local", "share", "sesori-figma-review");
assert.equal(resolveHome({}, home), underHome);
assert.equal(resolveHome({ XDG_DATA_HOME: data }, home), join(data, "sesori-figma-review"));
assert.equal(resolveHome({ XDG_DATA_HOME: join("relative", "data") }, home), underHome, "a relative XDG_DATA_HOME is invalid and ignored");
assert.equal(resolveHome({ XDG_DATA_HOME: data, SESORI_REVIEW_HOME: override }, home), override);

assert.deepEqual(FIGMA_TOOLS.map(tool => tool.name), ["get_flow", "get_screen", "focus", "annotate", "ask_user"]);
assert.ok(FIGMA_TOOLS.every(tool => tool.description && tool.schema), "both adapters use one validated Figma catalog");
const manifest = installPlugin();
if (manifest) assert.ok(readFileSync(manifest, "utf8").includes('"main": "dist/code.js"'));

const defaults = { provider: "claude" as const, providers: { claude: { model: "", effort: "" }, codex: { model: "", effort: "" } } };
assert.deepEqual(readSettings(), defaults);
writeFileSync(join(process.env.SESORI_REVIEW_HOME, "settings.json"), JSON.stringify({ model: "opus", effort: "low" }));
assert.deepEqual(readSettings(), { ...defaults, providers: { ...defaults.providers, claude: { model: "opus", effort: "low" } } });
saveSettings({ settings: { ...defaults, providers: { ...defaults.providers, claude: { model: "haiku", effort: "low" } } } });
assert.equal(readSettings().providers.claude.model, "haiku");
const settingsErrors: unknown[] = [];
writeFileSync(join(process.env.SESORI_REVIEW_HOME, "settings.json"), JSON.stringify({ ...defaults, provider: "future" }));
assert.throws(readSettings, /Unsupported provider "future"/);
assert.equal(readSettingsAdvisory({ onError: error => settingsErrors.push(error) }), undefined);
writeFileSync(join(process.env.SESORI_REVIEW_HOME, "settings.json"), "{");
assert.equal(readSettingsAdvisory({ onError: error => settingsErrors.push(error) }), undefined);
assert.deepEqual(settingsErrors.map(error => error instanceof Error), [true, true],
  "advisory credential warning reports malformed settings without inventing a provider");
saveSettings({ settings: defaults });

const dir = workspaceFor("file1", "Checkout redesign");
assert.ok(readFileSync(join(dir, "CLAUDE.md"), "utf8").includes("Checkout redesign"));
assert.ok(readAllow(dir).includes("mcp__figma__annotate"));
writeFileSync(join(dir, "CLAUDE.md"), "edited by teammate");
workspaceFor("file1", "Ignored replacement");
assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf8"), "edited by teammate");

const record = {
  provider: "claude" as const, sessionId: "same-native-id", title: "Review", anchor: { type: "flow" as const, nodeIds: [] },
  pageId: "0:1", pageName: "Page", createdAt: "a", updatedAt: "a", turns: 1, costUsd: 0.5,
  costStatus: "reported" as const, usage: zeroUsage(),
};
saveSession(dir, record);
saveSession(dir, { ...record, provider: "codex", costStatus: "estimated" });
saveSession(dir, { ...record, title: "Updated Claude", turns: 2 });
assert.deepEqual(readSessions(dir).map(item => [item.provider, item.sessionId, item.title, item.turns]), [
  ["codex", "same-native-id", "Review", 1], ["claude", "same-native-id", "Updated Claude", 2],
]);
const legacy = { ...record, provider: undefined, costStatus: undefined, sessionId: "legacy" };
writeFileSync(join(dir, "sessions.json"), JSON.stringify([legacy]));
assert.deepEqual(readSessions(dir).map(item => [item.provider, item.sessionId, item.costStatus]), [["claude", "legacy", "reported"]]);
console.log("selfcheck ok");
