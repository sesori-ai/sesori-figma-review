// Headless local harness: composition root for the provider-neutral review bridge.
import { readFileSync } from "node:fs";
import { BRIDGE_PORT } from "../../shared/protocol.ts";
import { ClaudeProvider } from "./providers/claude.ts";
import { CodexProvider } from "./providers/codex.ts";
import { createReviewBridge } from "./review-bridge.ts";
import { hasClaudeAuth, installPlugin, readSettingsAdvisory } from "./workspace.ts";

const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((...args: Parameters<typeof process.emitWarning>) => {
  if (!/canUseTool/.test(String(args[0]))) emitWarning(...args);
}) as typeof process.emitWarning;

const VERSION: string = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
const log = (...values: unknown[]) => console.log(new Date().toISOString(), ...values);
const app = createReviewBridge({
  version: VERSION,
  port: Number(process.env.SESORI_REVIEW_PORT ?? BRIDGE_PORT),
  log,
  createProviders: ({ onChanged }) => ({
    claude: new ClaudeProvider({ version: VERSION, log, onPrepared: onChanged }),
    codex: new CodexProvider({ version: VERSION, log, onPrepared: onChanged }),
  }),
});
process.once("SIGINT", () => { void app.shutdown(); });
process.once("SIGTERM", () => { void app.shutdown(); });

const manifest = installPlugin();
console.log(manifest
  ? `\nSesori Review is running. Keep this terminal open.\n\nFirst time? The matching plugin is bundled with this bridge.\nIn a Figma desktop design file: Plugins → Development → Import plugin from manifest…\n  ${manifest}\nThen run Plugins → Development → Sesori Review.\nThis copy refreshes on every bridge start; close and reopen the plugin after upgrading.\n\nFigma Community (review pending):\n  https://www.figma.com/community/plugin/1680238164100658906/sesori-review\n`
  : "\nPlugin build not found (run `npm run build`); the bridge is up but there is nothing to import into Figma.\n");
const startupSettings = readSettingsAdvisory({
  onError: error => log("Settings unavailable for startup credential warning", error),
});
if (startupSettings?.provider === "claude" && !hasClaudeAuth()) console.log("No Claude credentials found: run `claude` once to sign in, or export ANTHROPIC_API_KEY. The plugin will show \"Claude failed to start\" until then.\n");
