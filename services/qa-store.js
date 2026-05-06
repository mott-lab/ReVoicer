// File-based JSON Q&A storage. Port of backend/app/services/qa_store.py.
// Schema: <notesDir>/{content_hash}.qa.json — same as Python.

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

class QAStore {
  constructor(notesDir) {
    if (!notesDir) throw new Error('QAStore: notesDir is required');
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
    return path.join(this.notesDir, `${contentHash}.qa.json`);
  }

  async _readFile(contentHash) {
    await this._ready;
    try {
      const text = await fs.readFile(this._filePath(contentHash), 'utf-8');
      return JSON.parse(text);
    } catch (err) {
      if (err.code === 'ENOENT') return { content_hash: contentHash, entries: [] };
      throw err;
    }
  }

  async _writeFile(contentHash, data) {
    await this._ready;
    const filePath = this._filePath(contentHash);
    const tmp = path.join(this.notesDir, `.${contentHash}.qa.${process.pid}.${Date.now()}.tmp`);
    try {
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
      await fs.rename(tmp, filePath);
    } catch (err) {
      try { await fs.unlink(tmp); } catch { /* best effort */ }
      throw err;
    }
  }

  async createEntry({ contentHash, question, answer, selectedText, pageNumber }) {
    const entry = {
      id: randomUUID(),
      question,
      answer,
      selected_text: selectedText || null,
      page_number: pageNumber || 0,
      created_at: new Date().toISOString(),
    };
    return this._withLock(contentHash, async () => {
      const data = await this._readFile(contentHash);
      data.entries.push(entry);
      await this._writeFile(contentHash, data);
      return entry;
    });
  }

  async listEntries(contentHash) {
    const data = await this._readFile(contentHash);
    const entries = [...data.entries];
    entries.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
    return entries;
  }

  async deleteEntry(contentHash, entryId) {
    return this._withLock(contentHash, async () => {
      const data = await this._readFile(contentHash);
      const before = data.entries.length;
      data.entries = data.entries.filter((e) => e.id !== entryId);
      if (data.entries.length === before) return false;
      await this._writeFile(contentHash, data);
      return true;
    });
  }
}

let _instance = null;

function getQAStore(notesDir) {
  if (!_instance) {
    if (!notesDir) throw new Error('getQAStore: notesDir required on first call');
    _instance = new QAStore(notesDir);
  }
  return _instance;
}

module.exports = { QAStore, getQAStore };
