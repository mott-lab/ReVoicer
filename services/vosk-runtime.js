// Renderer-side Vosk runtime — provides a real-time live-transcript shim
// for Electron, where webkitSpeechRecognition is a no-op (Chromium ships
// without the Google Speech API key in non-Chrome builds).
//
// Lazy-loads vosk-browser from jsdelivr on first start() call, downloads the
// small English Vosk model into the renderer's HTTP cache, and exposes a
// SpeechRecognition-shaped class on `window.__voskRecognition`. speech.js
// (shared with the browser-extension build) prefers this when present and
// falls back to webkitSpeechRecognition otherwise.
//
// Vosk only fills the live preview — the final transcript still comes from
// the existing Whisper path (local or OpenAI), which has punctuation/casing.
//
// Progress events are dispatched as `pdfc-vosk-progress` so preload.js can
// render a toast without coupling to this module.

const VOSK_CDN = 'https://cdn.jsdelivr.net/npm/vosk-browser@0.0.8/+esm';
const MODEL_URL = 'https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz';

let _modelPromise = null;

function emit(stage, payload = {}) {
  window.dispatchEvent(new CustomEvent('pdfc-vosk-progress', {
    detail: { stage, ...payload },
  }));
}

async function getModel() {
  if (_modelPromise) return _modelPromise;
  _modelPromise = (async () => {
    emit('loading-runtime');
    const Vosk = await import(VOSK_CDN);
    emit('loading-model');
    const model = await Vosk.createModel(MODEL_URL);
    emit('ready');
    return model;
  })();
  // Don't lock subsequent calls into a rejected promise.
  _modelPromise.catch(() => { _modelPromise = null; });
  return _modelPromise;
}

// SpeechRecognition-shaped wrapper. speech.js (extension/lib/speech.js)
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
      const model = await getModel();
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
