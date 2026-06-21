#!/usr/bin/env node
// gavel — zero-dependency runner that shells out to advisor model CLIs (codex, gemini, …).
// Subcommands: setup | run | fuse. See ../CLAUDE.md for the contracts this implements.
//
// Design notes:
// - Advisors run READ-ONLY; only Claude (the caller) ever writes. Each provider hard-codes a
//   read-only policy and the prompt is always fed over stdin (never argv) — see PROVIDERS.
// - To add a provider, add one entry to PROVIDERS. Everything else (setup/run/fuse, config,
//   panel) is data-driven off that map.
import { spawn, spawnSync } from "node:child_process";
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

// codex prints its real failure as an `ERROR: {json}` line in stderr, below a multi-line banner that
// firstLines() would otherwise return instead. Prefer that line's message so errors (and the model
// fallback's looksLikeModelError check) see the actual cause, not the banner.
function codexError(r) {
  for (const line of (r.stderr || "").split("\n")) {
    const i = line.indexOf("ERROR:");
    if (i === -1) continue;
    const rest = line.slice(i + "ERROR:".length).trim();
    const msg = extractJson(rest)?.error?.message;
    if (msg) return msg;
    if (rest) return rest;
  }
  return errorSnippet(r);
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
    // Preferred default; if the account can't use it, runProvider falls back to the codex CLI default.
    defaultModel: "gpt-5.5-pro",
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
      // model may be empty (fallback) → omit -m so codex uses its own default model.
      const args = [
        "exec", "--color", "never", "-s", "read-only",
        "--skip-git-repo-check", "--ephemeral",
        "-C", cwd, "-o", tmp,
      ];
      if (model) args.push("-m", model);
      const r = await runCommand("codex", args, { cwd, timeoutMs, input: prompt, env });
      let text = "";
      try { text = fs.readFileSync(tmp, "utf8").trim(); } catch {}
      try { fs.unlinkSync(tmp); } catch {}
      if (r.spawnError) return { ok: false, error: `codex CLI not found — ${this.installHint}, then ${this.authHint}.` };
      if (r.timedOut) return { ok: false, error: `timed out after ${Math.round(timeoutMs / 1000)}s` };
      if (r.code !== 0) return { ok: false, error: codexError(r) || `codex exited with code ${r.code}` };
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
    // Preferred default; if the account can't use it, runProvider falls back to the gemini CLI default.
    defaultModel: "gemini-3.1-pro",
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
      // model may be empty (fallback) → omit -m so gemini uses its own default model.
      const args = ["--skip-trust", "--approval-mode", "plan", "--output-format", "json"];
      if (model) args.push("-m", model);
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

// --- Antigravity (agy) multi-model provider --------------------------------
// `agy` is the Antigravity CLI: one Antigravity / Google AI Pro login exposes several models
// (run `agy models`). We register one gavel provider per model so a single fuse panel can mix
// them - e.g. codex + Gemini 3.1 Pro + Claude Opus, all on one subscription. agy differs from
// codex/gemini in two ways, both handled here:
//   - No OS read-only sandbox, so we run it `isolated` (throwaway cwd, scrubbed PWD) like gemini,
//     and add its own `--sandbox` flag for terminal restrictions.
//   - It takes the prompt as the value of `-p` (argv), not on stdin. spawn() passes argv as an
//     array with no shell, so quotes / $() / backticks in a prompt are inert (no injection); the
//     one caveat is the prompt is visible in `ps` while the call runs. See docs/antigravity.md.
let _agyAuthCache; // `agy models` is the same for every agy-* provider, so probe once per run.
function agyCheckAuth() {
  if (_agyAuthCache !== undefined) return _agyAuthCache;
  // Real evidence, not just "the app folder exists": `agy models` returns the account's model list
  // only when signed in. Run it synchronously with a short timeout; a logged-out CLI errors or
  // stalls (the timeout kills it), and either way we report not-authed.
  const r = spawnSync("agy", ["models"], { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "pipe"] });
  if (r.error && r.error.code === "ENOENT") return (_agyAuthCache = { authed: false, via: null }); // not installed; the bin probe reports that
  const out = (r.stdout || "").trim();
  if (r.status === 0 && out) return (_agyAuthCache = { authed: true, via: "agy models" });
  return (_agyAuthCache = { authed: false, via: null });
}

function makeAgyProvider(key, modelString) {
  return {
    bin: "agy",
    tested: "1.0.10",
    isolation: "isolated",
    defaultModel: modelString,
    modelEnv: `GAVEL_${key.toUpperCase().replace(/-/g, "_")}_MODEL`,
    installHint: "install the Antigravity app (it ships the `agy` CLI; run `agy install` to add it to PATH)",
    authHint: "sign in to the Antigravity app once (Google AI Pro), which authorizes `agy`",
    checkAuth: agyCheckAuth,
    async run({ prompt, model, cwd, timeoutMs, env }) {
      const secs = Math.max(60, Math.round(timeoutMs / 1000));
      // model "" (the runProvider fallback) => omit --model so agy uses the plan's default model.
      const args = ["--sandbox", "--print-timeout", `${secs}s`];
      if (model) args.push("--model", model);
      args.push("-p", prompt); // prompt is the value of -p (argv); spawn array = no shell, no injection
      const r = await runCommand("agy", args, { cwd, timeoutMs, env });
      if (r.spawnError) return { ok: false, error: `agy CLI not found - ${this.installHint}.` };
      if (r.timedOut) return { ok: false, error: `timed out after ${secs}s` };
      if (r.code !== 0) return { ok: false, error: errorSnippet(r) || `agy exited with code ${r.code}` };
      const text = (r.stdout || "").trim();
      if (!text) return { ok: false, error: errorSnippet(r) || "agy returned no output" };
      return { ok: true, text };
    },
  };
}

// One provider per agy model. Keys are gavel provider names (panel/config); values are the exact
// strings `agy --model` expects (from `agy models`). Add/remove rows to match your plan's models.
const AGY_MODELS = {
  "agy-gemini-pro":   "Gemini 3.1 Pro (High)",
  "agy-gemini-flash": "Gemini 3.5 Flash (High)",
  "agy-opus":         "Claude Opus 4.6 (Thinking)",
  "agy-sonnet":       "Claude Sonnet 4.6 (Thinking)",
  "agy-gptoss":       "GPT-OSS 120B (Medium)",
};
for (const [key, modelString] of Object.entries(AGY_MODELS)) {
  PROVIDERS[key] = makeAgyProvider(key, modelString);
}

// --- Grok Build (grok) provider --------------------------------------------
// `grok` is xAI's Grok Build CLI: it signs in with your xAI/X login and runs on an active SuperGrok
// subscription (no API key), the same way codex uses a ChatGPT login and agy uses Antigravity.
// Single-turn headless mode is `grok -p <prompt>` (prompt as argv; spawn array = no shell, so no
// injection). We run it `isolated` like agy/gemini: a throwaway cwd, so it does not pick up this
// project's MCP servers/skills (which it would otherwise load from the cwd and fail to auth against)
// and cannot make relative writes into the repo. `--no-wait-for-background` returns right after the
// first turn instead of waiting up to grok's 600s background-task timeout.
function grokCheckAuth() {
  const p = path.join(os.homedir(), ".grok", "auth.json");
  return fs.existsSync(p) ? { authed: true, via: p } : { authed: false, via: null };
}
PROVIDERS.grok = {
  bin: "grok",
  tested: "0.2.59",
  isolation: "isolated",
  defaultModel: "grok-build",
  modelEnv: "GAVEL_GROK_MODEL",
  installHint: "install Grok Build with `curl -fsSL https://x.ai/cli/install.sh | bash`",
  authHint: "sign in with `grok login` (needs an active SuperGrok subscription)",
  checkAuth: grokCheckAuth,
  async run({ prompt, model, cwd, timeoutMs, env }) {
    // model "" (the runProvider fallback) => omit -m so grok uses its own default model.
    const args = ["--no-wait-for-background"];
    if (model) args.push("-m", model);
    args.push("-p", prompt); // prompt as the value of -p (argv); spawn array = no shell, no injection
    const r = await runCommand("grok", args, { cwd, timeoutMs, env });
    if (r.spawnError) return { ok: false, error: `grok CLI not found - ${this.installHint}.` };
    if (r.timedOut) return { ok: false, error: `timed out after ${Math.round(timeoutMs / 1000)}s` };
    if (r.code !== 0) return { ok: false, error: errorSnippet(r) || `grok exited with code ${r.code}` };
    const text = (r.stdout || "").trim();
    if (!text) return { ok: false, error: errorSnippet(r) || "grok returned no output" };
    return { ok: true, text };
  },
};

const PROVIDER_NAMES = Object.keys(PROVIDERS);

// Default fuse panel for this fork: Codex, two Antigravity-backed models (Gemini Pro and Claude
// Opus), and Grok Build - four advisors across four vendors, each on a subscription/login rather
// than a metered API key. Trim it with `gavel config set panel ...` for a leaner/cheaper fuse. The
// npm `gemini` CLI provider stays registered but is off the default panel (its free OAuth tier is
// deprecated; add it back if you have a key).
const DEFAULT_PANEL = ["codex", "agy-gemini-pro", "agy-opus", "grok"];

// --- config / settings -----------------------------------------------------
// Precedence (low -> high): defaults < ~/.gavel/config.json < ./.gavel.json < env < CLI flags.
// Shape: { providers: { <name>: { enabled: bool, model: str } }, panel: [name...], timeout: sec }

const DEFAULT_TIMEOUT_S = 1800;

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

// Returns { model, isDefault }. isDefault is true only when the model is our built-in defaultModel
// (no explicit/env/config override) — i.e. the case where runProvider may fall back to the CLI default
// if the account can't use it. An explicitly chosen model is always respected, never swapped.
function resolveModel(name, explicit, config) {
  const p = PROVIDERS[name];
  const override = explicit || process.env[p.modelEnv] || config.providers?.[name]?.model;
  return { model: override || p.defaultModel, isDefault: !override };
}

// Heuristic: does this provider error mean "the requested model isn't usable for this account"?
// Covers codex ("... model is not supported ...") and gemini ("Requested entity was not found.").
function looksLikeModelError(error) {
  const e = error || "";
  return /\b(model|requested entity)\b/i.test(e) &&
    /(not supported|not found|unknown|not available|does not have access|no access|unavailable|invalid)/i.test(e);
}

function resolvePanel(config) {
  const base = Array.isArray(config.panel) && config.panel.length ? config.panel : DEFAULT_PANEL;
  return base.filter((n) => PROVIDERS[n] && isEnabled(n, config));
}

function resolveTimeoutMs(opts, config) {
  const sec = Number(opts.timeout) || Number(process.env.GAVEL_TIMEOUT) || config.timeout || DEFAULT_TIMEOUT_S;
  return (sec > 0 ? sec : DEFAULT_TIMEOUT_S) * 1000; // ignore non-positive timeouts
}

function warnConfigErrors(config) {
  for (const e of config.configErrors || []) process.stderr.write(`gavel: ignoring invalid config — ${e}\n`);
}

// --- config writing (the `config` subcommand) ------------------------------
// Reads/writes ONE settings file (user ~/.gavel/config.json or project ./.gavel.json), never the
// merged view — so `set`/`unset` change exactly that scope and leave precedence intact.

function userConfigPath() { return path.join(os.homedir(), ".gavel", "config.json"); }
function projectConfigPath(cwd) { return path.join(cwd, ".gavel.json"); }

function readConfigFile(p) {
  let text;
  try { text = fs.readFileSync(p, "utf8"); } catch { return {}; } // absent → empty (we'll create it)
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`refusing to edit ${p}: it is not valid JSON (${e.message})`); }
}

function writeConfigFile(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
}

// Map a dotted key to a JSON path + value parser. Returns null for unknown keys.
function configKeySpec(key) {
  if (key === "timeout") return { path: ["timeout"], parse: parseTimeoutValue };
  if (key === "panel") return { path: ["panel"], parse: parsePanelValue };
  const m = key.match(/^([a-z0-9-]+)\.(model|enabled)$/i);
  if (m && PROVIDERS[m[1]]) {
    const jpath = ["providers", m[1], m[2]];
    return { path: jpath, parse: m[2] === "enabled" ? parseBoolValue : (v) => String(v) };
  }
  return null;
}

function configKeyList() {
  return ["timeout", "panel", ...PROVIDER_NAMES.flatMap((n) => [`${n}.model`, `${n}.enabled`])];
}

function parseTimeoutValue(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`timeout must be a positive number of seconds, got "${v}"`);
  return n;
}

function parseBoolValue(v) {
  if (v === "true") return true;
  if (v === "false") return false;
  throw new Error(`expected true or false, got "${v}"`);
}

function parsePanelValue(v) {
  const list = String(v).split(",").map((s) => s.trim()).filter(Boolean);
  if (!list.length) throw new Error("panel cannot be empty");
  const bad = list.filter((n) => !PROVIDERS[n]);
  if (bad.length) throw new Error(`unknown provider(s) in panel: ${bad.join(", ")} (valid: ${PROVIDER_NAMES.join(", ")})`);
  return list;
}

function setPath(obj, jpath, value) {
  let o = obj;
  for (let i = 0; i < jpath.length - 1; i++) {
    if (typeof o[jpath[i]] !== "object" || o[jpath[i]] === null) o[jpath[i]] = {};
    o = o[jpath[i]];
  }
  o[jpath[jpath.length - 1]] = value;
}

function unsetPath(obj, jpath) {
  let o = obj;
  for (let i = 0; i < jpath.length - 1; i++) {
    if (typeof o[jpath[i]] !== "object" || o[jpath[i]] === null) return;
    o = o[jpath[i]];
  }
  delete o[jpath[jpath.length - 1]];
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
async function runProvider(name, { prompt, model, isDefault, cwd, timeoutMs }) {
  const p = PROVIDERS[name];

  // Run once; if we're on our built-in default and the account can't use it, retry with the model
  // omitted so the CLI picks its own default. Returns the result tagged with the model actually used.
  const exec = async (runCwd, env) => {
    let res = await p.run({ prompt, model, cwd: runCwd, timeoutMs, env });
    let used = model;
    if (!res.ok && isDefault && model && looksLikeModelError(res.error)) {
      process.stderr.write(`gavel: ${name} model "${model}" unavailable (${res.error}); falling back to ${name} CLI default.\n`);
      res = await p.run({ prompt, model: "", cwd: runCwd, timeoutMs, env });
      used = res.ok ? `${name} default` : model;
    }
    return { ...res, model: used };
  };

  if (p.isolation === "readonly-sandbox") {
    return await exec(cwd, process.env);
  }
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), `gavel-${name}-`));
  const env = { ...process.env, PWD: tmpCwd };
  delete env.OLDPWD;
  delete env.INIT_CWD;
  try {
    return await exec(tmpCwd, env);
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
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { opts._.push(a); continue; } // positional (config action/key/value)
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
      model: resolveModel(name, null, config).model,
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

  const { model, isDefault } = resolveModel(provider, opts.model, config);
  const timeoutMs = resolveTimeoutMs(opts, config);
  const res = await runProvider(provider, { prompt, model, isDefault, cwd, timeoutMs });
  const result = { provider, model: res.model, ok: res.ok, text: res.ok ? res.text : "", error: res.ok ? null : res.error };

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
    const { model, isDefault } = resolveModel(name, opts[`${name}-model`], config);
    const res = await runProvider(name, { prompt, model, isDefault, cwd, timeoutMs });
    return { provider: name, model: res.model, ok: res.ok, text: res.ok ? res.text : "", error: res.ok ? null : res.error };
  }));

  if (opts.json) process.stdout.write(JSON.stringify(results, null, 2) + "\n");
  else process.stdout.write(renderFuse(results));
  process.exit(results.some((r) => r.ok) ? 0 : 1);
}

const CONFIG_USAGE =
  `usage: gavel config show [--json]\n` +
  `       gavel config set <key> <value> [--project]\n` +
  `       gavel config unset <key> [--project]\n` +
  `keys: ${configKeyList().join(", ")}\n` +
  `--project edits ./.gavel.json (this repo); default edits ~/.gavel/config.json (all projects).`;

function cmdConfigShow(cwd, opts) {
  const config = loadConfig(cwd);
  warnConfigErrors(config);
  const providers = Object.fromEntries(PROVIDER_NAMES.map((name) => {
    const { model, isDefault } = resolveModel(name, null, config);
    return [name, { enabled: isEnabled(name, config), model, modelIsDefault: isDefault }];
  }));
  const effective = { timeout: resolveTimeoutMs(opts, config) / 1000, panel: resolvePanel(config), providers };

  if (opts.json) {
    process.stdout.write(JSON.stringify(effective, null, 2) + "\n");
    return;
  }

  const userP = userConfigPath(), projP = projectConfigPath(cwd);
  const lines = ["Gavel config (effective)", "========================="];
  lines.push(`timeout: ${effective.timeout}s`);
  lines.push(`panel:   ${effective.panel.length ? effective.panel.join(", ") : "(none)"}`);
  lines.push("");
  for (const name of PROVIDER_NAMES) {
    const s = providers[name];
    lines.push(`${name}: model ${s.model}${s.modelIsDefault ? " (default — auto-falls-back if unavailable)" : " (pinned — no fallback)"} · enabled ${s.enabled ? "✓" : "✗"}`);
  }
  lines.push("");
  lines.push("Sources (low→high precedence; later overrides earlier):");
  lines.push(`  ~/.gavel/config.json  ${fs.existsSync(userP) ? "present" : "absent"}`);
  lines.push(`  ./.gavel.json         ${fs.existsSync(projP) ? "present" : "absent"}`);
  lines.push(`  env vars: GAVEL_TIMEOUT, GAVEL_CODEX_MODEL, GAVEL_GEMINI_MODEL`);
  lines.push("");
  lines.push("Change with: gavel config set <key> <value>  (add --project for this repo only)");
  lines.push(`  e.g. gavel config set timeout 600   ·   gavel config set codex.model gpt-5.5`);
  process.stdout.write(lines.join("\n") + "\n");
}

async function cmdConfig(opts) {
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  const [action = "show", key, value] = opts._;

  if (action === "show") return cmdConfigShow(cwd, opts);

  if (action !== "set" && action !== "unset") {
    process.stderr.write(CONFIG_USAGE + "\n");
    process.exit(2);
  }

  if (!key) { process.stderr.write(`error: ${action} needs a key.\n${CONFIG_USAGE}\n`); process.exit(2); }
  const spec = configKeySpec(key);
  if (!spec) { process.stderr.write(`error: unknown key "${key}".\nkeys: ${configKeyList().join(", ")}\n`); process.exit(2); }

  const file = opts.project ? projectConfigPath(cwd) : userConfigPath();
  const scope = opts.project ? "./.gavel.json (this repo)" : "~/.gavel/config.json (all projects)";
  const obj = readConfigFile(file); // throws on malformed JSON — we refuse to clobber it

  if (action === "set") {
    if (value === undefined) { process.stderr.write(`error: set ${key} needs a value.\n${CONFIG_USAGE}\n`); process.exit(2); }
    let parsed;
    try { parsed = spec.parse(value); } catch (e) { process.stderr.write(`error: ${e.message}\n`); process.exit(2); }
    setPath(obj, spec.path, parsed);
    writeConfigFile(file, obj);
    process.stdout.write(`set ${key} = ${JSON.stringify(parsed)} in ${scope}\n`);
    if (/\.model$/.test(key)) {
      process.stdout.write(`note: a pinned model opts out of auto-fallback — make sure your account can use it, or \`gavel config unset ${key}\` to restore the default.\n`);
    }
  } else {
    unsetPath(obj, spec.path);
    writeConfigFile(file, obj);
    process.stdout.write(`unset ${key} in ${scope}\n`);
  }
}

// --- dispatch --------------------------------------------------------------

const sub = process.argv[2];
const opts = parseArgs(process.argv.slice(3));
const commands = { setup: cmdSetup, run: cmdRun, fuse: cmdFuse, config: cmdConfig };
const handler = commands[sub];
if (!handler) {
  process.stderr.write("usage: gavel <setup|run|fuse|config> [options]\n");
  process.exit(2);
}
handler(opts).catch((err) => {
  process.stderr.write(`gavel: ${err?.stack || err}\n`);
  process.exit(1);
});
