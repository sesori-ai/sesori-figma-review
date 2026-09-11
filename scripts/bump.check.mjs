// One check for scripts/bump.mjs: the repo's real manifests copied into a temp directory,
// bumped twice, plus the inputs it has to refuse without touching anything.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = new URL("../", import.meta.url);
const manifests = ["package.json", "plugin/package.json", "bridge/package.json"];

const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "bump-check-"));
  for (const sub of ["scripts", "plugin", "bridge"]) mkdirSync(join(dir, sub));
  for (const name of [...manifests, "package-lock.json", "CHANGELOG.md", "scripts/bump.mjs"]) cpSync(new URL(name, repo), join(dir, name));
  return dir;
};
// stderr is piped, not inherited, so the runs that are supposed to fail stay quiet.
const bump = (dir, version) => execFileSync(process.execPath, [join(dir, "scripts/bump.mjs"), version], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const read = (dir, name) => readFileSync(join(dir, name), "utf8");
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

for (const bad of ["", "1.2", "01.2.3", "9.9.10-beta.1"]) assert.throws(() => bump(dir, bad), `refuses ${bad || "a missing version"}`);

const stale = fixture();
const before = versions(stale);
writeFileSync(join(stale, "CHANGELOG.md"), "# Changelog\n\n## [0.1.0]\n");
assert.throws(() => bump(stale, "9.9.9"), "refuses a CHANGELOG with no [Unreleased] heading");
assert.deepEqual(versions(stale), before, "and refuses before writing any version");

console.log("bump check ok");
