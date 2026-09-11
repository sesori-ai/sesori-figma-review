<p align="center"><img src="https://raw.githubusercontent.com/sesori-ai/sesori-figma-review/master/plugin/assets/icon-128.png" width="96" alt="Sesori Review"></p>
<h1 align="center">Sesori Review</h1>
<p align="center"><b>Claude reviews your Figma prototype with you, inside Figma.</b><br>
It walks the canvas screen by screen, asks before it assumes, and leaves Dev Mode annotations your developers can build from.</p>

<p align="center"><a href="https://www.figma.com/community/plugin/1680238164100658906/sesori-review"><b>Get it on the Figma Community →</b></a></p>

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

**2. Add the plugin to Figma** (once): install [**Sesori Review** from the Figma Community](https://www.figma.com/community/plugin/1680238164100658906/sesori-review). Running from source instead? The bridge prints a manifest path (`~/.sesori-review/plugin/manifest.json`) for **Plugins → Development → Import plugin from manifest…**.

**3. Review**: open a file, run **Plugins → Sesori Review**, click **Review flow**. The header dot turns green when the bridge and Claude are ready.

Next time you only need step 1 and step 3.

> **Notes.** Dev Mode annotations need a paid Figma plan; everything else works on free files. Agent SDK usage is billed like the API. For richer context (variables, component properties, code), turn on Figma's **desktop MCP server** (Dev Mode → inspect panel → *Enable desktop MCP server*); the review works without it.

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

The plugin is a thin client. The bridge is a small local process that runs the Claude Agent SDK, exposes Figma tools to Claude (`get_flow`, `get_screen`, `focus`, `annotate`, `ask_user`) and keeps a workspace per Figma file under `~/.sesori-review/files/<fileId>/`. See [ARCHITECTURE.md](ARCHITECTURE.md).

<details>
<summary><b>Configuration</b></summary>

Model and effort live in `~/.sesori-review/settings.json` (set from the plugin). Environment variables for the bridge:

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_REPO` | unset | Path to your app's source, mounted read-only so annotations use real component names. |
| `SESORI_REVIEW_HOME` | `~/.sesori-review` | Where the plugin copy, settings and workspaces live. |

Per-file workspace (`~/.sesori-review/files/<fileId>/`), the agent's working directory:

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
- **Versions differ** notice: `npm install -g @sesori/figma-review@latest`, then update the plugin ([Community](https://www.figma.com/community/plugin/1680238164100658906/sesori-review) updates itself; a manifest-imported copy updates when the bridge restarts).
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
npm run check          # type-check, sandbox check against a mock Figma API, bridge self-check
npm run bridge         # dev bridge (tsx), then import plugin/manifest.json in Figma
npm run smoke -w bridge   # fake plugin, one real turn through the bridge, no Figma needed
```

Layout: `plugin/` (Figma sandbox + UI iframe, bundled by `plugin/build.mjs`), `bridge/` (WebSocket server + Agent SDK session manager), `shared/protocol.ts` (the wire protocol). Decisions in [PLAN.md](PLAN.md).

**Releasing**: `npm version <v> --workspaces --include-workspace-root --no-git-tag-version`, add a [CHANGELOG.md](CHANGELOG.md) entry, then `npm publish --access public` from the repo root (`prepack` builds everything). The Figma plugin ships separately: import `plugin/manifest.json` in the desktop app and **Publish new version** — its `id` is the [Community listing](https://www.figma.com/community/plugin/1680238164100658906/sesori-review), listing copy is in [docs/community-listing.md](docs/community-listing.md) and its art in `plugin/assets/`.
</details>

## License

[Apache 2.0](LICENSE).
