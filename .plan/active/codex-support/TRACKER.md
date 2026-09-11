# Codex support tracker

Plan: [PLAN.md](PLAN.md). Scope: full user-facing parity on Claude and Codex; Codex-native sandboxed file/command
access approved. The user authorized executing the whole series: use automatic GitHub reviews only, automatically squash-merge each
PR once ready for human review, and continue without manual review requests or extra review-completion gates. Full
verification and parity gates still apply.
Plan PR: https://github.com/sesori-ai/sesori-figma-review/pull/1.

## Fixed PR series

| Step | Exact title | State |
| --- | --- | --- |
| 1 | 🌱 [codex-support] Record full-parity design and acceptance matrix [step 1/8] | Squash-merged as `232048a` (PR #1); initial plan architecture review approved |
| 2 | ⚙️ [codex-support] Stage provider contracts and Claude adapter [step 2/8] | Squash-merged as `ece1379d6768ecc032d6f030933034007d357910` (PR #3) |
| 3 | 🚧 [codex-support] Activate normalized review workflows [step 3/8] | Squash-merged as `b2b81e7d06b50f19141f4ab46b75628e402b557c` (PR #4); reviewed head `80707c2`, merge tree identical |
| 4 | 🚧 [codex-support] Add qualified Codex transport and execution policy [step 4/8] | Local correction/deterministic proof complete; native startup passes version/account/model/profile gates, but effective config rejects non-isolated inherited MCP state, so qualification remains blocked and enforcement was not run |
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

## Step 3 receipt

- PR #4 is squash-merged as `b2b81e7d06b50f19141f4ab46b75628e402b557c`; reviewed head `80707c2` and merge
  trees were verified identical (`5bb1f96b317f1b68e73c5963a2f118077f0f4afc`). Step 4 started from that clean
  fetched `origin/master` checkpoint.
- Publication/review coordination uses automatic GitHub reviews only. Parent owns all GitHub actions and merges;
  implementation checkpoints do not wait for manual review requests.

## Step 2 replacement foundation

- Predecessor receipt confirmed: PR #3 squash-merged as `ece1379d6768ecc032d6f030933034007d357910`; Step 3 started from fetched `origin/master` at that commit.
- Full older cutover reference stays at `origin/codex-support-step-2` (`f7265eb`); superseded PR #2 was not merged.
- Dormant foundation adds normalized contracts, neutral tools and Claude tests; released bridge/workspace/selfcheck stay
  byte-identical to master, with catalog/history reuse adapter-only.
- Step 3 retains all ownership, protocol, view, close, settings, accounting, smoke and qualification obligations below,
  plus exact legacy catalog/history adoption, legacy SDK removal and the UUID integration assertion.
- The `9bf1067` Step 3 live smoke used Claude Haiku/low, owned home, OS-assigned non-3055 ports and four-turn/$0.10
  limits. It proved steering, Stop/cards, reconnect/history, resumed-only output, 3 turns/$0.0248175 and cleanup.
  Follow-up queue/history/transport/smoke-lifetime fixes use deterministic proof only; no second paid smoke was run.
- First Step 3 review disposition: accepted provider-change derivation, handshake admission, and production-seam
  evidence findings. Qualified the settings finding: actual Claude disposal broadcasts health, so no outage was
  proven, but bridge-owned settled publication must not rely on that adapter callback. Parent also required pending-start/fresh
  attachment history and terminal ownership fixes. Deterministic tests now use ordinary dependency injection through
  the production receive/onUp/pump paths. Actual bundled-UI admission/history/settings/card/replay fixes and explicit
  bridge-owned settled-settings publication are now covered; fresh independent review remains pending.
- Recovery addendum authority supersedes historical grant `c24ec6fb-d7df-4e86-8334-cbe7fd8b43ba` for Step 3 only:
  hard ceiling 2,975, preferred <=2,970, for attached-History/final smoke cleanup and proof; later budgets are unchanged.
- **Historical `cfe0ec8`:** 1,532 lines, checks passing. Parent accepts up to 1,650 total lines only for existing
  foundation lifecycle/accounting/safety fixes and proof, never Step 3 scope; no paid/native fix turn was run.

## Step 4 local evidence

- Added lazy owned stdio lifecycle, bounded NDJSON framing, correlated client/server RPC, validated 0.154.0 consumed
  projections, and zero-turn readiness checks for exact version, supported auth, image/model efforts, profile presence,
  and effective config isolation.
- Bridge-built named policy grants workspace and optional `APP_REPO` reads, grants writes only to canonical `notes/`,
  disables command networking and unrelated apps/plugins/MCP/hooks/subagents/web tools, and routes eligible approvals
  to the user. Unsafe, merged, or unqualified configuration fails closed.
- Codex workspace provisioning is explicit: create-once `AGENTS.md` seeded from existing instructions, bridge-owned
  `.agents/skills/review-flow/SKILL.md` refresh, and symlink/path safety checks. Existing user files stay unchanged.
- Deterministic fake-child/static fixtures cover split/coalesced frames, bidirectional RPC, typed malformed responses,
  stderr, timeouts, exit/EOF/disposal, line bounds, unsupported requests, config leakage, and workspace preservation.
  These fixtures do not prove native sandbox enforcement, real auth/model behavior, or Figma.
- An exactly bounded native probe was approved and attempted once. The 0.154.0 App Server candidate closed stdout
  before returning `initialize`; no account/model/profile/config result was consumed. Per fail-closed approval, the
  worker did not retry or run Part 2 enforcement. The driver also reported `kill EPERM` while checking the detached
  process group after stdout closure; an exact fixture-path process scan found no remaining match, but the owned
  fixture was retained in the run artifact output because exit ownership was not observed strongly enough to authorize
  deletion.
- One separately approved diagnosis used unchanged production policy and only attempted `initialize`. It observed
  zero stdout bytes, 98 bounded stderr bytes, natural exit `1` with no signal, no response/`initialized`, and no child
  descendants. Sanitization classified a semantic invalid config value but found no safe matching policy key or CLI
  flag. The unique diagnostic fixture was deleted only after observing child exit; no retry or enforcement ran.
- Schema-backed follow-up identified the semantic defect in bridge-owned overrides. Codex 0.154.0 applies CLI keys
  by splitting every `.`; quoted dynamic filesystem paths therefore became nested path segments, while the schema
  requires flattened filesystem path keys. The bridge now supplies the complete named profile as one inline TOML
  table, keeping dynamic paths inside the value. Deterministic regression proof rejects filesystem dotted-key args.
- Correction-confirmation start 2 passed initialize, exact 0.154.0 version, supported account, bounded image-model,
  and named-profile gates, then failed closed during effective `config/read` isolation because active MCP state was
  not limited to the bridge-owned Figma server. Raw account/config data was not retained. Codex deep-merges config
  tables and exposes no schema-backed global MCP disable/replace switch; safely clearing arbitrary inherited server
  names through known per-process settings is therefore unavailable. No third start or Part 2 enforcement ran.
- Start 2 ended by observed App Server `SIGTERM`; its diagnostic counted six previously observed descendants and
  conservatively marked cleanup uncertain even though the post-run fixture-path scan found no match. Per approval,
  fixture `.tmp/codex-step4-config-4859cc40-c2c5-4389-9a9d-11a30f4977eb` remains in its original location.
- Separate process note: accidental unapproved `codex sandbox macos --help` was parsed as a sandbox invocation, not
  static inspection. It failed before requested executable `macos` launched with exact error
  `sandbox-exec: execvp() of 'macos' failed: No such file or directory` and exit `71`. No side effects were observed;
  it provides no enforcement qualification. `0.154.0` remains a schema/protocol candidate, not native support.

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
