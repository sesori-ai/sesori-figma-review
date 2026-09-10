# Architecture

Three processes, two of them inside Figma:

```
┌──────────────────────── Figma desktop ────────────────────────┐      ┌────────────── bridge (Node) ──────────────┐
│  plugin sandbox (code.ts)      plugin UI iframe (ui.ts)       │      │  WebSocket server :3055                    │
│  • owns the document           • chat panel, cards, buttons   │      │  • one plugin connection per Figma file    │
│  • executes tools:             • WebSocket client → bridge    │  WS  │  • per-file workspace provisioning         │
│    get_flow, get_screen,  ◄──► • relays tool calls to sandbox ├──────┤  • Claude Agent SDK query() per session    │
│    focus, annotate             • answers ask_user/permission  │ JSON │    - in-process MCP "figma" (5 tools)      │
│  • streams selection/page ctx    cards itself                 │      │    - canUseTool → permission cards         │
│                                                               │      │    - cost/usage → sessions.json            │
│  Figma desktop MCP server :3845 (read-only, rate limited) ◄───┼──────┼── streamable HTTP MCP client (Claude Code)  │
└───────────────────────────────────────────────────────────────┘      └────────────────────────────────────────────┘
                                                                                          │ spawns
                                                                                   Claude Code CLI ──► Anthropic API
```

The plugin never talks to Claude directly, and the bridge never renders anything. The user only sees the plugin.

## Repository layout

```
shared/protocol.ts          UpMsg / DownMsg / ToolResult / SessionRecord types; port and MCP URL constants
plugin/manifest.json        dynamic-page, editorType figma, allowedDomains ws://localhost:3055
plugin/assets/              icon.svg, mark.svg (inlined into ui.html by build.mjs as data URIs), PNGs for the Community listing
plugin/src/code.ts          sandbox: file id, context events, tool executor (+ sandbox.check.ts, runs it on a mock figma API)
plugin/src/flow.ts          pure prototype-flow walker
plugin/src/ui.html, ui.ts   UI iframe; build.mjs inlines the bundled ui.ts into dist/ui.html
bridge/src/bridge.ts        WebSocket server, SDK session manager, health, cost accounting
bridge/src/workspace.ts     ~/.sesori-review/ provisioning: files/<fileId>/ workspaces, settings.json, sessions index, transcript reader, usage math (+ selfcheck.ts)
bridge/smoke.mjs            fake plugin for an end-to-end run without Figma
```

## Per-file workspace (agent cwd)

```
~/.sesori-review/files/<fileId>/
├── CLAUDE.md                        review conventions; "tool-steering" section between BEGIN/END markers is removable
├── .mcp.json                        figma-desktop → http://127.0.0.1:3845/mcp (for CLI use; the bridge passes the same config)
├── .claude/skills/review-flow/SKILL.md
├── notes/                           the only place the agent may write files (Edit(//…/notes/**) allow rule)
└── sessions.json                    [{ sessionId, title, anchor, pageId, pageName, createdAt, updatedAt, turns, costUsd, usage }]
```

`fileId` is minted by the plugin on first run and stored with `figma.root.setSharedPluginData`, because
`figma.fileKey` is only exposed to private org plugins. Files are written once, never overwritten.

## Agent session configuration (bridge → SDK)

| Option | Value | Effect |
| --- | --- | --- |
| `cwd` | workspace dir | CLAUDE.md, skill and `.mcp.json` resolve from here; `permissions.json` is read by the bridge |
| `settingSources` | `["project"]` | load only project-level config, not the user's personal settings |
| `additionalDirectories` | `[APP_REPO]` if set | app source is readable, not writable |
| `mcpServers` + `strictMcpConfig` | in-process `figma`, http `figma-desktop` | no other MCP servers leak in |
| `tools` | Read, Glob, Grep, Write, Edit, Skill | no Bash, no web, no subagents |
| `allowedTools` = workspace `permissions.json` | `allow`: reads, Skill, `Edit(//<ws>/notes/**)`, all 5 figma tools, `mcp__figma-desktop` | auto-approved; edit per file to change |
| `canUseTool` | everything else (writes outside notes/) | becomes a permission card in the plugin |
| `disallowedTools` | `AskUserQuestion` | replaced by `ask_user`, which focuses the canvas first |
| `includePartialMessages` | true | text streams into the chat as it is generated |
| `resume` | session id | first message after History → Open |
| `model`, `effort` | `~/.sesori-review/settings.json` | picked in the plugin's settings panel; `""` = Claude Code default |

A fresh session for the connected file is pre-warmed with `startup()` as soon as the plugin says hello, and again
after every start, so "Review flow" does not pay the CLI boot.

## Message flows

### Connect

```
sandbox ──context{fileId,fileName,page,selection}──► UI
UI ──ws connect──► bridge
UI ──hello{fileId,fileName}──► bridge
bridge: workspaceFor(fileId) · prewarm(dir) · probe :3845
bridge ──sessions[]──► UI · ──health{claude,figmaMcp}──► UI · (──session──► UI if a session is already live for this file)
```

### Start a conversation

```
UI ──start{anchor, text, selection, resume?}──► bridge
bridge: endConv() · take the warm query (or query() cold, always cold on resume)
bridge: push user message = "[file/page/anchor]\n<text>\n[Current selection: …]"
bridge ──busy:true──► UI
SDK ──system.init──► bridge ──health{servers, model, version}──► UI · ──session{sessionId}──► UI
SDK ──stream_event/assistant──► bridge ──sdk──► UI   (text deltas render live; tool_use blocks become chips)
SDK ──stream_event message_start/message_delta──► bridge: usage += input / output tokens ──session──► UI (live)
SDK ──result──► bridge: rec.cost = base + total_cost_usd
bridge ──session──► UI · ──sessions──► UI · ──busy:false──► UI
```

`user` messages from the SDK (tool results, which carry screenshots) are not forwarded.

### Tool call executed by Figma

```
SDK ──mcp__figma__get_screen{nodeId}──► bridge tool handler
bridge ──tool{id, tool, args}──► UI ──postMessage──► sandbox
sandbox: exportAsync → base64 PNG + layer tree
sandbox ──reply{id, result}──► UI ──reply──► bridge → handler resolves → SDK gets image + text blocks
```

`focus` is the same round trip and changes `currentPage.selection` and the viewport (switching page if needed).

### ask_user (handled in the UI, not the sandbox)

```
SDK ──mcp__figma__ask_user{nodeId?, question, options?}──► bridge ──tool──► UI
UI: postMessage focus{nodeId} to sandbox · render card with option buttons + free text
user clicks an option, types in the card, or types in the main composer ──► UI ──reply{answer + current selection}──► bridge → SDK
```

The handler blocks until the user answers. In-process SDK MCP servers are exempt from the tool idle timeout.

### Permission (anything not in the workspace allow list, e.g. writes outside notes/)

```
SDK ──canUseTool(name, input)──► bridge ──permission{id, tool, input}──► UI
UI: focus input.nodeId if present · card with markdown preview · Allow / Deny
UI ──reply{behavior}──► bridge → {behavior:"allow", updatedInput} | {behavior:"deny", message}
```

### History → Open

```
UI ──open{sessionId}──► bridge: readTranscript(): parse ~/.claude/projects/<cwd slug>/<sessionId>.jsonl
bridge ──history{session, messages, attached}──► UI: render past user/assistant/tool/answer items
next composer message ──► UI ──start{resume: sessionId, text}──► bridge (chat is kept, not cleared)
```

The transcript is Claude Code's own file (our context lines are stripped, tool results and thinking dropped), so
opening costs nothing; the CLI only spawns when the user actually continues.

### Settings (model / effort)

```
UI ──settings{model, effort}──► bridge: saveSettings() · health.settings
bridge: live query → setModel() + applyFlagSettings({effortLevel}) · warm query closed and re-warmed with the new options
bridge ──health──► UI
```

### Steer and Stop

```
UI ──user{text, selection}──► bridge: push into the running input stream (busy:true)
   Claude Code picks it up between tool calls and merges it into the current turn (steering).
UI ──interrupt──► bridge: query.interrupt() → the turn ends with a result → busy:false
```

### Disconnects

- Plugin closes: every pending `tool`/`permission` request resolves with an error result / deny so the agent is
  not stuck. The session keeps running; reopening the plugin re-attaches (`hello` → `session`).
- Bridge restarts: the plugin reconnects every 2 s and shows "bridge offline" meanwhile. The live session is lost
  but can be reopened from History (Claude Code persisted the transcript).
- New `start` while a session runs: the old query is closed and its input stream ended.

## Cost and token accounting

`result.total_cost_usd` is cumulative for the CLI process and only arrives when a turn ends, which in a guided walk
can be many minutes. Token usage is therefore accumulated live from stream events: `message_start` carries the input
and cache tokens of one API response, `message_delta` its final output tokens. The bridge logs both this sum and
`result.usage` at the end of every turn so drift is visible.
On resume, stored totals are used as the base for the new process (assumed not restored by `--resume`).

## Security and permissions

- The plugin's network access is limited by the manifest to `ws://localhost:3055`.
- The bridge binds to 127.0.0.1 only. There is no auth on the socket: anything on the machine can connect and
  drive a review (ponytail: acceptable for a local POC; add a token in `hello` if that changes).
- The agent cannot run shell commands or reach the web. It can write only under `notes/` without asking.
- Annotations always require a click in the plugin.

## Known shortcuts (`ponytail:` comments in code)

- File id is not a UUID; unique enough for a folder name.
- Layer tree is capped at 300 visible nodes per `get_screen`; the agent zooms into children for more.
- One plugin connection per Figma file (a second instance for the same file replaces the first); one
  conversation at a time across files, starting a new one ends the previous.
- History → Open parses Claude Code's transcript file; the format is the CLI's, not ours.
- Model list in the settings panel is static (`MODELS` in protocol.ts); `query.supportedModels()` if it needs to be live.
- Cost after resume is base + new process total (see above).
