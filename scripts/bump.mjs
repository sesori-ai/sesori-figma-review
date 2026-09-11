// `npm run bump 0.3.2`: write one version into the three package.json files and the
// lockfile, and cut the CHANGELOG "Unreleased" section under that version. Nothing is
// committed; the commands to run next are printed.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
  console.error("usage: npm run bump <X.Y.Z>");
  process.exit(1);
}

const root = new URL("../package.json", import.meta.url);
// Re-running bump for the version already written is fine: it only cuts the CHANGELOG.
if (JSON.parse(readFileSync(root, "utf8")).version !== version) {
  execFileSync("npm", ["version", version, "--workspaces", "--include-workspace-root", "--no-git-tag-version"], { stdio: "inherit" });
}

const path = new URL("../CHANGELOG.md", import.meta.url);
const changelog = readFileSync(path, "utf8");
if (changelog.includes(`## [${version}]`)) {
  console.log(`CHANGELOG.md already has a [${version}] section; left as is`);
} else if (!/^## \[Unreleased\]\r?\n/m.test(changelog)) {
  throw new Error("CHANGELOG.md has no '## [Unreleased]' heading to cut from");
} else {
  writeFileSync(path, changelog.replace(/^## \[Unreleased\]\r?\n/m, `## [Unreleased]\n\n## [${version}]\n`));
}

console.log(`\nNext:\n  git commit -am "Release v${version}"\n  git tag -a v${version} -m "v${version}"\n  git push && git push origin v${version}   # the tag is what publishes\n`);
