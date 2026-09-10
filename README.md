# AI Review for Figma

Claude reviews your prototype from inside Figma: the flow as a whole, then screen by screen. It moves your
canvas to whatever it is talking about, asks you questions at the right spot, and writes Dev Mode annotations
so the design ends up dev-ready. Everything happens in the plugin panel; a small local bridge process runs the
Claude Agent SDK next to Figma.

```
figma-ai-review/
├── plugin/     Figma plugin (sandbox code + UI iframe). Import plugin/manifest.json into Figma desktop.
├── bridge/     Local Node process: WebSocket server + Claude Agent SDK. `npm run bridge`.
├── shared/     Wire protocol types used by both.
├── ARCHITECTURE.md   How the pieces talk to each other.
└── PLAN.md           Decisions, milestones, risks.
```

## Prerequisites

- **Node 22+** (the bridge uses the built-in `fetch`; the smoke test uses the built-in `WebSocket`).
- **Claude Code** installed and authenticated on the machine (`claude` login or `ANTHROPIC_API_KEY` in the
  environment). The bridge uses whatever Claude Code auth exists. For team use, prefer an API key per machine:
  Agent SDK usage falls under the Commercial Terms.
- **Figma desktop app** with a **paid plan** (Dev Mode annotations need one) and, optionally, the
  **Figma desktop MCP server** enabled: open Dev Mode → inspect panel → *Enable desktop MCP server*. It listens on
  `http://127.0.0.1:3845/mcp`. Without it the review still works using the plugin's own tools.

## Setup

```bash
cd figma-ai-review
npm install
npm run build          # bundles plugin/dist/code.js and plugin/dist/ui.html
```

Import the plugin into Figma desktop once: **Plugins → Development → Import plugin from manifest…** and pick
`figma-ai-review/plugin/manifest.json`. Turn on **Plugins → Development → Hot reload plugin** so rebuilds are
picked up.

## Run

Terminal, keep it running while you review:

```bash
cd figma-ai-review
APP_REPO=/path/to/your/app npm run bridge     # APP_REPO is optional (see below)
```

In Figma: open a file, **Plugins → Development → AI Review**. The header dot turns green when the bridge, Claude
and the Figma MCP server are all reachable; hover it for details.

## Use

- **Review flow** – reviews the prototype flow of the current page (starting points → reactions), then each screen.
- **Review selection** – select frames or components first, then click. The review is anchored to them.
- **New chat** – empty conversation anchored to the current page; just type a question.
- **History** – earlier sessions for this file, with cost. *Resume* continues one.
- Typing while Claude is working **steers** it: the message is merged into the running turn. **Stop** interrupts.
- Your current selection is attached to every message, so "make this one bigger" works.
- Annotations are written without asking. Anything not on the auto-approve list (e.g. a file outside the notes
  folder) shows an **Allow / Deny** card. Questions from Claude arrive as cards with option buttons; the canvas
  jumps to the spot it is asking about.
- The header shows session cost, input/output tokens and turn count.

## Configuration (environment variables for the bridge)

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_REPO` | unset | Path to the app's source. Mounted read-only so annotations can reference real components. |
| `FIGMA_REVIEW_HOME` | `~/.figma-review` | Where per-file workspaces live (`files/<fileId>/`). |
| `FIGMA_REVIEW_MODEL` | Claude Code default | Model alias or id, e.g. `sonnet`, `opus`, `haiku`. |
| `FIGMA_REVIEW_EFFORT` | Claude Code default | Effort level: `low`, `medium`, `high`, `xhigh`, `max`. |

Each Figma file gets a workspace with an editable `CLAUDE.md` (review conventions and a removable
"tool steering" section about the Figma MCP server), `permissions.json` (the **auto-approve list**: add or
remove tools under `allow`), `.mcp.json`, the `review-flow` skill, `notes/` and `sessions.json`.
All but the skill are created once and never overwritten, so edit them freely. You can also `cd` into a
workspace and run `claude --resume <sessionId>` to inspect a session from the CLI.

## Develop and test

```bash
npm run check                 # type-check both packages + sandbox (mock figma) and workspace/usage self-checks
npm run build                 # rebuild the plugin after editing plugin/src
FIGMA_REVIEW_MODEL=haiku npm run bridge   # then, in another terminal:
npm run smoke -w bridge       # fake plugin: one real turn through the bridge, ~2 cents, no Figma needed
```

## Troubleshooting

- **"bridge offline"** in the header: start `npm run bridge`. The plugin reconnects every 2 seconds.
- **Figma MCP down**: enable the desktop MCP server in Dev Mode (see Prerequisites) and click the header, or ignore it.
- **Claude failed to start**: run `claude` in a terminal to check auth; the bridge log shows the error.
- **Annotations fail**: the file is on a free plan, or the node type cannot hold annotations (groups, some vectors).
- **Nothing happens after "Review flow"**: check the bridge terminal. Tool calls wait for the plugin; if you close
  the plugin mid-turn they fail with "plugin not connected" and Claude is told so.
