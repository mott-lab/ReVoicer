// Generate a full peer-review draft from the manuscript text, the reviewer's
// notes, and the rubric — guided by user instructions and optional example
// reviews. Unlike review-check-service (which judges note coverage and returns
// JSON), this produces free-form Markdown prose.
//
// Reuses the configured per-provider credentials but lets the user pick a
// different provider/model for review via the `review_*` settings (see the
// Review tab in Settings).

const fs = require('node:fs/promises');
const path = require('node:path');
const { chat } = require('./llm-service');
const { getSettingsStore } = require('./settings-store');
const { getNoteStore } = require('./note-store');
const { getRubricStore } = require('./rubric-store');
const { getDocumentStore } = require('./document-store');
const { getReviewGenerateStore } = require('./review-generate-store');

const DEFAULT_INSTRUCTIONS =
  'Write a review for the academic research manuscript. Use any note contents and rubric provided.';

// Keep the prompt within a sane size. The document is the biggest input.
const MAX_DOC_CHARS = 60000;
const MAX_EXAMPLES = 20;
const MAX_EXAMPLES_CHARS = 20000;

const REVIEW_SYSTEM = `You are an experienced academic peer reviewer drafting a review of a research manuscript.

You will be given some or all of: the reviewer's own instructions, a writing style guide, one or more example reviews to imitate in structure and voice, the conference/journal rubric, the reviewer's annotations on the paper, and the manuscript text.

Guidelines:
- Follow the reviewer's instructions above all else.
- If a writing style guide is provided, match its voice, tone, and formatting.
- If example reviews are provided, mirror their structure, tone, length, and level of detail. Do not copy their content.
- Ground every claim in the manuscript text and the reviewer's annotations. Do not invent results, citations, or quotations.
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

// Resolve the instruction text: the textarea, or the built-in default.
function resolveInstructions(s) {
  return (s.review_instructions || '').trim() || DEFAULT_INSTRUCTIONS;
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
    cleaned_comment: n.cleaned_comment || n.raw_transcript || '',
    created_at: n.created_at || null,
  }));

  const rubricItems = await getRubricStore().listItems(pdfIdentifier);
  const rubricText = rubricItems.length
    ? rubricItems.map((it) => `- ${it.section}: ${it.description}`).join('\n')
    : '';

  const examples = await readExamples(s.review_examples_dir);
  const instructions = resolveInstructions(s);
  const styleGuide = (s.review_style_guide || '').trim();

  const parts = [
    '=== REVIEWER INSTRUCTIONS ===',
    instructions,
    '=== END REVIEWER INSTRUCTIONS ===',
  ];

  if (styleGuide) {
    parts.push('', '=== WRITING STYLE GUIDE ===', styleGuide, '=== END WRITING STYLE GUIDE ===');
  }

  if (examples.length) {
    parts.push('', '=== EXAMPLE REVIEWS (imitate their structure and voice) ===');
    examples.forEach((ex, i) => {
      parts.push(`--- Example ${i + 1} (${ex.name}) ---`, ex.text);
    });
    parts.push('=== END EXAMPLE REVIEWS ===');
  }

  if (rubricText) {
    parts.push('', '=== RUBRIC ===', rubricText, '=== END RUBRIC ===');
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

  // Review uses its own provider selection + credentials (review_* settings),
  // independent of Text Processing.
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

  // When the caller wants live feedback, accumulate thinking/text and push
  // snapshots out through onChunk on each streamed delta.
  let thinking = '';
  let streamedText = '';
  const onEvent = onChunk
    ? (ev) => {
        if (ev.type === 'thinking') thinking += ev.delta;
        else if (ev.type === 'text') streamedText += ev.delta;
        onChunk({ thinking, text: streamedText });
      }
    : undefined;

  const reviewText = await chat({
    system: REVIEW_SYSTEM,
    user: parts.join('\n'),
    temperature: 0.4,
    provider,
    model: modelByProvider[provider] || undefined,
    creds,
    maxTokens: 4096,
    onEvent,
  });

  const store = getReviewGenerateStore();
  const existing = await store.get(pdfIdentifier);
  return store.save(pdfIdentifier, {
    review_text: reviewText,
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
    note_count: existing ? existing.note_count : 0,
    generated_at: existing ? existing.generated_at : undefined,
    review_file_path: effectivePath,
  });
  saved.file_missing = false;
  return saved;
}

module.exports = { generateReview, getSavedReview, saveReview };
