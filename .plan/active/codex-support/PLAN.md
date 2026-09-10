# Codex support — full user-facing parity

Status: Step 1 squash-merged as `232048a`; initial architecture review approved. The user has authorized execution
of the entire series, automatic squash merges at ready-for-human-review, and continuation without waiting for
manual merges. Step 2 is implemented on `codex-support-step-2`; initial review and current PR feedback fixes are
applied and verified locally, pending parent final review/merge.

## Goal and locked user direction

Add Codex alongside Claude in Sesori Figma Review. Every existing user-facing feature must work with both:
flow/selection reviews, free-form chat, canvas focus, screenshot understanding, annotations, question and permission
cards, app-source reading, scratch notes, steering, Stop, settings, health, usage/cost, history, native resume,
and the existing npm/npx installation and plugin-refresh flow.
There is no reduced Codex MVP, silent omission, or automatic fallback to Claude.

The user selected **Codex-native file access**: sandboxed Codex command/file tools with explicit approvals are
allowed instead of reproducing Claude's dedicated file tools. This changes the implementation/security surface,
not the requirement to preserve user workflows. It does not authorize unrestricted execution or app-repo writes.

Work belongs only to this repository's `bridge/`, `plugin/`, `shared/`, root package/build metadata, tests, and docs. Do not change the Sesori
Apps Monorepo or its adapters. Execution stays in the supplied `olive-crane` worktree; Step 2 uses
`codex-support-step-2`. Do not create another worktree. Keep the existing root `PLAN.md` as historical context.

Planning procedure: reuse `sesori-plan-maker` from `sesori_apps_monorepo/.agents/skills/`; implementation handoff
uses `sesori-plan-worker`. Borrow their planning, review, and regression-proof principles, not the unrelated
Dart/Flutter workspace layout or mandatory monorepo layers.

Execution authorization: for this series, the user's latest instruction overrides the previous human-only merge
rule. Automatically squash-merge each PR when its current head is ready for human review, then continue to the next
step until the plan is completed. Monitor every PR; keep checks, feedback and mergeability current and use the
reviewed head when merging. Do not bypass protection or merge after a readiness regression. Keep at most one PR open
and one local successor in progress. Full-parity, security and retirement gates remain mandatory; a genuine missing
capability, unavailable test access or required user decision is a blocker, not permission to weaken those gates.

## Current implementation and evidence

Initial inspection: `516f2b5`. Before publication, fast-forwarded to `a359823` and inspected its npm/npx packaging,
startup/auth hints, plugin installation, and reconnect changes. The existing architecture remains the same.

| Location | Current behavior / coupling |
| --- | --- |
| `bridge/src/bridge.ts` | Claude SDK `query/startup`, five in-process Figma MCP tools, permission callback, one active conversation across files, one warm Claude query, file-keyed WebSocket clients and pending replies. |
| `bridge/src/workspace.ts` | Claude-specific instructions/skill/config, editable allow list, global model/effort settings, untagged session index, Claude JSONL history, Claude usage math; now also stable-path plugin installation and Claude auth detection. |
| `shared/protocol.ts` | Raw `sdk: any` down-messages, Claude model aliases/efforts/health, required numeric dollars, native session ID without provider identity. |
| `plugin/src/ui.ts`, `ui.html` | Claude event parsing/copy, single streaming text buffer, cards, provider-unaware history and settings. |
| `bridge/src/selfcheck.ts`, `smoke.mjs` | Workspace/usage/history fixtures and one paid Claude focus-tool smoke; no transport or UI lifecycle suite. |
| `plugin/src/sandbox.check.ts` | Mock Figma proof for document-tool operations, not real Figma rendering or model image understanding. |
| Root and bridge `package.json` | Root owns runtime dependencies and the public `@sesori/figma-review` bin; esbuild bundles bridge modules with external packages. `prepack` builds bridge and plugin; startup refreshes `~/.sesori-review/plugin/`. |

Source beats stale docs: `workspace.ts` auto-approves annotations by default; root `PLAN.md` and parts of
`ARCHITECTURE.md` still claim all annotations require a click. Preserve the editable allow-list behavior, including
asking when the user removes annotation permission, rather than accidentally adopting stale prose.

### Codex integration choice

Use **`codex app-server --stdio`**, not a wrapper around `codex exec`, not `codex mcp-server`, and not the automation-
oriented TypeScript SDK. App Server is the documented custom-client interface for interactive sessions, approvals,
streamed events, and history. Retain the Claude SDK behind its own adapter.

Local read-only CLI inspection found `codex-cli 0.154.0`. Generated experimental TypeScript bindings were inspected
in this worktree, then removed; no model turn, login, user configuration mutation, or paid smoke was run.
Important observed contracts:

- `thread/start`, `thread/resume`, `thread/read`; dynamic tools persist in native thread metadata across resume.
- `turn/start`, `turn/steer` with `expectedTurnId`, `turn/interrupt`.
- `item/tool/call`: results contain `contentItems` plus `success`; this installed version uses `inputText` and
  `inputImage` (`imageUrl`), not a guessed MCP/Responses content shape.
- `thread/settings/update` affects subsequent turns. Experimental `turn/settings/update` also accepts model/effort
  for a running turn, returning `applied` or `targetUnavailable`. Do not plan next-turn-only settings as parity.
- `model/list` reports supported efforts and image modalities. Do not pass Claude aliases or `max` blindly.
- `thread/tokenUsage/updated` contains cumulative `total` and per-response `last`; input includes cached input,
  and output contains reasoning output. Cache-write tokens are separately exposed in this version.
- `account/usage/read` accepts thread-scoped lookup; its optional `threadUsage.estimatedUsageUsdMicros` is an
  estimate, nullable, and billing-route dependent. It is not equivalent to a universally available billing receipt.
- Named permission profiles and dynamic tools are experimental/beta. Profile and legacy sandbox settings must not
  be combined. Existing personal MCP/plugin/features may be enabled by default.

These are schema/documentation findings, **not runtime proof**. `0.154.0` is a qualification candidate, not yet a
supported release claim. Step 3/4 must qualify it and record the exact tested version and supported auth routes.

References:
- <https://developers.openai.com/codex/app-server>
- <https://developers.openai.com/codex/sdk>
- <https://developers.openai.com/codex/permissions>
- <https://developers.openai.com/codex/config-reference>
- Exact local schema command: `codex app-server generate-ts --experimental --out <owned-inspection-directory>`.

## Architecture and ownership

```text
Figma sandbox <-> plugin UI <-> shared normalized protocol <-> bridge conversation owner
                                                          |-> Claude adapter -> Claude SDK
                                                          `-> Codex adapter  -> stdio client -> Codex App Server
Both adapters -> shared Figma tool definitions + existing plugin request/reply boundary -> Figma sandbox/cards
Both adapters -> normalized history/usage/events -> bridge persistence + plugin rendering
```

No SDK types or Codex RPC payloads reach the plugin. Two concrete adapters justify one small interface; this is not
a public extension framework. Keep the existing one-conversation limit. Do not add a database or transcript mirror.

| File (new unless marked existing) | Responsibility and dependencies |
| --- | --- |
| `bridge/src/providers/types.ts` | Bridge-only `ReviewProvider` / `ReviewSession` contracts: prepare, start/resume, history, models/health, send/steer, interrupt, apply settings, dispose, normalized event stream. Imports shared contracts, no implementations. |
| `bridge/src/providers/claude.ts` | Own SDK query, warm-query lifecycle, Claude input stream, SDK-to-normalized mapping, native transcript parsing and provider-specific accounting. Depends on SDK, provider contracts and Figma tool definitions; no UI or WebSocket imports. |
| `bridge/src/providers/codex-client.ts` | Own one lazily started stdio child, initialization, framing, RPC correlation, server-request responses and process disposal. No Figma policy, settings persistence, or UI logic. |
| `bridge/src/providers/codex-protocol.ts` | Small validated DTO projection for consumed RPCs/events, sourced from qualified generated schema. Parse unknown JSON at this boundary with existing Zod; ignore unrelated notifications without inventing types. |
| `bridge/src/providers/codex.ts` | Own active thread/turn IDs, mapping, models/settings, native history and usage, Codex server-request interpretation. Depends on stdio client and provider/tool contracts; no WebSocket or DOM imports. |
| `bridge/src/figma-tools.ts` | One catalog of five tool names/descriptions/schemas and forwarding through a supplied typed plugin request boundary. Claude exposes it as MCP; Codex as dynamic tools. Own the five-tool allow-list decision once, not inside the UI. |
| `bridge/src/bridge.ts` (existing) | Composition and sole conversation owner: choose adapter at start/resume, file routing, session-index writes, lifecycle, shared busy/errors, settings persistence. Existing pending plugin requests remain here. |
| `bridge/src/workspace.ts` (existing) | Provision workspace files, migrate/read/write settings and session index; preserve stable-path plugin installation. Move Claude transcript/auth-specific logic out; share review instruction/skill templates without overwriting user files. |
| Root and bridge `package.json` (existing) | Preserve public bin/files/prepack contract and root runtime dependency ownership; include new adapter modules in the bridge bundle without source-checkout path assumptions. |
| `shared/protocol.ts` (existing) | Provider identity, session key, settings/model descriptors, normalized display/health/usage/events and typed card requests; no provider implementation code. |
| `plugin/src/ui.ts`, `ui.html` (existing) | Render normalized events/cards and provider/model/effort selectors. No provider RPC parsing or permission policy. |

Use functions/modules unless a class genuinely owns lifecycle or transport state. New TS functions accept named
argument objects. Do not perpetuate `any` across newly changed external boundaries.

### Shared contracts and persisted compatibility

- Add `ProviderId = "claude" | "codex"` and a provider-qualified session reference `{ provider, sessionId }`.
  Codex `sessionId` here is its resumable **thread ID**, not an unrelated grouping/session-tree ID. Session upserts,
  Open, resume, attachment checks, and event routing compare both fields and the owning Figma file.
- `Settings` stores selected provider plus separate model/effort preferences for each provider. Decode existing
  `{ model, effort }` as Claude preferences, with Claude still selected. Read old session records as Claude without
  changing their native IDs, timestamps, costs, paths, or ability to resume. Persist the new shape on normal writes.
- Selecting a provider affects **new sessions only**. An existing/opened session stays bound to its original provider;
  explicitly display that provider and route subsequent messages/settings to it. Never migrate model context across
  providers. Disable changing the new-session provider while a turn is busy to avoid ambiguous UI intent.
- The bridge supplies model/effort descriptors and current/default settings. Keep preferences provider-specific;
  opening Claude history while Codex is the new-session choice must still display/apply Claude session settings.
- Replace raw `sdk` messages with a discriminated normalized event contract for assistant text start/delta/end,
  tool activity, status/compaction, error, turn completion/interruption, and authoritative usage/session updates.
  Include provider-qualified session and item identity on streamed activity; no image bytes in display events.
  A small UI item map is justified by real interleaved provider item streams; clear it on session replacement.
- Keep typed Figma tool results and existing card round trips. Add typed card previews for command, patch, and
  permission-scope requests, plus cancellation of outstanding cards when their request is no longer actionable.
  One-shot Allow/Deny must never silently grant a persistent exec rule or session-wide capability.
- Protocol and UI changes ship together. Add a minimal hello protocol version check with actionable rebuild/restart
  guidance rather than maintaining both raw SDK and normalized renderers indefinitely.

### Runtime and user-flow parity

1. **Connect/prepare:** provider-neutral health identifies selected/live provider, version, auth readiness, actual
   model, and MCP status. Codex is lazy: Claude-only installations do not need Codex; Codex-only use must not spawn
   Claude or receive a misleading missing-Claude-credentials startup warning. Reuse existing Codex CLI authentication;
   show `codex login`/installation guidance, no new OAuth UI. Keep `npx @sesori/figma-review`, its manifest-path output,
   stable plugin copy, and upgrade refresh behavior working without a repository checkout.
   Prepare the selected runtime without a paid turn. Keep Claude prewarming; do not pre-create empty Codex threads.
2. **Start/review:** create native session, attach shared instructions and review-flow skill, pass anchor and current
   selection, then stream normalized output. Codex dynamic tools route to the same five executors. Convert PNG base64
   into the qualified `inputImage` data URL shape; prove the model sees image content, not merely a tool label.
3. **Questions/annotations:** focus before discussing/asking, choices plus free text, answer plus current selection,
   append unless replace was explicitly requested. Preserve per-file allow-list behavior for both providers. Codex
   dynamic-tool execution is bridge-owned and does not inherit native shell approval automatically.
4. **Follow-up/steer/Stop:** idle input starts a new turn; busy input uses native steering. A confirmed stale-turn
   rejection may start the same input once as a new turn; never retry an ambiguous accepted RPC and duplicate input.
   Stop targets the actual active native turn, releases its question/permission requests, and produces one stopped
   state. New starts close the previous session and its pending requests before handing ownership to the replacement.
5. **Live settings:** apply saved preferences to future native turns and update the active turn through the native
   live API. `targetUnavailable` means the turn ended, not success for an active turn. Reflect effective settings;
   retain the previous setting and show an error on rejection. Verify changes at the next model invocation, not by
   assuming an already in-flight response can change model retroactively.
6. **History/resume:** Claude keeps its transcript reader; Codex uses `thread/read` for display and `thread/resume`
   only on continuation. Map text, tools, question answers, stops, and errors to shared history items; exclude hidden
   reasoning/raw screenshots. Use native persisted dynamic tool results for answers, and prove replay completeness
   after a bridge restart. If required history items are absent, that is a blocker, not permission to ship partial
   history or add a mirror store without revisiting this plan.
7. **Disconnect/recovery:** preserve file-scoped reattachment. Plugin disconnect resolves pending tools with error
   and approvals with deny; Codex process failure rejects outstanding RPCs and emits idle/error without affecting
   saved history. Preserve the current reconnect behavior that automatically reopens the displayed session after a
   bridge restart and resumes it on the next message, using its provider-qualified identity. End-session and
   bridge-shutdown dispose owned processes/listeners. No automatic model-turn replay,
   process restart loop, or second conversation scheduler.

Live-test authorization: the user explicitly approved bounded use of existing Claude and Codex sign-ins for this
plan's required smoke/regression tests, including acknowledged Claude API charges. Tests must not change logins or
global configuration, copy credentials, or expose account data. Use synthetic fixtures, isolated Sesori homes/free
ports, cheap models and native output/spend/turn bounds where available; clean up only owned processes and fixtures.
Use Haiku with low effort for routine Claude tests. For Codex, use the lowest-cost suitable image/tool-capable model
reported by the qualified model catalog with low effort. Model-switching proof uses the cheapest compatible pair and
tiny synthetic prompts. Do not use Opus, premium, or high-effort models for routine tests; ask before any required
expensive exception.

### Filesystem, permissions, and workspace parity

- Keep the per-Figma-file workspace path and user-edited `CLAUDE.md`, `.mcp.json`, `permissions.json`, and notes.
  Add create-once Codex `AGENTS.md` from the common review conventions. For existing workspaces seed it from the
  existing user-edited review instructions, with an explicit note that the two provider instruction files are now
  separately editable. Refresh the same bridge-owned skill in `.claude/skills/` and `.agents/skills/` from one template.
  Explicitly attach Codex skill input when starting Review flow rather than relying on vague skill discovery.
- Use a bridge-supplied named Codex permission profile: workspace read access, `notes/` write access, optional
  `APP_REPO` read access, and required runtime reads. Default command network access is disabled. Do not use plain
  workspace-write mode, which would grant writes to session indexes/configuration beside notes. Do not mix named
  profiles with legacy `sandbox`/`sandboxPolicy` fields.
- Keep native sandboxed command/file tools. Use explicit approval routing to the plugin, not an autonomous approval
  reviewer. Show command/cwd, file diff/paths, or requested access/scope before an Allow/Deny response. For normal
  commands the default constrained sandbox remains authoritative; requests expanding it require a card. For broader
  permission-grant requests use the smallest native scope and display it; deny unsupported scope or request types.
- `APP_REPO` must never become a writable root through `additionalDirectories`/runtime workspace-root defaults.
  Test real shell and patch attempts, not just rendered cards. App-repo writes stay denied; other outside-notes
  operations must not run without an explicit, accurately scoped approval. Verify symlink targets cannot escape
  notes silently. A profile the host cannot enforce makes Codex unavailable with a clear reason; no unsafe fallback.
- Keep inference/auth network traffic and the intentional Figma desktop MCP connection distinct from agent-command
  networking. Configure only the optional Figma desktop MCP server for Codex; disable unrelated inherited MCP,
  apps/connectors, hooks, subagents and network tools through qualified per-process/session overrides, without
  editing global Codex configuration, copying credentials, or adding an unauthenticated HTTP tool listener.
  Prove effective configuration. A partial map override must not accidentally merge personal servers back in.
- Keep existing Claude permission-file syntax working. Normalize the five known Figma-tool entries at the bridge
  catalog seam; do not invent a general Claude-permission-to-Codex-shell-rule translator. Codex native permissions
  are enforced by its explicit profile and approval requests, with the difference explained in workspace docs.

### Usage and dollar-cost parity

The header and History must retain per-session input/output/cache tokens, turns, and dollar cost. No `$0.000`
placeholder, hidden cost feature, double counting on resume, or guessed model pricing.

- Normalize Codex cumulative totals as replacement snapshots, not additive deltas. Define shared usage as uncached
  input, cache-read, cache-write, and output; subtract included cache categories only according to qualified native
  semantics, and do not add reasoning tokens a second time to output. Preserve Claude's existing cumulative/base
  accounting and cover both providers with resume fixtures.
- Retain numeric `costUsd` with explicit cost provenance/status alongside it (reported / estimated / unavailable).
  Legacy Claude values are reported. Codex's thread-scoped USD estimate is labeled `~$…` / "estimated" in header,
  History, and tooltip. Null upstream data is unavailable, never zero or a stale success claim.
- Read Codex thread-scoped usage after turn completion and when opening history; no account-usage polling loop or
  account-wide totals attributed to a Figma session. Reconcile by native thread total after resume. Convert micro-USD
  without unsafe integer loss. Preserve the existing last confirmed amount while a new result is being obtained.
- **Qualification blocker:** establish dollar availability for every advertised Codex auth/model route. The native
  field is optional. If a required route has no trustworthy USD source, stop and request a concrete decision on a
  sourced/labeled pricing fallback or a scope change. Do not silently retire the plan with costs omitted. The schema
  supports a route-dependent estimate; actual billing precision must never be claimed.

## Complexity budget and proportional safeguards

New persistent state: (1) provider tag on existing session records; (2) provider-keyed preferences in existing
settings; (3) cost provenance in existing records; (4) create-once Codex instruction file and generated skill copy.
No new database, event journal, cross-provider context copy, pricing cache, or auth storage.

New mutable runtime parts: one lazy Codex child/client with request IDs, one RPC pending map, one stdio framing
buffer and lifecycle listeners; one active thread/turn identity inside its adapter; a bounded current-session UI
item map for streamed blocks. Reuse the existing conversation owner, client map, plugin pending map, and selected
provider health/model snapshot. Scope pending plugin requests to the existing conversation owner for cleanup.
No second tool registry, general task queue, multi-conversation manager, polling timer, or replay/dedupe database.

| Safeguard | Evidence / ordinary flow and consequence | Smallest mechanism / accepted risk |
| --- | --- | --- |
| Provider-qualified sessions | Existing history/native resume would dispatch a Codex ID to Claude. | Tag and composite lookup in existing index; no ID translation service. |
| Live item identity | Interleaved text/tool events are native App Server behavior. | Current-session item map; no persistent delivery journal. |
| Reply ownership and cancellation | Stop, New, plugin replacement, or disconnect while a card is open. | Validate socket/conversation owner at existing pending map; resolve/delete once. |
| Stale-turn input | User sends while a turn completes. | Retry only explicit not-accepted/stale-target response; show ambiguous failure rather than replaying. |
| Config/profile isolation | Normal users already have global plugins/MCP and broad workspace defaults. | Explicit qualified overrides and native enforcement tests; not prompt-only restrictions. |
| Version qualification | Dynamic tools/profiles/live settings have experimental contracts. | Record tested baseline, detect unsupported runtime, fail clearly; no alternate execution backend. |

Accept existing local-loopback WebSocket trust posture and one-conversation limit. Adding socket authentication,
multiple simultaneous reviews, transcript migration between providers, web tools, subagents, automatic Codex-runtime
installers, and Windows support is out of scope. Preserve the existing automatic plugin-copy installer. User-customized instructions remain user-owned; no automatic two-way file sync.

## Implementation series

Soft cap: 1,500 changed lines per PR including tests, moves, generated files and docs. These are estimates, not a
reason to compress code or skip parity. If a slice grows beyond its coherent boundary, update the fixed series
before opening it. No bulk vendoring of the 847-file generated protocol: use a focused validated projection and
reproducible inspection against the qualified schema. No hand edits to generated files.

### 1. 🌱 [codex-support] Record full-parity design and acceptance matrix [step 1/7]

- **What / why:** Raise this plan and tracker before implementation; settle provider ownership and parity gates.
- **Complexity:** Trivial documentation; approximately 350–600 changed lines.
- **Risk and test focus:** No runtime risk; check source/API references, user decisions and architectural review.
- **Expected result:** No user-visible, database, or runtime behavior change. Only durable planning files.

### 2. 🚧 [codex-support] Isolate Claude behind normalized review contracts [step 2/7]

- **What / why:** Add provider contracts and common Figma catalog; move Claude-owned lifecycle/history/accounting;
  replace raw SDK UI traffic; introduce provider-qualified session/settings migration and protocol version check.
  Keep Claude the only selectable provider until Codex is wired. This establishes the shared parity seam once.
- **Complexity:** Complex cross-layer refactor and persisted compatibility; approximately 1,100–1,500 changed lines.
- **Risk and test focus:** Streaming identity, costs, old sessions/settings, cards, startup, steering/Stop, protocol
  mismatch, plugin reconnect. Extend selfchecks plus normalized-event/UI fixtures and run a real Claude smoke.
- **Expected result:** Existing Claude workflows unchanged. Old files load as Claude; new writes include provider
  identity/preferences/provenance. Internal SDK knowledge no longer lives in the plugin. No database added.

### 3. 🚧 [codex-support] Add qualified Codex transport and execution policy [step 3/7]

- **What / why:** Add lazy stdio client, validated consumed protocol shapes, startup/auth/version checks, named
  permission-profile/config construction, and Codex workspace/skill provisioning. Keep it unselected by default.
  Preserve the root dependency/bin contract and bundled asset resolution; do not depend on unshipped source files.
- **Complexity:** Complex process/security boundary; approximately 900–1,400 changed lines.
- **Risk and test focus:** Fake-child split/coalesced frames, bidirectional RPC, stderr, exit/EOF, request rejection,
  cleanup, unsupported methods; real no-turn startup/config verification, native permission enforcement in an
  owned fixture, old user-file preservation. Confirm no unrelated MCP/hooks/plugins or writable app roots leak in.
- **Expected result:** No new plugin choice yet. Testable Codex boundary, no global config/auth mutations; only
  provider workspace scaffolding when explicitly requested. Qualify version or stop with evidence.

### 4. 🚧 [codex-support] Implement Codex review sessions and native replay [step 4/7]

- **What / why:** Add Codex adapter and bridge selection for test clients: dynamic Figma tools/images, native
  file/command approvals, questions, turn controls, live settings, native history/resume, token/cost mapping.
  Extend provider-selectable smoke fixtures to prove all core workflows before UI exposure.
- **Complexity:** Complex native lifecycle and feature mapping; approximately 1,100–1,500 changed lines.
- **Risk and test focus:** Screenshot interpretation, slow human answer, permission denial/cancellation, native
  tool replay/answers after restart, live settings, cost-route availability and cumulative resume totals. Any
  missing parity remains blocking; update plan if a new persistence/security architecture becomes necessary.
- **Expected result:** Codex works through the same wire contract and existing fake-plugin entrypoint. Records
  retain Codex thread identity and metrics. No public reduced-functionality release or cross-provider resume.

### 5. ⚙️ [codex-support] Expose both providers with complete plugin workflows [step 5/7]

- **What / why:** Provider/model/effort UI, live-session identity, provider-neutral health/copy, command/diff/scope
  previews, estimate labels, mixed-provider History and new-session versus resumed-session settings behavior.
- **Complexity:** Moderate presentation/state integration; approximately 600–1,000 changed lines.
- **Risk and test focus:** Real Figma flow/selection/chat, all five tools, free-text and option answers, Allow/Deny,
  live settings, steer/Stop, switching providers, history/resume, app repo/notes, desktop MCP on/off. Both providers
  required; test Codex-only and Claude-only readiness. Existing sandbox checks still run.
- **Expected result:** Users can choose either provider with complete workflows. Preferences stay separate;
  existing sessions remain on their provider. UI distinguishes real provider errors and estimated dollar figures.

### 6. 🌿 [codex-support] Reconcile provider documentation and regression contracts [step 6/7]

- **What / why:** Update `README.md`, `ARCHITECTURE.md`, `CHANGELOG.md`, package descriptions/keywords, relevant
  historical-plan corrections, and add
  compact `docs/regression/README.md` plus `docs/regression/provider-review-parity.md`. Reconcile expected behavior
  against shipped implementation, especially annotation approvals, native tool access, profile/version/auth needs.
- **Complexity:** Straightforward documentation across related files; approximately 300–600 changed lines.
- **Risk and test focus:** Installation commands, capability claims, permissions wording and linked evidence;
  documentation must not describe unqualified runtime behavior as passing.
- **Expected result:** No new runtime/database behavior. Users and future workers have accurate setup, security,
  recovery, costs and regression instructions; no obsolete Claude-only global claims remain.

### 7. ⚙️ [codex-support] Verify full parity and retire the plan [step 7/7]

- **What / why:** Run the cumulative L4 matrix below against the final integrated head, record privacy-safe results
  in `docs/regression/results/codex-support.md`, update tracker, move this folder to `.plan/completed/codex-support/`
  only after all required coverage passes. This checks actual delivery, not schema feasibility.
- **Complexity:** Moderate multi-provider/external verification; approximately 150–400 changed lines.
- **Risk and test focus:** Full authoritative user journeys, native file policy, restart/recovery, accounting and
  no-provider regressions. Missing infrastructure is Blocked/Partial, never Pass.
- **Expected result:** No new runtime or database behavior; verified parity evidence and retired plan, or an honest
  active plan naming exact failures/blocked targets. Automatically squash-merge ready PRs and continue under the
  user's explicit series authorization above.

## Verification and retirement contract

No regression catalog exists in this repo today. Step 6 creates the two focused documents named above, using the
monorepo's cumulative-level/proof-boundary approach without importing irrelevant relay/mobile requirements.
Highest required level: **L4 Extended**, because this change promises disconnect/restart, native approval lifecycle,
settings during activity, persisted backward compatibility, and file-isolation behavior as well as normal reviews.

| Level | Added required coverage | Authoritative boundary |
| --- | --- | --- |
| L1 | Build/typecheck, connect/readiness, one streamed response and Figma focus per provider. | Automated plus real backend/fake plugin smoke. |
| L2 | Full normal feature inventory: all five tools, image understanding, flow/selection/chat, questions, notes/app-source reading, approvals, models/effort, metrics and native history/resume. | Real backends plus Figma desktop UI for rendering/canvas/card claims. |
| L3 | Mixed history/selected-provider behavior, legacy Claude workspace/session migration, live model/effort changes, cost provenance and auth/version setup, desktop MCP on/off; packed npm bin startup, plugin installation/upgrade refresh. | Automated migration fixtures, live backend, real Figma client and installed package artifact. |
| L4 | Stop/New/disconnect during question/approval, bridge/native-process restart and history, interleaved events, explicit stale-turn steering, sandbox write/network denials and symlinks. | Deterministic fault fixtures plus native sandbox and real Figma recovery. |

Required matrix:

- Providers: **both Claude and Codex** for every parity workflow; no representative-provider substitution where
  each adapter translates behavior. Mixed-provider history and selection are additional tests.
- Host/platform: macOS arm64 with real Figma desktop for the full UI matrix; Linux x64 headless bridge/backend
  smoke, app-repo/notes permissions and process lifecycle to preserve the initially documented Linux bridge support.
  Windows remains untested/out of scope. Do not claim Figma desktop UI runs on Linux.
- Auth: existing Claude Code signed-in route; Codex managed ChatGPT login and Codex API-key login/config route for
  headless creation/resume/models/accounting. Full Figma UX can use the qualified ChatGPT route. Do not add login UI,
  switch the owner's accounts, or start paid verification without authorized test credentials/access.
- Figma: test fixture with multiple screens and prototype wiring; selection-only and no-flow fallback; paid file for
  actual Dev Mode annotations; free-plan annotation failure remains explicit. Desktop MCP enabled and unavailable.
- Distribution: build and `npm pack`; inspect tarball contents and install/run its bin from an owned in-worktree
  test fixture without source-checkout dependencies. Verify both providers through the packaged bridge, printed
  manifest path, imported plugin, repeated-start refresh and unchanged user workspaces. Check root package dependency
  resolution, missing-Codex guidance and Codex-only startup without Claude credential warnings. No npm publication
  is required for this proof. All test fixtures stay inside the supplied worktree.
- Persistence: fresh home plus old untagged Claude settings/sessions/user-edited instructions, bridge restart,
  same-provider continuation and mixed-provider history. Use owned fixtures, never erase real account history.
- Cost: every selectable model/auth route must have a verified USD source or remain a named unresolved parity gate;
  model changes, cached/reasoning usage and resume cannot change accounting semantics silently.

Automated command baseline: `npm ci`, `npm run check`, `npm run build`. Extend those checks with meaningful adapter,
transport, mapper and UI fixtures; extend `npm run smoke -w bridge` with explicit provider and isolated-home options.
Never replace real image interpretation, native sandbox enforcement, or actual Figma rendering with mocks and call
it end-to-end. Native process probes and paid smokes are implementation-time work, not already completed planning.

Report Pass / Partial / Fail / Blocked / Not run with commit, versions, auth route, host, Figma plan/MCP mode,
variation, first divergent boundary and cleanup. Only privacy-safe summaries enter Git; credentials, real paths,
raw prompts/transcripts/images, account responses and unredacted logs stay outside committed evidence. Any matrix
reduction needs explicit user acceptance recorded here before retirement.

## Cleanup assessment

Include directly caused cleanup in its owning step: remove the raw SDK wire payload and UI parser, move Claude
history/usage ownership into its adapter, replace global Claude-only copy/model constants with provider descriptors,
and remove duplicate tool schemas. Step 2 completed the raw payload/parser removal, moved Claude lifecycle/history/
accounting behind the provider contract, and centralized the Figma catalog. Only absent legacy provider tags decode
as Claude; explicit unknown tags fail instead of reaching an adapter. Keep native transcript storage and legacy
Claude decode compatibility; existing users need them. Keep historical root plan but correct/link stale current-behavior claims in the documentation step.
No unrelated style rewrite, new framework, background service, mobile bridge changes, or socket-auth project.

## Review and unresolved evidence

- Architecture review: **APPROVED** for the initial plan by read-only `medium-intelligence-fast` run
  `3e87c9a5-fb51-40bd-aa8b-885be5fac3cd`. Pre-review gate passed; Section A applied to actual TypeScript modules;
  monorepo-only Section B diagrams/layers skipped. No architectural violations found.
- After that review, reconciled the plan with upstream `a359823`: preserve npm/npx packaging, plugin-copy refresh,
  provider-correct startup hints and automatic history reopen. Added packaged-artifact proof to the same L4 matrix;
  provider ownership/design is unchanged. These documentation/verification additions were parent-reviewed, not
  independently re-reviewed; the initial approval is not presented as a review of this later revision.
- Step 2's first architecture implementation review was **REJECTED** with six valid findings. Local fixes now keep
  model descriptors provider-owned, carry cost provenance through the provider seam, render unavailable cost
  explicitly, capture/deactivate request ownership, reserve asynchronous starts, and reject unknown provider tags.
  Focused checks cover generic selector data, unavailable cost, and migration rejection; parent owns publication.
- Parent's subsequent Step 2 audit found five issues: Stop owner deactivation, terminal-only usage, unstable stream
  item identity, startup follow-up replacement, and foreign-socket reply acceptance. Local fixes split turn
  cancellation from owner teardown, restore provisional usage without terminal side effects, key blocks by native
  message id + index, queue startup steering until session identity, and validate reply socket/owner. PR feedback
  then consolidated conversation activity/health, view/card ownership, immutable accounting baselines, warm callback
  fencing, handshake ordering, parser ordering, shared catalog exposure, mixed-block lifecycle, and stronger smoke
  proofs. Deterministic fixtures plus bounded Haiku multi-turn smoke cover these ordinary flows.
- Runtime qualification not run: dynamic image calls, human-wait duration, replay of answers, effective native
  permission profile/config isolation, live settings at a new model invocation, and per-route dollar estimates.
- If qualification exposes a genuine missing feature, keep the plan blocked and present the concrete gap to the
  user. Full user-facing parity is locked; reviewers and implementers cannot downgrade it to an MVP.
