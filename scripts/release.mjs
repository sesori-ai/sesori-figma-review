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
const run = (command, args, env) => execFileSync(command, args, { cwd: repo, stdio: "inherit", env: { ...process.env, ...env } });
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
run(process.execPath, [script("bump.mjs"), version], { SESORI_RELEASE: "1" });
try {
  // publish.yml runs the checks too, but failing them there leaves the tag pushed and the release half done.
  // npm is a .cmd shim on Windows, which execFileSync cannot launch by the bare name.
  run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "check"]);
} catch {
  refuse(`\nthe checks failed and the bump is still in the tree.\n  fix it and run this again, or drop the bump with \`git checkout -- .\``);
}

git("commit", "-am", `Release ${tag}`);
git("tag", "-a", tag, "-m", tag);
try {
  // Atomic, so the tag never reaches origin without the commit it names.
  run("git", ["push", "--atomic", "origin", "master", tag]);
} catch {
  // The commit and the tag are both correct here; only the push is missing, so retrying it is the whole recovery.
  refuse(`\nthe push failed. ${tag} and the release commit are ready locally:\n  retry with \`git push --atomic origin master ${tag}\`\n  or undo with \`git tag -d ${tag} && git reset --hard origin/master\``);
}

console.log(`\n${tag} pushed; publish.yml has it from here:\n  gh run watch $(gh run list --workflow=publish.yml --limit 1 --json databaseId -q '.[0].databaseId')\n`);
