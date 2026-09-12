<p align="center"><img src="https://raw.githubusercontent.com/sesori-ai/sesori-figma-review/master/plugin/assets/icon-128.png" width="96" alt="Sesori Review"></p>
<h1 align="center">Sesori Review</h1>
<p align="center"><b>Claude reviews your Figma prototype with you, inside Figma.</b><br>
It walks the canvas screen by screen, asks before it assumes, and leaves Dev Mode annotations your developers can build from.</p>

<p align="center"><a href="#manual-plugin-installation"><b>Install manually →</b></a> · <a href="https://www.figma.com/community/plugin/1680238164100658906/sesori-review">Figma Community (review pending)</a></p>

<p align="center"><img src="https://raw.githubusercontent.com/sesori-ai/sesori-figma-review/master/docs/screenshot.png" alt="The plugin panel: empty state, a question about the selected screen with Claude focusing and reading it, and a selection review with findings"></p>

## Why you'd want this

- **A second pair of eyes before handoff.** Click *Review flow* and Claude reads the prototype, then walks every screen: dead ends, missing loading/empty/error states, inconsistent spacing, unclear interactions, accessibility gaps.
- **It moves your canvas.** Claude focuses each frame before talking about it, so you follow along instead of reading a report about frames you have to hunt for.
- **It asks, it doesn't guess.** Questions arrive as cards with options. "Next screen?", "Write this as an annotation?", "Which of these flows matters most?"
- **Dev-ready output, not chat.** Findings you accept become Dev Mode annotations on the right nodes: what, behaviour, states, tokens, edge cases.
- **Your Claude, your bill.** Runs on the Claude Agent SDK with your own Claude Code login or API key. Pick model and effort in the plugin. Nothing leaves your machine except the calls to Anthropic.

## Quick start

You need **Node 22+**, the **Figma desktop app** (the browser version cannot reach a local process), and **Claude Code signed in** (run `claude` once) or an `ANTHROPIC_API_KEY` in your shell.

**1. Install and start the bridge**, and keep the terminal open:

```bash
npm install -g @sesori/figma-review   # once
sesori-figma-review                   # every time you review
```

(No install? `npx -y @sesori/figma-review` does both in one go.)

**2. Import the bundled plugin** (once): the Community listing is still under review, but the npm package already includes the plugin. In the Figma desktop app, open a design file and choose **Plugins → Development → Import plugin from manifest…**. Select the manifest path printed by the bridge (normally `~/.local/share/sesori-figma-review/plugin/manifest.json`). No clone or build needed. See [manual installation](#manual-plugin-installation) for file-picker help and the standalone ZIP option.

**3. Review**: run **Plugins → Development → Sesori Review**, then click **Review flow**. The header dot turns green when the bridge and Claude are ready. A Community-installed copy runs from **Plugins → Sesori Review** instead.

Next time you only need step 1 and step 3.

> **Notes.** Dev Mode annotations need a paid Figma plan; everything else works on free files. Agent SDK usage is billed like the API. For richer context (variables, component properties, code), turn on Figma's **desktop MCP server** (Dev Mode → inspect panel → *Enable desktop MCP server*); the review works without it.

## Manual plugin installation

### Recommended: use the plugin bundled with the bridge

1. Install and start the bridge using the [quick start](#quick-start) commands. Both global npm installs and `npx` include the matching built plugin.
2. Copy the **manifest path printed in the terminal**. The bridge refreshes this stable copy on every start; do not import from `node_modules` or the temporary npx cache.
3. In a Figma **desktop** design file, choose **Plugins → Development → Import plugin from manifest…** and select that `manifest.json`. On macOS, press **Cmd+Shift+G** in the file picker to paste the path into the hidden `.local` folder. On Windows, paste the printed path into the file-name field.
4. Run **Plugins → Development → Sesori Review**. Keep the bridge terminal open while reviewing.

The default path is `~/.local/share/sesori-figma-review/plugin/manifest.json` (`~` means your home folder). `SESORI_REVIEW_HOME` or `XDG_DATA_HOME` can change it; the printed path is authoritative.

**Update both together:** stop the bridge, run `npm install -g @sesori/figma-review@latest`, then start `sesori-figma-review` again. For npx, stop the old process and run `npx -y @sesori/figma-review@latest`. Close and reopen the plugin in Figma to load the refreshed files. No re-import is needed while the manifest stays at the same path. Installing the npm update alone does not refresh the copy until the new bridge starts, and an already-open plugin does not hot-reload.

### Alternative: download a standalone plugin ZIP

1. Open [GitHub Releases](https://github.com/sesori-ai/sesori-figma-review/releases) and download **`sesori-review-plugin-vX.Y.Z.zip`** under the release's **Assets**. Older releases may not have this asset; use the bundled-plugin method above instead. GitHub's **Source code** archives are not built plugins.
2. Extract the ZIP into a permanent folder. Keep `manifest.json` next to the `dist/` folder containing `code.js` and `ui.html`; do not import from inside the ZIP or move only the manifest.
3. Import that extracted `manifest.json` using **Plugins → Development → Import plugin from manifest…**, then run **Plugins → Development → Sesori Review**.
4. Start the bridge at the **same version** (replace `X.Y.Z` with the release version):

   ```bash
   npx -y @sesori/figma-review@X.Y.Z
   ```

The ZIP contains only the plugin, this README and the license—not the bridge or Node.js. A ZIP-imported copy is **not** updated by the bridge. To upgrade, close the plugin, replace the extracted plugin files with the new release in the same folder, update the bridge to that version, and reopen the plugin. If you move the folder, re-import its manifest. Use the bridge-managed copy instead if you want bridge upgrades to refresh the plugin automatically.

Once the [Community listing](https://www.figma.com/community/plugin/1680238164100658906/sesori-review) is approved, you can install it there instead. Community updates are separate from npm releases and may lag behind during Figma review.

## What you can do

| | |
| --- | --- |
| **Review flow** | Reviews the prototype flow of the current page, then screen by screen with "Next screen?" between screens. |
| **Selection** | Select frames or components, then click. The review is anchored to them. |
| **Just ask** | Type anything. Your current selection travels with every message, so "make this one bigger" works. |
| **History → Open** | Shows a past conversation for this file; your next message continues it with full context. |
| **Stop** | Replaces *Review flow* while Claude works. Interrupts the turn. Typing while Claude works steers it instead. |
| **Settings** (sliders) | Model (Default / Opus / Sonnet / Haiku) and effort. Applies to the running session too. |

Annotations are written without asking and appended to what is there. Anything not on the auto-approve list shows an **Allow / Deny** card. The header shows live cost, tokens and turns.

## How it works

```
Figma desktop ── plugin UI ──► ws://localhost:3055 ──► bridge (sesori-figma-review) ──► Claude Code ──► Anthropic API
```

The plugin is a thin client. The bridge is a small local process that runs the Claude Agent SDK, exposes Figma tools to Claude (`get_flow`, `get_screen`, `focus`, `annotate`, `ask_user`) and keeps a workspace per Figma file under `~/.local/share/sesori-figma-review/files/<fileId>/`. See [ARCHITECTURE.md](ARCHITECTURE.md).

<details>
<summary><b>Configuration</b></summary>

Model and effort live in `~/.local/share/sesori-figma-review/settings.json` (set from the plugin). Environment variables for the bridge:

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_REPO` | unset | Path to your app's source, mounted read-only so annotations use real component names. |
| `SESORI_REVIEW_HOME` | `$XDG_DATA_HOME/sesori-figma-review`, else `~/.local/share/sesori-figma-review` | Where the plugin copy, settings and workspaces live. |

Per-file workspace (`~/.local/share/sesori-figma-review/files/<fileId>/`), the agent's working directory:

| File | Purpose |
| --- | --- |
| `CLAUDE.md` | Review conventions. Edit freely; never overwritten. |
| `permissions.json` | The auto-approve list (`allow`). |
| `.mcp.json` | Points at the Figma desktop MCP server, so `claude` works from this folder too. |
| `.claude/skills/review-flow/` | The guided review skill. Refreshed on every start. |
| `notes/` | The only place the agent may write files without asking. |
| `sessions.json` | Session index: title, anchor, cost, tokens, turns. |

`cd` into a workspace and run `claude --resume <sessionId>` to continue a session from the CLI.
</details>

<details>
<summary><b>Troubleshooting</b></summary>

- **"bridge offline"** in the header: the panel shows the install and start commands. The plugin reconnects every 2 seconds and picks the conversation back up.
- **Versions differ** notice: follow the [update steps for your installation method](#manual-plugin-installation). The bridge-managed copy refreshes when the updated bridge starts; close and reopen the plugin too. A standalone ZIP must be replaced manually. Community updates are separate and can lag npm releases. If you imported before 0.3.1 from `~/.sesori-review/plugin/`, re-import from the path the bridge prints now.
- **Claude failed to start**: run `claude` in a terminal to check auth. The bridge terminal shows the error.
- **Figma MCP off**: enable the desktop MCP server in Dev Mode, or ignore it.
- **Annotations fail**: free Figma plan, or a node type that cannot hold annotations (groups, some vectors).
- **Nothing happens after "Review flow"**: check the bridge terminal. Closing the plugin mid-turn fails pending tool calls and Claude is told so.
</details>

<details>
<summary><b>Develop from source</b></summary>

```bash
git clone https://github.com/sesori-ai/sesori-figma-review.git
cd sesori-figma-review
npm install
npm run build          # plugin/dist/* and bridge/dist/bridge.mjs
npm run check          # type-check, sandbox/UI/bridge self-checks, release and packaging checks
npm run package:plugin # builds release/sesori-review-plugin-vX.Y.Z.zip for manual installation
npm run bridge         # dev bridge (tsx), then import plugin/manifest.json in Figma
npm run smoke -w bridge   # fake plugin, one real turn through the bridge, no Figma needed
```

Packaging and its checks use `zip` and `unzip` (included on macOS and the Ubuntu release runner; on Debian/Ubuntu, `sudo apt-get install zip unzip`). End users do not need these CLI tools.

Layout: `plugin/` (Figma sandbox + UI iframe, bundled by `plugin/build.mjs`), `bridge/` (WebSocket server + Agent SDK session manager), `shared/protocol.ts` (the wire protocol). Decisions in [PLAN.md](PLAN.md).

**Releasing**: entries land under `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md) as you go; then `npm run bump-and-release <v>` from a clean `master` bumps the version, runs the checks, commits and pushes the `v<v>` tag — the tag publishes to npm and attaches the built manual-install plugin ZIP to the GitHub Release (see [AGENTS.md](AGENTS.md)). The Figma Community version still ships separately: import `plugin/manifest.json` in the desktop app and **Publish new version** — its `id` is the [Community listing](https://www.figma.com/community/plugin/1680238164100658906/sesori-review), listing copy is in [docs/community-listing.md](docs/community-listing.md) and its art in `plugin/assets/`.
</details>

## License

[Apache 2.0](LICENSE).
