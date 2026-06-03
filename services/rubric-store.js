// File-based JSON storage for user-defined rubric items. A rubric item names
// a section the review must address along with a short description of what
// belongs in that section. Schema:
// `<notesDir>/{content_hash}.rubric.json`.
//
// Each entry: { id, section, description, created_at }.

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

class RubricStore {
  constructor(notesDir) {
    if (!notesDir) throw new Error('RubricStore: notesDir is required');
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
    return path.join(this.notesDir, `${contentHash}.rubric.json`);
  }

  async _readFile(contentHash) {
    await this._ready;
    try {
      const text = await fs.readFile(this._filePath(contentHash), 'utf-8');
      return JSON.parse(text);
    } catch (err) {
      if (err.code === 'ENOENT') return { content_hash: contentHash, items: [] };
      throw err;
    }
  }

  async _writeFile(contentHash, data) {
    await this._ready;
    const filePath = this._filePath(contentHash);
    const tmp = path.join(this.notesDir, `.${contentHash}.rubric.${process.pid}.${Date.now()}.tmp`);
    try {
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
      await fs.rename(tmp, filePath);
    } catch (err) {
      try { await fs.unlink(tmp); } catch { /* best effort */ }
      throw err;
    }
  }

  async createItem({ contentHash, section, description }) {
    const item = {
      id: randomUUID(),
      section: (section || '').trim(),
      description: (description || '').trim(),
      created_at: new Date().toISOString(),
    };
    return this._withLock(contentHash, async () => {
      const data = await this._readFile(contentHash);
      data.items.push(item);
      await this._writeFile(contentHash, data);
      return item;
    });
  }

  async listItems(contentHash) {
    const data = await this._readFile(contentHash);
    const items = [...data.items];
    items.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
    return items;
  }

  async updateItem(contentHash, itemId, updates) {
    return this._withLock(contentHash, async () => {
      const data = await this._readFile(contentHash);
      const item = data.items.find((i) => i.id === itemId);
      if (!item) return null;
      if (typeof updates.section === 'string') item.section = updates.section.trim();
      if (typeof updates.description === 'string') item.description = updates.description.trim();
      await this._writeFile(contentHash, data);
      return item;
    });
  }

  async deleteItem(contentHash, itemId) {
    return this._withLock(contentHash, async () => {
      const data = await this._readFile(contentHash);
      const before = data.items.length;
      data.items = data.items.filter((i) => i.id !== itemId);
      if (data.items.length === before) return false;
      await this._writeFile(contentHash, data);
      return true;
    });
  }

  // Replace all items for a PDF wholesale (used when loading a saved rubric
  // template). Each incoming {section, description} gets a fresh id; the shared
  // timestamp keeps the given order under listItems' stable sort.
  async replaceItems(contentHash, items) {
    return this._withLock(contentHash, async () => {
      const now = new Date().toISOString();
      const data = {
        content_hash: contentHash,
        items: (Array.isArray(items) ? items : []).map((it) => ({
          id: randomUUID(),
          section: (it.section || '').trim(),
          description: (it.description || '').trim(),
          created_at: now,
        })),
      };
      await this._writeFile(contentHash, data);
      return data.items;
    });
  }
}

let _instance = null;

function getRubricStore(notesDir) {
  if (!_instance) {
    if (!notesDir) throw new Error('getRubricStore: notesDir required on first call');
    _instance = new RubricStore(notesDir);
  }
  return _instance;
}

module.exports = { RubricStore, getRubricStore };
