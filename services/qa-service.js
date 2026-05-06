// Document Q&A — answers a question against the full extracted PDF text.

const { chat } = require('./llm-service');
const { getDocumentStore } = require('./document-store');
const { getQAStore } = require('./qa-store');

function qaSystemPrompt(documentText) {
  return `You are an expert at reading and analyzing academic papers. Answer the user's question based solely on the document text provided below. Be specific and cite relevant page numbers when possible. If the information is not in the document, say so clearly. Keep answers concise but thorough.

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
    temperature: 0.3,
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
