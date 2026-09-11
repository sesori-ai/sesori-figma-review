# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `npm run bump <X.Y.Z>` writes the version into the three `package.json` files and the lockfile, then cuts the `[Unreleased]` section under that version.
- Pushing a `vX.Y.Z` tag publishes the npm package: `.github/workflows/publish.yml` checks the tag against the manifests, runs `npm run check`, publishes with provenance through npm trusted publishing (OIDC, no token stored in the repo) and opens a GitHub Release carrying that version's changelog section.
- `AGENTS.md` holds the repository conventions, including the rule that every PR updates this changelog; `CLAUDE.md` points at it.

## [0.3.1]

- The plugin is on the [Figma Community](https://www.figma.com/community/plugin/1680238164100658906/sesori-review). Installing it no longer needs the manifest import; the bridge start banner points at the listing and keeps the manifest path for running from source.
- `plugin/manifest.json` carries the Community plugin `id`, so updates publish from this repo.

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
