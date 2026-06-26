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
 *
 * Pass a Range to derive the page from a cached selection — needed when the
 * live selection has moved (e.g. user has focused a textarea overlay).
 */
function getCurrentPageNumber(rangeOverride = null) {
  let range = rangeOverride;
  if (!range) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return 0;
    range = selection.getRangeAt(0);
  }

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

/**
 * Derive a clean base filename (no extension) for the currently open PDF — used
 * to name exports. The desktop shell loads the app as `…/app.html?file=<url>`
 * where the url is `pdfc://local/pdf/<base64url(absolutePath)>` (see main.js
 * loadPdf), so decode that segment back to the path and take its basename.
 * Returns '' when no PDF can be identified from the URL.
 */
function getPdfBaseName() {
  let fileParam = null;
  try {
    fileParam = new URL(window.location.href).searchParams.get('file');
  } catch {
    return '';
  }
  if (!fileParam) return '';

  // Last path segment of the file URL.
  const seg = fileParam.split('#')[0].split('?')[0].split('/').pop() || '';
  if (!seg) return '';

  // Prefer the base64url-decoded absolute path; otherwise treat the segment as
  // a plain (possibly %-encoded) filename.
  let name = '';
  const decodedPath = decodePdfPathSegment(seg);
  if (decodedPath) {
    name = decodedPath.split(/[\\/]/).pop() || '';
  }
  if (!name) {
    try { name = decodeURIComponent(seg); } catch { name = seg; }
  }

  return name.replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]+/g, '_').trim();
}

// Returns the decoded absolute path when `seg` is a base64url-encoded
// filesystem path (decodes to text containing a separator or ending in .pdf),
// else null.
function decodePdfPathSegment(seg) {
  if (!/^[A-Za-z0-9_-]+$/.test(seg)) return null;
  try {
    let b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const text = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    return /[\\/]|\.pdf$/i.test(text) ? text : null;
  } catch {
    return null;
  }
}
