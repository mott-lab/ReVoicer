#!/usr/bin/env node
// Downloads the small English Vosk model used by services/vosk-runtime.js
// for live transcription. Runs as a postinstall step so `npm install` in
// desktop/ leaves the app fully offline-ready. Skips the download when the
// file already exists (re-runs of npm install are a no-op).

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const MODEL_URL = 'https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz';
const MODEL_DIR = path.join(__dirname, '..', 'models');
const MODEL_PATH = path.join(MODEL_DIR, 'vosk-model-small-en-us-0.15.tar.gz');
const MIN_BYTES = 10 * 1024 * 1024; // ~40 MB expected; abort if much smaller

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const req = https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlink(dest, () => {});
        return resolve(download(res.headers.location, dest));
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      let lastPct = -1;
      res.on('data', (chunk) => {
        received += chunk.length;
        if (total > 0) {
          const pct = Math.floor((received / total) * 100);
          if (pct !== lastPct && pct % 10 === 0) {
            process.stdout.write(`  …${pct}%\n`);
            lastPct = pct;
          }
        }
      });
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    });
    req.on('error', (err) => {
      file.close();
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

(async () => {
  if (fs.existsSync(MODEL_PATH)) {
    const stat = fs.statSync(MODEL_PATH);
    if (stat.size >= MIN_BYTES) {
      console.log(`vosk model already present (${(stat.size / 1024 / 1024).toFixed(1)} MB) — skipping download`);
      return;
    }
    // Truncated previous run — re-download.
    fs.unlinkSync(MODEL_PATH);
  }
  fs.mkdirSync(MODEL_DIR, { recursive: true });
  console.log(`Downloading Vosk model → ${MODEL_PATH}`);
  try {
    await download(MODEL_URL, MODEL_PATH);
    const stat = fs.statSync(MODEL_PATH);
    console.log(`Done (${(stat.size / 1024 / 1024).toFixed(1)} MB).`);
  } catch (err) {
    console.error(`Failed to download Vosk model: ${err.message}`);
    console.error(`Live transcription will be disabled until the file at`);
    console.error(`  ${MODEL_PATH}`);
    console.error(`is present. Re-run \`npm run fetch-vosk-model\` to retry.`);
    process.exitCode = 0; // don't fail the whole install
  }
})();
