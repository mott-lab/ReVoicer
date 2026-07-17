// File-based JSON storage for reflection notes — the reviewer's overall
// impressions of a paper, captured in the Review tab before generating the
// review. Schema: `<notesDir>/{content_hash}.reflections.json`:
//   { content_hash, reflections: [ { id, raw_transcript, cleaned_text,
//     cleanup_status, created_at } ] }
// Multiple reflections per PDF. Unlike notes there is no re-clean queue:
// review generation sends both raw_transcript and cleaned_text to the LLM,
// so a 'pending' (uncleaned) reflection still contributes fully — the UI
// just badges it. Mirrors review-check-store.js's atomic write + per-hash
// lock pattern.

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

class ReflectionStore {
  constructor(notesDir) {
    if (!notesDir) throw new Error('ReflectionStore: notesDir is required');
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
    return path.join(this.notesDir, `${contentHash}.reflections.json`);
  }

  async _readFile(contentHash) {
    await this._ready;
    try {
      const text = await fs.readFile(this._filePath(contentHash), 'utf-8');
      return JSON.parse(text);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { content_hash: contentHash, reflections: [] };
      }
      throw err;
    }
  }

  async _writeFile(contentHash, data) {
    await this._ready;
    const filePath = this._filePath(contentHash);
    const tmp = path.join(this.notesDir, `.${contentHash}.reflections.${process.pid}.${Date.now()}.tmp`);
    try {
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
      await fs.rename(tmp, filePath);
    } catch (err) {
      try { await fs.unlink(tmp); } catch { /* best effort */ }
      throw err;
    }
  }

  async listReflections(contentHash) {
    const data = await this._readFile(contentHash);
    return [...data.reflections].sort((a, b) =>
      (a.created_at || '').localeCompare(b.created_at || ''));
  }

  async createReflection({ contentHash, rawTranscript, cleanedText, cleanupStatus }) {
    const reflection = {
      id: randomUUID(),
      raw_transcript: rawTranscript || '',
      cleaned_text: cleanedText || rawTranscript || '',
      cleanup_status: cleanupStatus || 'done',
      created_at: new Date().toISOString(),
    };
    return this._withLock(contentHash, async () => {
      const data = await this._readFile(contentHash);
      data.reflections.push(reflection);
      await this._writeFile(contentHash, data);
      return reflection;
    });
  }

  // Merge updates into one reflection. Returns the updated record, or null
  // when the id is unknown. Field whitelisting is the caller's job.
  async updateReflection(contentHash, reflectionId, updates) {
    return this._withLock(contentHash, async () => {
      const data = await this._readFile(contentHash);
      const reflection = data.reflections.find((r) => r.id === reflectionId);
      if (!reflection) return null;
      Object.assign(reflection, updates);
      await this._writeFile(contentHash, data);
      return { ...reflection };
    });
  }

  async deleteReflection(contentHash, reflectionId) {
    return this._withLock(contentHash, async () => {
      const data = await this._readFile(contentHash);
      const idx = data.reflections.findIndex((r) => r.id === reflectionId);
      if (idx === -1) return false;
      data.reflections.splice(idx, 1);
      await this._writeFile(contentHash, data);
      return true;
    });
  }
}

let _instance = null;

function getReflectionStore(notesDir) {
  if (!_instance) {
    if (!notesDir) throw new Error('getReflectionStore: notesDir required on first call');
    _instance = new ReflectionStore(notesDir);
  }
  return _instance;
}

module.exports = { ReflectionStore, getReflectionStore };
