# Changelog

## 0.3.0 — 2026-09-10

- Published as **`@sesori/figma-review`**: `npx @sesori/figma-review` starts the bridge, copies the plugin to `~/.sesori-review/plugin/` and prints the manifest path to import into Figma.
- Bridge is bundled to `bridge/dist/bridge.mjs`; dependencies hoisted to the root package.
- Bridge start hints when no Claude credentials are found.
- Plugin re-attaches to its conversation after a bridge restart.
- README rewritten around the quick start.

## 0.2.0 — 2026-09-10

- Renamed to **Sesori Figma Review**; new icon, mark and cover art (`plugin/assets/`). Workspaces now live in `~/.sesori-review/`.
- New UI: brand header with status and live cost, empty state, readable tool chips, typing indicator, cards, composer.
- Model and effort are picked in the plugin (⚙) and apply to the running session; no more bridge environment variables.
- While Claude asks a question, the card is the only place to answer (composer hidden).
- History → **Open** shows the past conversation; the next message resumes the session.
- Live token counter, Stop chip, annotations append by default, auto-approve list in `permissions.json`.

## 0.1.0

- First internal POC: plugin + bridge, guided flow review, ask_user cards, Dev Mode annotations.
