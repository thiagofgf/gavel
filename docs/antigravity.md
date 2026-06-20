# Antigravity (`agy`) provider

This fork adds Antigravity as a gavel provider. The point is simple: a single Antigravity sign-in
(Google AI Pro) gives you several models through one CLI, so your fuse panel can mix vendors without
juggling separate API keys or logins.

## Why it exists

Upstream gavel runs Gemini through the `gemini` npm CLI, which authenticates with the free "Gemini
Code Assist for individuals" OAuth tier. Google has been retiring that tier, and when it stops working
the `gemini` CLI fails with an `IneligibleTierError`. Antigravity is the replacement surface for that
plan, and its `agy` CLI can drive Gemini and several other models headlessly. Wiring `agy` in as a
provider keeps the panel working and, as a bonus, adds Claude and GPT-OSS models on the same login.

## Prerequisites

1. Install the **Antigravity** desktop app.
2. Make sure the `agy` CLI is on your PATH. The app ships it; `agy install` adds it if needed. Check
   with `agy --version` (this fork was tested against `1.0.10`).
3. Sign in to the app once with your **Google AI Pro** account. That session authorizes `agy`, and
   `/gavel:setup` detects it from the app's profile directory.

There is no npm package and no API key to set. `/gavel:setup` will not try to `npm install` an
`agy-*` provider; if one is missing it points you back to the app.

## Models and provider names

Run `agy models` to see what your plan exposes. This fork registers one gavel provider per model:

| Provider name      | agy model                      |
| ------------------ | ------------------------------ |
| `agy-gemini-pro`   | `Gemini 3.1 Pro (High)`        |
| `agy-gemini-flash` | `Gemini 3.5 Flash (High)`      |
| `agy-opus`         | `Claude Opus 4.6 (Thinking)`   |
| `agy-sonnet`       | `Claude Sonnet 4.6 (Thinking)` |
| `agy-gptoss`       | `GPT-OSS 120B (Medium)`        |

These pairs live in the `AGY_MODELS` table in `scripts/gavel.mjs`. If `agy models` lists different
names on your plan, edit the values to match (the keys are yours to name; the values must be exact).

## Using it

The default fuse panel is `codex,agy-gemini-pro,agy-opus`, so a fresh install already fuses across
three vendors (OpenAI, Google, Anthropic) plus the Claude model you are running. Change the panel any
time:

```bash
/gavel:config set panel codex,agy-gemini-pro,agy-sonnet,agy-gptoss
```

Send a one-off prompt to a single model without fusing:

```bash
/gavel:ask agy-opus Explain this stack trace.
```

Pin or swap the model behind a provider, or set it per project:

```bash
/gavel:config set agy-opus.model "Claude Sonnet 4.6 (Thinking)"
```

Each provider also reads a `GAVEL_<KEY>_MODEL` env var, for example `GAVEL_AGY_OPUS_MODEL`.

## How it runs, and the one safety caveat

Like Gemini, `agy` has no OS read-only sandbox, so gavel runs it **isolated**: in a throwaway working
directory with `PWD`/`OLDPWD` scrubbed, and with agy's own `--sandbox` flag for terminal
restrictions. As with every advisor, only Claude writes to your workspace.

One thing is genuinely different from the other providers. Codex and Gemini receive the prompt on
**stdin**; `agy` has no stdin prompt mode, so the runner passes the prompt as the value of `-p`. That
goes through `spawn` with an argument array and no shell, so quotes, `$(...)`, and backticks in a
prompt stay inert (there is no injection path). The trade-off is that the prompt text is visible in
`ps` for the few seconds the call runs. On a personal machine that is usually fine; if other users
share the host, keep that in mind before fusing secrets.

## Limitations

- `agy` answers from the prompt only. Because it runs in an isolated empty directory, it cannot read
  your repo. Put any code or context it needs into the task text.
- Availability of specific models depends on your Antigravity plan and can change. `agy models` is the
  source of truth; the table above is what one Google AI Pro plan showed at the time of writing.
- The `--print-timeout` passed to `agy` follows gavel's per-provider timeout (default 30 minutes).
