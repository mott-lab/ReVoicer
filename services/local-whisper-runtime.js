// Renderer-side Whisper runtime.
//
// Audio decoding/resampling happens here (OfflineAudioContext is unavailable
// in workers), but model loading and inference run in a Web Worker
// (local-whisper-worker.js) so the main thread — and PDF scrolling — never
// block during transcription. The worker lazy-loads
// @huggingface/transformers from jsdelivr on first use and caches model
// files in browser storage under the pdfc:// origin, so subsequent runs are
// instant and work offline.
//
// We deliberately avoid bundling: no build step, no node_modules size hit.
// Model files come from huggingface.co (CORS-friendly), runtime from jsdelivr.
//
// Exposes `window.__localWhisper.transcribe(blob) → {text}` and
// `window.__localWhisper.isModelCached() → boolean` (used by preload.js in
// offline mode to decide between attempting Whisper and falling back to the
// Vosk live transcript without triggering a model download).
// Progress (model download + inference) is broadcast via DOM events
// `pdfc-whisper-progress` so preload.js can render a toast without coupling
// to this module.

const MODEL_ID = 'Xenova/whisper-tiny.en';
const WORKER_URL = 'services/local-whisper-worker.js';

let _workerPromise = null;
let _nextId = 1;
const _pending = new Map(); // id → { resolve, reject }

function emit(stage, payload) {
  window.dispatchEvent(new CustomEvent('pdfc-whisper-progress', {
    detail: { stage, ...payload },
  }));
}

// The worker is created from a Blob URL rather than the pdfc:// URL directly:
// blob workers inherit the page origin, which sidesteps custom-protocol
// worker-loading restrictions while keeping Cache API storage shared.
async function getWorker() {
  if (_workerPromise) return _workerPromise;
  _workerPromise = (async () => {
    const src = await (await fetch(WORKER_URL)).text();
    const worker = new Worker(
      URL.createObjectURL(new Blob([src], { type: 'text/javascript' })),
      { type: 'module' },
    );
    worker.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.kind === 'progress') {
        const { kind, ...detail } = msg;
        emit(detail.stage, detail);
        return;
      }
      const entry = _pending.get(msg.id);
      if (!entry) return;
      _pending.delete(msg.id);
      if (msg.kind === 'result') entry.resolve({ text: msg.text });
      else entry.reject(new Error(msg.message || 'Whisper worker error'));
    };
    worker.onerror = (err) => {
      // Fatal worker failure (e.g. script load) — fail all in-flight requests
      // and let the next transcribe() spin up a fresh worker.
      for (const entry of _pending.values()) {
        entry.reject(new Error(err?.message || 'Whisper worker crashed'));
      }
      _pending.clear();
      worker.terminate();
      _workerPromise = null;
    };
    return worker;
  })();
  _workerPromise.catch(() => { _workerPromise = null; });
  return _workerPromise;
}

// Decode an audio Blob (webm/opus from MediaRecorder, etc.) into a 16kHz
// mono Float32Array suitable for Whisper. Uses OfflineAudioContext so the
// resampling stays off the main audio graph.
async function decodeTo16kMono(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  // AudioContext just for decoding; sample rate hint is best-effort.
  const decodeCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(
    1, 1, 44100,
  );
  // decodeAudioData on OfflineAudioContext is fine in modern Chromium.
  const audioBuf = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));

  // Mix to mono.
  const length = audioBuf.length;
  const channels = audioBuf.numberOfChannels;
  const mono = new Float32Array(length);
  for (let ch = 0; ch < channels; ch++) {
    const data = audioBuf.getChannelData(ch);
    for (let i = 0; i < length; i++) mono[i] += data[i] / channels;
  }
  if (audioBuf.sampleRate === 16000) return mono;

  // Resample via OfflineAudioContext.
  const targetRate = 16000;
  const targetLength = Math.round(length * targetRate / audioBuf.sampleRate);
  const offline = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(
    1, targetLength, targetRate,
  );
  const buf = offline.createBuffer(1, length, audioBuf.sampleRate);
  buf.copyToChannel(mono, 0);
  const src = offline.createBufferSource();
  src.buffer = buf;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

async function transcribe(blob) {
  const worker = await getWorker();
  emit('decoding', {});
  const samples = await decodeTo16kMono(blob);
  const id = _nextId++;
  const done = new Promise((resolve, reject) => {
    _pending.set(id, { resolve, reject });
  });
  // Transfer the buffer — no copy of potentially minutes of audio.
  worker.postMessage({ id, samples }, [samples.buffer]);
  return done;
}

// Heuristic pre-check: has transformers.js already cached the model weights?
// transformers.js v3 stores downloaded files in the Cache API under
// 'transformers-cache' (written by the worker; blob workers share the page
// origin, so it's visible here). Only a pre-check — the try/catch around
// transcribe() in preload.js remains the real safety net (e.g. cached weights
// but an uncached jsdelivr runtime import would still fail while truly
// offline).
async function isModelCached() {
  try {
    if (!('caches' in window)) return false;
    const cache = await caches.open('transformers-cache');
    const keys = await cache.keys();
    return keys.some((req) => req.url.includes(MODEL_ID) && req.url.includes('.onnx'));
  } catch {
    return false;
  }
}

window.__localWhisper = { transcribe, isModelCached };
