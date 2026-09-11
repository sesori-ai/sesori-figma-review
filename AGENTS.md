# AGENTS.md

Sesori Review: a Figma plugin plus a local bridge that runs the Claude Agent SDK. [README.md](README.md) is
what it does, [ARCHITECTURE.md](ARCHITECTURE.md) how the pieces fit, [PLAN.md](PLAN.md) the decisions behind it.

## Layout

- `plugin/` — Figma sandbox (`src/code.ts`) and UI iframe (`src/ui.ts`, `src/ui.html`), bundled by `plugin/build.mjs`.
- `bridge/` — WebSocket server and Agent SDK session manager; `src/providers/` holds the per-provider adapters.
- `shared/protocol.ts` — the wire protocol. Both sides of a protocol change belong in the same PR.
- `docs/` — Figma Community listing copy, Codex configuration.

## Working here

- `npm run check` (type-check plus the sandbox, UI and bridge self-checks) passes before a PR goes up. `npm run build`
  produces `plugin/dist/` and `bridge/dist/bridge.mjs`; neither is committed.
- Checks live next to the code they cover (`*.check.ts`, or `*.check.mjs` where there is nothing to compile) and run
  from `npm run check`. Non-trivial logic gets one; one-liners do not.
- `ponytail:` comments mark deliberate shortcuts and name the upgrade path. Keep them accurate and keep
  ARCHITECTURE.md's "Known shortcuts" list in sync.
- The bridge version comes from the root `package.json`, the plugin's from `plugin/package.json`, and the panel shows
  a notice when they differ. Never move one without the other — `npm run bump` moves all three.

## Changelog

- Always update `CHANGELOG.md` in the same PR as every change, including documentation and agent instructions. Add a
  concise, factual entry under `[Unreleased]` in the appropriate category (`Added`, `Changed`, `Fixed`); do not defer
  it until release or a follow-up PR.

## Building / releasing

- `npm run bump <X.Y.Z>` writes the version into the three `package.json` files and the lockfile and cuts
  `[Unreleased]` into a `[X.Y.Z]` section. Commit it as `Release vX.Y.Z`, then push an annotated `vX.Y.Z` tag.
- The tag is what publishes. `.github/workflows/publish.yml` checks the tag against the manifests, extracts the
  changelog section, runs `npm run check`, `npm publish --access public`, and opens a GitHub Release with that
  section. npm auth is trusted publishing over OIDC, so no token lives here; the one-time setup is npmjs.com →
  `@sesori/figma-review` → Settings → Trusted publisher → this repo, workflow `publish.yml`.
- The Figma plugin is published by hand from the Figma desktop app (import `plugin/manifest.json` → Publish new
  version, then Figma reviews it) — there is no API for it. The `id` in that manifest is the
  [Community listing](https://www.figma.com/community/plugin/1680238164100658906/sesori-review); its copy and assets
  are `docs/community-listing.md` and `plugin/assets/`.
