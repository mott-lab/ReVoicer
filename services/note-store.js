// File-based JSON note storage.
//
// Each PDF's notes live in `<notesDir>/{content_hash}.json` with the same
// schema as the Python backend, so notes copied from the FastAPI install will
// load unchanged here.
//
// File format:
//   {
//     "content_hash": "...",
//     "pdf_title": string | null,
//     "pdf_url": string | null,
//     "notes": [ { id, selected_text, page_number, raw_transcript,
//                  cleaned_comment, comment_type, highlight_data, created_at } ]
//   }

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');

class NoteStore {
  constructor(notesDir) {
    if (!notesDir) throw new Error('NoteStore: notesDir is required');
    this.notesDir = notesDir;
    this._locks = new Map();
    this._ready = fs.mkdir(this.notesDir, { recursive: true });
  }

  // Per-PDF write lock. Reads don't take the lock; we tolerate the (rare)
  // read-during-write race by re-reading on retry — same behavior as the
  // Python store, which only locks read-modify-write sequences.
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
      // Clean up the lock map if nothing else is queued.
      if (this._locks.get(contentHash) === prev.then(() => next)) {
        this._locks.delete(contentHash);
      }
    }
  }

  _filePath(contentHash) {
    return path.join(this.notesDir, `${contentHash}.json`);
  }

  async _readFile(contentHash) {
    await this._ready;
    const filePath = this._filePath(contentHash);
    try {
      const text = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(text);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { content_hash: contentHash, pdf_title: null, pdf_url: null, notes: [] };
      }
      throw err;
    }
  }

  async _writeFile(contentHash, data) {
    await this._ready;
    const filePath = this._filePath(contentHash);
    // Atomic write: write to temp file, then rename. Same approach as Python.
    const tmpPath = path.join(this.notesDir, `.${contentHash}.${process.pid}.${Date.now()}.tmp`);
    const text = JSON.stringify(data, null, 2);
    try {
      await fs.writeFile(tmpPath, text, 'utf-8');
      await fs.rename(tmpPath, filePath);
    } catch (err) {
      try { await fs.unlink(tmpPath); } catch { /* best effort */ }
      throw err;
    }
  }

  // Inject pdf_identifier and pdf_title into each note for parity with the
  // Python list_notes response shape.
  _decorate(notes, contentHash, pdfTitle) {
    for (const n of notes) {
      n.pdf_identifier = contentHash;
      n.pdf_title = pdfTitle;
    }
    return notes;
  }

  async createNote({
    contentHash, pdfTitle, pdfUrl, selectedText, pageNumber,
    rawTranscript, cleanedComment, commentType, highlightData,
  }) {
    const note = {
      id: randomUUID(),
      selected_text: selectedText || '',
      page_number: pageNumber || 0,
      raw_transcript: rawTranscript || '',
      cleaned_comment: cleanedComment || '',
      comment_type: commentType || 'summary',
      highlight_data: highlightData || null,
      created_at: new Date().toISOString(),
    };

    return this._withLock(contentHash, async () => {
      const data = await this._readFile(contentHash);
      if (pdfTitle) data.pdf_title = pdfTitle;
      if (pdfUrl) data.pdf_url = pdfUrl;
      data.notes.push(note);
      await this._writeFile(contentHash, data);
      return { ...note, pdf_identifier: contentHash, pdf_title: data.pdf_title };
    });
  }

  async listNotes(contentHash) {
    const data = await this._readFile(contentHash);
    const notes = [...data.notes];
    notes.sort((a, b) => {
      const pa = a.page_number || 0;
      const pb = b.page_number || 0;
      if (pa !== pb) return pa - pb;
      return (a.created_at || '').localeCompare(b.created_at || '');
    });
    return this._decorate(notes, contentHash, data.pdf_title);
  }

  async getNote(contentHash, noteId) {
    const data = await this._readFile(contentHash);
    const note = data.notes.find((n) => n.id === noteId);
    if (!note) return null;
    return { ...note, pdf_identifier: contentHash, pdf_title: data.pdf_title };
  }

  async deleteNote(contentHash, noteId) {
    return this._withLock(contentHash, async () => {
      const data = await this._readFile(contentHash);
      const before = data.notes.length;
      data.notes = data.notes.filter((n) => n.id !== noteId);
      if (data.notes.length === before) return false;
      await this._writeFile(contentHash, data);
      return true;
    });
  }

  async updateNote(contentHash, noteId, updates) {
    return this._withLock(contentHash, async () => {
      const data = await this._readFile(contentHash);
      const note = data.notes.find((n) => n.id === noteId);
      if (!note) return null;
      Object.assign(note, updates);
      await this._writeFile(contentHash, data);
      return { ...note, pdf_identifier: contentHash, pdf_title: data.pdf_title };
    });
  }
}

let _instance = null;

function getNoteStore(notesDir) {
  if (!_instance) {
    if (!notesDir) {
      throw new Error('getNoteStore: notesDir is required on first call');
    }
    _instance = new NoteStore(notesDir);
  }
  return _instance;
}

module.exports = { NoteStore, getNoteStore };
