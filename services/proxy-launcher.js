// PDF Converser - claude-max-api-proxy launcher.
// The app's openai_compat providers point at the local claude-max-api-proxy
// (vendor/claude-max-api-proxy submodule, port 3456). On startup, spawn it if
// nothing is listening there yet; stop that child on quit. A proxy started
// manually in a terminal is detected via /health and left alone.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PROXY_PORT = 3456;
const PROXY_ENTRY = path.join(
  __dirname, '..', 'vendor', 'claude-max-api-proxy', 'dist', 'server', 'standalone.js'
);

let child = null;

async function isProxyUp() {
  try {
    const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Fire-and-forget: never blocks app startup; failures are logged, and LLM
// calls surface their own errors if the proxy truly isn't reachable.
async function ensureProxy() {
  if (child) return;
  if (await isProxyUp()) {
    console.log(`[proxy] already running on port ${PROXY_PORT} — not spawning`);
    return;
  }
  if (!fs.existsSync(PROXY_ENTRY)) {
    console.warn(`[proxy] not built (${PROXY_ENTRY} missing) — run "npm run proxy:build"`);
    return;
  }
  // Electron's binary doubles as Node when ELECTRON_RUN_AS_NODE is set, so
  // the proxy runs without needing a node executable on PATH.
  child = spawn(process.execPath, [PROXY_ENTRY, String(PROXY_PORT)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (d) => process.stdout.write(`[proxy] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[proxy] ${d}`));
  child.on('exit', (code) => {
    if (code !== null && code !== 0) console.warn(`[proxy] exited with code ${code}`);
    child = null;
  });
}

function stopProxy() {
  if (child) {
    child.kill();
    child = null;
  }
}

module.exports = { ensureProxy, stopProxy };
