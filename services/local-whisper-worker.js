// Whisper inference worker. Runs the transformers.js pipeline off the main
// thread so model download + WASM/WebGPU inference never block scrolling or
// other UI. Loaded by local-whisper-runtime.js as a Blob-URL module worker
// (same origin, so the 'transformers-cache' Cache API storage is shared with
// the page and previously downloaded model weights are reused).
//
// Protocol: receives { id, samples } (16 kHz mono Float32Array, transferred);
// posts { kind: 'progress', stage, ... } during load/inference and a final
// { kind: 'result', id, text } or { kind: 'error', id, message }.

const TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/+esm';
const MODEL_ID = 'Xenova/whisper-tiny.en';

let _pipelinePromise = null;

function emit(stage, payload) {
  self.postMessage({ kind: 'progress', stage, ...payload });
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

self.onmessage = async (e) => {
  const { id, samples } = e.data;
  try {
    const transcriber = await getPipeline();
    emit('inferring', { samples: samples.length });
    // Whisper's encoder has a hard 30-second context window. Without these
    // parameters, transformers.js silently truncates the input — anything past
    // 30 s gets dropped from the transcript. chunk_length_s splits the audio
    // into 30 s windows; stride_length_s adds overlap so words on chunk
    // boundaries don't get clipped.
    const result = await transcriber(samples, {
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    emit('done', {});
    self.postMessage({ kind: 'result', id, text: (result?.text || '').trim() });
  } catch (err) {
    self.postMessage({ kind: 'error', id, message: err?.message || String(err) });
  }
};
