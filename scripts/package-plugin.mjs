// Archive the built plugin without source files, npm dependencies or stale dist output.
// `npm run package:plugin` builds first. zip is available on macOS and the Ubuntu release runner.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const plugin = join(root, "plugin");
const json = ({ path }) => JSON.parse(readFileSync(path, "utf8"));
const { version } = json({ path: join(root, "package.json") });
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid release version: ${version}`);
for (const workspace of ["plugin", "bridge"]) {
  if (json({ path: join(root, workspace, "package.json") }).version !== version) {
    throw new Error(`${workspace}/package.json does not match release version ${version}`);
  }
}
const manifest = json({ path: join(plugin, "manifest.json") });
if (manifest.main !== "dist/code.js" || manifest.ui !== "dist/ui.html") {
  throw new Error("Plugin entry paths changed; update scripts/package-plugin.mjs to match the manifest");
}
const runtime = ["manifest.json", "dist/code.js", "dist/ui.html"];
const docs = ["README.md", "LICENSE"];
// Refuse missing inputs before replacing an existing archive.
for (const file of runtime) readFileSync(join(plugin, file));
for (const file of docs) readFileSync(join(root, file));

const output = join(root, "release");
const archive = join(output, `sesori-review-plugin-v${version}.zip`);
mkdirSync(output, { recursive: true });
rmSync(archive, { force: true }); // zip otherwise updates an existing archive and keeps stale members.
execFileSync("zip", ["-q", "-X", archive, ...runtime], { cwd: plugin, stdio: "inherit" });
execFileSync("zip", ["-q", "-X", archive, ...docs], { cwd: root, stdio: "inherit" });
console.log(archive);
