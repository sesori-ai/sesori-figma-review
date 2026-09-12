// `npm run bump-and-release 0.3.2`: the whole npm release. From a clean, up-to-date master it bumps
// the version (scripts/bump.mjs), runs the checks, commits `Release vX.Y.Z`, tags it, and pushes the
// commit and the tag together. The tag is what publishes: .github/workflows/publish.yml takes it
// from there. The Figma plugin still ships by hand.
//
// Everything that cannot be taken back is refused before the first write. A published npm version is
// immutable, and a tag reaching origin starts a publish against it.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const script = (name) => fileURLToPath(new URL(name, import.meta.url));
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const run = (command, args, options) => execFileSync(command, args, { cwd: repo, stdio: "inherit", ...options, env: { ...process.env, ...options?.env } });
// What bump.mjs writes, so the recovery below restores exactly that and nothing else in the tree.
const bumped = "package.json plugin/package.json bridge/package.json package-lock.json CHANGELOG.md";
const refuse = (why) => {
  console.error(why);
  process.exit(1);
};

const version = process.argv[2];
// bump.mjs is the one that validates the version; this only has to know the tag name is well formed.
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) refuse("usage: npm run bump-and-release <X.Y.Z>");
const tag = `v${version}`;

// The release commit is `git commit -am`, so anything else left in the tree would ride along inside it.
if (git("status", "--porcelain")) refuse("working tree is not clean; commit or set aside everything else first");
if (git("rev-parse", "--abbrev-ref", "HEAD") !== "master") refuse("releases are cut from master");
git("fetch", "origin", "master", "--tags");
if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/master")) refuse("master and origin/master differ; pull or push first");
// A tag that exists has already had a publish run against it, and that version can never be republished.
if (git("tag", "--list", tag)) refuse(`${tag} already exists locally`);
if (git("ls-remote", "--tags", "origin", tag)) refuse(`${tag} already exists on origin`);

// Past here the tree is being written to, so the two things that can still fail say how to get back.
run(process.execPath, [script("bump.mjs"), version], { env: { SESORI_RELEASE: "1" } });
try {
  // publish.yml runs the checks too, but failing them there leaves the tag pushed and the release half done.
  // Through a shell: npm is a .cmd shim on Windows, which execFileSync refuses to launch directly.
  run("npm", ["run", "check"], { shell: true });
} catch {
  // Not "fix it and rerun": the bump is in the tree, and the unclean-tree guard would refuse that. The bump is
  // cheap to recreate, so dropping it and releasing again once master is green is the shorter way round.
  // Named files rather than `.`, so a fix already made somewhere else in the tree survives.
  refuse(`\nthe checks failed, and the bump is still in the tree.\n  drop it with \`git checkout -- ${bumped}\`, land the fix on master, then run this again`);
}

try {
  // The bump is allowed to land in its own PR, the way v0.3.1's did, and then there is nothing left to commit.
  if (git("status", "--porcelain")) git("commit", "-am", `Release ${tag}`);
  git("tag", "-a", tag, "-m", tag);
} catch (error) {
  // git() pipes stderr, so without this the reason — a signing failure, a hook — is lost behind a stack trace.
  refuse(`\ncould not commit or tag the release:\n${error.stderr || error.message}\n  undo with \`git reset --hard origin/master\`, and \`git tag -d ${tag}\` if the tag got created`);
}

try {
  // Atomic, so the tag never reaches origin without the commit it names.
  run("git", ["push", "--atomic", "origin", "master", tag]);
} catch {
  // Retrying the push is the whole recovery only while origin/master is where the preflight left it. If it moved,
  // this release is cut from the old tip and git rejects the retry; starting over is cheaper than reconciling.
  refuse(
    `\nthe push failed. ${tag} and the release commit are ready locally:\n  retry with \`git push --atomic origin master ${tag}\`\n  or undo with \`git tag -d ${tag} && git reset --hard origin/master\`\nif origin/master has moved on, git rejects the retry: undo, pull, and run this again.`,
  );
}

// A URL rather than a `gh run list --limit 1` incantation: the run may not exist yet, and that one would
// then hand back the previous release's run, green, while this one fails.
console.log(`\n${tag} pushed; publish.yml has it from here:\n  https://github.com/sesori-ai/sesori-figma-review/actions/workflows/publish.yml\n`);
