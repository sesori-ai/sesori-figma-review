// One check for scripts/release.mjs: a full release into a throwaway repo with a bare remote, plus
// every state it has to refuse without touching that remote. Nothing here reaches the network.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = new URL("../", import.meta.url);
const fixtures = [];
process.on("exit", () => fixtures.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

// A nested `npm run` would inherit the outer run's npm_* variables; the fixture gets a clean environment.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("npm_")));
// stderr is piped, not inherited, so the fixture's own git chatter stays out of the check's output.
const quiet = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, ...quiet }).trim();
const release = (dir, ...args) => execFileSync(process.execPath, [join(dir, "scripts/release.mjs"), ...args], { cwd: dir, env, ...quiet });
const manifestVersion = (dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
const ran = "check-ran";
// Everything a refused release must leave alone. Not the local tag list: release.mjs fetches tags before it
// looks at them, so a tag that exists only on origin legitimately appears locally on the way to being refused.
const written = ["package.json", "plugin/package.json", "bridge/package.json", "package-lock.json", "CHANGELOG.md"];
const state = (dir, remote) => [
  git(remote, "rev-parse", "refs/heads/master"),
  git(remote, "tag", "--list"),
  git(dir, "rev-parse", "HEAD"),
  git(dir, "status", "--porcelain"),
  ...written.map((name) => readFileSync(join(dir, name), "utf8")),
];

const temp = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  fixtures.push(dir);
  return dir;
};

// Small synthetic manifests, not the repo's: bump.check.mjs is what covers bump.mjs against the real ones.
const fixture = () => {
  const remote = temp("release-check-remote-");
  execFileSync("git", ["init", "--bare", "-b", "master", remote], quiet);

  const dir = temp("release-check-");
  for (const sub of ["scripts", "plugin", "bridge"]) mkdirSync(join(dir, sub));
  for (const name of ["scripts/bump.mjs", "scripts/release.mjs"]) cpSync(new URL(name, repo), join(dir, name));
  // `check` stands in for the real one, and leaves a (gitignored) mark so a release that skipped it is caught.
  const check = `node -e "require('node:fs').writeFileSync('${ran}', '')"`;
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.1.0", scripts: { check } }, null, 2) + "\n");
  writeFileSync(join(dir, ".gitignore"), `${ran}\n`);
  for (const ws of ["plugin", "bridge"]) writeFileSync(join(dir, ws, "package.json"), JSON.stringify({ version: "0.1.0" }, null, 2) + "\n");
  const packages = { "": { version: "0.1.0" }, plugin: { version: "0.1.0" }, bridge: { version: "0.1.0" } };
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ name: "fixture", version: "0.1.0", packages }, null, 2) + "\n");
  writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Something worth releasing.\n\n## [0.1.0]\n\n- First release.\n");

  git(dir, "init", "-b", "master");
  git(dir, "config", "user.email", "check@example.com");
  git(dir, "config", "user.name", "release check");
  git(dir, "remote", "add", "origin", remote);
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "fixture");
  git(dir, "push", "-u", "origin", "master");
  return { dir, remote };
};

const { dir, remote } = fixture();
release(dir, "0.2.0");
assert.equal(git(dir, "log", "-1", "--pretty=%s"), "Release v0.2.0", "the release commit names the version");
assert.equal(manifestVersion(dir), "0.2.0", "the manifests were bumped");
assert.match(readFileSync(join(dir, "CHANGELOG.md"), "utf8"), /^## \[Unreleased\]\n\n## \[0\.2\.0\]\n/m, "the changelog was cut");
assert.ok(existsSync(join(dir, ran)), "the checks ran before any of it was pushed");
assert.equal(git(remote, "rev-parse", "refs/heads/master"), git(dir, "rev-parse", "HEAD"), "the release commit reached origin");
// `cat-file -t` is what tells an annotated tag from a lightweight one; `^{}` dereferences either.
assert.equal(git(remote, "cat-file", "-t", "refs/tags/v0.2.0"), "tag", "the tag on origin is annotated");
assert.equal(git(remote, "rev-parse", "refs/tags/v0.2.0^{}"), git(dir, "rev-parse", "HEAD"), "and it names that commit");
assert.equal(git(dir, "status", "--porcelain"), "", "nothing is left uncommitted");

// Each refusal has to happen before anything is written or pushed, so the release can just be retried.
const refuses = (what, spoil, ...args) => {
  const { dir, remote } = fixture();
  spoil(dir, remote);
  const before = state(dir, remote);
  assert.throws(() => release(dir, ...args), `refuses ${what}`);
  assert.deepEqual(state(dir, remote), before, `and changes nothing for ${what}`);
  assert.ok(!existsSync(join(dir, ran)), `and refuses ${what} before spending a check run`);
};

refuses("a missing version", () => {});
for (const bad of ["1.2", "v1.2.3", "1.2.3-beta.1"]) refuses(`the version ${bad}`, () => {}, bad);
refuses("an unclean tree", (dir) => writeFileSync(join(dir, "stray.txt"), "not part of the release\n"), "0.2.0");
refuses("a branch other than master", (dir) => git(dir, "checkout", "-b", "feature"), "0.2.0");
refuses(
  "a master ahead of origin",
  (dir) => {
    writeFileSync(join(dir, "notes.md"), "unpushed\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "unpushed");
  },
  "0.2.0",
);
refuses("a tag that already exists locally", (dir) => git(dir, "tag", "v0.2.0"), "0.2.0");
refuses(
  "a tag that already exists on origin",
  (dir) => {
    git(dir, "tag", "v0.2.0");
    git(dir, "push", "origin", "v0.2.0");
    git(dir, "tag", "-d", "v0.2.0");
  },
  "0.2.0",
);

console.log("release check ok");
