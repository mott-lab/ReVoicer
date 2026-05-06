// File-based document text storage.
//
// Stores extracted PDF text at `<notesDir>/{content_hash}.text.json`. Kept
// separate from the notes file so note CRUD doesn't touch potentially large
// document text.
//
// File format:
//   { "content_hash": "...", "pages": { "1": "...", "2": "...", ... } }

const fs = require('node:fs/promises');
const path = require('node:path');

class DocumentStore {
  constructor(notesDir) {
    if (!notesDir) throw new Error('DocumentStore: notesDir is required');
    this.notesDir = notesDir;
    this._ready = fs.mkdir(this.notesDir, { recursive: true });
  }

  _filePath(contentHash) {
    return path.join(this.notesDir, `${contentHash}.text.json`);
  }

  async saveDocumentText(contentHash, pages) {
    await this._ready;
    const filePath = this._filePath(contentHash);
    const tmpPath = path.join(this.notesDir, `.${contentHash}.text.${process.pid}.${Date.now()}.tmp`);
    const data = { content_hash: contentHash, pages };
    try {
      await fs.writeFile(tmpPath, JSON.stringify(data), 'utf-8');
      await fs.rename(tmpPath, filePath);
    } catch (err) {
      try { await fs.unlink(tmpPath); } catch { /* best effort */ }
      throw err;
    }
  }

  async loadDocumentText(contentHash) {
    await this._ready;
    try {
      const text = await fs.readFile(this._filePath(contentHash), 'utf-8');
      return JSON.parse(text).pages || null;
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  // Format pages dict into a single string suitable for LLM context.
  formatForLlm(pages) {
    if (!pages) return '';
    const sortedKeys = Object.keys(pages).sort((a, b) => Number(a) - Number(b));
    const parts = [];
    for (const key of sortedKeys) {
      const text = (pages[key] || '').trim();
      if (text) parts.push(`[Page ${key}]\n${text}`);
    }
    return parts.join('\n\n');
  }
}

let _instance = null;

function getDocumentStore(notesDir) {
  if (!_instance) {
    if (!notesDir) {
      throw new Error('getDocumentStore: notesDir is required on first call');
    }
    _instance = new DocumentStore(notesDir);
  }
  return _instance;
}

module.exports = { DocumentStore, getDocumentStore };
