// Voice/typed annotation cleanup and type classification.

const { chat, parseJsonResponse } = require('./llm-service');

const VALID_TYPES = new Set([
  'summary', 'critique', 'strength', 'question',
  'related_work', 'suggestion', 'follow_up',
]);

function cleanupSystemPrompt(selectedText) {
  return `You are a research annotation assistant. Your job is to clean up a voice-recorded annotation about a passage in an academic paper, and classify its type.

The user highlighted the following text from the paper:
---
${selectedText}
---

They then spoke their annotation aloud. The raw speech transcript may contain:
- Filler words (um, uh, like, you know)
- False starts and self-corrections
- Rambling or repetitive phrasing
- Incomplete sentences

Your task:
1. Rewrite their annotation as a clear, concise, well-structured comment that PRESERVES ALL of their intellectual content, insights, questions, and critiques. Do not add your own analysis. Do not remove any substantive points they made. Just clean up the delivery.

2. Classify the comment as exactly ONE of these types:
- summary: Restating or paraphrasing what the text says
- critique: Identifying a weakness, flaw, or disagreement
- strength: Noting something positive or well-done
- question: Expressing confusion or asking something
- related_work: Connecting to other papers, authors, or ideas
- suggestion: Proposing an improvement or alternative approach
- follow_up: Noting something to investigate later or apply elsewhere

Output ONLY valid JSON with exactly two fields:
{"comment": "the cleaned annotation", "type": "one_of_the_types_above"}

No other text. Just the JSON.`;
}

function classifySystemPrompt(selectedText, comment) {
  return `You are a research annotation assistant. Your job is to classify a typed annotation about a passage in an academic paper.

The user highlighted the following text from the paper:
---
${selectedText}
---

They then wrote the following annotation:
---
${comment}
---

Classify the comment as exactly ONE of these types:
- summary: Restating or paraphrasing what the text says
- critique: Identifying a weakness, flaw, or disagreement
- strength: Noting something positive or well-done
- question: Expressing confusion or asking something
- related_work: Connecting to other papers, authors, or ideas
- suggestion: Proposing an improvement or alternative approach
- follow_up: Noting something to investigate later or apply elsewhere

Output ONLY valid JSON with exactly one field:
{"type": "one_of_the_types_above"}

No other text. Just the JSON.`;
}

async function cleanupTranscript(selectedText, rawTranscript) {
  const content = await chat({
    system: cleanupSystemPrompt(selectedText || ''),
    user: rawTranscript || '',
  });
  const parsed = parseJsonResponse(content);
  if (!parsed) return { comment: content, type: 'summary' };
  const type = VALID_TYPES.has(parsed.type) ? parsed.type : 'summary';
  return { comment: parsed.comment || content, type };
}

async function classifyCommentType(selectedText, comment) {
  const content = await chat({
    system: classifySystemPrompt(selectedText || '', comment || ''),
    user: 'Classify the annotation above.',
  });
  const parsed = parseJsonResponse(content);
  if (!parsed) return 'summary';
  return VALID_TYPES.has(parsed.type) ? parsed.type : 'summary';
}

module.exports = { cleanupTranscript, classifyCommentType, VALID_TYPES };
