// PDF Converser - API client. The localhost:8000 URLs are intercepted by
// preload.js and routed to the in-process handlers in api-stub.js; no HTTP
// server is involved. Failures here are config or internal errors, never a
// down backend.

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

  // Turn a non-2xx response into an Error that keeps the structured fields
  // api-stub returns ({ error, code }): `.status`, `.code` ('NOT_CONFIGURED' |
  // 'OFFLINE' | null), and `.serverMessage` — callers branch on these to show
  // actionable messages (see lib/error-messages.js).
  async _throwApiError(resp, label = 'API error') {
    const text = await resp.text();
    let message = text;
    let code = null;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        message = parsed.error || text;
        code = parsed.code || null;
      }
    } catch { /* non-JSON body — use raw text */ }
    const err = new Error(`${label} ${resp.status}: ${message}`);
    err.status = resp.status;
    err.code = code;
    err.serverMessage = message;
    throw err;
  }

  async createNote(noteData) {
    const resp = await fetch(`${this.baseUrl}/notes/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(noteData),
    });
    if (!resp.ok) await this._throwApiError(resp);
    return resp.json();
  }

  async getNotes(pdfIdentifier) {
    const params = new URLSearchParams({ pdf_identifier: pdfIdentifier });
    const resp = await fetch(`${this.baseUrl}/notes/?${params}`);
    if (!resp.ok) await this._throwApiError(resp);
    return resp.json();
  }

  async deleteNote(noteId, pdfIdentifier) {
    const params = new URLSearchParams({ pdf_identifier: pdfIdentifier });
    const resp = await fetch(`${this.baseUrl}/notes/${noteId}?${params}`, { method: 'DELETE' });
    if (!resp.ok) await this._throwApiError(resp);
  }

  async recleanNote(noteId, pdfIdentifier) {
    const params = new URLSearchParams({ pdf_identifier: pdfIdentifier });
    const resp = await fetch(`${this.baseUrl}/notes/${noteId}/reclean?${params}`, { method: 'PUT' });
    if (!resp.ok) await this._throwApiError(resp);
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
    if (!resp.ok) await this._throwApiError(resp);
    return resp.json();
  }

  async exportMarkdown(pdfIdentifier) {
    const params = new URLSearchParams({ pdf_identifier: pdfIdentifier });
    const resp = await fetch(`${this.baseUrl}/export/markdown?${params}`);
    if (!resp.ok) await this._throwApiError(resp);
    return resp.text();
  }

  async organizeBySection(pdfIdentifier) {
    const params = new URLSearchParams({ pdf_identifier: pdfIdentifier });
    const resp = await fetch(`${this.baseUrl}/organize/by-section?${params}`);
    if (!resp.ok) await this._throwApiError(resp);
    return resp.json();
  }

  async organizeByTheme(pdfIdentifier) {
    const params = new URLSearchParams({ pdf_identifier: pdfIdentifier });
    const resp = await fetch(`${this.baseUrl}/organize/by-theme?${params}`);
    if (!resp.ok) await this._throwApiError(resp);
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
    if (!resp.ok) await this._throwApiError(resp, 'Transcribe error');
    return resp.json();
  }

  async uploadDocumentText(pdfIdentifier, pageTexts) {
    const resp = await fetch(`${this.baseUrl}/documents/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdf_identifier: pdfIdentifier, pages: pageTexts }),
    });
    if (!resp.ok) await this._throwApiError(resp);
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
    if (!resp.ok) await this._throwApiError(resp);
    return resp.json();
  }

  async getQuestions(pdfIdentifier) {
    const params = new URLSearchParams({ pdf_identifier: pdfIdentifier });
    const resp = await fetch(`${this.baseUrl}/qa/?${params}`);
    if (!resp.ok) await this._throwApiError(resp);
    return resp.json();
  }

  async deleteQuestion(entryId, pdfIdentifier) {
    const params = new URLSearchParams({ pdf_identifier: pdfIdentifier });
    const resp = await fetch(`${this.baseUrl}/qa/${entryId}?${params}`, { method: 'DELETE' });
    if (!resp.ok) await this._throwApiError(resp);
  }

  async getReviewCheck(pdfIdentifier) {
    const params = new URLSearchParams({ pdf_identifier: pdfIdentifier });
    const resp = await fetch(`${this.baseUrl}/review-check/?${params}`);
    if (!resp.ok) await this._throwApiError(resp);
    return resp.json();
  }

  async runReviewCheck(pdfIdentifier, rubricText) {
    const resp = await fetch(`${this.baseUrl}/review-check/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pdf_identifier: pdfIdentifier,
        rubric_text: rubricText,
      }),
    });
    if (!resp.ok) await this._throwApiError(resp);
    return resp.json();
  }

  async getGeneratedReview(pdfIdentifier) {
    const params = new URLSearchParams({ pdf_identifier: pdfIdentifier });
    const resp = await fetch(`${this.baseUrl}/review/?${params}`);
    if (!resp.ok) await this._throwApiError(resp);
    return resp.json();
  }

  async generateReview(pdfIdentifier) {
    const resp = await fetch(`${this.baseUrl}/review/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdf_identifier: pdfIdentifier }),
    });
    if (!resp.ok) await this._throwApiError(resp);
    return resp.json();
  }

  async saveGeneratedReview(pdfIdentifier, reviewText, filePath) {
    const resp = await fetch(`${this.baseUrl}/review/`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdf_identifier: pdfIdentifier, review_text: reviewText, file_path: filePath || '' }),
    });
    if (!resp.ok) await this._throwApiError(resp);
    return resp.json();
  }

  async listReferences(pdfIdentifier) {
    const params = new URLSearchParams({ pdf_identifier: pdfIdentifier });
    const resp = await fetch(`${this.baseUrl}/references/?${params}`);
    if (!resp.ok) await this._throwApiError(resp);
    return resp.json();
  }

  async createReference(pdfIdentifier, { authors, title, link }) {
    const resp = await fetch(`${this.baseUrl}/references/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pdf_identifier: pdfIdentifier,
        authors: authors || '',
        title: title || '',
        link: link || '',
      }),
    });
    if (!resp.ok) await this._throwApiError(resp);
    return resp.json();
  }

  async updateReference(refId, pdfIdentifier, updates) {
    const params = new URLSearchParams({ pdf_identifier: pdfIdentifier });
    const resp = await fetch(`${this.baseUrl}/references/${refId}?${params}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!resp.ok) await this._throwApiError(resp);
    return resp.json();
  }

  async deleteReference(refId, pdfIdentifier) {
    const params = new URLSearchParams({ pdf_identifier: pdfIdentifier });
    const resp = await fetch(`${this.baseUrl}/references/${refId}?${params}`, { method: 'DELETE' });
    if (!resp.ok) await this._throwApiError(resp);
  }

  // Parse + cache the numbered reference list; returns { numbers, count, status }.
  async extractCitations(pdfIdentifier) {
    const resp = await fetch(`${this.baseUrl}/citations/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdf_identifier: pdfIdentifier }),
    });
    if (!resp.ok) await this._throwApiError(resp);
    return resp.json();
  }

  // Look up one reference number's metadata; returns { status, title, authors,
  // abstract, year, venue, doi, url, google_scholar_url, ... }.
  async lookupCitation(pdfIdentifier, number) {
    const resp = await fetch(`${this.baseUrl}/citations/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdf_identifier: pdfIdentifier, number }),
    });
    if (!resp.ok) await this._throwApiError(resp);
    return resp.json();
  }

  async listRubric(pdfIdentifier) {
    const params = new URLSearchParams({ pdf_identifier: pdfIdentifier });
    const resp = await fetch(`${this.baseUrl}/rubric/?${params}`);
    if (!resp.ok) await this._throwApiError(resp);
    return resp.json();
  }

  async createRubricItem(pdfIdentifier, { section, description }) {
    const resp = await fetch(`${this.baseUrl}/rubric/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pdf_identifier: pdfIdentifier,
        section: section || '',
        description: description || '',
      }),
    });
    if (!resp.ok) await this._throwApiError(resp);
    return resp.json();
  }

  async updateRubricItem(itemId, pdfIdentifier, updates) {
    const params = new URLSearchParams({ pdf_identifier: pdfIdentifier });
    const resp = await fetch(`${this.baseUrl}/rubric/${itemId}?${params}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!resp.ok) await this._throwApiError(resp);
    return resp.json();
  }

  async deleteRubricItem(itemId, pdfIdentifier) {
    const params = new URLSearchParams({ pdf_identifier: pdfIdentifier });
    const resp = await fetch(`${this.baseUrl}/rubric/${itemId}?${params}`, { method: 'DELETE' });
    if (!resp.ok) await this._throwApiError(resp);
  }

  async parseRubricText(pdfIdentifier, rubricText) {
    const resp = await fetch(`${this.baseUrl}/rubric/parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pdf_identifier: pdfIdentifier,
        rubric_text: rubricText || '',
      }),
    });
    if (!resp.ok) await this._throwApiError(resp);
    return resp.json();
  }

  // ─── Saved rubric templates (named, reusable rubrics) ───────────────────

  async listRubricTemplates() {
    const resp = await fetch(`${this.baseUrl}/rubric-templates/`);
    if (!resp.ok) await this._throwApiError(resp);
    return resp.json();
  }

  async saveRubricTemplate(name, items) {
    const resp = await fetch(`${this.baseUrl}/rubric-templates/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, items }),
    });
    if (!resp.ok) await this._throwApiError(resp);
    return resp.json();
  }

  async applyRubricTemplate(pdfIdentifier, templateId) {
    const resp = await fetch(`${this.baseUrl}/rubric-templates/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdf_identifier: pdfIdentifier, template_id: templateId }),
    });
    if (!resp.ok) await this._throwApiError(resp);
    return resp.json();
  }

  async checkHealth() {
    const resp = await fetch(`${this.baseUrl}/health`);
    return resp.ok;
  }
}
