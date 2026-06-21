# gavel

Claude Code plugin that fuses the running Claude model with **OpenAI Codex**, **Google Gemini**,
**Antigravity (`agy`) models**, and **Grok Build (`grok`)** (one Antigravity login exposes several agy
models; grok runs on a SuperGrok login): `/gavel:fuse` asks the panel in parallel, Claude judges +
synthesizes one answer, then acts on it. Local CLIs only; synchronous (no background jobs).

## Layout
- `commands/` — slash commands (`fuse`, `ask`, `setup`, `config`); thin Claude-side wrappers.
- `scripts/gavel.mjs` — zero-dependency Node runner: a **provider registry** + config layer.
  Subcommands: `setup | run | fuse | config`.
- `skills/gavel-synthesis/SKILL.md` — the judge/synthesis contract.
- `.claude-plugin/` — `plugin.json` + `marketplace.json` (repo is its own single-plugin marketplace).

## How fuse works
Runs in the main Claude context. Claude is **panelist #3 + judge + actor**. To keep it a genuine
third input and not just a referee of the two advisors, step 1 is **blind drafting**: Claude writes
its own complete answer to a temp file (`/tmp/gavel-claude-<ts>.md`) *before* the panel runs, then
runs the advisor panel in parallel, then synthesizes all three committed submissions per
`gavel-synthesis` (its draft is co-equal, not silently rewritten), then takes action. **Only Claude
writes** to the workspace. The runner (`gavel.mjs fuse`) only queries the panel advisors (Codex,
Gemini, `grok`, and any `agy-*` models) - Claude's contribution is the in-process draft, so there is
intentionally **no "claude" provider**.

## Read-only is a per-provider capability (`PROVIDERS[name].isolation`)
- `codex` → `readonly-sandbox`: runs in the project dir under `-s read-only` (a real OS sandbox), so
  it reads the repo but genuinely cannot write — a hard boundary.
- `gemini` → `isolated` (also the safe DEFAULT for any provider not marked `readonly-sandbox`): gemini
  has **no** OS read-only sandbox, and `--approval-mode plan` only blocks edit tools (it can still
  write via `run_shell_command` — verified). So `runProvider` runs it in a **throwaway temp cwd** with
  `PWD`/`OLDPWD`/`INIT_CWD` scrubbed, which stops it discovering the repo path or making relative/cwd
  writes into it. This is **isolation, not a hardened sandbox**: gemini still inherits `$HOME` (needed
  for auth) and will act on any absolute path it's handed — do NOT feed advisors untrusted content
  expecting confinement. Put context gemini needs into the prompt.
- `agy-*` (Antigravity) → `isolated` too: no OS read-only sandbox, so the same throwaway-cwd treatment
  as gemini, plus agy's own `--sandbox` flag. Unlike the others it takes the prompt as the value of
  `-p` (argv), not stdin; `spawn` passes argv as an array (no shell) so injection is still not possible.
- `grok` (Grok Build) → `isolated` too: throwaway cwd so it does not load the repo's MCP servers/skills
  (which it picks up from cwd and fails to auth against) and cannot write the repo. Prompt via `-p`
  (argv, no shell). Runs on a SuperGrok login, no API key.
- The `runProvider` harness creates/scrubs/deletes the throwaway dir; unknown isolation values default
  to isolated (fail safe).

## Prompts never travel through the shell
Prompts reach the runner via `--prompt-file` (or stdin), never a shell-quoted argument. Codex and
Gemini then get the prompt on **stdin**, never argv. `agy` is the exception: it has no stdin prompt
mode, so the runner passes the prompt as the value of `-p` through `spawn`'s argument array - still no
shell, so quotes / `$(...)` / backticks can't inject (the prompt is just briefly visible in `ps`).
Slash commands write the task to a temp file with the Write tool, then pass `--prompt-file`.
(`--prompt` exists for tests/programmatic use only.)

## CLI invocations (verified; flags vary by version — re-verify before changing)
- Codex (tested 0.133.0): `codex exec --color never -s read-only --skip-git-repo-check --ephemeral -m <model> -C <cwd> -o <tmp>`, prompt on stdin → read `<tmp>`.
- Gemini (tested 0.46.0): `gemini --skip-trust --approval-mode plan -m <model> --output-format json`, prompt on stdin, in a throwaway cwd → parse `.response`.
- agy (tested 1.0.10): `agy --sandbox --print-timeout <secs>s --model "<exact model>" -p <prompt>`, prompt as argv, in a throwaway cwd → plain-text stdout. One Antigravity login serves every `agy-*` model; run `agy models` for the exact strings.
- grok (tested 0.2.59): `grok --no-wait-for-background -m <model> -p <prompt>`, prompt as argv, in a throwaway cwd → plain-text stdout. Grok Build on a SuperGrok login; models `grok-build` / `grok-composer-2.5-fast` (run `grok models`). Isolation keeps it from loading the repo's MCP servers/skills.
- A provider is `ok` only on **exit code 0** with non-empty output; otherwise a structured error
  (gemini errors may arrive as JSON on stdout or stderr).

## Config / settings (precedence low→high)
defaults < `~/.gavel/config.json` < `./.gavel.json` < env < CLI flags. Shape:
`{ "providers": { "<name>": { "enabled": bool, "model": str } }, "panel": ["<name>"...], "timeout": sec }`
- Disabled provider → skipped in fuse, not counted "missing" in setup, no warning.
- Models: `GAVEL_CODEX_MODEL` / `GAVEL_GEMINI_MODEL` / `GAVEL_GROK_MODEL`, and `GAVEL_<KEY>_MODEL` per agy provider (e.g. `GAVEL_AGY_OPUS_MODEL`); timeout `GAVEL_TIMEOUT` (seconds, per provider). Default timeout 1800s (30 min). Default fuse panel: `codex,agy-gemini-pro,agy-opus,grok` (the npm `gemini` provider is registered but off the default panel).
- `gavel config` (subcommand + `/gavel:config`) reads/writes ONE settings file: `set`/`unset <key>` edits `~/.gavel/config.json` by default, or `./.gavel.json` with `--project`; `show` prints the merged effective view + sources. Keys: `timeout`, `panel`, `<provider>.model`, `<provider>.enabled`. It edits a single scope (never the merged view) and refuses to clobber a file that is already invalid JSON.
- Preferred defaults are codex `gpt-5.5-pro` / gemini `gemini-3.1-pro`. Model availability is account/tier dependent — if the resolved default isn't usable for the account (e.g. `gpt-5.5-pro` is rejected on a ChatGPT account; `gemini-3.1-pro`/`gemini-3-pro` 404 on personal OAuth), `runProvider` retries once with `-m` omitted so the CLI uses its own default. This fallback fires ONLY for the built-in default (`resolveModel().isDefault`); an explicit flag/env/config model is never swapped. Detection is heuristic (`looksLikeModelError`) and the fallback is logged to stderr.

## setup readiness
`ready` = at least one provider **in the resolved panel** is usable (so a panel/config that excludes
every usable provider reports not-ready, not a false positive). `degraded` = ready but some enabled
provider unusable. `missingProviders` = enabled-but-unusable. `configErrors` surfaces invalid settings
files (they're reported, not silently fail-open). `tooOld`/`versionUnknown` flag CLI version problems.

## Adding a provider
Add one entry to `PROVIDERS` in `scripts/gavel.mjs`:
`{ bin, tested, isolation, defaultModel, modelEnv, installHint, authHint, checkAuth(), run({prompt,model,cwd,timeoutMs,env}) }`.
Use `isolation: "readonly-sandbox"` ONLY if it has a real OS read-only sandbox (like codex `-s
read-only`); otherwise leave it `"isolated"` (the safe default). setup / run / fuse / panel / config
are data-driven off the map; to also expose it via `/gavel:ask`, add its name to the allow-list in
`commands/ask.md` (one line). Providers are CLI-based today — an API-key-only provider would need a
small change to the `usable` check (which currently requires a local binary). The `agy-*` rows (built
by `makeAgyProvider` from the `AGY_MODELS` table) are a worked example of registering several models
that share one CLI and one login.

## Conventions
- `scripts/gavel.mjs`: Node ESM, **zero npm deps** (`node:child_process`, `node:fs`, `node:os`, `node:path`).
- Advisors must never be able to write the workspace; only Claude acts. Keep it synchronous — no jobs/broker/MCP.
- Keep command markdown thin; logic/parsing lives in `gavel.mjs`. Reference plugin files via `${CLAUDE_PLUGIN_ROOT}`.
- Node project — the global "use uv for Python" rule doesn't apply (no Python here).

## Test
- `node scripts/gavel.mjs setup` (or `--json`); `bash scripts/smoke-test.sh` for the full gate.
- Per-finding regression tests are documented in the README.
