// Extract structured rubric items (section + description) from a free-form
// pasted rubric. The LLM is asked to identify the main components a reviewer
// is expected to address and return them as a JSON array.
//
// Mirrors the chat() / parseJsonResponse() flow used by cleanup-service and
// review-check-service.

const { chat, parseJsonResponse } = require('./llm-service');

const EXTRACT_SYSTEM = `You are helping a peer reviewer turn an unstructured reviewing rubric into a clean checklist of sections that a good review should cover.

You will receive raw rubric text pasted from a conference, journal, or guideline document. It may include numbered lists, prose, headers, bullets, or a mix.

Your task:
1. Identify 3–10 distinct sections the reviewer is expected to address.
2. For each section, write:
   - "section": a short, plain-language label (1–4 words, Title Case). Examples: "Novelty", "Soundness of Methods", "Clarity of Writing".
   - "description": a concise one-to-two-sentence explanation of what the reviewer should comment on for that section. Use plain language. Do not just copy the rubric verbatim if it is wordy; paraphrase tightly.
3. Skip meta-content (submission instructions, scoring scales, formatting rules) that the reviewer themselves does not need to write about.
4. Do not invent sections that are not implied by the input. If the input is too short or vague to extract anything meaningful, return an empty array.

Return ONLY valid JSON with this exact shape:
{"items":[{"section":"...","description":"..."},{"section":"...","description":"..."}]}

No prose, no markdown fences, no commentary. Just the JSON object.`;

async function extractRubricItems({ rubricText }) {
  const text = (rubricText || '').trim();
  if (!text) return { items: [] };

  const content = await chat({
    system: EXTRACT_SYSTEM,
    user: text,
  });

  const parsed = parseJsonResponse(content);
  if (!parsed || !Array.isArray(parsed.items)) {
    return { items: [], parse_error: true };
  }

  // Normalize: trim, drop empties, cap length so we don't pollute the store
  // if the model goes wild.
  const items = parsed.items
    .map((it) => ({
      section: typeof it?.section === 'string' ? it.section.trim() : '',
      description: typeof it?.description === 'string' ? it.description.trim() : '',
    }))
    .filter((it) => it.section.length > 0)
    .slice(0, 12);

  return { items };
}

module.exports = { extractRubricItems };
