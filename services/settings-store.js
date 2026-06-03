// Persistent settings. Two independent surfaces:
//   - text: cleanup, organize, Q&A, classification
//   - speech: voice-note transcription
//
// Each provider keeps its own credentials so users can flip between them
// without losing config. The old single-provider shape from earlier phases
// is migrated forward on first read.

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  // Text provider for cleanup / organize / Q&A.
  text_provider: 'openai',           // 'openai' | 'anthropic' | 'ollama' | 'openai_compat'
  cleanup_enabled: true,             // run LLM rewrite on note creation

  // Speech-to-text mode for voice annotations.
  // 'vosk' uses the bundled Vosk model for the final transcript (raw,
  // lowercase, no punctuation) — pair with cleanup_enabled=false to keep
  // the verbatim ASR output, or leave cleanup_enabled=true to let the LLM
  // polish it.
  speech_provider: 'openai_whisper', // 'openai_whisper' | 'local_whisper' | 'vosk' | 'off'

  // OpenAI (text + Whisper share the same key).
  openai_api_key: '',
  openai_model: 'gpt-4o-mini',
  openai_base_url: '',               // empty → SDK default (api.openai.com)

  // Anthropic (text only).
  anthropic_api_key: '',
  anthropic_model: 'claude-haiku-4-5-20251001',

  // Ollama (text only, local).
  ollama_base_url: 'http://localhost:11434',
  ollama_model: 'llama3.2',

  // Generic OpenAI-compatible endpoint (Groq / OpenRouter / LM Studio / vLLM / …).
  openai_compat_base_url: '',
  openai_compat_api_key: '',
  openai_compat_model: '',

  // Optional Semantic Scholar API key for in-text citation lookups. Empty is
  // fine — the keyless pool works at low volume, a key just raises rate limits.
  semantic_scholar_api_key: '',

  // Highlight appearance. false (default) → every highlight uses a flat yellow
  // background; true → highlights are colored by the note's primary tag. Per-note
  // color overrides (swatch picker / clicking a tag badge) win over both.
  auto_color_highlights: false,
};

// Migrate the older flat shape from phase 3b/3a where `llm_provider` was the
// single field driving both chat and Whisper. Idempotent — runs on every
// load but only fires when the legacy field is present.
function migrate(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const out = { ...raw };

  // Old single llm_provider shape (phases 3a–5a).
  if (out.llm_provider != null) {
    if (out.text_provider == null) {
      out.text_provider = raw.llm_provider === 'ollama' ? 'ollama' : 'openai';
    }
    if (out.speech_provider == null) {
      out.speech_provider = raw.openai_api_key ? 'openai_whisper' : 'local_whisper';
    }
    if (out.cleanup_enabled == null) out.cleanup_enabled = true;
    delete out.llm_provider;
  }

  // Phase 5b → 5c: 'browser' was non-functional in Electron (Web Speech
  // API needs a Google API key Electron's Chromium doesn't ship). Anyone
  // who'd selected it gets bumped to the Local Whisper option that
  // actually works.
  if (out.speech_provider === 'browser') {
    out.speech_provider = 'local_whisper';
  }

  return out;
}

class SettingsStore {
  constructor(filePath) {
    if (!filePath) throw new Error('SettingsStore: filePath is required');
    this.filePath = filePath;
    this._cache = null;
  }

  _readSync() {
    try {
      const text = fsSync.readFileSync(this.filePath, 'utf-8');
      const raw = JSON.parse(text);
      return { ...DEFAULTS, ...migrate(raw) };
    } catch (err) {
      if (err.code === 'ENOENT') return { ...DEFAULTS };
      throw err;
    }
  }

  get() {
    if (!this._cache) this._cache = this._readSync();
    return { ...this._cache };
  }

  async save(updates) {
    const current = this.get();
    const next = { ...current, ...updates };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf-8');
      await fs.rename(tmp, this.filePath);
    } catch (err) {
      try { await fs.unlink(tmp); } catch { /* best effort */ }
      throw err;
    }
    this._cache = next;
    return { ...next };
  }
}

let _instance = null;

function getSettingsStore(filePath) {
  if (!_instance) {
    if (!filePath) throw new Error('getSettingsStore: filePath required on first call');
    _instance = new SettingsStore(filePath);
  }
  return _instance;
}

module.exports = { SettingsStore, getSettingsStore, DEFAULTS };
