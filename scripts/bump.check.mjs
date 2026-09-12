// One check for scripts/bump.mjs: the repo's real manifests copied into a temp directory,
// bumped twice, plus the inputs it has to refuse without touching anything.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = new URL("../", import.meta.url);
const manifests = ["package.json", "plugin/package.json", "bridge/package.json"];
const files = [...manifests, "package-lock.json", "CHANGELOG.md"];
// The changelog is seeded, never copied: after a release `[Unreleased]` is empty by design,
// and this check has to pass on a release tree too — publish.yml runs it before publishing.
const changelogFixture = `# Changelog

## [Unreleased]

### Fixed

- Something worth releasing.

## [0.1.0]

- First release.
`;

const fixtures = [];
process.on("exit", () => fixtures.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "bump-check-"));
  fixtures.push(dir);
  for (const sub of ["scripts", "plugin", "bridge"]) mkdirSync(join(dir, sub));
  for (const name of [...manifests, "package-lock.json", "scripts/bump.mjs"]) cpSync(new URL(name, repo), join(dir, name));
  writeFileSync(join(dir, "CHANGELOG.md"), changelogFixture);
  return dir;
};
// stderr is piped, not inherited, so the runs that are supposed to fail stay quiet.
const bump = (dir, version) => execFileSync(process.execPath, [join(dir, "scripts/bump.mjs"), version], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const read = (dir, name) => readFileSync(join(dir, name), "utf8");
const snapshot = (dir) => Object.fromEntries(files.map((name) => [name, read(dir, name)]));
const versions = (dir) => {
  const lock = JSON.parse(read(dir, "package-lock.json"));
  return [...manifests.map((name) => JSON.parse(read(dir, name)).version), lock.version, ...["", "plugin", "bridge"].map((key) => lock.packages[key].version)];
};

const dir = fixture();
bump(dir, "9.9.9");
assert.deepEqual([...new Set(versions(dir))], ["9.9.9"], "every manifest and all four lockfile fields carry the new version");
const cut = read(dir, "CHANGELOG.md");
assert.match(cut, /^## \[Unreleased\]\n\n## \[9\.9\.9\]\n/m, "the Unreleased body moves under the new version");
bump(dir, "9.9.9");
assert.equal(read(dir, "CHANGELOG.md"), cut, "rerunning the same version does not cut a second section");

const before = snapshot(dir);
for (const bad of ["", "1.2", "01.2.3", "9.9.10-beta.1"]) {
  assert.throws(() => bump(dir, bad), `refuses ${bad || "a missing version"}`);
  assert.deepEqual(snapshot(dir), before, `and writes nothing for ${bad || "a missing version"}`);
}

// [Unreleased] is empty here, so a new version would only fail later in publish.yml.
assert.throws(() => bump(dir, "9.9.10"), "refuses a new version with nothing under [Unreleased]");
assert.deepEqual(snapshot(dir), before, "and writes nothing");

// A version behind the manifests would rewrite them backwards and print tag instructions.
const backwards = fixture();
const beforeBackwards = snapshot(backwards);
assert.throws(() => bump(backwards, "0.0.1"), "refuses a version older than the current one");
assert.deepEqual(snapshot(backwards), beforeBackwards, "and writes nothing");

// A cut version plus new Unreleased entries would tag changes the release notes omit.
writeFileSync(join(dir, "CHANGELOG.md"), cut.replace("## [Unreleased]\n", "## [Unreleased]\n\n### Fixed\n\n- Something found after the bump.\n"));
const withEntries = snapshot(dir);
assert.throws(() => bump(dir, "9.9.9"), "refuses a rerun that would strand new [Unreleased] entries");
assert.deepEqual(snapshot(dir), withEntries, "and writes nothing");

const stale = fixture();
const untouched = versions(stale);
writeFileSync(join(stale, "CHANGELOG.md"), "# Changelog\n\n## [0.1.0]\n");
assert.throws(() => bump(stale, "9.9.9"), "refuses a CHANGELOG with no [Unreleased] heading");
assert.deepEqual(versions(stale), untouched, "and refuses before writing any version");

const workspaceRecords = { "": { version: "0.0.0" }, plugin: { version: "0.0.0" }, bridge: { version: "0.0.0" } };
for (const [what, badLock] of [
  ["a missing workspace record", { version: "0.0.0", packages: { "": { version: "0.0.0" } } }],
  ["no top-level version", { packages: workspaceRecords }],
]) {
  const brokenLock = fixture();
  writeFileSync(join(brokenLock, "package-lock.json"), JSON.stringify(badLock, null, 2));
  const untouchedFiles = snapshot(brokenLock);
  assert.throws(() => bump(brokenLock, "9.9.9"), `refuses a lockfile with ${what}`);
  assert.deepEqual(snapshot(brokenLock), untouchedFiles, "and refuses before rewriting the manifests");
}

console.log("bump check ok");
