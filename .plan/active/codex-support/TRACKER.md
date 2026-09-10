# Codex support tracker

Plan: [PLAN.md](PLAN.md). Scope: full user-facing parity on Claude and Codex; Codex-native sandboxed file/command
access approved. The user authorized executing the whole series: automatically squash-merge each PR once ready
for human review and continue without waiting for manual merges. Full verification and parity gates still apply.
Plan PR: https://github.com/sesori-ai/sesori-figma-review/pull/1.

## Fixed PR series

| Step | Exact title | State |
| --- | --- | --- |
| 1 | 🌱 [codex-support] Record full-parity design and acceptance matrix [step 1/8] | Squash-merged as `232048a` (PR #1); initial plan architecture review approved |
| 2 | ⚙️ [codex-support] Stage provider contracts and Claude adapter [step 2/8] | PR #3 feedback fixed/verified locally; pending parent push and current-head review |
| 3 | 🚧 [codex-support] Activate normalized review workflows [step 3/8] | Not started; coordinated activation from preserved checkpoint obligations |
| 4 | 🚧 [codex-support] Add qualified Codex transport and execution policy [step 4/8] | Not started |
| 5 | 🚧 [codex-support] Implement Codex review sessions and native replay [step 5/8] | Not started |
| 6 | ⚙️ [codex-support] Expose both providers with complete plugin workflows [step 6/8] | Not started |
| 7 | 🌿 [codex-support] Reconcile provider documentation and regression contracts [step 7/8] | Not started |
| 8 | ⚙️ [codex-support] Verify full parity and retire the plan [step 8/8] | Not started |

## Planning evidence

- Initial repository inspection at `516f2b5`; fast-forwarded to `a359823` before publication and inspected its
  packaging/startup/reconnect changes. Plan now preserves npm/npx distribution and adds packed-artifact proof.
- Located/read `sesori-plan-maker` and `sesori-plan-worker` in the sibling monorepo.
- Official App Server, SDK, configuration and permissions documentation inspected.
- Installed `codex-cli 0.154.0` experimental generated schema inspected, not hand-edited or committed.
- No live Codex/Claude turn, native security test, paid smoke, Figma test, or account/config modification performed
  during Step 1 planning.

## Step 2 replacement foundation

- Full implementation stays immutable at `origin/codex-support-step-2` commit `f7265eb`; oversized PR #2 was closed
  as superseded, not merged or abandoned.
- This dormant foundation adds normalized contracts, neutral validated tools, Claude adapter and focused tests. Legacy
  wire/UI/session schemas remain active; exact catalog and transcript-leaf reuse preserve metadata and output. Codex,
  persistence migration and new UI/protocol behavior remain excluded.
- Step 3 retains provider-scoped ownership/settings/health, protocol-v3 mismatch handling, one view intent, file-scoped
  close, settings fencing, normalized identity/accounting, and bounded smoke obligations.
- Historical smokes used Claude Haiku/low, isolated homes/free ports and four-turn/$0.10 limits. Later Claude/Codex
  tests retain the recorded credential, model and spend rules.
- **Historical checkpoint `cfe0ec8`:** 1,532 changed lines (1,450 additions, 82 deletions), with all checks passing.
  Parent accepts a standing foundation review-fix tail up to 1,650 total lines only for existing lifecycle,
  accounting and safety repairs plus proof, never Step 3 activation. Tests cover catalog/schema reuse, warm/cold
  lifecycle and init fencing, settings, MCP fallback, transcript/stream/accounting, and fail-closed env limits.
  No paid/native turn was run for deterministic dormant-adapter fixes.

## Qualification gates before user-facing Codex exposure

- [ ] Qualified Codex version and reproducible consumed protocol contracts.
- [ ] Effective profile: notes writes, app-source reads, app-source write denial, explicit scoped approvals.
- [ ] No inherited unrelated MCP/apps/hooks/subagents/network tools or credential copying.
- [ ] All five Figma tools including actual image interpretation, long human questions and annotation policy.
- [ ] Native history replays answers/tool activity after restart and resumes the same provider context.
- [ ] Mid-turn model/effort update, steering and Stop preserve the existing UX.
- [ ] Native dollar estimates work on required auth/model routes, or the user explicitly decides a trustworthy fallback.
- [ ] Legacy Claude settings, instructions, history, costs and behavior remain intact.
- [ ] Packed npm bin, stable plugin installation/upgrade refresh and provider-correct startup work for both.

## Review

Initial plan: **APPROVED**, no architectural violations, read-only `medium-intelligence-fast` run
`3e87c9a5-fb51-40bd-aa8b-885be5fac3cd`. Pre-review gate passed; general Section A applied to this TypeScript repo;
unrelated monorepo Section B workspace diagrams/layers skipped. Runtime qualification remains pending.

Later `a359823` packaging-baseline reconciliation was parent-reviewed only; it preserves the current install flow
and adds artifact verification without changing provider architecture. Do not describe that revision as separately
approved by the subagent. Closed PR #2 review findings remain obligations for Step 3 activation; neither its revised
code nor this replacement foundation has a new architecture-approval claim.

PR #3's authoritative resolved-finding record is its
[inline review discussion](https://github.com/sesori-ai/sesori-figma-review/pull/3); focused tests and Git history
preserve implementation proof without duplicating every reply here. Two deliberate non-actionable dispositions remain:

- `3981805787`: inspected native app-scoped JSONL evidence had no `result` rows; persisted assistant text is already
  projected. No unsupported synthetic history shape was invented.
- `3982069514`: exact allow-list order intentionally remains conservative native-option identity; safe replacement
  cleanup is proven and no latency evidence warrants semantic normalization.

## Retirement

Required: cumulative L4 and the exact provider/platform/auth/Figma/persistence matrix in PLAN.md. Both backends
must pass user-facing parity. Partial, blocked, failed or unexecuted required coverage keeps this plan active.
Target evidence: `docs/regression/results/codex-support.md`. Matrix reductions require explicit user acceptance.
