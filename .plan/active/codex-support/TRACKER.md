# Codex support tracker

Plan: [PLAN.md](PLAN.md). Scope: full user-facing parity on Claude and Codex; Codex-native sandboxed file/command
access approved. The user authorized executing the whole series: automatically squash-merge each PR once ready
for human review and continue without waiting for manual merges. Full verification and parity gates still apply.
Plan PR: https://github.com/sesori-ai/sesori-figma-review/pull/1.

## Fixed PR series

| Step | Exact title | State |
| --- | --- | --- |
| 1 | 🌱 [codex-support] Record full-parity design and acceptance matrix [step 1/7] | Squash-merged as `232048a` (PR #1); initial architecture review approved |
| 2 | 🚧 [codex-support] Isolate Claude behind normalized review contracts [step 2/7] | PR feedback fixes implemented/verified locally; pending parent final review/merge |
| 3 | 🚧 [codex-support] Add qualified Codex transport and execution policy [step 3/7] | Not started |
| 4 | 🚧 [codex-support] Implement Codex review sessions and native replay [step 4/7] | Not started |
| 5 | ⚙️ [codex-support] Expose both providers with complete plugin workflows [step 5/7] | Not started |
| 6 | 🌿 [codex-support] Reconcile provider documentation and regression contracts [step 6/7] | Not started |
| 7 | ⚙️ [codex-support] Verify full parity and retire the plan [step 7/7] | Not started |

## Planning evidence

- Initial repository inspection at `516f2b5`; fast-forwarded to `a359823` before publication and inspected its
  packaging/startup/reconnect changes. Plan now preserves npm/npx distribution and adds packed-artifact proof.
- Located/read `sesori-plan-maker` and `sesori-plan-worker` in the sibling monorepo.
- Official App Server, SDK, configuration and permissions documentation inspected.
- Installed `codex-cli 0.154.0` experimental generated schema inspected, not hand-edited or committed.
- No live Codex/Claude turn, native security test, paid smoke, Figma test, or account/config modification performed.
- Step 1 planning branch had no dependencies installed or runtime validation; it squash-merged as `232048a`.

## Step 2 local evidence

- Added provider contracts, Claude adapter, one shared Figma tool catalog, normalized display events, provider-qualified
  sessions, provider-keyed settings migration, cost provenance, request cancellation, and protocol version gating.
- Removed raw Claude SDK wire/UI parsing and moved Claude lifecycle, transcript projection, and accounting into its adapter.
- `npm ci`, `npm run check`, `npm run build`, and `git diff --check` pass in the supplied worktree.
- Real Claude smoke passed before and after base reconciliation with existing authorized sign-in, Haiku/low, synthetic
  focus request, three-turn and $0.10 SDK bounds, isolated `SESORI_REVIEW_HOME`, and ports 43059/43060. Final result:
  one normalized streamed response, shared `focus` round trip, persisted provider/cost provenance, 22,605 tokens and
  positive $0.0046 reported cost.
- Isolated startup/plugin-copy/protocol-mismatch fixture passed on port 43058. Port 3055 was already occupied and untouched.
  Owned fixture homes, logs, and bridge processes were removed. No login/global config was changed or copied.
- User explicitly authorized bounded existing Claude/Codex sign-ins and acknowledged Claude API charges for remaining
  required smoke/regression work. Future steps need not request this again; retain isolation, spend bounds and privacy.
- Live tests must use Haiku/low for Claude and the lowest-cost suitable image/tool-capable model reported by the Codex
  catalog with low effort. Model-switching proof uses the cheapest compatible pair and tiny synthetic prompts. No
  Opus/premium/high-effort routine tests; ask before any required expensive exception.
- First architecture implementation review rejected six in-scope seams. All were fixed: model options now come from
  provider health; cost value/status travel together and unavailable never renders as dollars; request owners are
  captured and deactivated; async starts use one generation reservation and close stale completions; only absent
  legacy provider tags migrate to Claude while unknown tags fail explicitly. Focused migration/UI assertions added.
  No real Figma rendering claim is made.
- Post-first-review Claude smoke passed on isolated port 43061 with Haiku/low and the same $0.10/three-turn bounds:
  normalized focus round trip, one reported-cost turn, 22,590 tokens and positive $0.0117 cost. Owned fixture removed.
- Parent audit then found five ordinary-flow regressions. Fixes preserve request-owner activity across Stop, restore
  provisional live usage without terminal effects/double counting, correlate text through native message id + block
  index across changing envelope UUIDs, queue startup follow-ups until session identity, and reject foreign-socket
  replies. Automated fixtures cover each seam. Enhanced Haiku/low smoke on isolated port 43064 proved cancelled
  `ask_user` → interrupted turn → same-session `focus` follow-up, live tokens while busy, stable confirmed cost,
  started-block text accumulation, and two final turns: 34,487 tokens, positive $0.0241 cost. Owned fixture removed.
- Parent's cumulative Messages API usage correction from `1ed1e9d` remains: nonzero initial output, repeated deltas,
  and multiple responses reconcile per response. Lock-resolved SDK 0.3.263 types state `result.usage` is per-turn while
  `total_cost_usd` is query-cumulative. Final native three-result fixture observed independent per-turn totals whose
  sum exactly matched persisted usage; immutable resume-baseline fixtures cover both usage and cumulative cost.
- Final bounded Haiku/low smoke on isolated port 43067 proved healthy-client survival after an old-protocol reconnect,
  `ask_user` cancellation/Stop, same-provider/session focus follow-up, coherent started-block text, live usage with
  stable confirmed cost, selected-Codex/live-Claude provider-scoped health, actual idle reconnect, and a second
  completed text turn. Three native result snapshots summed exactly to persisted 33,128 tokens; cost was $0.007259.
  Four-turn/$0.10 bounds applied; owned fixture/process/log removed.
- Parent accepted the coherent soft-cap exception rather than re-splitting. Final pre-push audit then moved view
  cancellation from browsing the History list to choosing an actual row, preserving browse/dismiss/continue, and
  replaced global numeric start generation with one `{ fileId, intentId }` reservation. New/History close now affects
  only the registered socket's own active/pending file; file B cannot stop file A, while own-file close still cancels.
  Focused view/ownership checks passed; no extra paid smoke was needed for that boundary-only correction.
- Latest review consolidated connection/view reconciliation under the same ephemeral intent owner. Protocol v3 adds
  one validated connection snapshot: old plugin v1/v2 gets safe bridge rejection, legacy/malformed old-bridge messages
  produce actionable plugin guidance before UI effects, reconnect cancels cards/orphaned queued starts without paid
  replay, and fresh plugin instances attach the authoritative active/idle session. History requests carry that same
  transient intent identity, so late responses cannot steal a newer view. Settings completion is captured-owner fenced.
- `npm run smoke -w bridge` now always launches its own bundled bridge with an in-worktree isolated home, free port,
  Haiku/low, four-turn/$0.10 limits and cleanup; it has no external-target mode. Policy tests reject normal/external
  homes and binaries. Final default owned smoke passed with v1/v2 rejection, prior lifecycle assertions, 33,448
  persisted tokens and $0.022557 reported cost; owned fixture/process cleanup was verified. First post-v3 run timed out only because final idle proof still awaited removed
  `busy` replay; fixture cleanup succeeded, assertion now reads authoritative connection snapshot, and rerun passed.
- PR feedback repairs and ordinary-flow fixtures bring Step 2 to 2,323 changed lines, 823 above the accepted
  1,500-line soft cap. Latest growth is protocol/reconnect safety plus mandatory self-contained smoke isolation;
  moving either implementation or its focused proof would publish an unsafe intermediate. Splitting would publish the provider seam
  with known activity, view/card, accounting, warm-start, handshake, parser, catalog, display, or smoke regressions,
  so the coherent repair stays with its proof rather than shipping a broken intermediary.

## Qualification gates before user-facing Codex exposure

- [ ] Qualified Codex version and reproducible consumed protocol contracts.
- [ ] Effective profile: notes writes, app-source reads, app-source write denial, explicit scoped approvals.
- [ ] No inherited unrelated MCP/apps/hooks/subagents/network tools or credential copying.
- [ ] All five Figma tools including actual image interpretation, long human questions and annotation policy.
- [ ] Native history replays answers/tool activity after restart and resumes the same provider context.
- [ ] Mid-turn model/effort update, steering and Stop preserve the existing UX.
- [ ] Native dollar estimates work on required auth/model routes, or the user explicitly decides a trustworthy fallback.
- [x] Step 2 automated legacy migration fixtures and bounded synthetic Claude smoke pass.
- [ ] Final matrix still requires a real pre-Step-2 workspace plus real Figma verification of legacy
  settings/instructions/history/cost behavior; Step 2 fixture proof does not close that qualification.
- [ ] Packed npm bin, stable plugin installation/upgrade refresh and provider-correct startup work for both.

## Review

Initial plan: **APPROVED**, no architectural violations, read-only `medium-intelligence-fast` run
`3e87c9a5-fb51-40bd-aa8b-885be5fac3cd`. Pre-review gate passed; general Section A applied to this TypeScript repo;
unrelated monorepo Section B workspace diagrams/layers skipped. Runtime qualification remains pending.

Later `a359823` packaging-baseline reconciliation was parent-reviewed only; it preserves the current install flow
and adds artifact verification without changing provider architecture. Do not describe that revision as separately
approved by the subagent.

Step 2 first architecture implementation review: **REJECTED** with six valid in-scope findings. Fixes are applied and
validated locally. PR #2 automated feedback produced the consolidated dispositions below; parent owns final review/merge.

| Review comment ID(s) | Disposition |
| --- | --- |
| 3980456850, 3980527912 | Fixed: conversation-owned activity drives start/send/terminal/reconnect busy state. |
| 3980456864, 3980527945 | Fixed: missing Codex is provider-scoped; live Claude health is not globally failed. |
| 3980528015 | Fixed: settings diff by provider; no-op/unrelated changes do not dispose/re-prewarm Claude. |
| 3980456871, 3980527936, 3980527887 | Fixed together: ephemeral start intent owns confirmation/queue; stale start/session and History cannot drain wrong input. |
| 3980527918 | Fixed: actual New/History-row replacement cancels cards/native ownership; browsing/dismissing list preserves session. |
| 3980527926 | Fixed: immutable usage/cost baselines; SDK/native per-turn usage and cumulative cost proven. |
| 3980527845 | Fixed: warm entry identity fences replaced callbacks; dispose resets runtime truthfully. |
| 3980527897 | Fixed: protocol validates/rejects directly before healthy client replacement. |
| 3980959989, 3980960008, 3980974613 | Fixed: protocol v3 connection ack plus guarded inbound decoding gives safe bidirectional mismatch guidance. |
| 3980960002, 3980960012, 3980974625, 3980960024 | Fixed together: snapshot reconciles cards, orphaned startup, queue cancellation, busy state, and fresh-plugin attach under one intent/view owner. |
| 3980974673 | Fixed: History open/response reuse ephemeral intent identity; superseded response is discarded. |
| 3980974649 | Fixed: apply-settings completion/error commits only to captured current conversation. |
| 3980974662 | Fixed: smoke owns isolated bridge/home/port and bounded settings; policy rejects normal/external targets. |
| 3980974679 | Fixed: removed stale patch pin; evidence names lock-resolved SDK 0.3.263. |
| 3980974690 | Fixed: tautological History-toggle assertion removed; browse/dismiss wiring is code-audited, not claimed as DOM/Figma execution. |
| 3980527811 | Fixed: provider tag validates before malformed-record filtering. |
| 3980527957 | Fixed: exported neutral Figma descriptions and Zod schemas feed Claude and next Codex adapter. |
| 3980527987 | Fixed: per-response text-block indices suppress unmatched non-text `text_end`. |
| 3980527855 | Fixed: smoke snapshots provider/session and resets/asserts follow-up text by turn. |
| 3980527867 | Fixed: unexpected smoke tools receive error results and fail immediately. |
| 3980527972 | Fixed: Step 2 fixture proof and still-open real-workspace/Figma gate are separate. |
| 3980527998 | Fixed: status names parent final review/merge, not pending independent review. |
| 3980528006 | Fixed: parent audit count reconciled to five issues.

## Retirement

Required: cumulative L4 and the exact provider/platform/auth/Figma/persistence matrix in PLAN.md. Both backends
must pass user-facing parity. Partial, blocked, failed or unexecuted required coverage keeps this plan active.
Target evidence: `docs/regression/results/codex-support.md`. Matrix reductions require explicit user acceptance.
