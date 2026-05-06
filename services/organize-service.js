// LLM-driven note organization (by section / by theme).

const { chat, parseJsonResponse } = require('./llm-service');
const { getNoteStore } = require('./note-store');

const BY_SECTION_SYSTEM = `You are organizing annotations from an academic paper.
Given a list of annotations with their page numbers and highlighted text, group them by logical sections of the paper (e.g., Abstract, Introduction, Related Work, Methods, Results, Discussion, Conclusion).

Infer section names from the highlighted text context and page numbers.
If you cannot determine the section, use "Uncategorized".

Return a JSON object with this exact structure:
{"groups": [{"title": "Section Name", "note_ids": ["id1", "id2", "id3"]}]}

Only output valid JSON. No other text.`;

const BY_THEME_SYSTEM = `You are organizing annotations from an academic paper.
Given a list of annotations with their highlighted text and cleaned comments, group them by intellectual theme or topic. Examples of themes:
- Methodology concerns
- Key findings
- Connections to other work
- Questions for follow-up
- Statistical issues
- Writing/presentation
- Motivation/framing

Create 2-6 thematic groups based on the actual content of the annotations.

Return a JSON object with this exact structure:
{"groups": [{"title": "Theme Name", "note_ids": ["id1", "id2", "id3"]}]}

Only output valid JSON. No other text.`;

async function organizeNotes(pdfIdentifier, mode) {
  const notes = await getNoteStore().listNotes(pdfIdentifier);
  if (notes.length === 0) return { groups: [] };

  const notesData = notes.map((n) => ({
    id: n.id,
    page_number: n.page_number || 0,
    selected_text: (n.selected_text || '').slice(0, 200),
    cleaned_comment: n.cleaned_comment || '',
  }));
  const notesJson = JSON.stringify(notesData, null, 2);

  const system = mode === 'section' ? BY_SECTION_SYSTEM : BY_THEME_SYSTEM;
  const user = `Here are the annotations:\n\n${notesJson}`;

  let content;
  try {
    content = await chat({ system, user });
  } catch (err) {
    // Surface the error but also fall back so the sidebar still renders
    // something. Mirrors the Python "single bucket" fallback.
    return { groups: [{ title: `All Notes (LLM error: ${err.message})`, notes }] };
  }

  const parsed = parseJsonResponse(content);
  if (!parsed || !Array.isArray(parsed.groups)) {
    return { groups: [{ title: 'All Notes', notes }] };
  }

  const byId = new Map(notes.map((n) => [n.id, n]));
  const groups = [];
  for (const g of parsed.groups) {
    const groupNotes = (g.note_ids || [])
      .map((id) => byId.get(id))
      .filter(Boolean);
    if (groupNotes.length > 0) {
      groups.push({ title: g.title, notes: groupNotes });
    }
  }
  return { groups };
}

module.exports = { organizeNotes };
