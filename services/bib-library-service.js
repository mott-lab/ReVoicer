// Global BibTeX reference library, loaded from the user-configured
// bib_file_path setting (Settings → References). Parsed once and cached;
// the file's mtime is re-checked on every access so an externally updated
// export (e.g. Zotero Better BibTeX "keep updated") is picked up without a
// restart. Searchable from the sidebar's References tab; a chosen result is
// stored per-paper via references-store with only authors/title/link.

const fs = require('node:fs/promises');
const { parseBibtex } = require('./bib-parser');
const { getSettingsStore } = require('./settings-store');

const SEARCH_LIMIT = 20;

// "Doe, Jane and Smith, John" → "Doe, Jane; Smith, John".
function normalizeAuthors(raw) {
  if (!raw) return '';
  return raw
    .split(/\s+and\s+/i)
    .map((a) => a.trim())
    .filter(Boolean)
    .join('; ');
}

// Prefer the DOI (as a resolvable URL) over a plain url field.
function buildLink(fields) {
  const doi = (fields.doi || '').trim();
  if (doi) {
    if (/^https?:\/\//i.test(doi)) return doi;
    return `https://doi.org/${doi.replace(/^doi:\s*/i, '')}`;
  }
  return (fields.url || '').trim();
}

class BibLibrary {
  constructor() {
    this._path = '';
    this._mtimeMs = 0;
    this._records = [];
    this._status = { configured: false, ok: false, error: null, entry_count: 0, skipped_count: 0, path: '' };
  }

  // Re-read the configured path and re-parse when the file (or the setting)
  // changed. Never throws — failures land in the cached status.
  async ensureFresh() {
    const path = (getSettingsStore().get().bib_file_path || '').trim();
    if (!path) {
      this._path = '';
      this._records = [];
      this._status = { configured: false, ok: false, error: null, entry_count: 0, skipped_count: 0, path: '' };
      return;
    }

    let st;
    try {
      st = await fs.stat(path);
    } catch (err) {
      this._path = path;
      this._records = [];
      this._status = {
        configured: true,
        ok: false,
        error: `Cannot read ${path}: ${err.message}`,
        entry_count: 0,
        skipped_count: 0,
        path,
      };
      return;
    }

    if (path === this._path && st.mtimeMs === this._mtimeMs && this._status.ok) return;

    let text;
    try {
      text = await fs.readFile(path, 'utf-8');
    } catch (err) {
      this._path = path;
      this._records = [];
      this._status = {
        configured: true,
        ok: false,
        error: `Cannot read ${path}: ${err.message}`,
        entry_count: 0,
        skipped_count: 0,
        path,
      };
      return;
    }

    const { entries, skipped } = parseBibtex(text);
    this._records = entries.map((e) => {
      const f = e.fields;
      const authors = normalizeAuthors(f.author || f.editor || '');
      const title = f.title || '';
      const record = {
        key: e.key,
        authors,
        title,
        year: f.year || '',
        venue: f.journal || f.booktitle || f.venue || f.publisher || '',
        link: buildLink(f),
      };
      record.haystack = (Object.values(f).join(' ') + ' ' + e.key).toLowerCase();
      record.titleHay = title.toLowerCase();
      record.authorHay = authors.toLowerCase();
      return record;
    });
    this._path = path;
    this._mtimeMs = st.mtimeMs;
    this._status = {
      configured: true,
      ok: true,
      error: null,
      entry_count: this._records.length,
      skipped_count: skipped,
      path,
    };
  }

  async getStatus() {
    await this.ensureFresh();
    return { ...this._status };
  }

  // AND across whitespace-separated tokens over every field; title and
  // author matches rank above matches elsewhere.
  async search(q, limit = SEARCH_LIMIT) {
    await this.ensureFresh();
    const tokens = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length || !this._status.ok) return { results: [], total: 0 };

    const matches = [];
    for (const r of this._records) {
      let score = 0;
      let all = true;
      for (const t of tokens) {
        if (r.titleHay.includes(t)) score += 3;
        else if (r.authorHay.includes(t)) score += 2;
        else if (r.haystack.includes(t)) score += 1;
        else { all = false; break; }
      }
      if (all) matches.push({ r, score });
    }
    matches.sort((a, b) =>
      (b.score - a.score)
      || String(b.r.year).localeCompare(String(a.r.year))
      || a.r.title.localeCompare(b.r.title));
    return {
      results: matches.slice(0, limit).map(({ r }) => ({
        key: r.key,
        authors: r.authors,
        title: r.title,
        year: r.year,
        venue: r.venue,
        link: r.link,
      })),
      total: matches.length,
    };
  }

  // Warm load at startup / after a settings save; callers fire-and-forget.
  refresh() {
    return this.ensureFresh();
  }
}

let _instance = null;

function getBibLibrary() {
  if (!_instance) _instance = new BibLibrary();
  return _instance;
}

module.exports = { BibLibrary, getBibLibrary, normalizeAuthors, buildLink };
