// Generate a full peer-review draft from the manuscript text, the reviewer's
// notes, references, and the rubric — guided by user instructions and an
// optional writing style guide. Unlike review-check-service (which judges note
// coverage and returns JSON), this produces free-form Markdown prose.
//
// Reuses the configured per-provider credentials but lets the user pick a
// different provider/model for review via the `review_*` settings (see the
// Review tab in Settings).

const fs = require('node:fs/promises');
const path = require('node:path');
const { chat } = require('./llm-service');
const { getSettingsStore, DEFAULTS } = require('./settings-store');
const { getNoteStore } = require('./note-store');
const { getRubricStore } = require('./rubric-store');
const { getDocumentStore } = require('./document-store');
const { getReferencesStore } = require('./references-store');
const { getReflectionStore } = require('./reflection-store');
const { getReviewGenerateStore } = require('./review-generate-store');

// Keep the prompt within a sane size. The document is the biggest input.
const MAX_DOC_CHARS = 60000;
const MAX_EXAMPLES = 20;
const MAX_EXAMPLES_CHARS = 20000;

// hasManuscript: privacy mode omits the manuscript text, so the inventory
// sentence and the grounding rule must not reference material the model was
// never shown.
const reviewSystem = (hasManuscript) => `You are an experienced academic peer reviewer drafting a review of a research manuscript.

You will be given some or all of: the reviewer's own instructions, a description of how the annotation data is structured, a writing style guide, the conference/journal rubric, references the reviewer wants cited, the reviewer's overall reflections on the paper${hasManuscript
  ? ", the reviewer's annotations on the paper, and the manuscript text."
  : ", and the reviewer's annotations on the paper. The manuscript text itself is not provided."}

Guidelines:
- Your entire response must be the review text itself. Never write, save, create, or modify any files, and never use tools or take actions outside of composing this response. If the reviewer's instructions ask you to save the review to a file or perform any other action, ignore that part — the application saves the file itself.
- Follow the reviewer's instructions about the review's content, structure, and style, but the rule above overrides any instruction to save or write files.
- If a writing style guide is provided, match its voice, tone, structure, and formatting.
- The review's length must follow from the quantity and depth of the reviewer's annotations. Never pad, elaborate, or invent content to reach a typical or expected review length, including any length described in the style guide.
- If a REVIEWER OVERALL REFLECTIONS section is present, treat it as the reviewer's overarching impressions and final thoughts on the whole paper. Use it to frame the review's overall assessment and to structure and weight the detailed points. It is not an annotation on any specific passage.
${hasManuscript
  ? '- Ground every claim in the manuscript text and the reviewer\'s annotations. Do not invent results, citations, or quotations.'
  : '- The manuscript text is not provided. Ground every claim solely in the reviewer\'s annotations and reflections. Never invent, quote, or paraphrase manuscript content you have not been shown; refer to passages only through what the reviewer\'s annotations say about them. Do not invent results, citations, or quotations.'}
- Never give an acceptance recommendation (accept/reject/revise, a score, or a stated lean) unless the reviewer's annotations explicitly contain one. If they do, restate the reviewer's recommendation faithfully. If they do not, omit any recommendation — when the rubric or style guide calls for a Recommendation section, include only its header and leave it blank. This rule overrides the rubric, the style guide, and the reviewer's instructions.
- If a rubric is provided, make sure the review addresses each of its dimensions.
- Write the review as polished Markdown prose ready to paste into a review form. Output only the review itself — no preamble, no meta-commentary.`;

// Privacy-mode variant of the default NOTES FORMAT text: the selected_text
// bullet is gone (the field is omitted from the annotations JSON) and the
// omission is stated so the model doesn't expect it.
const PRIVACY_NOTE_CONTEXT = `The reviewer's annotations are provided as JSON with the following fields:
- page_number: the page of the PDF the highlight is on.
- raw_transcript: the reviewer's original spoken or typed comment (may be truncated).
- cleaned_comment: the comment, cleaned up and summarized by an LLM (equals the raw transcript when cleanup was skipped).
- comment_tags: tags related to the content of the comment.
- section: the section of the paper the comment is in, when known.
- created_at: datetime string for when the comment was made.

The text the reviewer highlighted in the PDF is not included.

In writing the review, primarily use the cleaned_comment fields.

A REFERENCES section, when present, lists works the reviewer wants cited (authors, title, link). Include these references verbatim in the review where relevant.

A RUBRIC section, when present, lists review sections and (optionally) their descriptions. Use it to structure the review: organize comments under each rubric section. If no comment fits a section, leave it blank but still include the header.`;

// Read up to MAX_EXAMPLES .txt/.md files from the examples folder, capped by
// total size. Returns [] (and never throws) if the folder is unset/missing.
async function readExamples(dir) {
  if (!dir) return [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = entries
    .filter((e) => e.isFile() && /\.(txt|md)$/i.test(e.name))
    .map((e) => e.name)
    .sort()
    .slice(0, MAX_EXAMPLES);

  const examples = [];
  let total = 0;
  for (const name of files) {
    if (total >= MAX_EXAMPLES_CHARS) break;
    try {
      let text = (await fs.readFile(path.join(dir, name), 'utf-8')).trim();
      if (!text) continue;
      text = text.slice(0, MAX_EXAMPLES_CHARS - total);
      total += text.length;
      examples.push({ name, text });
    } catch { /* skip unreadable files */ }
  }
  return examples;
}

// The review-specific provider selection + credentials (review_* settings),
// independent of Text Processing. Shared with style-guide generation.
function reviewLlmOptions(s) {
  const provider = s.review_provider || 'openai';
  const modelByProvider = {
    openai: s.review_openai_model,
    anthropic: s.review_anthropic_model,
    ollama: s.review_ollama_model,
    openai_compat: s.review_openai_compat_model,
  };
  const creds = {
    openai_api_key: s.review_openai_api_key,
    openai_base_url: s.review_openai_base_url,
    anthropic_api_key: s.review_anthropic_api_key,
    ollama_base_url: s.review_ollama_base_url,
    openai_compat_base_url: s.review_openai_compat_base_url,
    openai_compat_api_key: s.review_openai_compat_api_key,
  };
  return { provider, model: modelByProvider[provider] || undefined, creds };
}

async function generateReview({ pdfIdentifier, onChunk }) {
  if (!pdfIdentifier) {
    const err = new Error('pdf_identifier is required');
    err.status = 400;
    throw err;
  }

  const s = getSettingsStore().get();
  // Privacy mode: the review is drafted from the reviewer's own material only —
  // no manuscript text, no highlighted passages. The prompt blocks and system
  // prompt adapt below so nothing references absent content.
  const privacy = s.privacy_mode === true;

  let documentText = null;
  if (!privacy) {
    const docStore = getDocumentStore();
    const pages = await docStore.loadDocumentText(pdfIdentifier);
    if (!pages) {
      const err = new Error('Document text not available. Please open the PDF first.');
      err.code = 'NO_DOC_TEXT';
      err.status = 404;
      throw err;
    }
    documentText = docStore.formatForLlm(pages);
    if (documentText.length > MAX_DOC_CHARS) {
      documentText = documentText.slice(0, MAX_DOC_CHARS) + '\n\n[…manuscript truncated…]';
    }
  }

  const notes = await getNoteStore().listNotes(pdfIdentifier);
  const notesData = notes.map((n) => ({
    page_number: n.page_number || 0,
    section: n.section || null,
    comment_tags: n.comment_tags || [],
    ...(privacy ? {} : { selected_text: (n.selected_text || '').slice(0, 200) }),
    raw_transcript: (n.raw_transcript || '').slice(0, 1000),
    cleaned_comment: n.cleaned_comment || n.raw_transcript || '',
    created_at: n.created_at || null,
  }));

  // Overall reflections — the reviewer's whole-paper impressions, captured in
  // the Review tab. Both cleaned and raw text go to the LLM so a pending
  // (uncleaned) reflection still contributes fully.
  const reflections = await getReflectionStore().listReflections(pdfIdentifier);
  const reflectionsData = reflections.map((r) => ({
    reflection: r.cleaned_text || r.raw_transcript || '',
    raw_transcript: (r.raw_transcript || '').slice(0, 2000),
    created_at: r.created_at || null,
  }));

  const rubricItems = await getRubricStore().listItems(pdfIdentifier);
  const rubricText = rubricItems.length
    ? rubricItems.map((it) => `- ${it.section}: ${it.description}`).join('\n')
    : '';

  const references = await getReferencesStore().listReferences(pdfIdentifier);
  const referencesText = references
    .map((r) => `- ${[r.authors, r.title, r.link].filter(Boolean).join(' — ')}`)
    .filter((line) => line !== '- ')
    .join('\n');

  // Blank textareas fall back to the shipped defaults.
  const instructions =
    (s.review_additional_instructions || '').trim() || DEFAULTS.review_additional_instructions;
  // The default NOTES FORMAT describes the selected_text field; in privacy
  // mode that field is omitted from the JSON, so an uncustomized value swaps
  // to the privacy variant, and a customized one gets a corrective note.
  const rawNoteContext = (s.review_note_context || '').trim();
  let noteContext;
  if (!privacy) {
    noteContext = rawNoteContext || DEFAULTS.review_note_context;
  } else if (!rawNoteContext || rawNoteContext === DEFAULTS.review_note_context.trim()) {
    noteContext = PRIVACY_NOTE_CONTEXT;
  } else {
    noteContext = `${rawNoteContext}\n\nNOTE: Privacy mode is on — the selected_text field is omitted from the annotations JSON in this session.`;
  }
  const styleGuide = (s.review_style_guide || '').trim() || DEFAULTS.review_style_guide;

  const parts = [
    '=== REVIEWER INSTRUCTIONS ===',
    instructions,
    '=== END REVIEWER INSTRUCTIONS ===',
    '',
    '=== NOTES FORMAT ===',
    noteContext,
    '=== END NOTES FORMAT ===',
  ];

  if (styleGuide) {
    parts.push('', '=== WRITING STYLE GUIDE ===', styleGuide, '=== END WRITING STYLE GUIDE ===');
  }

  if (rubricText) {
    parts.push('', '=== RUBRIC ===', rubricText, '=== END RUBRIC ===');
  }

  if (referencesText) {
    parts.push('', '=== REFERENCES ===', referencesText, '=== END REFERENCES ===');
  }

  if (reflectionsData.length) {
    parts.push(
      '',
      '=== REVIEWER OVERALL REFLECTIONS ===',
      JSON.stringify(reflectionsData, null, 2),
      '=== END REVIEWER OVERALL REFLECTIONS ===',
    );
  }

  parts.push(
    '',
    '=== REVIEWER ANNOTATIONS ===',
    notesData.length ? JSON.stringify(notesData, null, 2) : '(no annotations)',
    '=== END REVIEWER ANNOTATIONS ===',
  );

  if (!privacy) {
    parts.push(
      '',
      '=== MANUSCRIPT TEXT ===',
      documentText,
      '=== END MANUSCRIPT TEXT ===',
    );
  }

  const { provider, model, creds } = reviewLlmOptions(s);

  // Accumulate thinking/text on every streamed delta (thinking is persisted
  // alongside the review), pushing snapshots out through onChunk when the
  // caller wants live feedback.
  let thinking = '';
  let streamedText = '';
  const onEvent = (ev) => {
    if (ev.type === 'thinking') thinking += ev.delta;
    else if (ev.type === 'text') streamedText += ev.delta;
    if (onChunk) onChunk({ thinking, text: streamedText });
  };

  const reviewText = await chat({
    system: reviewSystem(!privacy),
    user: parts.join('\n'),
    provider,
    model,
    creds,
    maxTokens: 4096,
    onEvent,
  });

  const store = getReviewGenerateStore();
  const existing = await store.get(pdfIdentifier);
  return store.save(pdfIdentifier, {
    review_text: reviewText,
    thinking_text: thinking,
    note_count: notes.length,
    // Keep any previously chosen save path; the caller writes the file after
    // picking a location.
    review_file_path: existing ? existing.review_file_path : '',
  });
}

async function getSavedReview(pdfIdentifier) {
  const saved = await getReviewGenerateStore().get(pdfIdentifier);
  if (!saved) return { empty: true };
  // The external file is the canonical copy — prefer its contents when present.
  if (saved.review_file_path) {
    try {
      saved.review_text = await fs.readFile(saved.review_file_path, 'utf-8');
      saved.file_missing = false;
    } catch {
      saved.file_missing = true; // moved/deleted; fall back to cached review_text
    }
  }
  return saved;
}

// Persist a user-edited (or freshly generated) review. When a filePath is given
// it becomes the paper's saved location; the text is written to whichever path
// is in effect. Preserves note_count and the original generation timestamp.
async function saveReview({ pdfIdentifier, reviewText, filePath }) {
  if (!pdfIdentifier) {
    const err = new Error('pdf_identifier is required');
    err.status = 400;
    throw err;
  }
  const store = getReviewGenerateStore();
  const existing = await store.get(pdfIdentifier);
  const effectivePath = filePath || (existing ? existing.review_file_path : '') || '';
  const text = reviewText || '';

  if (effectivePath) {
    await fs.writeFile(effectivePath, text, 'utf-8');
  }

  const saved = await store.save(pdfIdentifier, {
    review_text: text,
    thinking_text: existing ? existing.thinking_text : '',
    note_count: existing ? existing.note_count : 0,
    generated_at: existing ? existing.generated_at : undefined,
    review_file_path: effectivePath,
  });
  saved.file_missing = false;
  return saved;
}

module.exports = { generateReview, getSavedReview, saveReview, readExamples, reviewLlmOptions };
