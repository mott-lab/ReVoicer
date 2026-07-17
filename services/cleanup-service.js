// Voice/typed annotation cleanup, multi-tag classification, and section detection.

const { chat, parseJsonResponse } = require('./llm-service');

const VALID_TAGS = new Set([
  'summary', 'critique', 'strength', 'question',
  'related_work', 'suggestion', 'follow_up',
  'edit', 'presentation', 'novelty', 'technical', 'general',
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
- follow_up: Noting something to investigate later or apply elsewhere
- edit: A minor wording, typo, grammar, or copy-edit fix
- presentation: Concerns the writing, structure, figures, or clarity of the paper
- novelty: Concerns how new or original the contribution is
- technical: Concerns correctness, soundness, or rigor of the method/results
- general: A high-level or overall comment that doesn't fit the more specific tags`;

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

// Format the user-curated reference library for the cleanup prompt. The LLM
// uses this to resolve loose mentions ("the Smith paper", "see Smith
// et al.") into the proper author/title/link the user wants in the cleaned
// note.
function referencesBlock(references) {
  if (!Array.isArray(references) || references.length === 0) return '';
  const lines = references
    .filter((r) => (r.authors || r.title || r.link))
    .map((r, i) => {
      const parts = [];
      if (r.authors) parts.push(r.authors);
      if (r.title) parts.push(`"${r.title}"`);
      if (r.link) parts.push(r.link);
      return `${i + 1}. ${parts.join(' — ')}`;
    });
  if (lines.length === 0) return '';
  return `

The user has provided this reference library. If their transcript mentions any of these works (e.g. by an author surname like "Smith et al." or a partial title), substitute the loose mention with a proper reference using the matching authors, title, and link below. Do not invent citations; only use entries from this list.
---
${lines.join('\n')}
---`;
}

function cleanupSystemPrompt(selectedText, pageContext, references) {
  return `You are a research annotation assistant. Your job is to clean up a voice-recorded annotation about a passage in an academic paper, classify its type(s), and identify which section of the paper the passage is in.

The user highlighted the following text from the paper:
---
${selectedText}
---${pageContextBlock(pageContext)}${referencesBlock(references)}

They then spoke their annotation aloud. The raw speech transcript may contain:
- Filler words (um, uh, like, you know)
- False starts and self-corrections
- Rambling or repetitive phrasing
- Incomplete sentences
- Doubling back: returning to an earlier point later in the recording to add detail, clarify, or correct it

Your task:
1. Rewrite their annotation as a clear, concise, well-structured comment that PRESERVES ALL of their distinct intellectual content, insights, questions, and critiques. Do not add your own analysis. Do not drop any substantive point they made. Just clean up the delivery.

   The speaker often DOUBLES BACK: they raise a point early, move on to something else, then return to that first point later to add detail, clarify, or correct it. When this happens, MERGE every statement about the same point into ONE coherent point, placed where they first raised it — do not emit the revisited point as a second, separate item. Treat later remarks as enriching that single point, and treat a later correction as the speaker's final intent (drop the version it supersedes). Consolidating repeated mentions of the SAME idea is NOT removing content: aim for one well-developed point per distinct idea, not one item per time they happened to mention it. When two mentions are genuinely about different ideas, keep them separate.

   When the transcript mentions a work that matches an entry in the reference library above, replace the loose mention with the proper author + title (and link in parentheses if available).

2. Classify the comment with one or more tags from this list. Use multiple tags ONLY when the comment genuinely spans categories (e.g. a strength that also leads to a suggestion). Most comments need just one tag.
${TAG_DESCRIPTIONS}

3. Identify which section of the paper the highlighted passage is in. Use one of:
${SECTION_DESCRIPTIONS}
Use "other" if it doesn't fit. Infer from page context and content.

Output ONLY valid JSON with exactly three fields:
{"comment": "the cleaned annotation", "tags": ["tag1", "tag2"], "section": "section_name"}

No other text. Just the JSON.`;
}

function classifySystemPrompt(selectedText, comment, pageContext, references) {
  return `You are a research annotation assistant. Your job is to classify a typed annotation about a passage in an academic paper, and identify which section of the paper the passage is in.

The user highlighted the following text from the paper:
---
${selectedText}
---${pageContextBlock(pageContext)}${referencesBlock(references)}

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

async function cleanupTranscript(selectedText, rawTranscript, pageContext, references) {
  const content = await chat({
    system: cleanupSystemPrompt(selectedText || '', pageContext || '', references || []),
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

async function classifyCommentType(selectedText, comment, pageContext, references) {
  const content = await chat({
    system: classifySystemPrompt(selectedText || '', comment || '', pageContext || '', references || []),
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
