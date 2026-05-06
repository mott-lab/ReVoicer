// Renderer-side Whisper runtime.
//
// Lazy-loads @huggingface/transformers from jsdelivr on first transcribe()
// call (so app startup pays nothing), runs the model in the page's WASM
// (or WebGPU when available) sandbox, and caches the model files in browser
// storage under the pdfc:// origin so subsequent runs are instant.
//
// We deliberately avoid bundling: no build step, no node_modules size hit.
// Model files come from huggingface.co (CORS-friendly), runtime from jsdelivr.
//
// Exposes `window.__localWhisper.transcribe(blob) → {text}`.
// Progress (model download + inference) is broadcast via DOM events
// `pdfc-whisper-progress` so preload.js can render a toast without coupling
// to this module.

const TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/+esm';
const MODEL_ID = 'Xenova/whisper-tiny.en';

let _pipelinePromise = null;

function emit(stage, payload) {
  window.dispatchEvent(new CustomEvent('pdfc-whisper-progress', {
    detail: { stage, ...payload },
  }));
}

async function getPipeline() {
  if (_pipelinePromise) return _pipelinePromise;
  _pipelinePromise = (async () => {
    emit('loading-runtime', {});
    const { pipeline, env } = await import(TRANSFORMERS_CDN);
    // We don't ship local model files — let the lib pull from HF Hub.
    env.allowLocalModels = false;
    emit('loading-model', { model: MODEL_ID });
    const transcriber = await pipeline('automatic-speech-recognition', MODEL_ID, {
      progress_callback: (p) => {
        // p shape: { status, name, file, progress, loaded, total }
        emit('model-progress', p);
      },
    });
    emit('ready', {});
    return transcriber;
  })();
  // If the load fails we want the next call to retry, not stay stuck on a
  // rejected promise.
  _pipelinePromise.catch(() => { _pipelinePromise = null; });
  return _pipelinePromise;
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
  const transcriber = await getPipeline();
  emit('decoding', {});
  const samples = await decodeTo16kMono(blob);
  emit('inferring', { samples: samples.length });
  const result = await transcriber(samples);
  emit('done', {});
  return { text: (result?.text || '').trim() };
}

window.__localWhisper = { transcribe };
