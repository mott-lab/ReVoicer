#!/usr/bin/env node
// Ensures the claude-max-api-proxy submodule (vendor/claude-max-api-proxy)
// is checked out and compiled, so services/proxy-launcher.js can auto-start
// it. Runs as a postinstall step: a fresh `git clone` + `npm install` is all
// that's needed, even if the clone skipped --recurse-submodules. Skips the
// build when dist/ already exists (re-runs of npm install are a no-op);
// force a rebuild with `npm run proxy:build`. Failures warn but never fail
// the install — the app runs without the proxy, it just won't auto-start.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PROXY_DIR = path.join(ROOT, 'vendor', 'claude-max-api-proxy');
const PROXY_PKG = path.join(PROXY_DIR, 'package.json');
const PROXY_ENTRY = path.join(PROXY_DIR, 'dist', 'server', 'standalone.js');

function run(cmd, args, cwd) {
  // shell: true so Windows resolves npm.cmd
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  return res.status === 0;
}

// Check out the submodule if the clone skipped --recurse-submodules.
if (!fs.existsSync(PROXY_PKG)) {
  console.log('claude-max-api-proxy submodule not checked out — initializing…');
  const ok = run('git', ['submodule', 'update', '--init', 'vendor/claude-max-api-proxy'], ROOT);
  if (!ok || !fs.existsSync(PROXY_PKG)) {
    console.warn(
      'WARNING: could not initialize vendor/claude-max-api-proxy. The app still runs,\n' +
      'but the bundled LLM proxy will not auto-start. To fix:\n' +
      '  git submodule update --init\n' +
      '  npm run proxy:build'
    );
    process.exit(0);
  }
}

if (fs.existsSync(PROXY_ENTRY)) {
  console.log('claude-max-api-proxy already built — skipping (use `npm run proxy:build` to rebuild).');
  process.exit(0);
}

console.log('Building claude-max-api-proxy…');
const built =
  run('npm', ['ci', '--no-audit', '--no-fund'], PROXY_DIR) &&
  run('npm', ['run', 'build'], PROXY_DIR);
if (!built || !fs.existsSync(PROXY_ENTRY)) {
  console.warn('WARNING: proxy build failed. The app still runs; retry with `npm run proxy:build`.');
}
process.exit(0);
