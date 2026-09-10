# Changelog

## 0.3.0 — 2026-09-10

- Published as **`@sesori/figma-review`**: `npm install -g @sesori/figma-review` then `sesori-figma-review` (or `npx -y @sesori/figma-review`) starts the bridge, copies the plugin to `~/.sesori-review/plugin/` and prints the manifest path to import into Figma.
- Bridge is bundled to `bridge/dist/bridge.mjs`; dependencies hoisted to the root package.
- Bridge start hints when no Claude credentials are found.
- Plugin re-attaches to its conversation after a bridge restart. Reopening the plugin while Claude is idle shows the empty state instead of a stuck Stop button; the last conversation is in History.
- README rewritten around the quick start.
- Product name is **Sesori Review** (Figma Community does not allow "Figma" in plugin names); the npm package stays `@sesori/figma-review`.
- Offline card in the panel with the install and start commands and Copy buttons; a notice when the plugin is opened in the browser version of Figma, and one when plugin and bridge versions differ.
- The SDK's permission-shadowing warning is silenced (the auto-approve list is intended).

## 0.2.0 — 2026-09-10

- Renamed to **Sesori Figma Review**; new icon, mark and cover art (`plugin/assets/`). Workspaces now live in `~/.sesori-review/`.
- New UI: brand header with status and live cost, empty state, readable tool chips, typing indicator, cards, composer.
- Model and effort are picked in the plugin (⚙) and apply to the running session; no more bridge environment variables.
- While Claude asks a question, the card is the only place to answer (composer hidden).
- History → **Open** shows the past conversation; the next message resumes the session.
- Live token counter, Stop chip, annotations append by default, auto-approve list in `permissions.json`.

## 0.1.0

- First internal POC: plugin + bridge, guided flow review, ask_user cards, Dev Mode annotations.
