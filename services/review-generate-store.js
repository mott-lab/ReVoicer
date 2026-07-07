// File-based JSON storage for the latest generated review draft. Schema:
// `<notesDir>/{content_hash}.review-draft.json`. At most one record per PDF —
// regenerating overwrites the previous draft. Mirrors review-check-store.js's
// atomic write + per-hash lock pattern. Kept in a separate file from the
// review-rubric *check* (`.review.json`) so the two features don't clobber
// each other.

const fs = require('node:fs/promises');
const path = require('node:path');

class ReviewGenerateStore {
  constructor(notesDir) {
    if (!notesDir) throw new Error('ReviewGenerateStore: notesDir is required');
    this.notesDir = notesDir;
    this._locks = new Map();
    this._ready = fs.mkdir(this.notesDir, { recursive: true });
  }

  async _withLock(contentHash, fn) {
    const prev = this._locks.get(contentHash) || Promise.resolve();
    let release;
    const next = new Promise((resolve) => { release = resolve; });
    this._locks.set(contentHash, prev.then(() => next));
    try {
      await prev;
      return await fn();
    } finally {
      release();
      if (this._locks.get(contentHash) === prev.then(() => next)) {
        this._locks.delete(contentHash);
      }
    }
  }

  _filePath(contentHash) {
    return path.join(this.notesDir, `${contentHash}.review-draft.json`);
  }

  async _writeFile(contentHash, data) {
    await this._ready;
    const filePath = this._filePath(contentHash);
    const tmp = path.join(this.notesDir, `.${contentHash}.review-draft.${process.pid}.${Date.now()}.tmp`);
    try {
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
      await fs.rename(tmp, filePath);
    } catch (err) {
      try { await fs.unlink(tmp); } catch { /* best effort */ }
      throw err;
    }
  }

  // Returns the parsed record or null when no review has been generated yet.
  async get(contentHash) {
    await this._ready;
    try {
      const text = await fs.readFile(this._filePath(contentHash), 'utf-8');
      return JSON.parse(text);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async save(contentHash, { review_text, thinking_text, note_count, generated_at, review_file_path }) {
    const record = {
      content_hash: contentHash,
      review_text: review_text || '',
      // Model reasoning/commentary captured during generation; kept for
      // reference in the UI, never written to the .md review file.
      thinking_text: thinking_text || '',
      note_count: note_count || 0,
      // Preserve the original generation time on manual edits; default to now.
      generated_at: generated_at || new Date().toISOString(),
      // Absolute path of the user-chosen .md file (the canonical copy). '' until set.
      review_file_path: review_file_path || '',
    };
    return this._withLock(contentHash, async () => {
      await this._writeFile(contentHash, record);
      return record;
    });
  }
}

let _instance = null;

function getReviewGenerateStore(notesDir) {
  if (!_instance) {
    if (!notesDir) throw new Error('getReviewGenerateStore: notesDir required on first call');
    _instance = new ReviewGenerateStore(notesDir);
  }
  return _instance;
}

module.exports = { ReviewGenerateStore, getReviewGenerateStore };
