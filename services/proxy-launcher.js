// PDF Converser - bundled claude-max-api-proxy lifecycle.
//
// The proxy (vendor/claude-max-api-proxy) is an OpenAI-compatible server that
// wraps the Claude Code CLI, letting a Claude subscription drive the app's LLM
// features without an API key. It is strictly OPT-IN: nothing here runs unless
// the user ticks "Use bundled Claude Code CLI proxy" in Settings and passes
// setupAndTest(). Users without the CLI installed never touch it.
//
// Lifecycle:
//   Settings → setupAndTest()  resolves the CLI, builds on demand, starts the
//                              server, and proves it end to end with a real
//                              chat round-trip.
//   startup  → ensureProxy()   only when the setting is on (see main.js).
//   chat()   → ensureProxy()   safety net if the startup spawn failed or the
//                              proxy crashed mid-session (see llm-service.js).
//
// Every function returns a result object and never throws — Electron strips
// custom error properties across the IPC boundary, so codes travel in the
// payload (same pattern as desktop:generateStyleGuide).

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { setupProxy, cancelBuild, isBuilt: buildArtifactExists } = require('../scripts/setup-proxy');

const PROXY_PORT = 3456;
const PROXY_HOST = '127.0.0.1';
// Written into the Settings base-URL field. 127.0.0.1 rather than localhost:
// the proxy binds 127.0.0.1 only, and localhost can resolve to ::1 first.
const PROXY_BASE_URL = `http://${PROXY_HOST}:${PROXY_PORT}/v1`;
const HEALTH_URL = `http://${PROXY_HOST}:${PROXY_PORT}/health`;
// Maps to the "sonnet" CLI alias in the proxy's MODEL_MAP. Model ids it does
// not recognize silently route to Opus.
const DEFAULT_MODEL = 'claude-sonnet-4-5';
const PROXY_ENTRY = path.join(
  __dirname, '..', 'vendor', 'claude-max-api-proxy', 'dist', 'server', 'standalone.js'
);

let child = null;              // the server process, when we spawned it
let starting = null;           // single-flight promise for ensureProxy
let stderrTail = '';           // last ~8 KB of the child's stderr
let lastExit = null;           // { code, at } of the most recent exit
let lastHealthOkAt = 0;        // ms timestamp of the last confirmed /health
let restarts = [];             // spawn timestamps, for the crash-loop guard
let setupInFlight = false;

// Accepts localhost/::1 too, so a hand-typed base URL still gets the safety net.
function isBundledProxyUrl(url) {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):3456(\/.*)?$/i.test(String(url || '').trim());
}

// Is anything listening, and is it actually our proxy? /health on the real
// server reports provider 'claude-code-cli'; anything else owns the port.
async function probe() {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return { up: true, ours: false, foreign: true, provider: null };
    const json = await res.json().catch(() => ({}));
    const ours = json.provider === 'claude-code-cli';
    if (ours) lastHealthOkAt = Date.now();
    return { up: true, ours, foreign: !ours, provider: json.provider || null };
  } catch {
    return { up: false, ours: false, foreign: false, provider: null };
  }
}

// Locate the Claude CLI binary. The proxy spawns it WITHOUT a shell, so on
// Windows a .cmd/.bat shim would fail with ENOENT — detect that here and pass
// the resolved path down via CLAUDE_BIN (which the proxy honors) so PATH
// differences between this process and the child can't break it.
function resolveClaudeBin() {
  const fromEnv = process.env.CLAUDE_BIN;
  let candidate = fromEnv;

  if (!candidate) {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    let out = '';
    try {
      const res = spawnSync(finder, ['claude'], { encoding: 'utf-8', windowsHide: true });
      out = res.status === 0 ? String(res.stdout || '') : '';
    } catch { out = ''; }
    const hits = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (hits.length === 0) {
      return {
        ok: false,
        code: 'CLI_NOT_FOUND',
        message: 'Claude Code CLI not found on your PATH. Install it, then run Set up and test again.',
      };
    }
    // Prefer a real executable over a shim (see the .cmd check below).
    candidate = process.platform === 'win32'
      ? (hits.find((h) => /\.exe$/i.test(h)) || hits[0])
      : hits[0];
  }

  if (fromEnv && !fs.existsSync(candidate)) {
    return {
      ok: false,
      code: 'CLI_NOT_FOUND',
      message: `CLAUDE_BIN is set to "${candidate}", but no file exists there.`,
    };
  }

  // Node cannot spawn .cmd/.bat without a shell, and the proxy spawns the CLI
  // without one — so a shim would fail there even though it works in a
  // terminal. Catch it here with an actionable message instead of a confusing
  // ENOENT later.
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(candidate)) {
    return {
      ok: false,
      code: 'CLI_SHIM_ONLY',
      message: `The claude command resolves to a script shim (${candidate}). The proxy launches the CLI `
        + 'without a shell, which cannot run .cmd/.bat files. Install the native CLI executable, '
        + 'or point the CLAUDE_BIN environment variable at one.',
    };
  }

  try {
    const res = spawnSync(candidate, ['--version'], { encoding: 'utf-8', timeout: 5000, windowsHide: true });
    if (res.status !== 0) {
      return {
        ok: false,
        code: 'CLI_VERSION_FAILED',
        message: `"${candidate} --version" failed: ${String(res.stderr || res.error?.message || '').trim().slice(0, 300)}`,
      };
    }
    return { ok: true, path: candidate, version: String(res.stdout || '').trim() };
  } catch (err) {
    return { ok: false, code: 'CLI_VERSION_FAILED', message: err.message || String(err) };
  }
}

// PDFC_PROXY_FORCE_BUILD lets tests exercise the build step without deleting
// the real dist/.
function isBuilt() {
  if (process.env.PDFC_PROXY_FORCE_BUILD) return false;
  return buildArtifactExists();
}

async function buildProxy({ force = false, onLine } = {}) {
  return setupProxy({ force, onLine });
}

// Where the Claude CLI runs. The proxy invokes it with
// --dangerously-skip-permissions and defaults cwd to process.cwd(), which would
// be wherever the app was launched from. Point it at an app-owned scratch dir
// so any tool use stays contained.
function proxyCwd() {
  try {
    const { app } = require('electron');
    const dir = path.join(app.getPath('userData'), 'proxy-cwd');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return undefined; // non-Electron context (tests) — fall back to default
  }
}

function mapExitMessage(stderr) {
  const s = String(stderr || '');
  if (/Port \d+ is already in use/i.test(s)) {
    return { code: 'PORT_IN_USE', message: `Port ${PROXY_PORT} is already in use by another process.` };
  }
  if (/Claude CLI not found/i.test(s)) {
    return { code: 'CLI_NOT_FOUND', message: 'The proxy could not find the Claude Code CLI.' };
  }
  const tail = s.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 300);
  return { code: 'EXITED', message: tail ? `The proxy exited: ${tail}` : 'The proxy exited unexpectedly.' };
}

// Start the proxy if it isn't already running, resolving only once it answers
// /health (or fails). Safe to call concurrently and on every LLM request.
async function ensureProxy({ timeoutMs = 20000 } = {}) {
  // Fast path: our child is alive and answered health recently.
  if (child && child.exitCode === null && Date.now() - lastHealthOkAt < 10000) {
    return { ok: true, code: 'OK', state: 'already', message: 'Proxy running.' };
  }
  if (starting) return starting;
  starting = (async () => {
    const seen = await probe();
    if (seen.ours) {
      return { ok: true, code: 'OK', state: child ? 'already' : 'external', message: 'Proxy already running.' };
    }
    if (seen.foreign) {
      return {
        ok: false,
        code: 'PORT_FOREIGN',
        message: `Port ${PROXY_PORT} is in use by another service (it did not identify as the Claude proxy). `
          + 'Stop that service and try again.',
      };
    }
    if (!isBuilt()) {
      return {
        ok: false,
        code: 'NOT_BUILT',
        message: 'The bundled Claude proxy is not built yet. Open Settings and click "Set up and test".',
      };
    }
    const cli = resolveClaudeBin();
    if (!cli.ok) return { ok: false, code: cli.code, message: cli.message };

    // Crash-loop guard: don't respawn endlessly behind a failing CLI.
    const now = Date.now();
    restarts = restarts.filter((t) => now - t < 60000);
    if (restarts.length >= 3) {
      return {
        ok: false,
        code: 'CRASH_LOOP',
        message: 'The proxy exited repeatedly. Open Settings and run "Set up and test" to see why.',
      };
    }
    restarts.push(now);

    stderrTail = '';
    const proc = spawn(process.execPath, [PROXY_ENTRY, String(PROXY_PORT)], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        CLAUDE_BIN: cli.path,
        // Without this the proxy discards the CLI's stderr, leaving every
        // failure as a bare exit code.
        DEBUG_SUBPROCESS: '1',
        // Drop the proxy's OpenClaw tool-mapping system prompt — ~40 lines of
        // instructions about tools that don't exist here, appended to every
        // request otherwise.
        NO_OPENCLAW_PROMPT: '1',
      },
      cwd: proxyCwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child = proc;
    proc.stdout.on('data', (d) => process.stdout.write(`[proxy] ${d}`));
    proc.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d).slice(-8192);
      process.stderr.write(`[proxy] ${d}`);
    });

    let exited = null;
    proc.on('exit', (code) => {
      exited = { code, at: Date.now() };
      lastExit = exited;
      if (child === proc) child = null;
    });

    // Race readiness against the child dying and the overall timeout.
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (exited) {
        const mapped = mapExitMessage(stderrTail);
        return { ok: false, code: mapped.code, message: mapped.message, stderr: stderrTail.slice(-1000) };
      }
      const p = await probe();
      if (p.ours) return { ok: true, code: 'OK', state: 'spawned', message: 'Proxy started.' };
      if (Date.now() > deadline) {
        return {
          ok: false,
          code: 'TIMEOUT',
          message: `The proxy did not become ready within ${Math.round(timeoutMs / 1000)}s.`,
          stderr: stderrTail.slice(-1000),
        };
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  })().finally(() => { starting = null; });
  return starting;
}

// Only ever kills a proxy we spawned — one started manually in a terminal is
// left alone. Also cancels an in-flight build.
function stopProxy() {
  cancelBuild();
  if (!child) return;
  const proc = child;
  child = null;
  try {
    if (process.platform === 'win32' && proc.pid) {
      // /T so per-request `claude` grandchildren go too.
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
    } else {
      proc.kill();
    }
  } catch { /* best effort */ }
}

function status() {
  return {
    built: isBuilt(),
    spawned: !!child && child.exitCode === null,
    pid: child ? child.pid : null,
    lastExit,
  };
}

// A real chat round-trip. This is the only step that proves the CLI works and
// is logged in: /health never touches the CLI, and the proxy's /v1/models
// returns a hardcoded list, so both pass with no CLI at all.
async function chatRoundTrip(model, timeoutMs = 120000) {
  const t0 = Date.now();
  try {
    const res = await fetch(`http://${PROXY_HOST}:${PROXY_PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
        max_tokens: 16,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, body: text.slice(0, 500), latencyMs: Date.now() - t0 };
    let json;
    try { json = JSON.parse(text); } catch {
      return { ok: false, status: res.status, body: text.slice(0, 500), latencyMs: Date.now() - t0 };
    }
    const content = json?.choices?.[0]?.message?.content;
    if (!content) {
      return { ok: false, status: res.status, body: text.slice(0, 500), latencyMs: Date.now() - t0 };
    }
    return { ok: true, content, latencyMs: Date.now() - t0 };
  } catch (err) {
    const timedOut = /abort|timeout/i.test(String(err?.message || err));
    return { ok: false, timedOut, body: err?.message || String(err), latencyMs: Date.now() - t0 };
  }
}

// Distinguishes "the CLI itself is broken/logged out" from "the proxy's CLI
// invocation is stale" — both surface as an identical 500 from the proxy.
function cliDirectCheck(binPath) {
  try {
    const res = spawnSync(binPath, ['--print', '--model', 'sonnet', 'say ok'], {
      encoding: 'utf-8', timeout: 60000, windowsHide: true,
    });
    const out = `${res.stdout || ''}${res.stderr || ''}`;
    return { ok: res.status === 0, output: out.trim().slice(0, 400) };
  } catch (err) {
    return { ok: false, output: err.message || String(err) };
  }
}

async function fetchModels() {
  try {
    const res = await fetch(`http://${PROXY_HOST}:${PROXY_PORT}/v1/models`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const json = await res.json();
    return (json.data || []).map((m) => m.id).filter(Boolean).sort();
  } catch {
    return [];
  }
}

// Full opt-in setup, driven by the Settings "Set up and test" button. Runs the
// steps in order, reporting each one, and stops at the first hard failure.
// Returns { ok, code, message, steps, models, baseUrl, model } and never throws.
async function setupAndTest({ model, onProgress } = {}) {
  if (setupInFlight) {
    return {
      ok: false,
      code: 'BUSY',
      message: 'A proxy setup is already running — wait for it to finish.',
      steps: [],
    };
  }
  setupInFlight = true;
  const steps = [];
  const useModel = (model || '').trim() || DEFAULT_MODEL;

  const step = (id, label, status, detail) => {
    const entry = { id, label, status, detail: detail || '' };
    const existing = steps.findIndex((s) => s.id === id);
    if (existing >= 0) steps[existing] = entry; else steps.push(entry);
    onProgress?.(entry);
    return entry;
  };
  const fail = (id, label, code, message) => {
    step(id, label, 'fail', message);
    return { ok: false, code, message, steps, model: useModel, baseUrl: PROXY_BASE_URL };
  };

  try {
    // 1. Claude CLI
    step('cli', 'Claude Code CLI', 'run');
    const cli = resolveClaudeBin();
    if (!cli.ok) return fail('cli', 'Claude Code CLI', cli.code, cli.message);
    step('cli', 'Claude Code CLI', 'ok', `${cli.version} — ${cli.path}`);

    // 2. Build (on demand)
    if (isBuilt()) {
      step('build', 'Proxy build', 'skip', 'Already built.');
    } else {
      step('build', 'Proxy build', 'run', 'Installing dependencies and compiling…');
      const built = await buildProxy({
        onLine: (line) => step('build', 'Proxy build', 'run', line),
      });
      if (!built.ok) return fail('build', 'Proxy build', built.code, built.message);
      step('build', 'Proxy build', 'ok', 'Compiled.');
    }

    // 3. Port ownership
    step('port', `Port ${PROXY_PORT}`, 'run');
    const seen = await probe();
    if (seen.foreign) {
      return fail('port', `Port ${PROXY_PORT}`, 'PORT_FOREIGN',
        `Port ${PROXY_PORT} is in use by another service (it did not identify as the Claude proxy). `
        + 'Stop that service and try again.');
    }
    step('port', `Port ${PROXY_PORT}`, 'ok', seen.ours ? 'Proxy already listening.' : 'Free.');

    // 4. Start
    step('start', 'Start proxy', 'run');
    const started = await ensureProxy({ timeoutMs: 25000 });
    if (!started.ok) {
      return fail('start', 'Start proxy', started.code,
        started.stderr ? `${started.message}\n${started.stderr.slice(-400)}` : started.message);
    }
    step('start', 'Start proxy', 'ok',
      started.state === 'external' ? 'Using a proxy that was already running.' : 'Listening.');

    // 5. Real chat round-trip — the only step that proves the CLI works.
    step('chat', 'Live request', 'run', 'Asking Claude for a one-word reply…');
    const chat = await chatRoundTrip(useModel);
    if (!chat.ok) {
      const direct = cliDirectCheck(cli.path);
      if (chat.timedOut) {
        return fail('chat', 'Live request', 'CHAT_TIMEOUT',
          'No response within 120s. The first request can be slow — try again, or run '
          + '`claude -p hi` in a terminal to check the CLI.');
      }
      if (direct.ok) {
        return fail('chat', 'Live request', 'PROXY_FLAGS',
          'Your Claude Code CLI works, but the bundled proxy could not drive it — the vendored proxy is '
          + 'likely out of date for your CLI version. Update it with: '
          + 'git -C vendor/claude-max-api-proxy pull, then npm run proxy:build.'
          + (chat.body ? `\nProxy said: ${chat.body.slice(0, 200)}` : ''));
      }
      if (/log ?in|auth|credential|unauthor|api key/i.test(direct.output)) {
        return fail('chat', 'Live request', 'AUTH_FAILED',
          'The Claude Code CLI is not logged in. Run `claude` in a terminal, finish the login, then try again.'
          + `\nCLI said: ${direct.output.slice(0, 200)}`);
      }
      return fail('chat', 'Live request', 'CHAT_FAILED',
        `The request failed.${chat.body ? ` Proxy said: ${chat.body.slice(0, 200)}` : ''}`
        + (direct.output ? `\nCLI said: ${direct.output.slice(0, 200)}` : ''));
    }
    step('chat', 'Live request', 'ok', `Replied in ${(chat.latencyMs / 1000).toFixed(1)}s.`);

    // 6. Models (non-fatal)
    const models = await fetchModels();
    if (!/opus|sonnet|haiku/i.test(useModel)) {
      step('models', 'Models', 'warn',
        `"${useModel}" is not a recognized Claude model id — the proxy will route it to Opus.`);
    } else {
      step('models', 'Models', 'ok', `${models.length} available.`);
    }

    return {
      ok: true,
      code: 'OK',
      message: `Connected — replied in ${(chat.latencyMs / 1000).toFixed(1)}s using ${useModel}.`,
      steps,
      models,
      baseUrl: PROXY_BASE_URL,
      model: useModel,
    };
  } catch (err) {
    return {
      ok: false,
      code: 'INTERNAL',
      message: err?.message || String(err),
      steps,
      model: useModel,
      baseUrl: PROXY_BASE_URL,
    };
  } finally {
    setupInFlight = false;
  }
}

module.exports = {
  PROXY_PORT,
  PROXY_BASE_URL,
  DEFAULT_MODEL,
  isBundledProxyUrl,
  probe,
  resolveClaudeBin,
  isBuilt,
  buildProxy,
  ensureProxy,
  stopProxy,
  status,
  setupAndTest,
};
