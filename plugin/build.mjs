// Bundles the sandbox code and inlines the UI bundle into a single ui.html (Figma wants one file).
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

mkdirSync("dist", { recursive: true });
await build({ entryPoints: ["src/code.ts"], bundle: true, outfile: "dist/code.js", target: "es2020" });
const ui = await build({ entryPoints: ["src/ui.ts"], bundle: true, write: false, target: "es2020" });
const html = readFileSync("src/ui.html", "utf8").replace("<!-- SCRIPT -->", `<script>${ui.outputFiles[0].text}</script>`);
writeFileSync("dist/ui.html", html);
console.log("built dist/code.js and dist/ui.html");
