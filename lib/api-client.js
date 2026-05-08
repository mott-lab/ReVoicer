// PDF Converser - Backend API Client

class ApiClient {
  constructor() {
    this.baseUrl = 'http://localhost:8000/api';
  }

  async init() {
    const stored = await chrome.storage.local.get('backendUrl');
    if (stored.backendUrl) {
      this.baseUrl = stored.backendUrl.replace(/\/$/, '');
    }
  }

  async createNote(noteData) {
    const resp = await fetch(`${this.baseUrl}/notes/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(noteData),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`API error ${resp.status}: ${text}`);
    }
    return resp.json();
  }

  async getNotes(pdfIdentifier) {
    const params = new URLSearchParams({ pdf_identifier: pdfIdentifier });
    const resp = await fetch(`${this.baseUrl}/notes/?${params}`);
    if (!resp.ok) throw new Error(`API error: ${resp.status}`);
    return resp.json();
  }

  async deleteNote(noteId, pdfIdentifier) {
    const params = new URLSearchParams({ pdf_identifier: pdfIdentifier });
    const resp = await fetch(`${this.baseUrl}/notes/${noteId}?${params}`, { method: 'DELETE' });
    if (!resp.ok) throw new Error(`API error: ${resp.status}`);
  }

  async recleanNote(noteId, pdfIdentifier) {
    const params = new URLSearchParams({ pdf_identifier: pdfIdentifier });
    const resp = await fetch(`${this.baseUrl}/notes/${noteId}/reclean?${params}`, { method: 'PUT' });
    if (!resp.ok) throw new Error(`API error: ${resp.status}`);
    return resp.json();
  }

  // Update editable fields on a note (comment_tags, section, color_override).
  // Server whitelists allowed fields and re-mirrors comment_type to the
  // primary tag. Returns the updated note.
  async updateNote(noteId, pdfIdentifier, updates) {
    const params = new URLSearchParams({ pdf_identifier: pdfIdentifier });
    const resp = await fetch(`${this.baseUrl}/notes/${noteId}?${params}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`API error ${resp.status}: ${text}`);
    }
    return resp.json();
  }

  async exportMarkdown(pdfIdentifier) {
    const params = new URLSearchParams({ pdf_identifier: pdfIdentifier });
    const resp = await fetch(`${this.baseUrl}/export/markdown?${params}`);
    if (!resp.ok) throw new Error(`API error: ${resp.status}`);
    return resp.text();
  }

  async organizeBySection(pdfIdentifier) {
    const params = new URLSearchParams({ pdf_identifier: pdfIdentifier });
    const resp = await fetch(`${this.baseUrl}/organize/by-section?${params}`);
    if (!resp.ok) throw new Error(`API error: ${resp.status}`);
    return resp.json();
  }

  async organizeByTheme(pdfIdentifier) {
    const params = new URLSearchParams({ pdf_identifier: pdfIdentifier });
    const resp = await fetch(`${this.baseUrl}/organize/by-theme?${params}`);
    if (!resp.ok) throw new Error(`API error: ${resp.status}`);
    return resp.json();
  }

  async transcribe(audioBlob) {
    const formData = new FormData();
    // Determine file extension from mime type
    const ext = audioBlob.type.includes('webm') ? 'webm'
      : audioBlob.type.includes('ogg') ? 'ogg'
      : audioBlob.type.includes('mp4') ? 'mp4'
      : 'webm';
    formData.append('audio', audioBlob, `recording.${ext}`);
    const resp = await fetch(`${this.baseUrl}/transcribe`, {
      method: 'POST',
      body: formData,
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Transcribe error ${resp.status}: ${text}`);
    }
    return resp.json();
  }

  async uploadDocumentText(pdfIdentifier, pageTexts) {
    const resp = await fetch(`${this.baseUrl}/documents/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdf_identifier: pdfIdentifier, pages: pageTexts }),
    });
    if (!resp.ok) throw new Error(`API error: ${resp.status}`);
    return resp.json();
  }

  async askQuestion(pdfIdentifier, question, selectedText, pageNumber = 0) {
    const resp = await fetch(`${this.baseUrl}/qa/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pdf_identifier: pdfIdentifier,
        question,
        selected_text: selectedText || null,
        page_number: pageNumber,
      }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`API error ${resp.status}: ${text}`);
    }
    return resp.json();
  }

  async getQuestions(pdfIdentifier) {
    const params = new URLSearchParams({ pdf_identifier: pdfIdentifier });
    const resp = await fetch(`${this.baseUrl}/qa/?${params}`);
    if (!resp.ok) throw new Error(`API error: ${resp.status}`);
    return resp.json();
  }

  async deleteQuestion(entryId, pdfIdentifier) {
    const params = new URLSearchParams({ pdf_identifier: pdfIdentifier });
    const resp = await fetch(`${this.baseUrl}/qa/${entryId}?${params}`, { method: 'DELETE' });
    if (!resp.ok) throw new Error(`API error: ${resp.status}`);
  }

  async checkHealth() {
    const resp = await fetch(`${this.baseUrl}/health`);
    return resp.ok;
  }
}
