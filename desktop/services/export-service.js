// Markdown export. Port of backend/app/services/export_service.py.
// Output formatting is intentionally byte-identical to the Python version.

const { getNoteStore } = require('./note-store');

function titleCase(s) {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

async function exportToMarkdown(pdfIdentifier) {
  const store = getNoteStore();
  const notes = await store.listNotes(pdfIdentifier);

  if (notes.length === 0) {
    return '# Annotations\n\nNo annotations found for this document.\n';
  }

  const pdfTitle = notes[0].pdf_title || 'Untitled Document';
  const lines = [
    `# Annotations: ${pdfTitle}`,
    '',
    `*Source: ${pdfIdentifier}*`,
    '',
    '*Exported from PDF Converser*',
    '',
    '---',
    '',
  ];

  let currentPage = null;
  for (const note of notes) {
    const page = note.page_number || 0;
    if (page !== currentPage) {
      currentPage = page;
      const label = currentPage > 0 ? `Page ${currentPage}` : 'Page (unknown)';
      lines.push(`## ${label}`);
      lines.push('');
    }

    const typeLabel = titleCase(note.comment_type || 'summary');
    lines.push(`**[${typeLabel}]**`);
    lines.push('');
    lines.push(`> ${note.selected_text}`);
    lines.push('');
    lines.push(note.cleaned_comment);
    lines.push('');
    lines.push('<details><summary>Raw voice note</summary>');
    lines.push('');
    lines.push(note.raw_transcript);
    lines.push('');
    lines.push('</details>');
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = { exportToMarkdown };
