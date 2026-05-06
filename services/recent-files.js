// Persistent recent-files list. Lives at userData/recent-files.json.
// Bounded to MAX entries; most-recently-opened first.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const MAX = 10;

class RecentFiles {
  constructor(filePath) {
    if (!filePath) throw new Error('RecentFiles: filePath is required');
    this.filePath = filePath;
    this._list = this._readSync();
  }

  _readSync() {
    try {
      const text = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed.filter((p) => typeof p === 'string') : [];
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      console.error('recent-files: read failed:', err.message);
      return [];
    }
  }

  async _writeAtomic() {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify(this._list, null, 2), 'utf-8');
      await fsp.rename(tmp, this.filePath);
    } catch (err) {
      try { await fsp.unlink(tmp); } catch { /* best effort */ }
      throw err;
    }
  }

  list() {
    return [...this._list];
  }

  async add(absPath) {
    if (!absPath) return;
    // Move-to-front, dedupe, cap.
    this._list = [absPath, ...this._list.filter((p) => p !== absPath)].slice(0, MAX);
    await this._writeAtomic();
  }

  async remove(absPath) {
    const before = this._list.length;
    this._list = this._list.filter((p) => p !== absPath);
    if (this._list.length !== before) await this._writeAtomic();
  }

  async clear() {
    this._list = [];
    await this._writeAtomic();
  }
}

let _instance = null;

function getRecentFiles(filePath) {
  if (!_instance) {
    if (!filePath) throw new Error('getRecentFiles: filePath required on first call');
    _instance = new RecentFiles(filePath);
  }
  return _instance;
}

module.exports = { RecentFiles, getRecentFiles, MAX };
