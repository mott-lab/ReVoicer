// Global (not per-PDF) store of named, reusable review rubrics ("templates"),
// e.g. one per conference. Lets the user save the current rubric under a name
// and load it into any paper without re-pasting / re-extracting it.
//
// Single file: `<notesDir>/rubric-templates.json`. Schema:
//   { templates: [ { id, name, items: [{section, description}],
//                    created_at, updated_at } ] }

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

class RubricTemplatesStore {
  constructor(notesDir) {
    if (!notesDir) throw new Error('RubricTemplatesStore: notesDir is required');
    this.notesDir = notesDir;
    this.filePath = path.join(notesDir, 'rubric-templates.json');
    this._lock = Promise.resolve();
    this._ready = fs.mkdir(this.notesDir, { recursive: true });
  }

  // Single global lock (one file, no per-PDF keys).
  async _withLock(fn) {
    const prev = this._lock;
    let release;
    this._lock = new Promise((r) => { release = r; });
    try {
      await prev;
      return await fn();
    } finally {
      release();
    }
  }

  async _read() {
    await this._ready;
    try {
      const text = await fs.readFile(this.filePath, 'utf-8');
      const data = JSON.parse(text);
      return data && Array.isArray(data.templates) ? data : { templates: [] };
    } catch (err) {
      if (err.code === 'ENOENT') return { templates: [] };
      throw err;
    }
  }

  async _write(data) {
    await this._ready;
    const tmp = path.join(this.notesDir, `.rubric-templates.${process.pid}.${Date.now()}.tmp`);
    try {
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
      await fs.rename(tmp, this.filePath);
    } catch (err) {
      try { await fs.unlink(tmp); } catch { /* best effort */ }
      throw err;
    }
  }

  _normalizeItems(items) {
    return (Array.isArray(items) ? items : [])
      .map((it) => ({
        section: (it.section || '').trim(),
        description: (it.description || '').trim(),
      }))
      .filter((it) => it.section || it.description);
  }

  async list() {
    const data = await this._read();
    return [...data.templates].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }

  async getById(id) {
    const data = await this._read();
    return data.templates.find((t) => t.id === id) || null;
  }

  // Upsert by case-insensitive name so re-saving the same conference updates it
  // rather than creating a duplicate.
  async save({ name, items }) {
    const cleanName = (name || '').trim();
    if (!cleanName) {
      const e = new Error('name is required');
      e.status = 400;
      throw e;
    }
    const normItems = this._normalizeItems(items);
    return this._withLock(async () => {
      const data = await this._read();
      const now = new Date().toISOString();
      const existing = data.templates.find(
        (t) => (t.name || '').toLowerCase() === cleanName.toLowerCase(),
      );
      if (existing) {
        existing.items = normItems;
        existing.updated_at = now;
        await this._write(data);
        return existing;
      }
      const tpl = { id: randomUUID(), name: cleanName, items: normItems, created_at: now, updated_at: now };
      data.templates.push(tpl);
      await this._write(data);
      return tpl;
    });
  }
}

let _instance = null;

function getRubricTemplatesStore(notesDir) {
  if (!_instance) {
    if (!notesDir) throw new Error('getRubricTemplatesStore: notesDir required on first call');
    _instance = new RubricTemplatesStore(notesDir);
  }
  return _instance;
}

module.exports = { RubricTemplatesStore, getRubricTemplatesStore };
