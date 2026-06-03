// File-based JSON storage for parsed in-text citations and their looked-up
// metadata. Schema: `<notesDir>/{content_hash}.citations.json`:
//
//   {
//     content_hash,
//     entries: [ { number, raw } ],          // the numbered reference list
//     extracted_at,
//     lookups: {                              // per-number metadata cache
//       "12": { status, title, authors, abstract, year, venue, doi, url,
//               google_scholar_url, source, looked_up_at },
//       ...
//     }
//   }
//
// Mirrors review-check-store.js's atomic write + per-hash lock pattern.

const fs = require('node:fs/promises');
const path = require('node:path');

class CitationsStore {
  constructor(notesDir) {
    if (!notesDir) throw new Error('CitationsStore: notesDir is required');
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
    return path.join(this.notesDir, `${contentHash}.citations.json`);
  }

  async _writeFile(contentHash, data) {
    await this._ready;
    const filePath = this._filePath(contentHash);
    const tmp = path.join(this.notesDir, `.${contentHash}.citations.${process.pid}.${Date.now()}.tmp`);
    try {
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
      await fs.rename(tmp, filePath);
    } catch (err) {
      try { await fs.unlink(tmp); } catch { /* best effort */ }
      throw err;
    }
  }

  // Returns the parsed record or null when citations have never been
  // extracted for this PDF.
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

  // Persist the parsed numbered reference list, preserving any metadata
  // lookups already cached for this PDF.
  async saveEntries(contentHash, entries) {
    return this._withLock(contentHash, async () => {
      const existing = await this.get(contentHash);
      const record = {
        content_hash: contentHash,
        entries: Array.isArray(entries) ? entries : [],
        extracted_at: new Date().toISOString(),
        lookups: existing?.lookups && typeof existing.lookups === 'object' ? existing.lookups : {},
      };
      await this._writeFile(contentHash, record);
      return record;
    });
  }

  // Cache a single number's looked-up metadata. Creates the record if the
  // entries haven't been persisted yet (shouldn't normally happen).
  async saveLookup(contentHash, number, lookup) {
    return this._withLock(contentHash, async () => {
      const existing = await this.get(contentHash);
      const record = existing || {
        content_hash: contentHash,
        entries: [],
        extracted_at: new Date().toISOString(),
        lookups: {},
      };
      if (!record.lookups || typeof record.lookups !== 'object') record.lookups = {};
      record.lookups[String(number)] = { ...lookup, looked_up_at: new Date().toISOString() };
      await this._writeFile(contentHash, record);
      return record.lookups[String(number)];
    });
  }
}

let _instance = null;

function getCitationsStore(notesDir) {
  if (!_instance) {
    if (!notesDir) throw new Error('getCitationsStore: notesDir required on first call');
    _instance = new CitationsStore(notesDir);
  }
  return _instance;
}

module.exports = { CitationsStore, getCitationsStore };
