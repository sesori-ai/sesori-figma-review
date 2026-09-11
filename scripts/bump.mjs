// `npm run bump 0.3.2`: write one version into the three package.json files and the
// lockfile, and cut the CHANGELOG "Unreleased" section under that version. Everything is
// read and validated before the first write, and every file is rewritten on every run, so
// a rerun repairs whatever an interrupted one left behind. Nothing is committed; the
// commands to run next are printed.

import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
// No prereleases: publish.yml runs `npm publish` without `--tag`, which npm refuses for them.
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? "")) {
  console.error("usage: npm run bump <X.Y.Z>");
  process.exit(1);
}

const file = (name) => new URL(`../${name}`, import.meta.url);
const manifests = ["package.json", "plugin/package.json", "bridge/package.json"];
const versionField = /^(\s*"version":\s*)"[^"]+"/m;
// The same heading grammar publish.yml extracts release notes with: `## [X.Y.Z]`, alone on its line.
const heading = new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\]\r?$`, "m");

const changelog = readFileSync(file("CHANGELOG.md"), "utf8");
const alreadyCut = heading.test(changelog);
const unreleased = (changelog.split(/^## \[Unreleased\]\r?\n/m)[1] ?? "").split(/^## \[/m)[0].trim();
if (!alreadyCut && !/^## \[Unreleased\]\r?\n/m.test(changelog)) {
  throw new Error("CHANGELOG.md has no '## [Unreleased]' heading to cut from");
}
// Entries added after the cut would ship in the tag but not in the release notes.
if (alreadyCut && unreleased) {
  throw new Error(`CHANGELOG.md already has a [${version}] section and [Unreleased] is not empty: move those entries into [${version}], or bump the next version`);
}

const sources = manifests.map((name) => {
  const text = readFileSync(file(name), "utf8");
  if (!versionField.test(text)) throw new Error(`${name}: no version field found`);
  return [name, text];
});
// The lockfile repeats the version in four places. npm writes it as 2-space JSON, so a
// parse/stringify round-trip leaves every other byte of the file untouched.
const lock = JSON.parse(readFileSync(file("package-lock.json"), "utf8"));
const lockKeys = ["", "plugin", "bridge"];
for (const key of lockKeys) {
  if (typeof lock.packages?.[key]?.version !== "string") throw new Error(`package-lock.json: no version for "${key || "the root package"}"`);
}

for (const [name, text] of sources) writeFileSync(file(name), text.replace(versionField, `$1"${version}"`));
lock.version = version;
for (const key of lockKeys) lock.packages[key].version = version;
writeFileSync(file("package-lock.json"), JSON.stringify(lock, null, 2) + "\n");

if (alreadyCut) console.log(`CHANGELOG.md already has a [${version}] section; left as is`);
else writeFileSync(file("CHANGELOG.md"), changelog.replace(/^## \[Unreleased\]\r?\n/m, `## [Unreleased]\n\n## [${version}]\n`));

console.log(`\nNext:\n  git commit -am "Release v${version}"\n  git tag -a v${version} -m "v${version}"\n  git push && git push origin v${version}   # the tag is what publishes\n`);
