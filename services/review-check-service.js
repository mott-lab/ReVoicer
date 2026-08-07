// Check the user's annotations against the paper's rubric sections. Each
// section is judged directly (covered / partial / missing) so verdicts map
// 1:1 onto the Rubric tab's cards, then the result is persisted so the
// coverage stays visible across sessions.
//
// Mirrors organize-service.js's notes → JSON → chat() → parseJsonResponse()
// flow, plus a save through review-check-store.

const { chat, parseJsonResponse } = require('./llm-service');
const { getNoteStore } = require('./note-store');
const { getReviewCheckStore } = require('./review-check-store');
const { getSettingsStore } = require('./settings-store');

const REVIEW_SYSTEM = `You are helping a peer reviewer check that their annotations on a paper cover every section of their reviewing rubric.

You will receive:
- The rubric as a JSON array of sections, each with an id, a section title, and a description of what the review should address for it.
- A list of the reviewer's annotations on the paper.

For EACH rubric section (do not skip, merge, or invent sections), decide how well the reviewer's annotations address it:
- "covered": one or more annotations clearly engage with this section.
- "partial": annotations touch on it but the coverage is shallow or one-sided.
- "missing": no annotation addresses this section meaningfully.

For each section, list the ids of the annotations that support your verdict (empty array if status is "missing"), and write a one-sentence gap_summary describing what the reviewer should still address. For "covered", a brief affirmation is fine.

Return a JSON object with this exact structure, using the same ids you were given:
{"sections":[{"id":"...","status":"covered"|"partial"|"missing","evidence_note_ids":["..."],"gap_summary":"..."}]}

Only output valid JSON. No other text.`;

async function checkReview({ pdfIdentifier, rubricItems }) {
  const items = (Array.isArray(rubricItems) ? rubricItems : [])
    .filter((it) => it && it.id)
    .map((it) => ({
      id: String(it.id),
      section: String(it.section || ''),
      description: String(it.description || ''),
    }));

  const notes = await getNoteStore().listNotes(pdfIdentifier);

  if (notes.length === 0) {
    return {
      sections: [],
      note_count: 0,
      checked_at: null,
    };
  }

  // Privacy mode: the highlighted passages are paper content; coverage is
  // judged from the comments alone. (The system prompt never mentions
  // highlights, so no wording change is needed.)
  const privacy = getSettingsStore().get().privacy_mode === true;
  const notesData = notes.map((n) => ({
    id: n.id,
    page_number: n.page_number || 0,
    section: n.section || null,
    comment_tags: n.comment_tags || [],
    ...(privacy ? {} : { selected_text: (n.selected_text || '').slice(0, 200) }),
    cleaned_comment: n.cleaned_comment || '',
  }));

  const userMsg = [
    '=== RUBRIC SECTIONS ===',
    JSON.stringify(items, null, 2),
    '=== END RUBRIC SECTIONS ===',
    '',
    '=== ANNOTATIONS ===',
    JSON.stringify(notesData, null, 2),
    '=== END ANNOTATIONS ===',
  ].join('\n');

  const content = await chat({ system: REVIEW_SYSTEM, user: userMsg });

  const parsed = parseJsonResponse(content);
  if (!parsed || !Array.isArray(parsed.sections)) {
    return {
      sections: [],
      parse_error: true,
      note_count: notes.length,
      checked_at: null,
    };
  }

  const notesById = new Map(notes.map((n) => [n.id, n]));
  const verdictById = new Map(
    parsed.sections.filter((s) => s && s.id).map((s) => [String(s.id), s])
  );

  // One entry per rubric item, in rubric order. A section the model dropped
  // is simply omitted; the renderer shows it as not checked.
  const sections = [];
  for (const item of items) {
    const v = verdictById.get(item.id);
    if (!v) continue;
    const status = ['covered', 'partial', 'missing'].includes(v.status) ? v.status : 'partial';
    const evidence = (Array.isArray(v.evidence_note_ids) ? v.evidence_note_ids : [])
      .map((id) => {
        const n = notesById.get(id);
        if (!n) return null;
        const comment = n.cleaned_comment || n.raw_transcript || '';
        return {
          id,
          page_number: n.page_number || 0,
          preview: comment.length > 80 ? comment.slice(0, 80) + '…' : comment,
        };
      })
      .filter(Boolean);
    sections.push({
      rubric_item_id: item.id,
      // Snapshot of the section text the check ran against — the renderer
      // compares it to the current card to flag stale verdicts.
      section: item.section,
      description: item.description,
      status,
      evidence,
      gap_summary: String(v.gap_summary || ''),
    });
  }

  const saved = await getReviewCheckStore().save(pdfIdentifier, { sections });
  return { ...saved, note_count: notes.length };
}

async function getSavedReviewCheck(pdfIdentifier) {
  const saved = await getReviewCheckStore().get(pdfIdentifier);
  // Pre-per-section records (rubric_text + components) can't be mapped onto
  // rubric cards; treat them as "no check yet".
  if (!saved || !Array.isArray(saved.sections)) return { empty: true };
  return saved;
}

module.exports = { checkReview, getSavedReviewCheck };
