// Exercise the actual packager with small built-plugin fixtures. No network or source build needed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../", import.meta.url);
const dir = mkdtempSync(join(tmpdir(), "plugin-package-check-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
for (const path of ["scripts", "plugin/dist", "plugin/src", "bridge"]) {
  mkdirSync(join(dir, path), { recursive: true });
}
for (const path of [
  "scripts/package-plugin.mjs", "package.json", "plugin/package.json", "bridge/package.json",
  "plugin/manifest.json", "README.md", "LICENSE",
]) cpSync(new URL(path, root), join(dir, path));
const { version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
const archive = join(dir, "release", `sesori-review-plugin-v${version}.zip`);
writeFileSync(join(dir, "plugin/dist/code.js"), "// built sandbox\n");
writeFileSync(join(dir, "plugin/dist/ui.html"), "<!doctype html><p>built UI</p>\n");
writeFileSync(join(dir, "plugin/dist/stale.js"), "// not part of the plugin\n");
writeFileSync(join(dir, "plugin/src/code.ts"), "// source is not a release asset\n");
const quiet = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
// A different cwd catches accidental reliance on the caller's directory.
const pack = () => execFileSync(process.execPath, [join(dir, "scripts/package-plugin.mjs")], {
  cwd: join(dir, "bridge"), ...quiet,
});
const members = () => execFileSync("unzip", ["-Z1", archive], quiet).trim().split("\n").sort();
const content = ({ path }) => execFileSync("unzip", ["-p", archive, path], quiet);
const expected = ["LICENSE", "README.md", "dist/code.js", "dist/ui.html", "manifest.json"].sort();

pack();
execFileSync("unzip", ["-tqq", archive], quiet);
assert.deepEqual(members(), expected, "only the runtime, instructions and license ship");
assert.equal(content({ path: "manifest.json" }), readFileSync(join(dir, "plugin/manifest.json"), "utf8"));
const manifest = JSON.parse(content({ path: "manifest.json" }));
for (const path of [manifest.main, manifest.ui]) {
  assert.equal(content({ path }), readFileSync(join(dir, "plugin", path), "utf8"), `${path} resolves in the ZIP`);
}
for (const path of ["README.md", "LICENSE"]) {
  assert.equal(content({ path }), readFileSync(join(dir, path), "utf8"));
}

// A rerun replaces the archive, not just its known entries, and ships the refreshed build.
execFileSync("zip", ["-q", archive, "dist/stale.js"], { cwd: join(dir, "plugin"), ...quiet });
writeFileSync(join(dir, "plugin/dist/code.js"), "// rebuilt sandbox\n");
pack();
assert.deepEqual(members(), expected, "reruns do not retain stale ZIP members");
assert.equal(content({ path: "dist/code.js" }), "// rebuilt sandbox\n");

const refuses = ({ path, replacement, error }) => {
  const input = join(dir, path);
  const original = readFileSync(input);
  const before = readFileSync(archive);
  if (replacement === undefined) rmSync(input);
  else writeFileSync(input, replacement);
  try {
    assert.throws(pack, error);
    assert.deepEqual(readFileSync(archive), before, "bad inputs leave the existing archive untouched");
  } finally { writeFileSync(input, original); }
};
for (const workspace of ["plugin", "bridge"]) {
  refuses({
    path: `${workspace}/package.json`, replacement: JSON.stringify({ version: "mismatch" }),
    error: /does not match release version/,
  });
}
refuses({ path: "package.json", replacement: '{"version":"../bad"}', error: /Invalid release version/ });
refuses({
  path: "plugin/manifest.json", replacement: JSON.stringify({ ...manifest, main: "missing.js" }),
  error: /Plugin entry paths changed/,
});
for (const path of ["plugin/dist/code.js", "plugin/dist/ui.html", "README.md", "LICENSE"]) {
  refuses({ path, error: /ENOENT/ });
}

console.log("plugin package check ok");
