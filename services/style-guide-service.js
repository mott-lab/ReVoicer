// Generate a review writing style guide from the user's example reviews.
// Reads .txt/.md files from the review examples folder, has the review LLM
// distill them into actionable guidance, and persists the result straight
// into the review_style_guide setting (plus a last-generated timestamp).
//
// Uses the same provider selection + credentials as review generation
// (review_* settings). The examples folder feeds only this generator — the
// drafted reviews see the resulting style guide, not the examples themselves.

const { chat } = require('./llm-service');
const { getSettingsStore } = require('./settings-store');
const { readExamples, reviewLlmOptions } = require('./review-generate-service');

const STYLE_GUIDE_SYSTEM = `You are an expert writing analyst. You will be given one or more example peer reviews of academic manuscripts, all written by the same reviewer.

Produce a concise, actionable writing style guide that captures how this reviewer writes. Cover: voice and tone, typical structure and section ordering, typical length and level of detail, formatting conventions (headers, lists, paragraphs), sentence style and word choice, and any recurring phrases or habits.

Guidelines:
- Write the guide as direct, imperative guidance (e.g. "Use short declarative sentences."), not as commentary about the examples.
- Do not include content specific to any one paper (topics, findings, author names).
- The guide will be pasted into a "writing style guide" field that instructs an LLM drafting future reviews, so make every line usable as an instruction.
- Output only the style guide, in Markdown. No preamble, no meta-commentary.`;

// Settings keys the caller (the Settings form) may override so that unsaved
// form edits — a freshly picked folder, a new API key — take effect without
// requiring Save first. Persistence still only writes the style guide fields.
const OVERRIDE_KEYS = [
  'review_provider',
  'review_examples_dir',
  'review_openai_api_key',
  'review_openai_model',
  'review_openai_base_url',
  'review_anthropic_api_key',
  'review_anthropic_model',
  'review_ollama_base_url',
  'review_ollama_model',
  'review_openai_compat_base_url',
  'review_openai_compat_api_key',
  'review_openai_compat_model',
];

async function generateStyleGuide(overrides = {}) {
  const store = getSettingsStore();
  const s = store.get();
  for (const key of OVERRIDE_KEYS) {
    if (overrides[key] !== undefined) s[key] = overrides[key];
  }

  const dir = (s.review_examples_dir || '').trim();
  if (!dir) {
    const err = new Error('No example reviews folder is set.');
    err.code = 'NO_EXAMPLES_DIR';
    err.status = 400;
    throw err;
  }

  const examples = await readExamples(dir);
  if (!examples.length) {
    const err = new Error('No readable .txt or .md files found in the examples folder.');
    err.code = 'NO_EXAMPLES';
    err.status = 400;
    throw err;
  }

  const parts = [];
  examples.forEach((ex, i) => {
    parts.push(`--- Example ${i + 1} (${ex.name}) ---`, ex.text, '');
  });

  const styleGuide = await chat({
    system: STYLE_GUIDE_SYSTEM,
    user: parts.join('\n'),
    temperature: 0.3,
    maxTokens: 2048,
    ...reviewLlmOptions(s),
  });

  const generated_at = new Date().toISOString();
  await store.save({
    review_style_guide: styleGuide,
    review_style_guide_generated_at: generated_at,
  });

  return { style_guide: styleGuide, generated_at, example_count: examples.length };
}

module.exports = { generateStyleGuide };
