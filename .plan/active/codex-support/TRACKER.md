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

- Full reviewed implementation remains immutable at `origin/codex-support-step-2` commit `f7265eb`. Oversized PR #2
  (https://github.com/sesori-ai/sesori-figma-review/pull/2) was closed as superseded, not merged or abandoned.
- Foundation boundary: additive provider-neutral IDs/refs/events/health/model/cost contracts, provider interfaces,
  neutral Zod Figma catalog, complete dormant Claude adapter, and focused adapter/history/stream/accounting tests.
  Released `UpMsg`/`DownMsg`/`Health`/`Settings`/`SessionRecord`, plugin UI and protocol remain active and unchanged.
  Approved stateless reuse makes legacy bridge tools consume the exact neutral catalog and makes legacy history call
  the shared Claude transcript leaf; metadata/output stay identical while unsafe non-native IDs now reject. This
  slice does not expose Codex, migrate persistence, or claim new UI/protocol behavior.
- Step 3 activation must retain valid checkpoint fixes: provider-scoped health/settings; immutable request/session
  ownership; protocol v3 mixed-version guidance; single connection/view intent for start/reconnect/History/cards;
  file-scoped close; settings-await fencing; normalized block identity/usage/cost; and self-owned bounded smoke.
- Historical checkpoint smokes used authorized existing Claude sign-in, Haiku/low, isolated homes/free ports,
  four-turn/$0.10 limits and no credential/config copying. They prove preserved intent, not this dormant foundation.
  Later live tests retain those rules. Codex tests use cheapest suitable catalog-reported image/tool-capable model and
  low effort; ask before premium/high-effort exceptions.
- **Verified checkpoint (`cfe0ec8`):** 1,532 changed lines (1,450 additions, 82 deletions). Parent accepted this
  32-line soft-cap tail for final cost-provenance/health fixes and regression proof. `npm ci`, legacy workspace
  checks, focused mocked Claude adapter checks, both builds and `git diff --check` pass. Tests cover exact tool description strings, selected parameter
  metadata, representative schema cases and source-audited legacy catalog reuse;
  warm settings/boundary identity, replacement/consume/cold fallback/dispose/stale fencing; serialized settings,
  rollback and fail-closed behavior; init MCP fallback; safe UUID transcript projection; normalized stream identity;
  cumulative response/per-turn usage; invalid/recovered immutable cost; and fail-closed optional turn/budget limits
  before native dispatch. No legacy wire/UI/session schema changed; no paid/native turn was run for deterministic
  dormant-adapter fixes.

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
