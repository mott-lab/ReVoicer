// Note organization. Section view groups by the stored `section` field on
// each note (set by the cleanup-service at note-creation time). Theme view is
// still LLM-driven over the full note set.

const { chat, parseJsonResponse } = require('./llm-service');
const { getNoteStore } = require('./note-store');
const { getSettingsStore } = require('./settings-store');

const SECTION_ORDER = [
  'abstract', 'introduction', 'background', 'related_work_section',
  'methods', 'results', 'discussion', 'conclusion', 'references',
];

const SECTION_LABELS = {
  abstract: 'Abstract',
  introduction: 'Introduction',
  background: 'Background',
  related_work_section: 'Related Work',
  methods: 'Methods',
  results: 'Results',
  discussion: 'Discussion',
  conclusion: 'Conclusion',
  references: 'References',
};

// hasHighlights: privacy mode omits the highlighted text from the note JSON,
// so the prompt must not promise a field that isn't there.
const byThemeSystem = (hasHighlights) => `You are organizing annotations from an academic paper.
Given a list of annotations with their ${hasHighlights ? 'highlighted text and ' : ''}cleaned comments, group them by intellectual theme or topic. Examples of themes:
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

function organizeBySection(notes) {
  const buckets = new Map();
  for (const n of notes) {
    const key = n.section || 'uncategorized';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(n);
  }
  const groups = [];
  for (const key of SECTION_ORDER) {
    if (buckets.has(key)) {
      groups.push({ title: SECTION_LABELS[key], notes: buckets.get(key) });
      buckets.delete(key);
    }
  }
  // Anything else (custom values that slipped through, or 'uncategorized')
  // goes at the end, alphabetised, with Uncategorized last.
  const remaining = [...buckets.keys()].filter((k) => k !== 'uncategorized').sort();
  for (const key of remaining) {
    groups.push({ title: SECTION_LABELS[key] || key, notes: buckets.get(key) });
  }
  if (buckets.has('uncategorized')) {
    groups.push({ title: 'Uncategorized', notes: buckets.get('uncategorized') });
  }
  return { groups };
}

async function organizeByTheme(notes) {
  if (notes.length === 0) return { groups: [] };
  // Privacy mode: the highlighted passages are paper content — theme grouping
  // works on the cleaned comments alone.
  const privacy = getSettingsStore().get().privacy_mode === true;
  const notesData = notes.map((n) => ({
    id: n.id,
    page_number: n.page_number || 0,
    ...(privacy ? {} : { selected_text: (n.selected_text || '').slice(0, 200) }),
    cleaned_comment: n.cleaned_comment || '',
  }));
  const notesJson = JSON.stringify(notesData, null, 2);

  let content;
  try {
    content = await chat({ system: byThemeSystem(!privacy), user: `Here are the annotations:\n\n${notesJson}` });
  } catch (err) {
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

async function organizeNotes(pdfIdentifier, mode) {
  const notes = await getNoteStore().listNotes(pdfIdentifier);
  if (notes.length === 0) return { groups: [] };
  if (mode === 'section') return organizeBySection(notes);
  return organizeByTheme(notes);
}

module.exports = { organizeNotes };
