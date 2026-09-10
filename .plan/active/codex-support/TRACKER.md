# Codex support tracker

Plan: [PLAN.md](PLAN.md). Scope: full user-facing parity on Claude and Codex; Codex-native sandboxed file/command
access approved. The user authorized executing the whole series: automatically squash-merge each PR once ready
for human review and continue without waiting for manual merges. Full verification and parity gates still apply.
Plan PR: https://github.com/sesori-ai/sesori-figma-review/pull/1.

## Fixed PR series

| Step | Exact title | State |
| --- | --- | --- |
| 1 | 🌱 [codex-support] Record full-parity design and acceptance matrix [step 1/8] | Squash-merged as `232048a` (PR #1); initial plan architecture review approved |
| 2 | ⚙️ [codex-support] Stage provider contracts and Claude adapter [step 2/8] | Implemented and verified locally on `codex-support-foundations`; pending parent publication |
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
  Released `UpMsg`/`DownMsg`/`Health`/`Settings`/`SessionRecord`, bridge flow, plugin UI and protocol remain active and
  unchanged. This slice does not expose Codex, migrate persistence, or claim new UI/protocol behavior.
- Step 3 activation must retain valid checkpoint fixes: provider-scoped health/settings; immutable request/session
  ownership; protocol v3 mixed-version guidance; single connection/view intent for start/reconnect/History/cards;
  file-scoped close; settings-await fencing; normalized block identity/usage/cost; and self-owned bounded smoke.
- Historical checkpoint smokes used authorized existing Claude sign-in, Haiku/low, isolated homes/free ports,
  four-turn/$0.10 limits and no credential/config copying. They prove preserved intent, not this dormant foundation.
  Later live tests retain those rules. Codex tests use cheapest suitable catalog-reported image/tool-capable model and
  low effort; ask before premium/high-effort exceptions.
- Foundation diff is 720 changed lines (688 additions, 32 deletions), within the cap and leaner than the rough
  750–1,000 estimate without omitted proof. `npm ci`, workspace checks, focused Claude adapter check, both builds and `git diff --check` pass. Tests cover
  neutral tool schemas/models, interface conformance, dispose health, native transcript filtering, provider-qualified
  stream/tool mapping, text-only block lifecycle, cumulative response deltas, per-turn results and immutable resumed
  cost. No live bridge/plugin file or legacy wire type changed; no paid/native turn was run for dormant wiring.

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

## Retirement

Required: cumulative L4 and the exact provider/platform/auth/Figma/persistence matrix in PLAN.md. Both backends
must pass user-facing parity. Partial, blocked, failed or unexecuted required coverage keeps this plan active.
Target evidence: `docs/regression/results/codex-support.md`. Matrix reductions require explicit user acceptance.
