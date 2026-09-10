# Changelog

## 0.2.0 — 2026-09-10

- Renamed to **Sesori Figma Review**; new icon, mark and cover art (`plugin/assets/`). Workspaces now live in `~/.sesori-review/`.
- New UI: brand header with status and live cost, empty state, readable tool chips, typing indicator, cards, composer.
- Model and effort are picked in the plugin (⚙) and apply to the running session; no more bridge environment variables.
- While Claude asks a question, the card is the only place to answer (composer hidden).
- History → **Open** shows the past conversation; the next message resumes the session.
- Live token counter, Stop chip, annotations append by default, auto-approve list in `permissions.json`.

## 0.1.0

- First internal POC: plugin + bridge, guided flow review, ask_user cards, Dev Mode annotations.
