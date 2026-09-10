<p align="center"><img src="plugin/assets/icon-128.png" width="96" alt="Sesori Figma Review"></p>
<h1 align="center">Sesori Figma Review</h1>
<p align="center">Claude reviews your prototype from inside Figma: the flow, then every screen, asking at the right spot and leaving Dev Mode annotations.</p>

Everything happens in the plugin panel. Claude moves your canvas to whatever it is talking about, asks questions
as cards, and writes Dev Mode annotations so the design ends up dev-ready. A small local **bridge** process runs the
[Claude Agent SDK](https://docs.anthropic.com/en/docs/agent-sdk) next to Figma; you never talk to it directly.

```
Figma desktop ── plugin (this repo, plugin/) ──► ws://localhost:3055 ──► bridge (this repo, bridge/) ──► Claude Code ──► Anthropic API
```

## Requirements

- **macOS or Linux with Node 22+.** Windows should work but is untested.
- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and signed in** (`claude` once in a
  terminal, or `ANTHROPIC_API_KEY` in the environment). The bridge uses whatever Claude Code auth exists. Agent SDK
  usage is billed like the API.
- **Figma desktop app.** Dev Mode annotations need a **paid Figma plan**; everything else works on free files.
- Optional: the **Figma desktop MCP server** (Dev Mode → inspect panel → *Enable desktop MCP server*). It gives Claude
  variables, component properties and generated code. Without it the review still works with the plugin's own tools.

## Install

```bash
git clone https://github.com/sesori-ai/sesori-figma-review.git
cd sesori-figma-review
npm install
npm run build            # → plugin/dist/code.js and plugin/dist/ui.html
```

Then, in Figma desktop, once: **Plugins → Development → Import plugin from manifest…** and pick
`plugin/manifest.json` from this checkout. Optionally turn on **Plugins → Development → Hot reload plugin**.

## Run

1. Start the bridge and keep the terminal open while you review:
   ```bash
   npm run bridge
   ```
2. In Figma, open a file and run **Plugins → Development → Sesori Figma Review**.
3. The dot in the panel header turns green when the bridge, Claude and the Figma MCP server are all reachable.
   Hover it for details.

Optional: `APP_REPO=/path/to/your/app npm run bridge` mounts your app's source read-only so annotations can refer to
real component names.

## Using it

| Control | What it does |
| --- | --- |
| **Review flow** | Reviews the prototype flow of the current page (starting points → reactions), then walks screen by screen. Claude focuses each screen before talking about it and asks "Next screen?" between screens. |
| **Selection** | Select frames or components first, then click. The review is anchored to them. |
| **New** | Empty conversation. Just type a question; your current selection travels with every message, so "make this one bigger" works. |
| **History** | Earlier sessions for this file with cost. **Open** shows the whole past conversation; your next message continues that session with its full context. |
| **Stop** | Appears in place of *Review flow* while Claude works. Interrupts the turn. |
| **Settings** (sliders icon) | Pick the Claude **model** (Default / Opus / Sonnet / Haiku) and **effort**. Applies to the running session and to new ones. |

- **Questions from Claude** arrive as a card with option buttons and a text box. While a card is open the composer is
  hidden: the card is the only place to answer. The canvas jumps to the spot the question is about.
- **Typing while Claude works steers it**: the message is merged into the running turn.
- **Annotations are written without asking.** Claude appends to existing annotations and only replaces them when you
  say so. Anything not on the auto-approve list (for example a file write outside the notes folder) shows an
  **Allow / Deny** card.
- The header shows live **cost, input/output tokens and turn count** for the session.

## Configuration

Model and effort are chosen in the plugin and stored on the bridge machine in `~/.sesori-review/settings.json`.
Bridge environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_REPO` | unset | Path to your app's source. Mounted read-only for the agent. |
| `SESORI_REVIEW_HOME` | `~/.sesori-review` | Where settings and per-file workspaces live. |

Each Figma file gets a workspace under `~/.sesori-review/files/<fileId>/`, which is the agent's working directory:

| File | Purpose |
| --- | --- |
| `CLAUDE.md` | Review conventions. Has a removable "tool steering" section about the Figma MCP server. Edit freely. |
| `permissions.json` | The **auto-approve list**. Add or remove tools under `allow`. |
| `.mcp.json` | Points at the Figma desktop MCP server, so `claude` works from this folder too. |
| `.claude/skills/review-flow/` | The guided review skill. Rewritten by the bridge on every start. |
| `notes/` | The only place the agent may write files without asking. |
| `sessions.json` | Session index: title, anchor, cost, tokens, turns. |

Everything except the skill is created once and never overwritten. You can `cd` into a workspace and run
`claude --resume <sessionId>` to continue a session from the CLI.

## Develop and test

```bash
npm run check                 # type-check both packages, run the sandbox (mock Figma API) and bridge self-checks
npm run build                 # rebuild the plugin after editing plugin/src
npm run bridge                # then, in another terminal:
npm run smoke -w bridge       # fake plugin: one real turn through the bridge, a few cents, no Figma needed
```

Layout: `plugin/` (Figma sandbox code + UI iframe, bundled by `plugin/build.mjs`), `bridge/` (WebSocket server +
Agent SDK session manager), `shared/protocol.ts` (the wire protocol both sides import). See
[ARCHITECTURE.md](ARCHITECTURE.md) for message flows and [PLAN.md](PLAN.md) for decisions.

## Troubleshooting

- **"bridge offline"** in the header: start `npm run bridge`. The plugin reconnects every 2 seconds.
- **Figma MCP off**: enable the desktop MCP server in Dev Mode (see Requirements), or ignore it.
- **Claude failed to start**: run `claude` in a terminal to check auth; the bridge terminal shows the error.
- **Annotations fail**: the file is on a free plan, or the node type cannot hold annotations (groups, some vectors).
- **Nothing happens after "Review flow"**: check the bridge terminal. Tool calls wait for the plugin; closing the
  plugin mid-turn fails them and Claude is told so.
- **History is empty after moving the checkout**: workspaces are keyed by a per-file id stored in the Figma file, not
  by path, so they survive moves. Sessions themselves live in Claude Code's own transcript store.

## Publishing to Figma Community

The plugin is a thin client for a bridge the user runs themselves, so the listing must say so. Assets are in
`plugin/assets/`: `icon.svg` / `icon-128.png` (plugin icon), `mark.svg` (the bare mark used inside the UI) and
`cover-1920x960.png` (cover art). Regenerate the PNGs after editing the SVGs
(`qlmanage -t -s 128 -o plugin/assets plugin/assets/icon.svg` on macOS). `plugin/manifest.json` allows only
`ws://localhost:3055`; Figma assigns the plugin `id` on first publish. Bump `version` in the three `package.json`
files and add a [CHANGELOG.md](CHANGELOG.md) entry per release; the version shows in the settings panel.

## License

[Apache 2.0](LICENSE).
