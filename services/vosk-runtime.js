// Renderer-side Vosk runtime — provides a real-time live-transcript shim
// for Electron, where webkitSpeechRecognition is a no-op (Chromium ships
// without the Google Speech API key in non-Chrome builds).
//
// Both the vosk-browser library and the English speech model are bundled
// locally (vendored under node_modules/vosk-browser and downloaded to
// models/ by the postinstall script). Everything loads from pdfc:// over
// the local protocol handler — the app runs fully offline.
//
// On startup the model is loaded in the background so the first mic click
// is instant. Exposes a SpeechRecognition-shaped class on
// `window.__voskRecognition`; speech.js prefers this when present and
// falls back to webkitSpeechRecognition otherwise.
//
// Vosk only fills the live preview — the final transcript still comes from
// the existing Whisper path (local or OpenAI), which has punctuation/casing.
//
// Progress events are dispatched as `pdfc-vosk-progress` so preload.js can
// render a toast without coupling to this module.

const VOSK_LIB = 'pdfc://local/app/node_modules/vosk-browser/dist/vosk.js';
const MODEL_URL = 'pdfc://local/app/models/vosk-model-small-en-us-0.15.tar.gz';

let _modelPromise = null;
let _modelReady = false;
let _voskScriptPromise = null;

function emit(stage, payload = {}) {
  window.dispatchEvent(new CustomEvent('pdfc-vosk-progress', {
    detail: { stage, ...payload },
  }));
}

// vosk-browser is published as a UMD bundle (~5.6 MB) with the Worker and
// WASM inlined as Blob URLs. We inject it once via <script> so it sets
// `window.Vosk`. Async — does not block the renderer.
function loadVoskScript() {
  if (window.Vosk) return Promise.resolve(window.Vosk);
  if (_voskScriptPromise) return _voskScriptPromise;
  _voskScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = VOSK_LIB;
    script.async = true;
    script.onload = () => {
      if (window.Vosk) resolve(window.Vosk);
      else reject(new Error('vosk-browser loaded but window.Vosk is undefined'));
    };
    script.onerror = () => reject(new Error(`Failed to load ${VOSK_LIB}`));
    document.head.appendChild(script);
  });
  _voskScriptPromise.catch(() => { _voskScriptPromise = null; });
  return _voskScriptPromise;
}

// Silent loader — kicked off at app startup so the first mic click is
// instant. Emits no progress events; the interactive path
// (getModelInteractive) handles user-visible toasts only when the user is
// actually waiting.
function ensureModel() {
  if (!_modelPromise) {
    _modelPromise = (async () => {
      const Vosk = await loadVoskScript();
      const model = await Vosk.createModel(MODEL_URL);
      _modelReady = true;
      return model;
    })();
    _modelPromise.catch(() => { _modelPromise = null; });
  }
  return _modelPromise;
}

// Used by start(). If the preload already finished, returns instantly with
// no toast. If the user beat the preload, emit progress events so the toast
// appears.
async function getModelInteractive() {
  if (_modelReady) return _modelPromise;
  emit('loading-model');
  const model = await ensureModel();
  emit('ready');
  return model;
}

// SpeechRecognition-shaped wrapper. speech.js (lib/speech.js)
// expects `new SpeechRecognition()` plus { continuous, interimResults, lang,
// onresult, onerror, onend, start(), stop() }. The result event must be
// shaped like the Web Speech API: { resultIndex, results[i].isFinal,
// results[i][0].transcript }.
class VoskRecognition {
  constructor() {
    this.continuous = true;
    this.interimResults = true;
    this.lang = 'en-US';
    this.onresult = null;
    this.onerror = null;
    this.onend = null;

    this._started = false;
    this._stream = null;
    this._audioContext = null;
    this._sourceNode = null;
    this._processorNode = null;
    this._recognizer = null;
    this._finalSegments = [];
    this._interim = '';
  }

  async start() {
    if (this._started) return;
    this._started = true;
    try {
      const model = await getModelInteractive();
      // Cancelled while the model was loading.
      if (!this._started) return;

      this._stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this._audioContext = new (window.AudioContext || window.webkitAudioContext)();
      // Vosk handles resampling internally when constructed at the
      // AudioContext's actual sampleRate.
      this._recognizer = new model.KaldiRecognizer(this._audioContext.sampleRate);

      this._recognizer.on('result', (msg) => {
        const text = msg?.result?.text || '';
        if (!text) return;
        const newIndex = this._finalSegments.length;
        this._finalSegments.push(text);
        this._interim = '';
        this._fireResult(newIndex);
      });
      this._recognizer.on('partialresult', (msg) => {
        const partial = msg?.result?.partial || '';
        if (partial === this._interim) return;
        this._interim = partial;
        this._fireResult(this._finalSegments.length);
      });

      this._sourceNode = this._audioContext.createMediaStreamSource(this._stream);
      this._processorNode = this._audioContext.createScriptProcessor(4096, 1, 1);
      this._processorNode.onaudioprocess = (event) => {
        try { this._recognizer.acceptWaveform(event.inputBuffer); }
        catch { /* recognizer may be torn down mid-frame */ }
      };
      this._sourceNode.connect(this._processorNode);
      // ScriptProcessor only ticks while connected to the destination, but
      // we don't want the mic echoed back — route through a muted gain node.
      const muted = this._audioContext.createGain();
      muted.gain.value = 0;
      this._processorNode.connect(muted);
      muted.connect(this._audioContext.destination);

      emit('listening');
    } catch (err) {
      this._started = false;
      this._cleanup();
      this.onerror?.({ error: err?.message || String(err) });
    }
  }

  stop() {
    if (!this._started) return;
    this._started = false;
    // Best-effort flush of any in-flight partial.
    try {
      const tail = this._recognizer?.finalResult?.()?.text;
      if (tail) {
        const newIndex = this._finalSegments.length;
        this._finalSegments.push(tail);
        this._interim = '';
        this._fireResult(newIndex);
      }
    } catch { /* noop */ }
    this._cleanup();
    emit('done');
    this.onend?.();
  }

  _fireResult(resultIndex) {
    if (!this.onresult) return;
    const results = this._finalSegments.map((seg) => ({
      isFinal: true,
      0: { transcript: seg + ' ', confidence: 1 },
      length: 1,
    }));
    if (this._interim) {
      results.push({
        isFinal: false,
        0: { transcript: this._interim, confidence: 0 },
        length: 1,
      });
    }
    this.onresult({ resultIndex, results });
  }

  _cleanup() {
    try { this._processorNode?.disconnect(); } catch {}
    try { this._sourceNode?.disconnect(); } catch {}
    try { this._stream?.getTracks().forEach((t) => t.stop()); } catch {}
    try { this._audioContext?.close(); } catch {}
    try { this._recognizer?.remove?.(); } catch {}
    this._processorNode = null;
    this._sourceNode = null;
    this._stream = null;
    this._audioContext = null;
    this._recognizer = null;
  }
}

window.__voskRecognition = VoskRecognition;

// Kick off the model download in the background as soon as the renderer
// loads, so the first mic click is instant. Skipped when speech is
// disabled in settings; uses HTTP cache on subsequent launches.
(async () => {
  try {
    const settings = await window.desktop?.getSettings?.();
    if (settings?.speech_provider === 'off') return;
  } catch { /* settings unavailable on first run is fine — preload anyway */ }
  ensureModel().catch(() => { /* surfaced via toast on user-initiated start() */ });
})();
