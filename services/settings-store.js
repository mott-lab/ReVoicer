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

// Shipped default for review_style_guide (Settings → Review). Kept as a
// standalone markdown file — it's ~12 KB and full of backticks/fenced code
// blocks that would need escaping in a template literal. "Generate style
// guide" overwrites the setting; blanking the textarea falls back to this.
let DEFAULT_STYLE_GUIDE = '';
try {
  DEFAULT_STYLE_GUIDE = fsSync.readFileSync(path.join(__dirname, 'default-style-guide.md'), 'utf-8');
} catch { /* file missing — default stays empty */ }

const DEFAULTS = {
  // Text provider for cleanup / organize / Q&A.
  text_provider: 'openai',           // 'openai' | 'anthropic' | 'ollama' | 'openai_compat'
  cleanup_enabled: true,             // run LLM rewrite on note creation

  // Manual offline mode: no LLM calls at all (notes saved raw and marked
  // cleanup_status='pending'), voice transcription forced onto local paths
  // (Local Whisper if its model is cached, else the bundled Vosk transcript).
  offline_mode: false,

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

  // Review generation has its own provider selector + credentials (mirrors the
  // text_* fields) so a different/stronger model can draft reviews. The Settings
  // UI offers an "Autofill from Text Processing" button to copy the text keys.
  review_provider: 'openai',         // 'openai' | 'anthropic' | 'ollama' | 'openai_compat'

  review_openai_api_key: '',
  review_openai_model: 'gpt-4o-mini',
  review_openai_base_url: '',

  review_anthropic_api_key: '',
  review_anthropic_model: 'claude-haiku-4-5-20251001',

  review_ollama_base_url: 'http://localhost:11434',
  review_ollama_model: 'llama3.2',

  review_openai_compat_base_url: '',
  review_openai_compat_api_key: '',
  review_openai_compat_model: '',

  review_examples_dir: '',           // folder of .txt/.md example reviews (feeds style-guide generation)

  // Describes the structure of the data the app sends with each review request
  // (annotation JSON fields, references, rubric). Shown in Settings → Review
  // as "Note context".
  review_note_context: `The reviewer's annotations are provided as JSON with the following fields:
- selected_text: the text highlighted in the PDF (may be truncated).
- page_number: the page of the PDF the highlight is on.
- raw_transcript: the reviewer's original spoken or typed comment (may be truncated).
- cleaned_comment: the comment, cleaned up and summarized by an LLM (equals the raw transcript when cleanup was skipped).
- comment_tags: tags related to the content of the comment.
- section: the section of the paper the comment is in.
- created_at: datetime string for when the comment was made.

In writing the review, primarily use the cleaned_comment fields.

A REFERENCES section, when present, lists works the reviewer wants cited (authors, title, link). Include these references verbatim in the review where relevant.

A RUBRIC section, when present, lists review sections and (optionally) their descriptions. Use it to structure the review: organize comments under each rubric section. If no comment fits a section, leave it blank but still include the header.`,

  // Tone, format, and process guidance for drafting the review. Shown in
  // Settings → Review as "Additional instructions".
  review_additional_instructions: `Write a review for the academic research manuscript. Use any note contents and rubric provided.

Always use a formal tone. Do not use em-dashes. Write tight, concise, clear, and to-the-point prose. Prefer simple, direct language and avoid extended sentence formulations that try to balance or draw connections between different concepts unless necessary.

Format the review in Markdown, e.g. headers denoted with hashtag sets.

Sometimes the notes include a comment that refers back to a previous comment. This comes from conversational use of the tool: such a comment modifies, revisits, or extends what was said before. Do not include both comments in the review; extract the meaningful aspects of each and combine them. Do a first pass over the notes to find such relationships — check the cleaned_comment and also the raw_transcript for this — and use created_at to confirm the inferred later comment was indeed made after the inferred earlier one.

After that first pass is complete, write the review, organizing the comments in a way consistent with the writing style guide.`,

  // Voice/tone/formatting guidance followed by drafted reviews. Ships with a
  // default template (services/default-style-guide.md); "Generate style guide"
  // replaces it with one distilled from the user's example reviews.
  review_style_guide: DEFAULT_STYLE_GUIDE,
  review_style_guide_generated_at: '', // ISO timestamp of the last "Generate style guide" run

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

  // review_instructions was split into review_note_context +
  // review_additional_instructions; the legacy value is intentionally
  // discarded (its content lives on in the new DEFAULTS).
  if ('review_instructions' in out) delete out.review_instructions;

  // Few-shot example inclusion was removed — the examples folder now feeds
  // style-guide generation only.
  if ('review_use_examples' in out) delete out.review_use_examples;

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
