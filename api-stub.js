// In-process implementation of the API surface fetched at
// http://localhost:8000/api/* (intercepted by preload.js). All routes
// dispatch to ./services/.
//
// (File name kept as `api-stub.js` for git history continuity — it is no
// longer a stub.)

const { getNoteStore } = require('./services/note-store');
const { getDocumentStore } = require('./services/document-store');
const { getQAStore } = require('./services/qa-store');
const { exportToMarkdown } = require('./services/export-service');
const { cleanupTranscript, classifyCommentType } = require('./services/cleanup-service');
const { organizeNotes } = require('./services/organize-service');
const { askQuestion } = require('./services/qa-service');
const { transcribeAudio } = require('./services/transcribe-service');
const { getSettingsStore } = require('./services/settings-store');
const { checkReview, getSavedReviewCheck } = require('./services/review-check-service');
const { getReviewCheckStore } = require('./services/review-check-store');
const { generateReview, getSavedReview, saveReview } = require('./services/review-generate-service');
const { getReviewGenerateStore } = require('./services/review-generate-store');
const { getReferencesStore } = require('./services/references-store');
const { getRubricStore } = require('./services/rubric-store');
const { extractRubricItems } = require('./services/rubric-extract-service');
const { getRubricTemplatesStore } = require('./services/rubric-templates-store');
const { extractCitations } = require('./services/citation-extract-service');
const { lookupCitation } = require('./services/scholar-lookup-service');
const { getCitationsStore } = require('./services/citations-store');

// Heuristic fallback used when the user has globally disabled LLM cleanup.
// Mirrors the categories defined in cleanup-service VALID_TAGS. Returns a
// single-element tag array for parity with the LLM path.
function inferCommentTags(text) {
  const lower = (text || '').toLowerCase();
  if (lower.includes('?')) return ['question'];
  if (lower.includes('weak') || lower.includes('issue') || lower.includes('problem')) return ['critique'];
  if (lower.includes('strong') || lower.includes('good') || lower.includes('nice')) return ['strength'];
  if (lower.includes('todo') || lower.includes('follow up') || lower.includes('check')) return ['follow_up'];
  if (lower.includes('related') || lower.includes('cf.') || lower.includes('see also')) return ['related_work'];
  if (lower.includes('suggest')) return ['suggestion'];
  return ['summary'];
}

// Build a small context snippet for the cleanup LLM: the current page text plus
// the previous page (often where the section heading lives). Capped so we
// don't blow past the model's cheap-token budget.
async function buildPageContext(pdfIdentifier, pageNumber) {
  if (!pdfIdentifier || !pageNumber || pageNumber < 1) return '';
  try {
    const pages = await getDocumentStore().loadDocumentText(pdfIdentifier);
    if (!pages) return '';
    const parts = [];
    const prev = pages[String(pageNumber - 1)];
    if (prev) parts.push(`[Page ${pageNumber - 1}]\n${prev.slice(-1500)}`);
    const cur = pages[String(pageNumber)];
    if (cur) parts.push(`[Page ${pageNumber}]\n${cur.slice(0, 3000)}`);
    return parts.join('\n\n');
  } catch {
    return '';
  }
}

const routes = {
  'GET /api/health': () => ({ status: 'ok' }),

  // ─── Notes ─────────────────────────────────────────────────────────────

  'GET /api/notes/': async ({ query }) => {
    const notes = await getNoteStore().listNotes(query.pdf_identifier);
    return { notes, total: notes.length };
  },

  'POST /api/notes/': async ({ body }) => {
    const { cleanup_enabled, offline_mode } = getSettingsStore().get();
    if (offline_mode) {
      // Offline: no LLM, no heuristics — save raw and mark pending so the
      // sidebar's "Clean pending" queue can process it once back online.
      return getNoteStore().createNote({
        contentHash: body.pdf_identifier,
        pdfTitle: body.pdf_title || null,
        pdfUrl: null,
        selectedText: body.selected_text || '',
        pageNumber: body.page_number || 0,
        rawTranscript: body.raw_transcript || '',
        cleanedComment: body.raw_transcript || '',
        commentTags: ['summary'], // placeholder; replaced when cleaned
        section: null,
        highlightData: body.highlight_data || null,
        cleanupStatus: 'pending',
        // Typed notes with "Clean up with LLM" unchecked keep their text
        // verbatim when the queue drains — classify (tags/section) only.
        cleanupMode: body.skip_cleanup ? 'classify' : 'full',
      });
    }
    const skipRewrite = body.skip_cleanup || !cleanup_enabled;
    const pageContext = cleanup_enabled
      ? await buildPageContext(body.pdf_identifier, body.page_number)
      : '';
    const references = cleanup_enabled
      ? await getReferencesStore().listReferences(body.pdf_identifier)
      : [];
    let cleaned;
    let commentTags;
    let section;
    if (skipRewrite) {
      cleaned = body.raw_transcript || '';
      if (cleanup_enabled) {
        const r = await classifyCommentType(body.selected_text || '', body.raw_transcript || '', pageContext, references);
        commentTags = r.tags;
        section = r.section;
      } else {
        commentTags = inferCommentTags(body.raw_transcript);
        section = null;
      }
    } else {
      const result = await cleanupTranscript(body.selected_text || '', body.raw_transcript || '', pageContext, references);
      cleaned = result.comment;
      commentTags = result.tags;
      section = result.section;
    }

    return getNoteStore().createNote({
      contentHash: body.pdf_identifier,
      pdfTitle: body.pdf_title || null,
      pdfUrl: null,
      selectedText: body.selected_text || '',
      pageNumber: body.page_number || 0,
      rawTranscript: body.raw_transcript || '',
      cleanedComment: cleaned,
      commentTags,
      section,
      highlightData: body.highlight_data || null,
    });
  },

  'DELETE /api/notes/:id': async ({ params, query }) => {
    const ok = await getNoteStore().deleteNote(query.pdf_identifier, params.id);
    if (!ok) return { __status: 404, error: 'Note not found' };
    return { ok: true };
  },

  'PUT /api/notes/:id/reclean': async ({ params, query }) => {
    if (getSettingsStore().get().offline_mode) {
      return {
        __status: 503,
        error: 'Offline mode is on — turn it off in Settings to clean notes.',
        code: 'OFFLINE',
      };
    }
    const store = getNoteStore();
    const note = await store.getNote(query.pdf_identifier, params.id);
    if (!note) return { __status: 404, error: 'Note not found' };
    const pageContext = await buildPageContext(query.pdf_identifier, note.page_number);
    const references = await getReferencesStore().listReferences(query.pdf_identifier);

    // Pending classify-only notes (typed offline with "Clean up with LLM"
    // unchecked) keep their text verbatim — only tags/section are assigned.
    // An explicit Re-clean of an already-done note is always a full clean.
    if (note.cleanup_status === 'pending' && note.cleanup_mode === 'classify') {
      const { tags, section } = await classifyCommentType(
        note.selected_text || '',
        note.raw_transcript || '',
        pageContext,
        references,
      );
      return store.updateNote(query.pdf_identifier, params.id, {
        comment_tags: tags,
        section,
        cleanup_status: 'done',
      });
    }

    const { comment, tags, section } = await cleanupTranscript(
      note.selected_text || '',
      note.raw_transcript || '',
      pageContext,
      references,
    );
    return store.updateNote(query.pdf_identifier, params.id, {
      cleaned_comment: comment,
      comment_tags: tags,
      section,
      cleanup_status: 'done',
    });
  },

  'PUT /api/notes/:id': async ({ params, query, body }) => {
    const store = getNoteStore();
    const updates = {};
    if (Array.isArray(body?.comment_tags)) {
      const filtered = body.comment_tags.filter(
        (t) => typeof t === 'string' && /^[a-z_]+$/.test(t),
      );
      if (filtered.length > 0) updates.comment_tags = filtered.slice(0, 3);
    }
    if ('section' in (body || {})) {
      updates.section = body.section || null;
    }
    if (typeof body?.cleaned_comment === 'string') {
      updates.cleaned_comment = body.cleaned_comment;
    }
    if ('color_override' in (body || {})) {
      const c = body.color_override;
      // Allow null (reset) or a #RRGGBB hex.
      if (c === null || (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c))) {
        updates.color_override = c;
      }
    }
    if (Object.keys(updates).length === 0) {
      return { __status: 400, error: 'No valid fields to update' };
    }
    const updated = await store.updateNote(query.pdf_identifier, params.id, updates);
    if (!updated) return { __status: 404, error: 'Note not found' };
    return updated;
  },

  // ─── Export ────────────────────────────────────────────────────────────

  'GET /api/export/markdown': async ({ query }) => {
    return exportToMarkdown(query.pdf_identifier);
  },

  // ─── Documents ─────────────────────────────────────────────────────────

  'POST /api/documents/text': async ({ body }) => {
    await getDocumentStore().saveDocumentText(body.pdf_identifier, body.pages || {});
    return { ok: true, pages: Object.keys(body.pages || {}).length };
  },

  // ─── Organize ──────────────────────────────────────────────────────────

  'GET /api/organize/by-section': async ({ query }) => {
    return organizeNotes(query.pdf_identifier, 'section');
  },

  'GET /api/organize/by-theme': async ({ query }) => {
    return organizeNotes(query.pdf_identifier, 'theme');
  },

  // ─── Review Check ──────────────────────────────────────────────────────

  'GET /api/review-check/': async ({ query }) => {
    return getSavedReviewCheck(query.pdf_identifier);
  },

  'POST /api/review-check/': async ({ body }) => {
    return checkReview({
      pdfIdentifier: body.pdf_identifier,
      rubricText: body.rubric_text || '',
    });
  },

  // ─── Review Generate ───────────────────────────────────────────────────

  'GET /api/review/': async ({ query }) => {
    return getSavedReview(query.pdf_identifier);
  },

  'POST /api/review/generate': async ({ body }) => {
    return generateReview({ pdfIdentifier: body.pdf_identifier });
  },

  'PUT /api/review/': async ({ body }) => {
    return saveReview({
      pdfIdentifier: body.pdf_identifier,
      reviewText: body.review_text || '',
      filePath: body.file_path || '',
    });
  },

  // ─── Transcribe ────────────────────────────────────────────────────────

  'POST /api/transcribe': async ({ body }) => {
    return transcribeAudio({
      data: body?.audio || body?.audio_blob?.data,
      type: body?.audio_blob?.type || 'audio/webm',
      name: body?.audio_blob?.name || 'recording.webm',
    });
  },

  // ─── Q&A ───────────────────────────────────────────────────────────────

  'POST /api/qa/': async ({ body }) => {
    return askQuestion({
      pdfIdentifier: body.pdf_identifier,
      question: body.question,
      selectedText: body.selected_text,
      pageNumber: body.page_number,
    });
  },

  'GET /api/qa/': async ({ query }) => {
    const entries = await getQAStore().listEntries(query.pdf_identifier);
    return { entries, total: entries.length };
  },

  'DELETE /api/qa/:id': async ({ params, query }) => {
    const ok = await getQAStore().deleteEntry(query.pdf_identifier, params.id);
    if (!ok) return { __status: 404, error: 'Q&A entry not found' };
    return { ok: true };
  },

  // ─── References ────────────────────────────────────────────────────────

  'GET /api/references/': async ({ query }) => {
    const references = await getReferencesStore().listReferences(query.pdf_identifier);
    return { references, total: references.length };
  },

  'POST /api/references/': async ({ body }) => {
    if (!body?.pdf_identifier) {
      return { __status: 400, error: 'pdf_identifier is required' };
    }
    return getReferencesStore().createReference({
      contentHash: body.pdf_identifier,
      authors: body.authors || '',
      title: body.title || '',
      link: body.link || '',
    });
  },

  'PUT /api/references/:id': async ({ params, query, body }) => {
    const updates = {};
    if (typeof body?.authors === 'string') updates.authors = body.authors;
    if (typeof body?.title === 'string') updates.title = body.title;
    if (typeof body?.link === 'string') updates.link = body.link;
    if (Object.keys(updates).length === 0) {
      return { __status: 400, error: 'No valid fields to update' };
    }
    const updated = await getReferencesStore().updateReference(query.pdf_identifier, params.id, updates);
    if (!updated) return { __status: 404, error: 'Reference not found' };
    return updated;
  },

  'DELETE /api/references/:id': async ({ params, query }) => {
    const ok = await getReferencesStore().deleteReference(query.pdf_identifier, params.id);
    if (!ok) return { __status: 404, error: 'Reference not found' };
    return { ok: true };
  },

  // ─── Rubric ────────────────────────────────────────────────────────────

  'GET /api/rubric/': async ({ query }) => {
    const items = await getRubricStore().listItems(query.pdf_identifier);
    return { items, total: items.length };
  },

  'POST /api/rubric/': async ({ body }) => {
    if (!body?.pdf_identifier) {
      return { __status: 400, error: 'pdf_identifier is required' };
    }
    return getRubricStore().createItem({
      contentHash: body.pdf_identifier,
      section: body.section || '',
      description: body.description || '',
    });
  },

  // Extract rubric items from pasted text via the LLM and append each as a
  // new entry in the rubric store. Returns the list of created items so the
  // sidebar can refresh and the user can edit them in place.
  'POST /api/rubric/parse': async ({ body }) => {
    if (!body?.pdf_identifier) {
      return { __status: 400, error: 'pdf_identifier is required' };
    }
    const { items, parse_error } = await extractRubricItems({
      rubricText: body.rubric_text || '',
    });
    const store = getRubricStore();
    const created = [];
    for (const it of items) {
      // Sequential insert keeps the per-PDF lock simple — each createItem
      // takes the lock, writes, releases. Item count is small enough that
      // serial inserts are not a perf concern.
      const item = await store.createItem({
        contentHash: body.pdf_identifier,
        section: it.section,
        description: it.description,
      });
      created.push(item);
    }
    return { items: created, parse_error: !!parse_error };
  },

  'PUT /api/rubric/:id': async ({ params, query, body }) => {
    const updates = {};
    if (typeof body?.section === 'string') updates.section = body.section;
    if (typeof body?.description === 'string') updates.description = body.description;
    if (Object.keys(updates).length === 0) {
      return { __status: 400, error: 'No valid fields to update' };
    }
    const updated = await getRubricStore().updateItem(query.pdf_identifier, params.id, updates);
    if (!updated) return { __status: 404, error: 'Rubric item not found' };
    return updated;
  },

  'DELETE /api/rubric/:id': async ({ params, query }) => {
    const ok = await getRubricStore().deleteItem(query.pdf_identifier, params.id);
    if (!ok) return { __status: 404, error: 'Rubric item not found' };
    return { ok: true };
  },

  // ─── Rubric templates (named, reusable rubrics) ─────────────────────────

  'GET /api/rubric-templates/': async () => {
    const templates = await getRubricTemplatesStore().list();
    return {
      templates: templates.map((t) => ({
        id: t.id,
        name: t.name,
        item_count: (t.items || []).length,
        updated_at: t.updated_at,
      })),
    };
  },

  // Save (upsert by name) the supplied rubric items under a name.
  'POST /api/rubric-templates/': async ({ body }) => {
    if (!body?.name || !String(body.name).trim()) {
      return { __status: 400, error: 'name is required' };
    }
    return getRubricTemplatesStore().save({ name: body.name, items: body.items || [] });
  },

  // Apply a saved template to a PDF: replace that PDF's rubric with the
  // template's items. Returns the new rubric items.
  'POST /api/rubric-templates/apply': async ({ body }) => {
    if (!body?.pdf_identifier || !body?.template_id) {
      return { __status: 400, error: 'pdf_identifier and template_id are required' };
    }
    const tpl = await getRubricTemplatesStore().getById(body.template_id);
    if (!tpl) return { __status: 404, error: 'Rubric template not found' };
    const items = await getRubricStore().replaceItems(body.pdf_identifier, tpl.items || []);
    return { items };
  },

  // ─── Citations ─────────────────────────────────────────────────────────

  // Parse + cache the numbered reference list. Returns the set of available
  // reference numbers so the renderer knows which in-text "[N]" to make
  // clickable.
  'POST /api/citations/extract': async ({ body }) => {
    if (!body?.pdf_identifier) {
      return { __status: 400, error: 'pdf_identifier is required' };
    }
    return extractCitations({ pdfIdentifier: body.pdf_identifier });
  },

  // Look up one reference's metadata (cached per number after the first call).
  'POST /api/citations/lookup': async ({ body }) => {
    if (!body?.pdf_identifier || body.number == null) {
      return { __status: 400, error: 'pdf_identifier and number are required' };
    }
    return lookupCitation({ pdfIdentifier: body.pdf_identifier, number: body.number });
  },
};

function matchRoute(method, pathname) {
  const exact = routes[`${method} ${pathname}`];
  if (exact) return { handler: exact, params: {} };
  for (const key of Object.keys(routes)) {
    const sp = key.indexOf(' ');
    if (key.slice(0, sp) !== method) continue;
    const pattern = key.slice(sp + 1);
    if (!pattern.includes(':')) continue;
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$');
    const m = pathname.match(re);
    if (m) return { handler: routes[key], params: m.groups || {} };
  }
  return null;
}

let _initialized = false;

function initialize({ notesDir }) {
  if (_initialized) return;
  getNoteStore(notesDir);
  getDocumentStore(notesDir);
  getQAStore(notesDir);
  getReviewCheckStore(notesDir);
  getReviewGenerateStore(notesDir);
  getReferencesStore(notesDir);
  getRubricStore(notesDir);
  getRubricTemplatesStore(notesDir);
  getCitationsStore(notesDir);
  _initialized = true;
}

async function handleRequest({ method, path: pathname, query, body }) {
  const matched = matchRoute(method, pathname);
  if (!matched) {
    return { status: 404, body: { error: `no route for ${method} ${pathname}` } };
  }
  try {
    const result = await matched.handler({ params: matched.params, query: query || {}, body });
    if (result && typeof result === 'object' && '__status' in result) {
      const { __status, ...rest } = result;
      return { status: __status, body: rest };
    }
    return { status: 200, body: result };
  } catch (err) {
    return {
      status: err.status || 500,
      body: { error: err.message || String(err), code: err.code || null },
    };
  }
}

module.exports = { initialize, handleRequest };
