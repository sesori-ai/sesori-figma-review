# Codex support tracker

Plan: [PLAN.md](PLAN.md). Scope: full user-facing parity on Claude and Codex; Codex-native sandboxed file/command
access approved. The user authorized executing the whole series: automatically squash-merge each PR once ready
for human review and continue without waiting for manual merges. Full verification and parity gates still apply.
Plan PR: https://github.com/sesori-ai/sesori-figma-review/pull/1.

## Fixed PR series

| Step | Exact title | State |
| --- | --- | --- |
| 1 | 🌱 [codex-support] Record full-parity design and acceptance matrix [step 1/7] | Squash-merged as `232048a` (PR #1); initial architecture review approved |
| 2 | 🚧 [codex-support] Isolate Claude behind normalized review contracts [step 2/7] | Implemented and verified locally on `codex-support-step-2`; pending independent review/publication |
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
- Real Claude smoke passed with existing authorized sign-in, Haiku/low, synthetic focus request, three-turn and $0.10
  SDK bounds, isolated `SESORI_REVIEW_HOME`, and override port 43059. Result: one normalized streamed response, shared
  `focus` tool round trip, persisted provider/cost provenance, 22,605 tokens and positive $0.0046 reported cost on
  final integrated head (port 43060).
- Isolated startup/plugin-copy/protocol-mismatch fixture passed on port 43058. Port 3055 was already occupied and untouched.
  Owned fixture homes, logs, and bridge processes were removed. No login/global config was changed or copied.
- User explicitly authorized bounded existing Claude/Codex sign-ins and acknowledged Claude API charges for remaining
  required smoke/regression work. Future steps need not request this again; retain isolation, spend bounds and privacy.
- Independent implementation review remains required before Step 2 publication. No real Figma rendering claim is made.

## Qualification gates before user-facing Codex exposure

- [ ] Qualified Codex version and reproducible consumed protocol contracts.
- [ ] Effective profile: notes writes, app-source reads, app-source write denial, explicit scoped approvals.
- [ ] No inherited unrelated MCP/apps/hooks/subagents/network tools or credential copying.
- [ ] All five Figma tools including actual image interpretation, long human questions and annotation policy.
- [ ] Native history replays answers/tool activity after restart and resumes the same provider context.
- [ ] Mid-turn model/effort update, steering and Stop preserve the existing UX.
- [ ] Native dollar estimates work on required auth/model routes, or the user explicitly decides a trustworthy fallback.
- [x] Step 2 automated migration fixtures and bounded live Claude smoke preserve legacy settings/history/cost paths;
  cumulative final matrix still requires old real-workspace and Figma coverage.
- [ ] Packed npm bin, stable plugin installation/upgrade refresh and provider-correct startup work for both.

## Review

Initial plan: **APPROVED**, no architectural violations, read-only `medium-intelligence-fast` run
`3e87c9a5-fb51-40bd-aa8b-885be5fac3cd`. Pre-review gate passed; general Section A applied to this TypeScript repo;
unrelated monorepo Section B workspace diagrams/layers skipped. Runtime qualification remains pending.

Later `a359823` packaging-baseline reconciliation was parent-reviewed only; it preserves the current install flow
and adds artifact verification without changing provider architecture. Do not describe that revision as separately
approved by the subagent.

## Retirement

Required: cumulative L4 and the exact provider/platform/auth/Figma/persistence matrix in PLAN.md. Both backends
must pass user-facing parity. Partial, blocked, failed or unexecuted required coverage keeps this plan active.
Target evidence: `docs/regression/results/codex-support.md`. Matrix reductions require explicit user acceptance.
