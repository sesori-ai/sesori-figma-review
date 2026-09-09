# Plan: AI design review inside Figma

## Goal

A Figma plugin our team uses from the Figma desktop app to have Claude review a prototype: the flow as a
whole, then each screen, answering questions along the way, steering the user's canvas to whatever is being
discussed, and leaving Dev Mode annotations that make the design dev-ready. All interaction happens in the
plugin panel. Nobody talks to a terminal.

## Constraints and decisions

| Decision | Why |
| --- | --- |
| Plugin UI is the only chat surface | The whole point of the plugin; a CLI-driven review is already possible without it. |
| Local bridge process running the Claude Agent SDK | The SDK is Node-only and spawns Claude Code, so it cannot live in the plugin iframe. It gives us the agent loop, MCP, permissions, sessions and CLAUDE.md for free. Accepted cost: each teammate runs `npm run bridge`. |
| Figma tools are an in-process MCP server in the bridge, executed by the plugin | Only the plugin's sandbox can move the viewport, export PNGs or write annotations. |
| Figma desktop MCP server (`127.0.0.1:3845`), not the remote one | No OAuth, more reliable, already running on every designer's machine once enabled. Read-only, rate limited. |
| Per-file workspace under `~/.figma-review/files/<fileId>/` as the agent's cwd | Gives CLAUDE.md, a skill, `.mcp.json`, notes/ and a sessions index per Figma file; keeps writes away from the app repo (which is mounted read-only as an additional directory). |
| Own file id in shared plugin data | `figma.fileKey` is only available to private org plugins. |
| Annotations via `node.annotations` (paid plan) | Native Dev Mode annotations; no fake pin layers. |
| Every write goes through a permission card | `annotate` and any write outside `notes/` are not in `allowedTools`, so the SDK asks the plugin. |
| New messages steer, Stop interrupts | Claude Code merges a message sent mid-turn into the running turn between tool calls. `interrupt()` is the Stop button. |
| `ask_user` tool instead of the built-in `AskUserQuestion` | It focuses the canvas on the node in question before asking. |
| Pre-warm the next session with `startup()` | Removes the CLI boot cost from "Review flow". |
| Cost and tokens per session in `sessions.json` | From `result.total_cost_usd` and per-API-response usage deduplicated by message id. |

## Milestones

- [x] **M0 Design** – feasibility checked against Figma Plugin API docs and the Agent SDK reference.
- [x] **M1 Skeleton (this commit)** – plugin (`manifest`, sandbox executor, UI), bridge (WebSocket server, workspace
      provisioning, SDK session manager, health, cost), shared protocol, self-checks, smoke test, docs.
      Verified: type checks, the sandbox check (code.ts against a mock `figma` API: flow walk, screen tree, focus,
      annotate), the workspace/usage check, and an end-to-end smoke run (fake plugin → bridge → Claude → `focus`
      tool → answer → cost recorded). Not yet verified: anything that needs the real Figma app.
- [ ] **M2 First real review in Figma** – import the manifest, run against a real prototype, fix what breaks:
      node id format accepted by the desktop MCP tools (`12:34` vs `12-34`), export sizes, annotation writes,
      viewport behaviour across pages.
- [ ] **M3 Review quality** – tune CLAUDE.md and the `review-flow` skill on real files; decide whether the
      tool-steering section (Figma MCP rate limits) earns its keep or gets deleted.
- [ ] **M4 Team rollout** – shared install instructions, one API key per machine (Agent SDK usage falls under the
      Commercial ToS), maybe a `launchd` entry so the bridge is always up.

## Out of scope for the POC

Community publishing, multi-plugin connections to one bridge, user-attached screenshots in chat, markdown
rendering in the chat panel, comments on the canvas, forking sessions, per-node annotation categories.

## Risks and unknowns

- Figma desktop MCP rate limits (~10/min, 200/day per seat for read tools) may bite during long reviews; the
  plugin's own tools carry no such limit, which is why the CLAUDE.md steering section exists.
- `--resume` cost accounting: the bridge assumes Claude Code does not restore cost totals on resume and adds the
  stored total to the new process's total. If it does restore them, costs double count after a resume.
- The SDK loads the user's globally installed skills into the session even with `settingSources: ["project"]`
  (seen in the smoke test). Harmless noise for now.
- A `setSharedPluginData` write marks the Figma file as modified the first time the plugin runs in it.
