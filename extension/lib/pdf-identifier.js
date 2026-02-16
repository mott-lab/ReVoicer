// PDF Converser - PDF Identifier Utility

/**
 * Extract a stable identifier from the current PDF.
 * Prefers the content hash (SHA-256 of first 64KB) computed by viewer.js,
 * which survives renames and moves. Falls back to URL-based identifier.
 */
function getPdfIdentifier() {
  // Prefer content hash computed by viewer.js from PDF bytes
  if (window.__pdfContentHash) {
    return window.__pdfContentHash;
  }

  // Fallback: URL-based identifier
  const url = new URL(window.location.href);

  // If we're in our own viewer, the real PDF URL is in the ?file= param
  if (url.pathname.includes('viewer/viewer.html')) {
    const fileParam = url.searchParams.get('file');
    if (fileParam) return fileParam;
  }

  // Remove common transient params
  const transientParams = ['t', '_', 'ts', 'timestamp', 'cache', 'v'];
  transientParams.forEach(p => url.searchParams.delete(p));
  return url.origin + url.pathname + (url.search || '');
}

/**
 * Attempt to detect the current page number from the DOM.
 * Works with Google Scholar PDF Reader and PDF.js-based viewers.
 */
function getCurrentPageNumber() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return 0;

  const range = selection.getRangeAt(0);
  const node = range.startContainer;
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;

  // Strategy 1: Our viewer's page containers (.pdf-page[data-page-number])
  const pdfConverserPage = element.closest('.pdf-page[data-page-number]');
  if (pdfConverserPage) {
    return parseInt(pdfConverserPage.dataset.pageNumber, 10) || 0;
  }

  // Strategy 2: Generic data-page-number attribute (Google Scholar, PDF.js, etc.)
  const pageEl = element.closest('[data-page-number]');
  if (pageEl) {
    return parseInt(pageEl.dataset.pageNumber, 10) || 0;
  }

  // Strategy 3: Look for page number in URL hash
  const hash = window.location.hash;
  const pageMatch = hash.match(/page=(\d+)/);
  if (pageMatch) return parseInt(pageMatch[1], 10);

  // Strategy 4: Look for a page input/indicator element
  const pageInput = document.querySelector('#pageNumber, [data-page], .page-number input');
  if (pageInput && pageInput.value) {
    return parseInt(pageInput.value, 10) || 0;
  }

  return 0;
}

/**
 * Get the PDF title from the page.
 */
function getPdfTitle() {
  return document.title || null;
}
