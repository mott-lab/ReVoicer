// Check the user's annotations against a pasted reviewing rubric. Extracts
// rubric components via the LLM and judges each as covered / partial /
// missing, then persists the result so reopening the modal restores state.
//
// Mirrors organize-service.js's notes → JSON → chat() → parseJsonResponse()
// flow, plus a save through review-check-store.

const { chat, parseJsonResponse } = require('./llm-service');
const { getNoteStore } = require('./note-store');
const { getReviewCheckStore } = require('./review-check-store');

const REVIEW_SYSTEM = `You are helping a peer reviewer check that their annotations on a paper cover all the main components their conference's reviewing rubric asks for.

You will receive:
- A rubric (the conference's reviewing standards / required dimensions).
- A list of the reviewer's annotations on the paper.

Your tasks:
1. Extract 3–8 of the most important components the rubric requires the review to address. Use short titles (e.g. "Novelty", "Soundness of methods").
2. For each component, decide how well the reviewer's annotations address it:
   - "covered": one or more annotations clearly engage with this component.
   - "partial": annotations touch on it but the coverage is shallow or one-sided.
   - "missing": no annotation addresses this component meaningfully.
3. For each component, list the ids of the annotations that support your verdict (empty array if status is "missing").
4. For each component, write a one-sentence gap_summary describing what the reviewer should still address. For "covered", a brief affirmation is fine.

Return a JSON object with this exact structure:
{"components":[{"title":"...","description":"...","status":"covered"|"partial"|"missing","evidence_note_ids":["..."],"gap_summary":"..."}]}

Only output valid JSON. No other text.`;

async function checkReview({ pdfIdentifier, rubricText }) {
  const notes = await getNoteStore().listNotes(pdfIdentifier);

  if (notes.length === 0) {
    return {
      rubric_text: rubricText || '',
      components: [],
      note_count: 0,
      checked_at: null,
    };
  }

  const notesData = notes.map((n) => ({
    id: n.id,
    page_number: n.page_number || 0,
    section: n.section || null,
    comment_tags: n.comment_tags || [],
    selected_text: (n.selected_text || '').slice(0, 200),
    cleaned_comment: n.cleaned_comment || '',
  }));
  const notesJson = JSON.stringify(notesData, null, 2);

  const userMsg = [
    '=== RUBRIC ===',
    rubricText || '(empty rubric)',
    '=== END RUBRIC ===',
    '',
    '=== ANNOTATIONS ===',
    notesJson,
    '=== END ANNOTATIONS ===',
  ].join('\n');

  const content = await chat({ system: REVIEW_SYSTEM, user: userMsg });

  const parsed = parseJsonResponse(content);
  if (!parsed || !Array.isArray(parsed.components)) {
    return {
      rubric_text: rubricText || '',
      components: [],
      parse_error: true,
      note_count: notes.length,
      checked_at: null,
    };
  }

  const byId = new Map(notes.map((n) => [n.id, n]));
  const components = parsed.components.map((c) => {
    const status = ['covered', 'partial', 'missing'].includes(c.status) ? c.status : 'partial';
    const evidence = (Array.isArray(c.evidence_note_ids) ? c.evidence_note_ids : [])
      .map((id) => {
        const n = byId.get(id);
        if (!n) return null;
        const comment = n.cleaned_comment || n.raw_transcript || '';
        return {
          id,
          page_number: n.page_number || 0,
          preview: comment.length > 80 ? comment.slice(0, 80) + '…' : comment,
        };
      })
      .filter(Boolean);
    return {
      title: String(c.title || 'Untitled'),
      description: String(c.description || ''),
      status,
      evidence,
      gap_summary: String(c.gap_summary || ''),
    };
  });

  const saved = await getReviewCheckStore().save(pdfIdentifier, {
    rubric_text: rubricText || '',
    components,
  });
  return { ...saved, note_count: notes.length };
}

async function getSavedReviewCheck(pdfIdentifier) {
  const saved = await getReviewCheckStore().get(pdfIdentifier);
  if (!saved) return { empty: true };
  return saved;
}

module.exports = { checkReview, getSavedReviewCheck };
