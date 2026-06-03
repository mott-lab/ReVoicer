// File-based JSON storage for user-supplied references that the cleanup LLM
// uses as context (so a transcript mention like "Gottsacker et al." can be
// resolved to the proper title/authors/link). Schema:
// `<notesDir>/{content_hash}.refs.json`.
//
// Each entry: { id, authors, title, link, created_at }.

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

class ReferencesStore {
  constructor(notesDir) {
    if (!notesDir) throw new Error('ReferencesStore: notesDir is required');
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
    return path.join(this.notesDir, `${contentHash}.refs.json`);
  }

  async _readFile(contentHash) {
    await this._ready;
    try {
      const text = await fs.readFile(this._filePath(contentHash), 'utf-8');
      return JSON.parse(text);
    } catch (err) {
      if (err.code === 'ENOENT') return { content_hash: contentHash, references: [] };
      throw err;
    }
  }

  async _writeFile(contentHash, data) {
    await this._ready;
    const filePath = this._filePath(contentHash);
    const tmp = path.join(this.notesDir, `.${contentHash}.refs.${process.pid}.${Date.now()}.tmp`);
    try {
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
      await fs.rename(tmp, filePath);
    } catch (err) {
      try { await fs.unlink(tmp); } catch { /* best effort */ }
      throw err;
    }
  }

  async createReference({ contentHash, authors, title, link }) {
    const ref = {
      id: randomUUID(),
      authors: (authors || '').trim(),
      title: (title || '').trim(),
      link: (link || '').trim(),
      created_at: new Date().toISOString(),
    };
    return this._withLock(contentHash, async () => {
      const data = await this._readFile(contentHash);
      data.references.push(ref);
      await this._writeFile(contentHash, data);
      return ref;
    });
  }

  async listReferences(contentHash) {
    const data = await this._readFile(contentHash);
    const refs = [...data.references];
    refs.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
    return refs;
  }

  async updateReference(contentHash, refId, updates) {
    return this._withLock(contentHash, async () => {
      const data = await this._readFile(contentHash);
      const ref = data.references.find((r) => r.id === refId);
      if (!ref) return null;
      if (typeof updates.authors === 'string') ref.authors = updates.authors.trim();
      if (typeof updates.title === 'string') ref.title = updates.title.trim();
      if (typeof updates.link === 'string') ref.link = updates.link.trim();
      await this._writeFile(contentHash, data);
      return ref;
    });
  }

  async deleteReference(contentHash, refId) {
    return this._withLock(contentHash, async () => {
      const data = await this._readFile(contentHash);
      const before = data.references.length;
      data.references = data.references.filter((r) => r.id !== refId);
      if (data.references.length === before) return false;
      await this._writeFile(contentHash, data);
      return true;
    });
  }
}

let _instance = null;

function getReferencesStore(notesDir) {
  if (!_instance) {
    if (!notesDir) throw new Error('getReferencesStore: notesDir required on first call');
    _instance = new ReferencesStore(notesDir);
  }
  return _instance;
}

module.exports = { ReferencesStore, getReferencesStore };
