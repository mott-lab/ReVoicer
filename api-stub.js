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
    const { cleanup_enabled } = getSettingsStore().get();
    const skipRewrite = body.skip_cleanup || !cleanup_enabled;
    const pageContext = cleanup_enabled
      ? await buildPageContext(body.pdf_identifier, body.page_number)
      : '';
    let cleaned;
    let commentTags;
    let section;
    if (skipRewrite) {
      cleaned = body.raw_transcript || '';
      if (cleanup_enabled) {
        const r = await classifyCommentType(body.selected_text || '', body.raw_transcript || '', pageContext);
        commentTags = r.tags;
        section = r.section;
      } else {
        commentTags = inferCommentTags(body.raw_transcript);
        section = null;
      }
    } else {
      const result = await cleanupTranscript(body.selected_text || '', body.raw_transcript || '', pageContext);
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
    const store = getNoteStore();
    const note = await store.getNote(query.pdf_identifier, params.id);
    if (!note) return { __status: 404, error: 'Note not found' };
    const pageContext = await buildPageContext(query.pdf_identifier, note.page_number);
    const { comment, tags, section } = await cleanupTranscript(
      note.selected_text || '',
      note.raw_transcript || '',
      pageContext,
    );
    return store.updateNote(query.pdf_identifier, params.id, {
      cleaned_comment: comment,
      comment_tags: tags,
      section,
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
