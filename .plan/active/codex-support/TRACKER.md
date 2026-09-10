# Codex support tracker

Plan: [PLAN.md](PLAN.md). Scope: full user-facing parity on Claude and Codex; Codex-native sandboxed file/command
access approved. The user authorized executing the whole series: automatically squash-merge each PR once ready
for human review and continue without waiting for manual merges. Full verification and parity gates still apply.
Plan PR: https://github.com/sesori-ai/sesori-figma-review/pull/1.

## Fixed PR series

| Step | Exact title | State |
| --- | --- | --- |
| 1 | 🌱 [codex-support] Record full-parity design and acceptance matrix [step 1/8] | Squash-merged as `232048a` (PR #1); initial plan architecture review approved |
| 2 | ⚙️ [codex-support] Stage provider contracts and Claude adapter [step 2/8] | Squash-merged as `ece1379d6768ecc032d6f030933034007d357910` (PR #3) |
| 3 | 🚧 [codex-support] Activate normalized review workflows [step 3/8] | Implementation reviews rejected two checkpoints; parent-qualified fixes implemented locally; fresh independent review required |
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

- Predecessor receipt confirmed: PR #3 squash-merged as `ece1379d6768ecc032d6f030933034007d357910`; Step 3 started from fetched `origin/master` at that commit.
- Full older cutover reference stays at `origin/codex-support-step-2` (`f7265eb`); superseded PR #2 was not merged.
- Dormant foundation adds normalized contracts, neutral tools and Claude tests; released bridge/workspace/selfcheck stay
  byte-identical to master, with catalog/history reuse adapter-only.
- Step 3 retains all ownership, protocol, view, close, settings, accounting, smoke and qualification obligations below,
  plus exact legacy catalog/history adoption, legacy SDK removal and the UUID integration assertion.
- Step 3 live activation smoke used Claude Haiku/low, isolated home/free port and four-turn/$0.10 process limits.
  It proved busy steering through a question card, Stop cancellation, idle reconnect, native history, and nonzero
  cumulative usage/cost after resume through a recreated bridge/query process.
- First Step 3 review disposition: accepted provider-change derivation, handshake admission, and production-seam
  evidence findings. Qualified the settings finding: simple model→effort DOM edits were already correct, while stale
  health replacement and concurrent whole-document persistence were real. Parent also required pending-start/fresh
  attachment history and terminal ownership fixes. Deterministic tests now use ordinary dependency injection through
  the production receive/onUp/pump paths. Actual bundled-UI admission/history/settings/card fixes are now covered;
  fresh independent review remains pending.
- Parent approved a Step-3-only 2,250-line ceiling after review exposed additional UI lifecycle failures; readable
  bundled-`ui.ts` integration proof replaces helper-only proof. The exception does not apply to later steps.
- **Historical `cfe0ec8`:** 1,532 lines, checks passing. Parent accepts up to 1,650 total lines only for existing
  foundation lifecycle/accounting/safety fixes and proof, never Step 3 scope; no paid/native fix turn was run.

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
