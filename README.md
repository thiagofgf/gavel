<h1 align="center">gavel 👨‍⚖️</h1>

<p align="center">
  <b>Multi-model fusion for Claude Code.</b><br>
  Ask claude + codex + gemini + Antigravity models in parallel, then judge their answers into one and act on it.
</p>

---

`/gavel:fuse <task>` asks a **panel** of models the same thing: the **Claude Code model you're running** plus the advisors in your panel - **OpenAI Codex** and, through one **Antigravity** login, models like **Gemini 3.1 Pro** and **Claude Opus**. The advisors are **read-only**; Claude is a **panelist and the actor**. The answers are judged and synthesized into a single fused answer, which is then **acted on**. Only Claude writes to your workspace.

It runs the models through their **local CLIs** (`codex`, `gemini`, `agy`), reusing your existing logins. No API keys to wire up, no MCP servers, no background jobs.

## Inspiration

Gavel is inspired by OpenRouter's [**Fusion beats Frontier**](https://openrouter.ai/blog/announcements/fusion-beats-frontier/): dispatch a prompt to a panel of models, then have a judge synthesize their answers into one response that beats any single frontier model. Gavel brings that pattern into Claude Code — Codex and Gemini answer as advisors, and their answers are judged and fused into one before it acts.

<p align="center">
  <img src="assets/fusion-benchmark-chart.png" alt="Fused model panels outscore individual frontier models on OpenRouter's DRACO deep-research benchmark" width="720">
</p>

<sub>Benchmark chart from OpenRouter's "Fusion beats Frontier" announcement (© OpenRouter), included for reference and attribution.</sub>

## Install

This is a fork of [junkim100/gavel](https://github.com/junkim100/gavel) that adds an **Antigravity (`agy`) provider**, so one Antigravity / Google AI Pro login can put several models (Gemini 3.1 Pro, Claude Opus, and more) on the fuse panel. See [docs/antigravity.md](docs/antigravity.md).

In Claude Code:

```text
/plugin marketplace add thiagofgf/gavel
/plugin install gavel@gavel
```

(Reload/restart if prompted.)

**Local development** - clone the repo and point the marketplace at the clone instead:

```text
git clone https://github.com/thiagofgf/gavel.git
/plugin marketplace add /path/to/gavel    # the cloned directory
/plugin install gavel@gavel
```

## Setup

```text
/gavel:setup
```

Reports whether each provider is installed, authenticated, and recent enough, and offers to install what it can. Authentication:

- **Codex** - `!codex login` (install: `npm install -g @openai/codex`).
- **Gemini** - run `!gemini` once to log in (OAuth), or `export GEMINI_API_KEY=…` (install: `npm install -g @google/gemini-cli`). Note: the free Code Assist OAuth tier is being retired for individuals; if it stops working, use a key or the `agy-*` models below.
- **Antigravity (`agy-*`)** - install the Antigravity app (it ships the `agy` CLI; `agy install` adds it to PATH) and sign in once with Google AI Pro. That single login authorizes every `agy-*` model.

Gavel needs **at least one** advisor usable, but a multi-model panel works best.

## Commands

| Command | What it does |
| --- | --- |
| `/gavel:fuse <task>` | Ask Claude + your panel (Codex + Antigravity models) in parallel, synthesize one fused answer, then act on it. |
| `/gavel:ask <provider> <prompt>` | Send a prompt to a single provider (`codex`, `gemini`, or an `agy-*` model) and show its answer verbatim (no fusing, no edits). |
| `/gavel:setup` | Check/install/auth the Codex, Gemini, and Antigravity (`agy`) CLIs. |
| `/gavel:config [show \| set <key> <value> \| unset <key>]` | View or change settings (model, timeout, panel) in the user or `--project` config file. |

## How advisors stay read-only

Only Claude modifies your workspace. The two advisors are constrained differently because their CLIs differ:

- **Codex** runs in your project under its OS read-only sandbox (`-s read-only`) — a hard boundary: it reads your code but cannot change it.
- **Gemini** has no equivalent read-only sandbox (its `plan` mode doesn't stop shell-based writes), so gavel runs it **isolated**: in a throwaway directory with `PWD`/`OLDPWD` scrubbed, so it can't discover your repo path or make relative writes into it. It answers from the task text - include any code Gemini should see directly in your task. Note this is isolation, **not a hardened sandbox**: Gemini still inherits `$HOME` and could act on an absolute path you hand it, so don't paste untrusted content into a fuse expecting confinement.
- **Antigravity (`agy-*`)** also has no OS read-only sandbox, so gavel runs it **isolated** the same way, plus its own `--sandbox` flag. One difference: `agy` takes the prompt as a command-line value (`-p`), not on stdin. gavel passes it through `spawn` with an argument array (no shell), so quotes / `$(...)` / backticks stay inert; the only caveat is the prompt is briefly visible in `ps` while the call runs. See [docs/antigravity.md](docs/antigravity.md).
- For Codex and Gemini, prompts are passed via a temp file and reach the CLI on **stdin**, never through the shell or process arguments (so quotes / `$(...)` / secrets in a task can't inject or leak). `agy` is the one exception noted above (argv, but still no shell).

## Configuration

Defaults: Codex `gpt-5.5-pro`, Gemini `gemini-3.1-pro`, each `agy-*` provider pinned to its named model (e.g. `agy-opus` is `Claude Opus 4.6 (Thinking)`), per-model timeout `1800s` (30 min). The Codex/Gemini defaults are *preferred* - if your account can't use them, gavel falls back to whatever the CLI itself defaults to (a model you explicitly set is always respected, never swapped). Override via env vars (`GAVEL_CODEX_MODEL`, `GAVEL_GEMINI_MODEL`, `GAVEL_AGY_OPUS_MODEL`, and so on, plus `GAVEL_TIMEOUT`) or a settings file - `~/.gavel/config.json` (user) or `./.gavel.json` (project).

Easiest way to change settings is the `config` command (no hand-editing JSON):

```bash
/gavel:config show                       # effective settings + which file each comes from
/gavel:config set timeout 600            # 10-min timeout, for all projects (~/.gavel/config.json)
/gavel:config set codex.model gpt-5.5    # pin a model (opts that provider out of auto-fallback)
/gavel:config set gemini.model gemini-2.5-pro --project   # this repo only (./.gavel.json)
/gavel:config unset codex.model          # restore the preferred default + auto-fallback
```

Keys: `timeout` (seconds), `panel` (comma-separated), `<provider>.model`, `<provider>.enabled`. Or edit the file directly:

```json
{
  "providers": {
    "codex":          { "enabled": true, "model": "gpt-5.5-pro" },
    "agy-gemini-pro": { "enabled": true },
    "agy-opus":       { "enabled": true }
  },
  "panel": ["codex", "agy-gemini-pro", "agy-opus"],
  "timeout": 1800
}
```

- Set a provider `"enabled": false` to skip it everywhere with **no repeated warnings**.
- `panel` selects which providers `/gavel:fuse` queries. The default is `["codex", "agy-gemini-pro", "agy-opus"]`; list any registered providers to change it. The npm `gemini` CLI stays available but is off the default panel, since its free OAuth tier is deprecated.

> Gemini model availability depends on your account/tier. If you hit `ModelNotFoundError`, set `GAVEL_GEMINI_MODEL` to a model you can access (e.g. `gemini-2.5-flash`).
>
> The `agy-*` models track whatever your Antigravity plan exposes - run `agy models` to see the exact names. Those strings live in the `AGY_MODELS` table in `scripts/gavel.mjs`; edit the rows if your plan lists different models.

## Adding another model

`scripts/gavel.mjs` is built around a `PROVIDERS` registry. To add a CLI (e.g. a future `qwen`), add one entry — its binary, default model, auth check, and a `run()` that invokes it read-only with the prompt on stdin — and leave it `isolated` (the default) unless it has a real OS read-only sandbox like Codex. It then appears in `/gavel:setup` and the `/gavel:fuse` panel automatically; to also expose it via `/gavel:ask`, add its name to the one-line allow-list in `commands/ask.md`. (Providers are CLI-based today; an API-key-only provider would need a small tweak to the `usable` check.)

## Requirements & versions

`node`, plus at least one advisor CLI: `codex` (logged in), `gemini` (logged in), and/or `agy` from the Antigravity app (signed in). Tested with **codex ≥ 0.133.0**, **gemini ≥ 0.46.0**, and **agy ≥ 1.0.10**; older versions may lack required flags - `/gavel:setup` warns if a CLI is older than tested.

## Testing

`bash scripts/smoke-test.sh` runs the deterministic checks (read-only enforcement, prompt injection-safety, strict exit codes, degraded/disabled readiness). The in-Claude-Code behavior of the slash commands (`/gavel:fuse` synthesizing then acting) is best verified live in a scratch repo.

## License

MIT — see [LICENSE](./LICENSE).
