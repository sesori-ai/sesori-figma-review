# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added test-client Codex bridge composition and native session/replay support behind existing provider selection.
- GitHub Releases attach a built `sesori-review-plugin-vX.Y.Z.zip` for manual Figma installation, including the manifest, sandbox/UI bundles, README and license. `npm run package:plugin` builds it locally; packaging checks cover archive layout, version agreement, missing inputs and clean reruns. Release retries rebuild and replace the asset even when npm publishing is skipped.

### Changed

- Codex keeps verified token usage while reporting Cost unavailable when its supported native API omits USD.
- Codex now pins required permission/settings capabilities and confirms queued future settings.
- Quick start and the bridge banner recommend importing the plugin already bundled with npm while Figma Community review is pending. Manual setup docs cover the stable manifest path, standalone release ZIPs, matching bridge versions, and the different update steps for bridge-managed, ZIP and Community installs.
- Architecture and contributor docs describe manual-install release assets and the `zip`/`unzip` tooling used to package and check them.

### Fixed

- Codex approvals now confine writes to notes and reject network escalation; session preparation, history, accounting, terminal recovery,
  malformed items, spawn retirement, and startup credential warnings remain safe across asynchronous races and invalid inputs.

## [0.3.2]

### Added

- `npm run bump-and-release <X.Y.Z>` cuts a release in one command: from a clean `master` that matches origin it bumps the version, runs `npm run check`, commits `Release vX.Y.Z` and pushes that commit and an annotated `vX.Y.Z` tag atomically, leaving the publish to `publish.yml`. It refuses an unclean tree, a branch other than `master`, a `master` out of sync with origin, and a tag that already exists, all before writing anything; a check or a push that fails after that point prints the command that finishes or undoes the release.

### Changed

- `.gitignore` covers `.worktrees/`, so a `git worktree` created under the repository root does not show up as untracked in the main checkout.
- `npm run bump` prints only the manual commit, tag and push path, and stays silent about it when `bump-and-release` is the caller.
- AGENTS.md and README.md document `npm run bump-and-release` as the way to release, and AGENTS.md records that the npm trusted publisher needs **Allowed actions → allow `npm publish`**: npm defaults a new connection to staged publishing only, which `publish.yml` does not use, and a connection cannot be edited afterwards.

## [0.3.1]

### Added

- The plugin is on the [Figma Community](https://www.figma.com/community/plugin/1680238164100658906/sesori-review). Installing it no longer needs the manifest import; the bridge start banner points at the listing and keeps the manifest path for running from source.
- `plugin/manifest.json` carries the Community plugin `id`, so updates publish from this repo.
- `npm run bump <X.Y.Z>` writes the version into the three `package.json` files and the lockfile, then cuts the `[Unreleased]` section under that version. It refuses what cannot become a release: a version older than the current one, an empty `[Unreleased]`, and entries stranded there after that version was already cut.
- Pushing a `vX.Y.Z` tag publishes the npm package: `.github/workflows/publish.yml` checks the tag against the manifests, runs `npm run check`, publishes with provenance through npm trusted publishing (OIDC, no token stored in the repo) and opens a GitHub Release carrying that version's changelog section.
- `AGENTS.md` holds the repository conventions, including the rule that every PR updates this changelog; `CLAUDE.md` points at it.

### Changed

- The plugin copy, settings and per-file workspaces live under `$XDG_DATA_HOME/sesori-figma-review` (default `~/.local/share/sesori-figma-review`, and the default is also used when `XDG_DATA_HOME` is relative, which the XDG spec calls invalid) instead of `~/.sesori-review`. `SESORI_REVIEW_HOME` still overrides it; there is no migration of an existing `~/.sesori-review`, and a plugin imported from the old path has to be re-imported from the new one (or installed from the Community).

## [0.3.0]

- Published as **`@sesori/figma-review`**: `npm install -g @sesori/figma-review` then `sesori-figma-review` (or `npx -y @sesori/figma-review`) starts the bridge, copies the plugin to `~/.sesori-review/plugin/` and prints the manifest path to import into Figma.
- Bridge is bundled to `bridge/dist/bridge.mjs`; dependencies hoisted to the root package.
- Bridge start hints when no Claude credentials are found.
- Plugin re-attaches to its conversation after a bridge restart. Reopening the plugin while Claude is idle shows the empty state instead of a stuck Stop button; the last conversation is in History.
- README rewritten around the quick start.
- Product name is **Sesori Review** (Figma Community does not allow "Figma" in plugin names); the npm package stays `@sesori/figma-review`.
- Offline card in the panel with the install and start commands and Copy buttons; a notice when the plugin is opened in the browser version of Figma, and one when plugin and bridge versions differ.
- The SDK's permission-shadowing warning is silenced (the auto-approve list is intended).

## [0.2.0]

- Renamed to **Sesori Figma Review**; new icon, mark and cover art (`plugin/assets/`). Workspaces now live in `~/.sesori-review/`.
- New UI: brand header with status and live cost, empty state, readable tool chips, typing indicator, cards, composer.
- Model and effort are picked in the plugin (⚙) and apply to the running session; no more bridge environment variables.
- While Claude asks a question, the card is the only place to answer (composer hidden).
- History → **Open** shows the past conversation; the next message resumes the session.
- Live token counter, Stop chip, annotations append by default, auto-approve list in `permissions.json`.

## [0.1.0]

- First internal POC: plugin + bridge, guided flow review, ask_user cards, Dev Mode annotations.
