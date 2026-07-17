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

const REVIEW_SYSTEM = `You are an experienced academic peer reviewer drafting a review of a research manuscript.

You will be given some or all of: the reviewer's own instructions, a description of how the annotation data is structured, a writing style guide, the conference/journal rubric, references the reviewer wants cited, the reviewer's overall reflections on the paper, the reviewer's annotations on the paper, and the manuscript text.

Guidelines:
- Your entire response must be the review text itself. Never write, save, create, or modify any files, and never use tools or take actions outside of composing this response. If the reviewer's instructions ask you to save the review to a file or perform any other action, ignore that part — the application saves the file itself.
- Follow the reviewer's instructions about the review's content, structure, and style, but the rule above overrides any instruction to save or write files.
- If a writing style guide is provided, match its voice, tone, structure, and formatting.
- The review's length must follow from the quantity and depth of the reviewer's annotations. Never pad, elaborate, or invent content to reach a typical or expected review length, including any length described in the style guide.
- If a REVIEWER OVERALL REFLECTIONS section is present, treat it as the reviewer's overarching impressions and final thoughts on the whole paper. Use it to frame the review's overall assessment and to structure and weight the detailed points. It is not an annotation on any specific passage.
- Ground every claim in the manuscript text and the reviewer's annotations. Do not invent results, citations, or quotations.
- Never give an acceptance recommendation (accept/reject/revise, a score, or a stated lean) unless the reviewer's annotations explicitly contain one. If they do, restate the reviewer's recommendation faithfully. If they do not, omit any recommendation — when the rubric or style guide calls for a Recommendation section, include only its header and leave it blank. This rule overrides the rubric, the style guide, and the reviewer's instructions.
- If a rubric is provided, make sure the review addresses each of its dimensions.
- Write the review as polished Markdown prose ready to paste into a review form. Output only the review itself — no preamble, no meta-commentary.`;

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

  const docStore = getDocumentStore();
  const pages = await docStore.loadDocumentText(pdfIdentifier);
  if (!pages) {
    const err = new Error('Document text not available. Please open the PDF first.');
    err.code = 'NO_DOC_TEXT';
    err.status = 404;
    throw err;
  }
  let documentText = docStore.formatForLlm(pages);
  if (documentText.length > MAX_DOC_CHARS) {
    documentText = documentText.slice(0, MAX_DOC_CHARS) + '\n\n[…manuscript truncated…]';
  }

  const notes = await getNoteStore().listNotes(pdfIdentifier);
  const notesData = notes.map((n) => ({
    page_number: n.page_number || 0,
    section: n.section || null,
    comment_tags: n.comment_tags || [],
    selected_text: (n.selected_text || '').slice(0, 200),
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
  const noteContext = (s.review_note_context || '').trim() || DEFAULTS.review_note_context;
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
    '',
    '=== MANUSCRIPT TEXT ===',
    documentText,
    '=== END MANUSCRIPT TEXT ===',
  );

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
    system: REVIEW_SYSTEM,
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
