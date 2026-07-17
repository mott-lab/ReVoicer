// File-based JSON storage for the latest review-rubric check. Schema:
// `<notesDir>/{content_hash}.review.json`. At most one record per PDF —
// re-checking overwrites the previous result. Mirrors qa-store.js's atomic
// write + per-hash lock pattern.

const fs = require('node:fs/promises');
const path = require('node:path');

class ReviewCheckStore {
  constructor(notesDir) {
    if (!notesDir) throw new Error('ReviewCheckStore: notesDir is required');
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
    return path.join(this.notesDir, `${contentHash}.review.json`);
  }

  async _writeFile(contentHash, data) {
    await this._ready;
    const filePath = this._filePath(contentHash);
    const tmp = path.join(this.notesDir, `.${contentHash}.review.${process.pid}.${Date.now()}.tmp`);
    try {
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
      await fs.rename(tmp, filePath);
    } catch (err) {
      try { await fs.unlink(tmp); } catch { /* best effort */ }
      throw err;
    }
  }

  // Returns the parsed record or null when no check has been run for this
  // PDF. Distinguishing "never run" from "ran with empty rubric" matters to
  // the renderer, so we deliberately don't substitute a stub object on
  // ENOENT.
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

  async save(contentHash, { sections }) {
    const record = {
      content_hash: contentHash,
      sections: Array.isArray(sections) ? sections : [],
      checked_at: new Date().toISOString(),
    };
    return this._withLock(contentHash, async () => {
      await this._writeFile(contentHash, record);
      return record;
    });
  }

  async clear(contentHash) {
    return this._withLock(contentHash, async () => {
      try {
        await fs.unlink(this._filePath(contentHash));
        return true;
      } catch (err) {
        if (err.code === 'ENOENT') return false;
        throw err;
      }
    });
  }
}

let _instance = null;

function getReviewCheckStore(notesDir) {
  if (!_instance) {
    if (!notesDir) throw new Error('getReviewCheckStore: notesDir required on first call');
    _instance = new ReviewCheckStore(notesDir);
  }
  return _instance;
}

module.exports = { ReviewCheckStore, getReviewCheckStore };
