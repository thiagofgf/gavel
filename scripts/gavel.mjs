#!/usr/bin/env node
// gavel — zero-dependency runner that shells out to advisor model CLIs (codex, gemini, …).
// Subcommands: setup | run | fuse. See ../CLAUDE.md for the contracts this implements.
//
// Design notes:
// - Advisors run READ-ONLY; only Claude (the caller) ever writes. Each provider hard-codes a
//   read-only policy and the prompt is always fed over stdin (never argv) — see PROVIDERS.
// - To add a provider, add one entry to PROVIDERS. Everything else (setup/run/fuse, config,
//   panel) is data-driven off that map.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// --- helpers ---------------------------------------------------------------

function firstLines(s, n = 5) {
  return (s || "").trim().split("\n").slice(0, n).join("\n").trim();
}

function errorSnippet(r) {
  return firstLines(r.stderr) || firstLines(r.stdout);
}

function extractJson(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch {}
  }
  return null;
}

// Run a child process; never rejects. Resolves {code, stdout, stderr, timedOut, spawnError}.
// `input`, when provided, is written to the child's stdin (how prompts reach every CLI).
function runCommand(cmd, args, { cwd, timeoutMs, input, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: env ?? process.env,
      stdio: [input != null ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", timedOut = false, settled = false;
    const timer = timeoutMs
      ? setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch {} }, timeoutMs)
      : null;
    const done = (r) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (err) =>
      done({ code: -1, stdout, stderr: stderr || String(err?.message ?? err), timedOut, spawnError: err?.code === "ENOENT" }));
    child.on("close", (code) => done({ code, stdout, stderr, timedOut, spawnError: false }));
    if (input != null) {
      child.stdin.on("error", () => {});
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

async function probe(bin, args = ["--version"]) {
  const r = await runCommand(bin, args, { timeoutMs: 10000 });
  if (r.spawnError) return { available: false, version: null, semver: null };
  const out = r.stdout || r.stderr || "";
  const m = out.match(/(\d+\.\d+\.\d+)/); // first semver anywhere in the output (not just line 1)
  return { available: true, version: firstLines(out, 1), semver: m ? m[1] : null };
}

// --- provider registry -----------------------------------------------------
// Each provider encapsulates: how to run it READ-ONLY with the prompt on stdin, how to parse its
// output, its default model + model env override, and how to check auth. Add a provider here.

const PROVIDERS = {
  codex: {
    bin: "codex",
    tested: "0.133.0",
    // `-s read-only` is a real OS sandbox, so codex can safely explore the project read-only.
    isolation: "readonly-sandbox",
    defaultModel: "gpt-5.5",
    modelEnv: "GAVEL_CODEX_MODEL",
    installHint: "install with `npm install -g @openai/codex`",
    authHint: "authenticate with `!codex login`",
    checkAuth() {
      const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
      const p = path.join(home, "auth.json");
      return fs.existsSync(p) ? { authed: true, via: p } : { authed: false, via: null };
    },
    async run({ prompt, model, cwd, timeoutMs, env }) {
      const tmp = path.join(os.tmpdir(), `gavel-codex-${process.pid}-${Date.now()}.txt`);
      // -s read-only enforces the advisor (no writes); prompt is piped on stdin (never argv).
      const args = [
        "exec", "--color", "never", "-s", "read-only",
        "--skip-git-repo-check", "--ephemeral",
        "-m", model, "-C", cwd, "-o", tmp,
      ];
      const r = await runCommand("codex", args, { cwd, timeoutMs, input: prompt, env });
      let text = "";
      try { text = fs.readFileSync(tmp, "utf8").trim(); } catch {}
      try { fs.unlinkSync(tmp); } catch {}
      if (r.spawnError) return { ok: false, error: `codex CLI not found — ${this.installHint}, then ${this.authHint}.` };
      if (r.timedOut) return { ok: false, error: `timed out after ${Math.round(timeoutMs / 1000)}s` };
      if (r.code !== 0) return { ok: false, error: errorSnippet(r) || `codex exited with code ${r.code}` };
      if (!text) text = (r.stdout || "").trim();
      if (!text) return { ok: false, error: "codex returned no output" };
      return { ok: true, text };
    },
  },

  gemini: {
    bin: "gemini",
    tested: "0.46.0",
    // gemini has no OS read-only sandbox and `--approval-mode plan` only blocks edit tools (the model
    // can still write via run_shell_command — verified). So we run it ISOLATED: a throwaway cwd with
    // PWD/OLDPWD/INIT_CWD scrubbed (see runProvider), so it won't discover or make relative/cwd writes
    // to your project. This is NOT a hardened sandbox — gemini still inherits $HOME (needed for auth)
    // and can act on any absolute path it is handed, so don't treat it as a boundary for untrusted
    // input. The run() flags are defense-in-depth + headless plumbing.
    isolation: "isolated",
    defaultModel: "gemini-2.5-pro",
    modelEnv: "GAVEL_GEMINI_MODEL",
    installHint: "install with `npm install -g @google/gemini-cli`",
    authHint: "run `!gemini` once to log in (OAuth) or set GEMINI_API_KEY",
    checkAuth() {
      if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENAI_API_KEY)
        return { authed: true, via: "env (GEMINI_API_KEY/GOOGLE_API_KEY)" };
      const p = path.join(os.homedir(), ".gemini", "oauth_creds.json");
      return fs.existsSync(p) ? { authed: true, via: p } : { authed: false, via: null };
    },
    async run({ prompt, model, cwd, timeoutMs, env }) {
      // --skip-trust unblocks headless mode in the fresh cwd; --approval-mode plan blocks edit tools;
      // prompt is piped on stdin (never argv); --output-format json so we can require a real answer.
      const args = ["--skip-trust", "--approval-mode", "plan", "-m", model, "--output-format", "json"];
      const r = await runCommand("gemini", args, { cwd, timeoutMs, input: prompt, env });
      if (r.spawnError) return { ok: false, error: `gemini CLI not found — ${this.installHint}, then ${this.authHint}.` };
      if (r.timedOut) return { ok: false, error: `timed out after ${Math.round(timeoutMs / 1000)}s` };
      const parsed = extractJson((r.stdout || "").trim()) || extractJson((r.stderr || "").trim());
      const parsedErr = parsed?.error
        ? (typeof parsed.error === "string" ? parsed.error : (parsed.error.message || JSON.stringify(parsed.error)))
        : null;
      if (parsedErr) return { ok: false, error: parsedErr };
      if (r.code !== 0) return { ok: false, error: errorSnippet(r) || `gemini exited with code ${r.code}` };
      // Require a real JSON answer. Do NOT fall back to raw stdout — that would launder a banner,
      // stats-only output, or an older CLI ignoring --output-format json into a fake [ok] answer.
      const text = typeof parsed?.response === "string" ? parsed.response.trim() : "";
      if (!text) return { ok: false, error: errorSnippet(r) || "gemini did not return a JSON response (the CLI may be too old, or not support --output-format json)" };
      return { ok: true, text };
    },
  },
};

const PROVIDER_NAMES = Object.keys(PROVIDERS);

// --- config / settings -----------------------------------------------------
// Precedence (low -> high): defaults < ~/.gavel/config.json < ./.gavel.json < env < CLI flags.
// Shape: { providers: { <name>: { enabled: bool, model: str } }, panel: [name...], timeout: sec }

const DEFAULT_TIMEOUT_S = 300;

function loadConfig(cwd) {
  const cfg = { providers: {}, configErrors: [] };
  const sources = [
    path.join(os.homedir(), ".gavel", "config.json"),
    path.join(cwd, ".gavel.json"),
  ];
  for (const p of sources) {
    let text;
    try { text = fs.readFileSync(p, "utf8"); } catch { continue; } // absent/unreadable: ignore silently
    let raw;
    try { raw = JSON.parse(text); }
    catch (e) { cfg.configErrors.push(`${p}: invalid JSON (${e.message})`); continue; } // surface, don't fail open silently
    if (typeof raw.timeout === "number") cfg.timeout = raw.timeout;
    if (Array.isArray(raw.panel)) cfg.panel = raw.panel;
    if (raw.providers && typeof raw.providers === "object") {
      for (const [k, v] of Object.entries(raw.providers)) {
        cfg.providers[k] = { ...(cfg.providers[k] || {}), ...v };
      }
    }
  }
  return cfg;
}

function isEnabled(name, config) {
  return config.providers?.[name]?.enabled !== false; // enabled unless explicitly disabled
}

function resolveModel(name, explicit, config) {
  const p = PROVIDERS[name];
  return explicit || process.env[p.modelEnv] || config.providers?.[name]?.model || p.defaultModel;
}

function resolvePanel(config) {
  const base = Array.isArray(config.panel) && config.panel.length ? config.panel : PROVIDER_NAMES;
  return base.filter((n) => PROVIDERS[n] && isEnabled(n, config));
}

function resolveTimeoutMs(opts, config) {
  const sec = Number(opts.timeout) || Number(process.env.GAVEL_TIMEOUT) || config.timeout || DEFAULT_TIMEOUT_S;
  return (sec > 0 ? sec : DEFAULT_TIMEOUT_S) * 1000; // ignore non-positive timeouts
}

function warnConfigErrors(config) {
  for (const e of config.configErrors || []) process.stderr.write(`gavel: ignoring invalid config — ${e}\n`);
}

function parseVersion(s) {
  const m = (s || "").match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function versionBelow(actual, min) {
  const a = parseVersion(actual), b = parseVersion(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

// Run a provider, isolating it from the user's project unless it declares a hard read-only sandbox.
// Safe default: anything that is NOT "readonly-sandbox" runs in a throwaway temp dir (deleted after)
// with PWD/OLDPWD/INIT_CWD scrubbed, so it can't discover the repo path or make relative/cwd writes.
async function runProvider(name, { prompt, model, cwd, timeoutMs }) {
  const p = PROVIDERS[name];
  if (p.isolation === "readonly-sandbox") {
    return await p.run({ prompt, model, cwd, timeoutMs, env: process.env });
  }
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), `gavel-${name}-`));
  const env = { ...process.env, PWD: tmpCwd };
  delete env.OLDPWD;
  delete env.INIT_CWD;
  try {
    return await p.run({ prompt, model, cwd: tmpCwd, timeoutMs, env });
  } finally {
    try { fs.rmSync(tmpCwd, { recursive: true, force: true }); } catch {}
  }
}

// --- arg + prompt handling -------------------------------------------------

const VALUE_OPTS = new Set([
  "provider", "model", "prompt", "prompt-file", "cwd", "timeout",
  ...PROVIDER_NAMES.map((n) => `${n}-model`),
]);

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (VALUE_OPTS.has(key)) opts[key] = argv[++i];
    else opts[key] = true; // boolean flag (e.g. --json)
  }
  return opts;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { data += d; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

// Prompt never travels through the shell: it comes from a file (--prompt-file), stdin, or --prompt
// (the last for tests/programmatic use only). Slash commands use --prompt-file via the Write tool.
async function resolvePrompt(opts) {
  if (opts["prompt-file"] != null) {
    try { return fs.readFileSync(opts["prompt-file"], "utf8").trim(); }
    catch (err) { throw new Error(`cannot read --prompt-file: ${err?.message ?? err}`); }
  }
  if (opts.prompt != null) return String(opts.prompt).trim();
  if (!process.stdin.isTTY) return (await readStdin()).trim();
  return "";
}

// --- subcommands -----------------------------------------------------------

async function cmdSetup(opts) {
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  const config = loadConfig(cwd);
  const [node, npm] = await Promise.all([probe("node"), probe("npm")]);

  const providers = {};
  const missingProviders = [];
  const nextSteps = [];
  let anyUsable = false;

  await Promise.all(PROVIDER_NAMES.map(async (name) => {
    const p = PROVIDERS[name];
    const enabled = isEnabled(name, config);
    const bin = await probe(p.bin);
    const auth = p.checkAuth();
    const usable = enabled && bin.available && auth.authed;
    const tooOld = bin.semver ? versionBelow(bin.semver, p.tested) : false;
    const versionUnknown = bin.available && !bin.semver;
    providers[name] = {
      enabled, installed: bin.available, version: bin.version, semver: bin.semver, tested: p.tested,
      isolation: p.isolation, authed: auth.authed, authVia: auth.via, usable, tooOld, versionUnknown,
      model: resolveModel(name, null, config),
    };
    if (!enabled) return;
    if (tooOld) nextSteps.push(`${name}: installed ${bin.semver} is older than tested ${p.tested}; required flags may be unsupported.`);
    else if (versionUnknown) nextSteps.push(`${name}: could not parse its version; ensure it is at least ${p.tested}.`);
    if (usable) { anyUsable = true; return; }
    missingProviders.push(name);
    if (!bin.available) nextSteps.push(`${name}: ${p.installHint}.`);
    else if (!auth.authed) nextSteps.push(`${name}: ${p.authHint}.`);
  }));

  // Readiness reflects whether /gavel:fuse can actually run: at least one PANEL member is usable
  // (not merely "some provider somewhere is usable", which could be excluded by the panel/config).
  const panel = resolvePanel(config);
  const panelUsable = panel.filter((n) => providers[n]?.usable);
  const ready = panelUsable.length > 0;
  const degraded = ready && missingProviders.length > 0;

  if (!ready && anyUsable) {
    nextSteps.push("Usable advisors exist but none are in the active panel — fix `panel`/`enabled` in your settings.");
  }
  for (const e of config.configErrors) nextSteps.push(`config: ${e}`);
  if (!nextSteps.length) {
    nextSteps.push(ready ? "Ready — try `/gavel:fuse <task>`." : "No advisor is usable yet — install/authenticate at least one above.");
  }

  const report = {
    ready, degraded, node, npm, providers, missingProviders, panel,
    configErrors: config.configErrors,
    timeoutSeconds: resolveTimeoutMs(opts, config) / 1000, nextSteps,
  };

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }

  const mark = (b) => (b ? "✓" : "✗");
  const lines = ["Gavel setup", "============"];
  lines.push(`node:   ${mark(node.available)} ${node.version || "not found"}`);
  lines.push(`npm:    ${mark(npm.available)} ${npm.version || "not found"}`);
  for (const name of PROVIDER_NAMES) {
    const s = providers[name];
    if (!s.enabled) { lines.push(`${name}: enabled ✗ (disabled in settings — skipped)`); continue; }
    lines.push(
      `${name}: installed ${mark(s.installed)}${s.installed ? ` (${s.version}${s.tooOld ? ` ⚠ older than tested ${s.tested}` : ""})` : ""}` +
      ` · auth ${mark(s.authed)}${s.authVia ? ` (${s.authVia})` : ""}` +
      ` · usable ${mark(s.usable)} · ${s.isolation} · model ${s.model}`,
    );
  }
  lines.push("");
  lines.push(`ready: ${mark(ready)}${degraded ? "  (degraded — some advisors unavailable)" : ""}`);
  lines.push(`panel: ${panel.length ? panel.join(", ") : "(none)"}  ·  timeout ${report.timeoutSeconds}s`);
  if (missingProviders.length) lines.push(`unavailable (enabled): ${missingProviders.join(", ")}`);
  lines.push("");
  lines.push("Next steps:");
  for (const s of nextSteps) lines.push(`- ${s}`);
  process.stdout.write(lines.join("\n") + "\n");
}

async function cmdRun(opts) {
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  const config = loadConfig(cwd);
  warnConfigErrors(config);
  const provider = opts.provider;
  if (!PROVIDERS[provider]) {
    process.stderr.write(`usage: gavel run --provider <${PROVIDER_NAMES.join("|")}> --prompt-file <path> [--model M] [--cwd DIR] [--timeout S]\n`);
    process.exit(2);
  }
  if (!isEnabled(provider, config)) {
    process.stderr.write(`error: provider "${provider}" is disabled in settings (enable it in ~/.gavel/config.json or ./.gavel.json)\n`);
    process.exit(2);
  }
  const prompt = await resolvePrompt(opts);
  if (!prompt) { process.stderr.write("error: no prompt (use --prompt-file, --prompt, or stdin)\n"); process.exit(2); }

  const model = resolveModel(provider, opts.model, config);
  const timeoutMs = resolveTimeoutMs(opts, config);
  const res = await runProvider(provider, { prompt, model, cwd, timeoutMs });
  const result = { provider, model, ok: res.ok, text: res.ok ? res.text : "", error: res.ok ? null : res.error };

  if (opts.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  else if (result.ok) process.stdout.write(result.text + "\n");
  else process.stderr.write(`error (${provider} · ${model}): ${result.error}\n`);
  process.exit(result.ok ? 0 : 1);
}

function renderFuse(results) {
  const ok = results.filter((r) => r.ok).length;
  const bar = "=".repeat(64);
  const out = [`GAVEL PANEL — ${ok}/${results.length} model(s) responded`, bar];
  for (const r of results) {
    out.push("", `----- ${r.provider} · ${r.model} · [${r.ok ? "ok" : "error"}] -----`);
    out.push(r.ok ? r.text : `(no answer) ${r.error}`);
  }
  out.push("", bar);
  return out.join("\n") + "\n";
}

async function cmdFuse(opts) {
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  const config = loadConfig(cwd);
  warnConfigErrors(config);
  const prompt = await resolvePrompt(opts);
  if (!prompt) { process.stderr.write("error: no prompt (use --prompt-file, --prompt, or stdin)\n"); process.exit(2); }

  const panel = resolvePanel(config);
  if (!panel.length) {
    const msg = "No advisor models are enabled/available. Run `/gavel:setup`.";
    if (opts.json) process.stdout.write(JSON.stringify({ panel: [], results: [], note: msg }, null, 2) + "\n");
    else process.stdout.write(msg + "\n");
    process.exit(1);
  }

  const timeoutMs = resolveTimeoutMs(opts, config);
  const results = await Promise.all(panel.map(async (name) => {
    const model = resolveModel(name, opts[`${name}-model`], config);
    const res = await runProvider(name, { prompt, model, cwd, timeoutMs });
    return { provider: name, model, ok: res.ok, text: res.ok ? res.text : "", error: res.ok ? null : res.error };
  }));

  if (opts.json) process.stdout.write(JSON.stringify(results, null, 2) + "\n");
  else process.stdout.write(renderFuse(results));
  process.exit(results.some((r) => r.ok) ? 0 : 1);
}

// --- dispatch --------------------------------------------------------------

const sub = process.argv[2];
const opts = parseArgs(process.argv.slice(3));
const commands = { setup: cmdSetup, run: cmdRun, fuse: cmdFuse };
const handler = commands[sub];
if (!handler) {
  process.stderr.write("usage: gavel <setup|run|fuse> [options]\n");
  process.exit(2);
}
handler(opts).catch((err) => {
  process.stderr.write(`gavel: ${err?.stack || err}\n`);
  process.exit(1);
});
