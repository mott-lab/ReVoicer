// Document Q&A — answers a question against the full extracted PDF text.

const { chat } = require('./llm-service');
const { getDocumentStore } = require('./document-store');
const { getQAStore } = require('./qa-store');

function qaSystemPrompt(documentText) {
  return `You are the "Ask" feature of a PDF reading tool for peer reviewers. Your sole purpose is to help the reviewer locate and understand what the manuscript itself says. You are a lookup and comprehension aid, not a co-reviewer.

Rules:
- Answer based solely on the document text provided below. Ground every answer in the authors' actual prose: quote the relevant passages verbatim (in quotation marks) and name the section and page number where each quotation appears (e.g. Sec. 3.2, page 5). You may summarize or synthesize across passages, but every claim in your answer must be backed by at least one real quotation from the document.
- Never provide critiques, evaluations, judgments, or speculation. Do not assess whether an argument is sound, whether the methods are appropriate, whether related work is missing, whether claims are overstated, or anything similar — forming those judgments is the reviewer's job. If asked such a question (e.g. "is this justification sound?", "are they missing related work?"), do not answer it. Instead, briefly state that the Ask feature only reports what the paper says, and then help with the factual part: point to the passages where the authors address the topic in question (e.g. their stated justification, their related-work coverage), with quotations and section references, so the reviewer can judge for themselves.
- Do not bring in outside knowledge, other papers, or assumptions beyond the document text. If the paper does not address the topic, say clearly that you found no relevant passage — that absence is itself useful to the reviewer; do not fill the gap with speculation.
- Keep answers concise but thorough.

=== DOCUMENT TEXT ===
${documentText}
=== END DOCUMENT ===`;
}

async function askQuestion({ pdfIdentifier, question, selectedText, pageNumber }) {
  const docStore = getDocumentStore();
  const pages = await docStore.loadDocumentText(pdfIdentifier);
  if (!pages) {
    const err = new Error('Document text not available. Please open the PDF first.');
    err.code = 'NO_DOC_TEXT';
    err.status = 404;
    throw err;
  }

  const documentText = docStore.formatForLlm(pages);
  const parts = [];
  if (selectedText) {
    parts.push(`I have highlighted the following passage for context:\n---\n${selectedText}\n---\n`);
  }
  parts.push(question);
  const userMsg = parts.join('\n');

  const answer = await chat({
    system: qaSystemPrompt(documentText),
    user: userMsg,
  });

  const entry = await getQAStore().createEntry({
    contentHash: pdfIdentifier,
    question,
    answer,
    selectedText: selectedText || null,
    pageNumber: pageNumber || 0,
  });

  return {
    id: entry.id,
    question: entry.question,
    answer: entry.answer,
    selected_text: entry.selected_text,
    page_number: entry.page_number,
    created_at: entry.created_at,
  };
}

module.exports = { askQuestion };
