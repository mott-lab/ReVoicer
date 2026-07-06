// Preload: shims the `chrome.*` extension APIs that the existing extension
// code expects, and exposes a small `window.desktop` IPC bridge for the start
// screen. As the desktop port progresses, each shim will be replaced with a
// real IPC call (notes, settings, sidebar messaging).
//
// Note on contextIsolation: it is disabled in main.js because Electron
// pre-populates `window.chrome` in the main world and `contextBridge` cannot
// bind on top of an existing property. We assign directly to `window.chrome`
// here instead. Acceptable for the skeleton; phase 5 will reintroduce
// isolation alongside a real IPC API.

const { ipcRenderer, webUtils } = require('electron');

// Real same-page pub/sub for chrome.runtime.{sendMessage, onMessage}. In the
// Chrome extension, content.js (in the viewer tab) and sidebar.js (in the
// side panel) coordinated via the service worker; in the desktop split-pane
// build they live in the same document, so messages just need to broadcast
// to the other listener in this page.
const messageBus = {
  _listeners: new Set(),
  addListener(fn) { this._listeners.add(fn); },
  removeListener(fn) { this._listeners.delete(fn); },
  hasListener(fn) { return this._listeners.has(fn); },
};

// Wait for viewer.js to finish computing the SHA-256 content hash. sidebar.js
// asks for the current PDF id immediately on load (its init() sends
// `getCurrentPdfId`), but the viewer fetches and hashes the first 64KB of the
// PDF asynchronously, so the hash may not be set yet.
async function resolveCurrentPdf() {
  const start = Date.now();
  while (!window.__pdfContentHash && Date.now() - start < 5000) {
    await new Promise((r) => setTimeout(r, 75));
  }
  if (window.__pdfContentHash) {
    return { pdfIdentifier: window.__pdfContentHash, pdfTitle: document.title || null };
  }
  // Fallback to the file URL (matches the service worker's behavior in the
  // Chrome extension when the content script wasn't reachable).
  let fileParam = null;
  try { fileParam = new URL(location.href).searchParams.get('file'); } catch { /* ignore */ }
  return { pdfIdentifier: fileParam || null, pdfTitle: document.title || null };
}

async function dispatchMessage(msg) {
  // The service worker translated this one — sidebar.js sends it directly.
  if (msg && msg.action === 'getCurrentPdfId') {
    return resolveCurrentPdf();
  }

  // Broadcast to in-page listeners. Match Chrome's onMessage contract:
  // - if a listener returns true, it intends to call sendResponse later (we
  //   await that callback).
  // - if a listener returns a non-undefined value, that becomes the response.
  // - otherwise sendResponse may still be called synchronously.
  let resp;
  const pendingAsync = [];
  for (const fn of messageBus._listeners) {
    let asyncResolved;
    const asyncPromise = new Promise((resolve) => { asyncResolved = resolve; });
    let calledSendResponse = false;
    const sendResponse = (r) => {
      if (calledSendResponse) return;
      calledSendResponse = true;
      resp = r;
      asyncResolved(r);
    };
    try {
      const ret = fn(msg, { id: 'desktop' }, sendResponse);
      if (ret === true) {
        pendingAsync.push(asyncPromise);
      } else if (ret !== undefined) {
        resp = ret;
        asyncResolved(ret);
      } else if (calledSendResponse) {
        // sendResponse was called synchronously — already captured.
      }
    } catch (err) {
      console.error('chrome.runtime listener threw:', err);
    }
  }
  if (pendingAsync.length > 0) {
    // Wait briefly for the first async sendResponse, but don't hang forever.
    await Promise.race([
      Promise.all(pendingAsync),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
  }
  return resp;
}

// Patch (don't replace) the existing window.chrome — Electron may have its own
// properties on it that we shouldn't clobber.
window.chrome = window.chrome || {};
window.chrome.runtime = Object.assign({}, window.chrome.runtime, {
  // Resolve to the same custom scheme the renderer is loaded under, so
  // viewer.js's `chrome.runtime.getURL('viewer/pdfjs/pdf.worker.min.mjs')`
  // stays same-origin with app.html.
  getURL(relativePath) {
    const clean = String(relativePath).replace(/^\/+/, '');
    return `pdfc://local/app/${clean}`;
  },
  // Supports both Chrome forms:
  //   sendMessage(msg) → Promise<response>
  //   sendMessage(msg, callback) → undefined
  sendMessage(msg, callback) {
    const promise = dispatchMessage(msg);
    if (typeof callback === 'function') {
      promise.then(callback, (err) => console.error('sendMessage error:', err));
      return undefined;
    }
    return promise;
  },
  onMessage: messageBus,
  // Chrome exposes lastError on a sync call after a callback has been
  // invoked. We never set an error so a noop getter is enough — sidebar.js
  // reads it via `chrome.runtime.lastError`.
  get lastError() { return undefined; },
});
window.chrome.storage = Object.assign({}, window.chrome.storage, {
  local: {
    get() { return Promise.resolve({}); },
    set() { return Promise.resolve(); },
    remove() { return Promise.resolve(); },
  },
});

window.desktop = {
  openPdfDialog: () => ipcRenderer.invoke('desktop:openPdfDialog'),
  openPdfPath: (absPath) => ipcRenderer.invoke('desktop:openPdfPath', absPath),
  getRecentFiles: () => ipcRenderer.invoke('desktop:getRecentFiles'),
  openSettings: () => ipcRenderer.invoke('desktop:openSettings'),
  getSettings: () => ipcRenderer.invoke('desktop:getSettings'),
  saveSettings: (updates) => ipcRenderer.invoke('desktop:saveSettings', updates),
  testConnection: (provider, params) => ipcRenderer.invoke('desktop:testConnection', provider, params),
  openExternal: (url) => ipcRenderer.invoke('desktop:openExternal', url),
  selectDirectory: () => ipcRenderer.invoke('desktop:selectDirectory'),
  selectFile: () => ipcRenderer.invoke('desktop:selectFile'),
  generateReview: (pdfIdentifier) => ipcRenderer.invoke('desktop:generateReview', pdfIdentifier),
  chooseSavePath: (defaultPath) => ipcRenderer.invoke('desktop:chooseSavePath', defaultPath),
};

// Relay streamed review-generation chunks onto a DOM event the sidebar listens
// to (same pattern as the whisper/vosk progress toasts above).
ipcRenderer.on('desktop:reviewChunk', (_e, payload) => {
  window.dispatchEvent(new CustomEvent('pdfc-review-chunk', { detail: payload }));
});

// The settings window lives in its own BrowserWindow; when settings are saved
// there, main pings the main window so the PDF pane can re-render highlights
// (e.g. the auto-color toggle). Relay it onto the same-page bus that content.js
// already listens to.
ipcRenderer.on('desktop:settingsChanged', () => {
  syncSettingsClasses();
  dispatchMessage({ action: 'settingsChanged' }).catch(() => {});
});

// Toggle CSS classes on <html> that mirror settings, so the stylesheet alone
// can hide the mic button (speech off) and show the offline badge (see
// app.html). Re-run on every settings save so toggles take effect live.
async function syncSettingsClasses() {
  try {
    const s = await ipcRenderer.invoke('desktop:getSettings');
    const html = document.documentElement;
    if (!html) return;
    html.classList.toggle('speech-off', s.speech_provider === 'off');
    html.classList.toggle('offline-mode', s.offline_mode === true);
  } catch { /* settings unavailable on first run; fine */ }
}
window.addEventListener('DOMContentLoaded', syncSettingsClasses);

// Drag-drop: dropping a .pdf anywhere in the window opens it. Without the
// preventDefault calls, Electron navigates the renderer to the file:// URL,
// which side-steps our viewer entirely.
window.addEventListener('dragover', (e) => {
  if (e.dataTransfer && Array.from(e.dataTransfer.items || []).some((i) => i.kind === 'file')) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }
});
window.addEventListener('drop', (e) => {
  const files = Array.from(e.dataTransfer?.files || []);
  const pdf = files.find((f) => /\.pdf$/i.test(f.name));
  if (!pdf) return;
  e.preventDefault();
  // Electron 32+ removed the legacy `File.path` field; webUtils is the
  // supported way to recover an absolute path from a renderer-side File.
  const abs = webUtils.getPathForFile(pdf);
  if (abs) ipcRenderer.invoke('desktop:openPdfPath', abs);
});

// Fetch interceptor: route http://localhost:8000/api/* through IPC to the
// in-process stub router. Phase 3 swaps the stubs for real implementations
// behind the same `api:request` channel — no changes needed here.
const API_PREFIX = 'http://localhost:8000';
const ORIG_FETCH = window.fetch.bind(window);

async function bodyToIpc(body) {
  if (body == null) return undefined;
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch { return body; }
  }
  if (body instanceof FormData) {
    const out = {};
    for (const [key, value] of body.entries()) {
      if (value instanceof Blob) {
        out[key] = {
          __blob: true,
          type: value.type,
          name: value.name || null,
          data: await value.arrayBuffer(),
        };
        // Also expose audio bytes directly when the field is named `audio`,
        // since the stub transcribe handler reads body.audio.byteLength.
        if (key === 'audio') out.audio = await value.arrayBuffer();
      } else {
        out[key] = value;
      }
    }
    return out;
  }
  return body;
}

// Local Whisper progress toast. Subscribes to events emitted by
// services/local-whisper-runtime.js so this preload doesn't need to import
// transformers.js itself.
let _whisperToast = null;
function setWhisperToast(text) {
  if (!_whisperToast || !_whisperToast.isConnected) {
    _whisperToast = document.createElement('div');
    _whisperToast.id = 'pdfc-whisper-progress';
    _whisperToast.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#323639;color:#e0e0e0;padding:10px 16px;border-radius:6px;font-size:13px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,0.4);z-index:99999;min-width:240px;text-align:center;';
    document.body.appendChild(_whisperToast);
  }
  _whisperToast.textContent = text;
}
function hideWhisperToast() {
  if (_whisperToast) {
    _whisperToast.remove();
    _whisperToast = null;
  }
}
window.addEventListener('pdfc-whisper-progress', (e) => {
  const d = e.detail || {};
  switch (d.stage) {
    case 'loading-runtime': setWhisperToast('Loading Whisper runtime…'); break;
    case 'loading-model':   setWhisperToast('Loading speech model…');   break;
    case 'model-progress':
      if (d.status === 'progress' && typeof d.progress === 'number') {
        const fileLabel = d.file ? ` · ${d.file}` : '';
        setWhisperToast(`Downloading speech model${fileLabel} — ${Math.round(d.progress)}%`);
      } else if (d.status === 'ready' || d.status === 'done') {
        setWhisperToast('Speech model loaded.');
      }
      break;
    case 'decoding':
    case 'inferring':       setWhisperToast('Transcribing locally…');  break;
    case 'done':            hideWhisperToast();                         break;
  }
});

// Vosk progress toast — same UI as Whisper's, just with text reflecting
// that this is the live-preview model (~40 MB, downloaded once).
window.addEventListener('pdfc-vosk-progress', (e) => {
  const d = e.detail || {};
  switch (d.stage) {
    case 'loading-model':   setWhisperToast('Loading live-transcript model…'); break;
    case 'ready':           setWhisperToast('Live transcript ready.'); break;
    case 'listening':       hideWhisperToast(); break;
    case 'done':            hideWhisperToast(); break;
  }
});

// Empty-but-OK transcribe response: content.js sees no text and keeps the
// live (Vosk) transcript it already holds — the offline fallback path.
function softEmptyTranscript() {
  return new Response(JSON.stringify({ text: '', skipped: 'offline' }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

async function tryLocalWhisper(body) {
  let offline = false;
  try {
    const s = await ipcRenderer.invoke('desktop:getSettings');
    offline = s.offline_mode === true;
    // Offline forces the cloud provider onto the local path; everything else
    // (vosk/off) already skips server transcription upstream, but never let
    // a request leave the renderer while offline.
    const wantsLocal = s.speech_provider === 'local_whisper'
      || (offline && s.speech_provider === 'openai_whisper');
    if (!wantsLocal) return offline ? softEmptyTranscript() : null;
  } catch { return null; }
  if (!window.__localWhisper) return offline ? softEmptyTranscript() : null;

  // Offline + model not yet cached → skip the attempt entirely: avoids both a
  // doomed slow attempt and a surprise ~75MB HuggingFace download if the
  // machine actually still has connectivity. Vosk live transcript is used.
  if (offline && !(await window.__localWhisper.isModelCached())) {
    return softEmptyTranscript();
  }

  const audioBuf = body?.audio || body?.audio_blob?.data;
  const type = body?.audio_blob?.type || 'audio/webm';
  if (!audioBuf) {
    return new Response(JSON.stringify({ text: '' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }
  try {
    const blob = new Blob([audioBuf], { type });
    const result = await window.__localWhisper.transcribe(blob);
    return new Response(JSON.stringify(result), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    hideWhisperToast();
    // Offline: fail silently into the Vosk fallback instead of surfacing an
    // error the user can't act on.
    if (offline) return softEmptyTranscript();
    return new Response(JSON.stringify({
      error: `Local Whisper failed: ${err.message || err}`,
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

window.fetch = async function patchedFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : input.url;
  if (!url || !url.startsWith(API_PREFIX)) {
    return ORIG_FETCH(input, init);
  }

  const u = new URL(url);
  const method = (init.method || 'GET').toUpperCase();
  const query = Object.fromEntries(u.searchParams.entries());
  const body = await bodyToIpc(init.body);

  // Special-case transcribe so Local Whisper can run entirely in this
  // renderer without an IPC round-trip to the main process.
  if (u.pathname === '/api/transcribe' && method === 'POST') {
    const localResp = await tryLocalWhisper(body);
    if (localResp) return localResp;
  }

  const result = await ipcRenderer.invoke('api:request', {
    method,
    path: u.pathname,
    query,
    body,
  });

  const isString = typeof result.body === 'string';
  const responseBody = isString ? result.body : JSON.stringify(result.body);
  const contentType = isString ? 'text/plain; charset=utf-8' : 'application/json';

  return new Response(responseBody, {
    status: result.status,
    statusText: result.status === 200 ? 'OK' : 'Error',
    headers: { 'Content-Type': contentType },
  });
};
