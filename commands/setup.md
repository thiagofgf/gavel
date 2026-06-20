---
description: Check whether the Codex and Gemini CLIs are installed and authenticated for gavel
argument-hint: ""
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gavel.mjs" setup --json
```

Read the JSON report. It lists each provider under `providers.<name>` with `enabled`, `installed`,
`authed`, `usable`, `version`, `tooOld`, and `isolation`, plus top-level `ready`, `degraded`,
`missingProviders`, and `panel`. Then:

- For each provider that is **enabled but not installed** (`installed: false`) while `npm.available`
  is true, use `AskUserQuestion` **once** to ask which missing CLI(s) to install now (multi-select if
  both). Put installing first and suffix the label with `(Recommended)`. Install commands:
  - Codex: `npm install -g @openai/codex`
  - Gemini: `npm install -g @google/gemini-cli`
- The `agy-*` (Antigravity) providers are **not** npm-installable. They need the Antigravity desktop
  app, which ships the `agy` CLI (`agy install` adds it to PATH). If an `agy-*` provider is enabled
  but not installed, point the user to install Antigravity - do not offer npm for it.
- Run the chosen install command(s), then rerun the setup report.
- If npm is unavailable, don't offer to install — just report and point to the install docs.

Then present the final report, preserving guidance:
- If a provider is installed but not authenticated, give its auth step: Codex → run `!codex login`;
  Gemini → run `!gemini` once (OAuth) or `export GEMINI_API_KEY=…`; `agy-*` → sign in to the
  Antigravity app once (Google AI Pro), which authorizes `agy` for every `agy-*` model.
- If any provider has `tooOld: true`, warn that the installed CLI is older than the tested version and
  some required flags may be unsupported (suggest upgrading).
- A provider `disabled` in settings is intentionally skipped — do not nag about it.

Note: gavel needs **at least one** usable advisor (`ready: true`); a multi-model panel works best.
Codex explores the repo read-only; Gemini and the `agy-*` models run isolated. One Antigravity login
unlocks every `agy-*` model (Gemini 3.1 Pro, Claude Opus, and more). Model/timeout defaults and
per-provider settings live in `~/.gavel/config.json` or a project `./.gavel.json`.
