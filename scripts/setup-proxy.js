#!/usr/bin/env node
// Checks out and compiles the claude-max-api-proxy submodule
// (vendor/claude-max-api-proxy) so services/proxy-launcher.js can start it.
//
// This is NOT an install step — the proxy is opt-in, so the build runs on
// demand the first time a user ticks "Use bundled Claude Code CLI proxy" in
// Settings (via proxy-launcher's setupAndTest), or manually with
// `npm run proxy:build`. Output is streamed line-by-line through `onLine` so
// the Settings UI can show progress; nothing here writes to the console
// except when run directly from the command line.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PROXY_DIR = path.join(ROOT, 'vendor', 'claude-max-api-proxy');
const PROXY_PKG = path.join(PROXY_DIR, 'package.json');
const PROXY_ENTRY = path.join(PROXY_DIR, 'dist', 'server', 'standalone.js');

// Tracks the in-flight child so the app can kill a build on quit.
let current = null;

function run(cmd, args, cwd, onLine) {
  return new Promise((resolve) => {
    let child;
    try {
      // Windows needs a shell to run npm (a .cmd wrapper Node refuses to spawn
      // directly). Pass the whole command as one string rather than an args
      // array — same result, minus Node's shell+args deprecation warning. Every
      // argument here is a hardcoded constant, so there is nothing to escape.
      child = process.platform === 'win32'
        ? spawn([cmd, ...args].join(' '), { cwd, shell: true, windowsHide: true })
        : spawn(cmd, args, { cwd, windowsHide: true });
    } catch (err) {
      onLine?.(`${cmd} failed to start: ${err.message}`);
      return resolve({ ok: false, spawnFailed: true });
    }
    current = child;
    const feed = (buf) => {
      for (const line of String(buf).split(/\r?\n/)) {
        if (line.trim()) onLine?.(line.trim());
      }
    };
    child.stdout?.on('data', feed);
    child.stderr?.on('data', feed);
    // ENOENT etc. — the binary isn't on PATH.
    child.on('error', (err) => {
      onLine?.(`${cmd} failed to start: ${err.message}`);
      current = null;
      resolve({ ok: false, spawnFailed: true });
    });
    child.on('close', (code) => {
      current = null;
      resolve({ ok: code === 0, code });
    });
  });
}

// Kill an in-flight build (app quitting). Best effort.
function cancelBuild() {
  if (!current) return;
  const child = current;
  current = null;
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill();
    }
  } catch { /* best effort */ }
}

function isBuilt() {
  return fs.existsSync(PROXY_ENTRY);
}

// Returns { ok, code, message, log }. `code` is 'OK' | 'ALREADY_BUILT' |
// 'NOT_BUILDABLE' | 'SUBMODULE_MISSING' | 'GIT_MISSING' | 'BUILD_TOOL_MISSING'
// | 'BUILD_FAILED'. Never throws.
async function setupProxy({ force = false, onLine } = {}) {
  const log = [];
  const emit = (line) => { log.push(line); onLine?.(line); };

  // A packaged app has no source tree or npm to build with.
  if (__dirname.includes('app.asar')) {
    return {
      ok: false,
      code: 'NOT_BUILDABLE',
      message: 'This packaged build cannot compile the proxy. Run it from a source checkout.',
      log,
    };
  }

  if (!force && isBuilt()) {
    return { ok: true, code: 'ALREADY_BUILT', message: 'Proxy already built.', log };
  }

  // Check out the submodule if the clone skipped --recurse-submodules.
  if (!fs.existsSync(PROXY_PKG)) {
    emit('Submodule not checked out — running git submodule update --init…');
    const res = await run('git', ['submodule', 'update', '--init', 'vendor/claude-max-api-proxy'], ROOT, emit);
    if (res.spawnFailed) {
      return {
        ok: false,
        code: 'GIT_MISSING',
        message: 'git is not available, so vendor/claude-max-api-proxy could not be checked out.',
        log,
      };
    }
    if (!res.ok || !fs.existsSync(PROXY_PKG)) {
      return {
        ok: false,
        code: 'SUBMODULE_MISSING',
        message: 'Could not check out vendor/claude-max-api-proxy. Needs git and a network connection. '
          + 'Fix manually with: git submodule update --init',
        log,
      };
    }
  }

  emit('Installing proxy dependencies…');
  const install = await run('npm', ['ci', '--no-audit', '--no-fund'], PROXY_DIR, emit);
  if (install.spawnFailed) {
    return {
      ok: false,
      code: 'BUILD_TOOL_MISSING',
      message: 'npm is not on this app\'s PATH. Run `npm run proxy:build` in a terminal instead.',
      log,
    };
  }
  if (!install.ok) {
    return { ok: false, code: 'BUILD_FAILED', message: 'npm ci failed for the proxy.', log };
  }

  emit('Compiling proxy…');
  const build = await run('npm', ['run', 'build'], PROXY_DIR, emit);
  if (!build.ok || !isBuilt()) {
    return { ok: false, code: 'BUILD_FAILED', message: 'The proxy build (tsc) failed.', log };
  }

  return { ok: true, code: 'OK', message: 'Proxy built.', log };
}

module.exports = { setupProxy, cancelBuild, isBuilt, PROXY_DIR, PROXY_ENTRY };

if (require.main === module) {
  setupProxy({ force: process.argv.includes('--force'), onLine: (l) => console.log(l) })
    .then((res) => {
      console.log(res.ok ? res.message : `FAILED (${res.code}): ${res.message}`);
      process.exit(res.ok ? 0 : 1);
    });
}
