// Voice/typed annotation cleanup, multi-tag classification, and section detection.

const { chat, parseJsonResponse } = require('./llm-service');

const VALID_TAGS = new Set([
  'summary', 'critique', 'strength', 'question',
  'related_work', 'suggestion', 'follow_up',
]);

// Section enum. `related_work_section` is the paper's "Related Work" heading;
// distinct from the `related_work` *tag*, which marks a comment that connects
// to other work regardless of where it appears.
const VALID_SECTIONS = new Set([
  'abstract', 'introduction', 'background', 'related_work_section',
  'methods', 'results', 'discussion', 'conclusion', 'references', 'other',
]);

// Back-compat export — older callers imported VALID_TYPES.
const VALID_TYPES = VALID_TAGS;

const TAG_DESCRIPTIONS = `- summary: Restating or paraphrasing what the text says
- critique: Identifying a weakness, flaw, or disagreement
- strength: Noting something positive or well-done
- question: Expressing confusion or asking something
- related_work: Connecting to other papers, authors, or ideas
- suggestion: Proposing an improvement or alternative approach
- follow_up: Noting something to investigate later or apply elsewhere`;

const SECTION_DESCRIPTIONS = `- abstract, introduction, background, related_work_section,
  methods, results, discussion, conclusion, references, other`;

function pageContextBlock(pageContext) {
  if (!pageContext) return '';
  return `

For section context, here is the surrounding page text from the PDF:
---
${pageContext}
---`;
}

function cleanupSystemPrompt(selectedText, pageContext) {
  return `You are a research annotation assistant. Your job is to clean up a voice-recorded annotation about a passage in an academic paper, classify its type(s), and identify which section of the paper the passage is in.

The user highlighted the following text from the paper:
---
${selectedText}
---${pageContextBlock(pageContext)}

They then spoke their annotation aloud. The raw speech transcript may contain:
- Filler words (um, uh, like, you know)
- False starts and self-corrections
- Rambling or repetitive phrasing
- Incomplete sentences

Your task:
1. Rewrite their annotation as a clear, concise, well-structured comment that PRESERVES ALL of their intellectual content, insights, questions, and critiques. Do not add your own analysis. Do not remove any substantive points they made. Just clean up the delivery.

2. Classify the comment with one or more tags from this list. Use multiple tags ONLY when the comment genuinely spans categories (e.g. a strength that also leads to a suggestion). Most comments need just one tag.
${TAG_DESCRIPTIONS}

3. Identify which section of the paper the highlighted passage is in. Use one of:
${SECTION_DESCRIPTIONS}
Use "other" if it doesn't fit. Infer from page context and content.

Output ONLY valid JSON with exactly three fields:
{"comment": "the cleaned annotation", "tags": ["tag1", "tag2"], "section": "section_name"}

No other text. Just the JSON.`;
}

function classifySystemPrompt(selectedText, comment, pageContext) {
  return `You are a research annotation assistant. Your job is to classify a typed annotation about a passage in an academic paper, and identify which section of the paper the passage is in.

The user highlighted the following text from the paper:
---
${selectedText}
---${pageContextBlock(pageContext)}

They then wrote the following annotation:
---
${comment}
---

Classify the comment with one or more tags. Use multiple tags ONLY when the comment genuinely spans categories. Most comments need just one tag.
${TAG_DESCRIPTIONS}

Also identify the paper section the highlighted passage is in:
${SECTION_DESCRIPTIONS}
Use "other" if unclear.

Output ONLY valid JSON with exactly two fields:
{"tags": ["tag1", "tag2"], "section": "section_name"}

No other text. Just the JSON.`;
}

function normalizeTags(rawTags) {
  if (!Array.isArray(rawTags)) return ['summary'];
  const filtered = rawTags
    .filter((t) => typeof t === 'string')
    .map((t) => t.trim())
    .filter((t) => VALID_TAGS.has(t));
  // De-dupe, cap at 3.
  const seen = new Set();
  const out = [];
  for (const t of filtered) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 3) break;
  }
  return out.length > 0 ? out : ['summary'];
}

function normalizeSection(rawSection) {
  if (typeof rawSection !== 'string') return null;
  const s = rawSection.trim();
  if (!s || s === 'other') return null;
  return VALID_SECTIONS.has(s) ? s : null;
}

async function cleanupTranscript(selectedText, rawTranscript, pageContext) {
  const content = await chat({
    system: cleanupSystemPrompt(selectedText || '', pageContext || ''),
    user: rawTranscript || '',
  });
  const parsed = parseJsonResponse(content);
  if (!parsed) return { comment: content, tags: ['summary'], section: null };
  return {
    comment: parsed.comment || content,
    tags: normalizeTags(parsed.tags),
    section: normalizeSection(parsed.section),
  };
}

async function classifyCommentType(selectedText, comment, pageContext) {
  const content = await chat({
    system: classifySystemPrompt(selectedText || '', comment || '', pageContext || ''),
    user: 'Classify the annotation above.',
  });
  const parsed = parseJsonResponse(content);
  if (!parsed) return { tags: ['summary'], section: null };
  return {
    tags: normalizeTags(parsed.tags),
    section: normalizeSection(parsed.section),
  };
}

module.exports = {
  cleanupTranscript,
  classifyCommentType,
  VALID_TAGS,
  VALID_TYPES,
  VALID_SECTIONS,
};
