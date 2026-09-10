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
- Foundation current diff is 1,532 changed lines (1,450 additions, 82 deletions), within the 1,500-line cap. `npm ci`, legacy workspace checks, focused mocked Claude adapter
  checks, both builds and `git diff --check` pass. Tests cover exact tool description strings, selected parameter
  metadata, representative schema cases and source-audited legacy catalog reuse;
  warm settings/boundary identity, replacement/consume/cold fallback/dispose/stale fencing; serialized settings,
  rollback and fail-closed behavior; init MCP fallback; safe UUID transcript projection; normalized stream identity;
  cumulative response/per-turn usage; and invalid/recovered immutable cost. No legacy wire/UI/session schema changed;
  no paid/native turn was run for deterministic dormant-adapter fixes.

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

PR #3 current-head findings and local dispositions:

| Review comment IDs | Disposition |
| --- | --- |
| 3981475303, 3981525719, 3982209348 | Fixed at warm-entry identity: immutable file/dir/settings match, safely rebound boundary delegate, stale consumed/replaced/disposed results fenced; sync close failures handled and consume-throw resource closed before cold fallback; completed prepare error clears only at owned no-warm retry, with readiness left to initialized output; mocked lifecycle paths covered. |
| 3981475321, 3981525731 | Fixed: session-owned effective settings, serialized updates, rollback after partial failure, fail-closed session on rollback failure; closed send rejects and closed interrupt settles without native control; Stop stays independent. |
| 3981475312, 3981525775 | Fixed: normalized init MCP snapshot survives refresh rejection and failure is logged. |
| 3981525724, 3981525785 | Fixed: UUID-only native IDs before path construction; one SDK-free transcript leaf serves legacy wrapper and adapter, preserving filtering/interruption/trailing lines. |
| 3981525740, 3982209342 | Fixed: invalid native cost preserves known amount unavailable; valid cumulative value is exact base+native while explicit fresh/resume provenance retains reported/estimated/unavailable historical confidence. |
| 3981525759 | Fixed: released descriptions and hints restored exactly; representative schemas tested and legacy catalog reuse source-audited through unchanged old tool/reply flow. |
| 3981834685 | Fixed: copied allow-list joins warm immutable key and same operation snapshot feeds options; real fixture edits replace prepare cache and force current cold start. |
| 3981834697 | Fixed: one active-turn identity makes idle/failed/late Stop safe and clears old ownership before result yields; native starts and suspended iterator covered. |
| 3981834703 | Fixed: MCP refresh has cleaned 1s deadline; timeout keeps init fallback, does not block following output, and safely observes late rejection. |
| 3981805798 | Fixed: ordinary native user array text projects with context stripping; mixed image/non-question tool result stays hidden. |
| 3981805806 | Fixed: proof wording limited to exact descriptions, selected metadata, representative schemas and source audit. |
| 3981805787 | Declined with parent native evidence: inspected 13 app-scoped JSONL transcripts contain no native `result` rows; persisted assistant text is already projected. No synthetic format invented pending an actual supported native shape. |
| 3982009538, 3982069529 | Fixed: repeated Stop is idempotent while active turn already carries interruption intent; first failure still clears for retry. |
| 3982069514 | Declined: exact allow-list order is conservative native-input invalidation; safe close behavior is proven and no latency evidence warrants semantic normalization. |
| 3981525734 | Fixed: narrow injectable Claude-native factory; mocked prepare/start/session iteration, lifecycle, MCP and settings paths; owned temp roots auto-clean. |
| 3981525766, 3981525781 | Fixed: usage/cost documented as replacement cumulative session snapshots; transport/native-session qualification refs corrected to Steps 4/5. |

## Retirement

Required: cumulative L4 and the exact provider/platform/auth/Figma/persistence matrix in PLAN.md. Both backends
must pass user-facing parity. Partial, blocked, failed or unexecuted required coverage keeps this plan active.
Target evidence: `docs/regression/results/codex-support.md`. Matrix reductions require explicit user acceptance.
