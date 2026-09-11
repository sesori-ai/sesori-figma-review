# Figma Community listing

Live at <https://www.figma.com/community/plugin/1680238164100658906/sesori-review> (plugin `id` in `plugin/manifest.json`).

Copy for the Community page. Figma's description field is rich text: headings, bold, bullet lists and links paste from this file.

## Name

Sesori Review

## Tagline

Design review with Claude, screen by screen, inside Figma

## Description

**A senior reviewer that walks your prototype with you.**

Sesori Review reads your prototype flow, then goes through it one screen at a time. It moves your canvas to the frame it is talking about, tells you what would block a developer, asks before it assumes, and writes the answers into Dev Mode annotations. You end the session with a design that is ready to hand off, not a report to act on later.

**What it does**

- **Reviews the flow first.** Entry points, main path, branches, dead ends, screens with no way back.
- **Then every screen.** Missing loading, empty and error states. Unclear interactions. Inconsistent spacing and tokens. Accessibility gaps. At most five findings per screen, sorted by impact.
- **Follows you on the canvas.** Every screen is focused before it is discussed. You never hunt for the frame it means.
- **Asks at the right spot.** Questions arrive as cards with options, with the canvas already on the node in question.
- **Leaves dev-ready annotations.** What, behaviour, states, tokens, edge cases, on the node they apply to. Appended to what is there, never overwriting your notes.
- **Answers questions.** Select anything and ask. Your selection travels with every message.

**Your account, your machine**

The plugin talks to a small bridge running on your computer, which runs Claude through the Claude Agent SDK with your own Claude Code login or Anthropic API key. Nothing goes through Sesori servers. You choose the model and effort in the plugin and see the cost of every session in the header.

**Setup, once**

1. Install Node 22 or newer.
2. In a terminal: `npm install -g @sesori/figma-review`
3. Start the bridge and keep the terminal open: `sesori-figma-review`
4. Sign in to Claude Code (`claude`) or set `ANTHROPIC_API_KEY`.

Then open any file and run Sesori Review. Full guide: https://github.com/sesori-ai/sesori-figma-review

**Good to know**

- Figma desktop app only. The browser version cannot reach a local process.
- Dev Mode annotations need a paid Figma plan. Everything else works on free files.
- Turn on Figma's desktop MCP server (Dev Mode → inspect panel) to give the reviewer variables, component properties and code. It works without it.
- Open source under Apache 2.0. Issues and ideas: https://github.com/sesori-ai/sesori-figma-review/issues

## Tags

design review, dev mode, annotations, handoff, prototype, accessibility, AI, Claude

## Assets

- Icon: `plugin/assets/icon-128.png`
- Cover: `plugin/assets/cover-1920x960.png`

## Support

- Support contact: the sesori-ai GitHub issues page, plus an email of your choice.
- Network access reasoning is in `plugin/manifest.json`.
