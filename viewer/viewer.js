// PDF Converser - PDF.js Viewer
// Renders PDFs with a selectable text layer so our content script can access selections

import * as pdfjsLib from './pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('viewer/pdfjs/pdf.worker.min.mjs');

let pdfDoc = null;
let currentScale = 1.5;
const pageTexts = {};
const MIN_SCALE = 0.5;
const MAX_SCALE = 4.0;
const SCALE_STEP = 0.25;

// Stable render state. Page divs are built once on PDF load and reused on
// every zoom — we resize them in place rather than tearing down and rebuilding
// the page list. The generation counter + activeRenderTask let a new zoom
// cancel the in-flight render so concurrent passes can't race to appendChild.
let pdfPages = [];
let pageDivs = [];
let renderGeneration = 0;
let activeRenderTask = null;
let textExtractedFired = false;

// Get the PDF URL from query params
const params = new URLSearchParams(window.location.search);
const pdfUrl = params.get('file');

// Compute SHA-256 content hash from the first 64KB of the PDF for stable identification.
// This hash survives renames and moves — same content always produces the same identifier.
async function computeContentHash(url) {
  try {
    const resp = await fetch(url, { headers: { 'Range': 'bytes=0-65535' } });
    const buffer = await resp.arrayBuffer();
    // If server ignores Range header, slice to first 64KB for consistent hashing
    const hashBytes = buffer.byteLength > 65536 ? buffer.slice(0, 65536) : buffer;
    const digest = await crypto.subtle.digest('SHA-256', hashBytes);
    const hashArray = Array.from(new Uint8Array(digest));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (err) {
    console.error('PDF Converser: Failed to compute content hash:', err);
    return null;
  }
}

if (!pdfUrl) {
  document.getElementById('pages').innerHTML = '<div id="loading-msg">No PDF file specified.</div>';
} else {
  // Compute content hash before loading, so it's available when the user interacts
  computeContentHash(pdfUrl).then(hash => {
    window.__pdfContentHash = hash;
    if (hash) {
      console.log('PDF Converser: content hash computed:', hash.substring(0, 12) + '...');
    }
  });
  // Old #pdf-title element in the side panel was removed. The window's
  // document.title (set in loadPdf below) still carries the filename.
  const titleEl = document.getElementById('pdf-title');
  if (titleEl) titleEl.textContent = decodeURIComponent(pdfUrl.split('/').pop().split('?')[0]);
  loadPdf(pdfUrl);
}

async function loadPdf(url) {
  const pagesContainer = document.getElementById('pages');
  pagesContainer.innerHTML = '<div id="loading-msg">Loading PDF...</div>';

  try {
    pdfDoc = await pdfjsLib.getDocument({ url }).promise;

    document.getElementById('page-count').textContent = pdfDoc.numPages;
    document.getElementById('page-input').max = pdfDoc.numPages;
    document.title = `PDF Converser - ${decodeURIComponent(url.split('/').pop().split('?')[0])}`;

    // Reset render state for the new document.
    if (activeRenderTask) {
      try { activeRenderTask.cancel(); } catch { /* ignore */ }
      activeRenderTask = null;
    }
    renderGeneration++;
    textExtractedFired = false;
    for (const k of Object.keys(pageTexts)) delete pageTexts[k];

    // Pre-fetch every PDFPageProxy. pdf.js caches page objects internally, so
    // resolving them all now lets later getViewport() calls stay synchronous.
    pdfPages = await Promise.all(
      Array.from({ length: pdfDoc.numPages }, (_, i) => pdfDoc.getPage(i + 1)),
    );

    // Build the page DOM exactly once. From here on, zoom changes mutate the
    // existing canvas/text-layer rather than re-appending pages.
    pagesContainer.innerHTML = '';
    pageDivs = pdfPages.map((_, i) => {
      const pageDiv = document.createElement('div');
      pageDiv.className = 'pdf-page';
      pageDiv.dataset.pageNumber = i + 1;
      const canvas = document.createElement('canvas');
      pageDiv.appendChild(canvas);
      const textLayerDiv = document.createElement('div');
      textLayerDiv.className = 'text-layer';
      pageDiv.appendChild(textLayerDiv);
      // Annotation layer holds clickable link rectangles. Sits on top of the
      // text layer so links win over text selection in their bounding box.
      const annotationLayerDiv = document.createElement('div');
      annotationLayerDiv.className = 'annotation-layer';
      pageDiv.appendChild(annotationLayerDiv);
      return pageDiv;
    });
    for (const div of pageDivs) pagesContainer.appendChild(div);

    // Initial render at the current scale, then fit-to-width (which triggers
    // its own rerender — the generation guard handles the overlap cleanly).
    await rerender();
    fitToWidth();
  } catch (err) {
    console.error('PDF load error:', err);
    pagesContainer.innerHTML = `<div id="loading-msg">Failed to load PDF: ${err.message}</div>`;
  }
}

function renderTextLayer(textContent, container, viewport) {
  const items = textContent.items;
  let spanIndex = 0;

  for (const item of items) {
    if (!item.str) continue;

    const span = document.createElement('span');
    span.textContent = item.str;
    span.dataset.index = String(spanIndex++);

    // Position the text span to overlay the canvas text
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);

    const fontHeight = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]);
    const left = tx[4];
    const top = tx[5] - fontHeight;

    span.style.left = `${left}px`;
    span.style.top = `${top}px`;
    span.style.fontSize = `${fontHeight}px`;
    span.style.fontFamily = item.fontName || 'sans-serif';

    // Scale width to match rendered text
    if (item.width > 0) {
      const targetWidth = item.width * viewport.scale;
      span.style.letterSpacing = '0px';
      container.appendChild(span);
      const actualWidth = span.getBoundingClientRect().width;
      if (actualWidth > 0 && targetWidth > 0) {
        span.style.transform = `scaleX(${targetWidth / actualWidth})`;
      }
    } else {
      container.appendChild(span);
    }
  }
}

// Render link annotations as absolute-positioned <a> elements. We only handle
// `Link` annotations (URLs and internal page jumps) — that covers references,
// table-of-contents entries, and DOIs in academic PDFs. Form fields and
// other annotation subtypes are ignored.
function renderAnnotationLayer(annotations, container, viewport) {
  for (const ann of annotations) {
    if (ann.subtype !== 'Link') continue;
    if (!ann.url && !ann.dest) continue;

    // viewport.convertToViewportRectangle returns viewport-space coords with
    // y axis flipped vs. PDF space; normalizeRect orders them low→high so
    // (x1,y1) is the top-left in CSS space.
    const [x1, y1, x2, y2] = pdfjsLib.Util.normalizeRect(
      viewport.convertToViewportRectangle(ann.rect),
    );

    const a = document.createElement('a');
    a.className = 'annotation-link';
    a.style.left = `${x1}px`;
    a.style.top = `${y1}px`;
    a.style.width = `${Math.max(1, x2 - x1)}px`;
    a.style.height = `${Math.max(1, y2 - y1)}px`;

    if (ann.url) {
      // Set href so the link is keyboard-focusable and shows the URL on
      // hover via the title attribute. The click handler routes through
      // shell.openExternal so the OS browser opens it, not a child window.
      a.href = ann.url;
      a.title = ann.url;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.desktop?.openExternal?.(ann.url);
      });
    } else {
      a.href = '#';
      a.title = 'Jump to destination';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        jumpToDestination(ann.dest).catch((err) => {
          console.warn('PDF Converser: could not resolve link destination', err);
        });
      });
    }
    container.appendChild(a);
  }
}

// Resolve a Link annotation's `dest` (named string or explicit array) to a
// page number and scroll there. Drops y-offset precision — landing on the
// page is enough for academic-paper navigation.
async function jumpToDestination(dest) {
  let resolved = dest;
  if (typeof dest === 'string') {
    resolved = await pdfDoc.getDestination(dest);
  }
  if (!Array.isArray(resolved) || resolved.length === 0) return;
  const pageRef = resolved[0];
  const pageIndex = await pdfDoc.getPageIndex(pageRef);
  scrollToPage(pageIndex + 1);
  document.getElementById('page-input').value = pageIndex + 1;
}

async function rerender() {
  if (!pdfDoc || pdfPages.length === 0) return;
  const myGen = ++renderGeneration;

  // Cancel the previous pass's in-flight pdf.js render so concurrent zooms
  // don't both try to draw into the same canvases.
  if (activeRenderTask) {
    try { activeRenderTask.cancel(); } catch { /* ignore */ }
    activeRenderTask = null;
  }

  // Synchronously resize every page to the new scale. This makes the
  // scrollbar settle to its final size immediately — no shrink-then-grow
  // flicker — even before the first canvas has been redrawn.
  //
  // HiDPI: the canvas backing store is scaled by devicePixelRatio so text
  // stays crisp on Retina/4K displays. CSS size stays at the logical
  // viewport size; only the pixel buffer grows.
  const dpr = window.devicePixelRatio || 1;
  for (let i = 0; i < pdfPages.length; i++) {
    const vp = pdfPages[i].getViewport({ scale: currentScale });
    const div = pageDivs[i];
    div.style.width = `${vp.width}px`;
    div.style.height = `${vp.height}px`;
    const canvas = div.querySelector('canvas');
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = `${Math.floor(vp.width)}px`;
    canvas.style.height = `${Math.floor(vp.height)}px`;
    div.querySelector('.text-layer').innerHTML = '';
    div.querySelector('.annotation-layer').innerHTML = '';
  }

  // Page-by-page render. We bail after every await if a newer zoom kicked
  // off, so a stale generation can't keep mutating canvases or firing events.
  for (let i = 0; i < pdfPages.length; i++) {
    if (myGen !== renderGeneration) return;
    const page = pdfPages[i];
    const div = pageDivs[i];
    const viewport = page.getViewport({ scale: currentScale });
    const canvas = div.querySelector('canvas');
    const ctx = canvas.getContext('2d');

    // Match the DPR-multiplied canvas: pdf.js draws into a buffer that's
    // `dpr` times larger than the viewport, then the browser downsamples to
    // CSS pixels. Without this transform pdf.js would draw at viewport size
    // into the larger buffer and the result would be upscaled (blurry).
    const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null;
    const task = page.render({ canvasContext: ctx, viewport, transform });
    activeRenderTask = task;
    try {
      await task.promise;
    } catch (err) {
      // pdf.js throws RenderingCancelledException when cancel() is called;
      // that's expected when a newer zoom raced this one.
      if (myGen !== renderGeneration) return;
      throw err;
    } finally {
      if (activeRenderTask === task) activeRenderTask = null;
    }
    if (myGen !== renderGeneration) return;

    const textContent = await page.getTextContent();
    if (myGen !== renderGeneration) return;
    const textLayerDiv = div.querySelector('.text-layer');
    textLayerDiv.innerHTML = '';
    renderTextLayer(textContent, textLayerDiv, viewport);
    pageTexts[i + 1] = textContent.items.map(item => item.str).join(' ');

    const annotations = await page.getAnnotations();
    if (myGen !== renderGeneration) return;
    renderAnnotationLayer(annotations, div.querySelector('.annotation-layer'), viewport);

    document.dispatchEvent(new CustomEvent('pdfpagerendered', { detail: { pageNum: i + 1 } }));
  }

  // Fire pdftextextracted exactly once per PDF load — text content doesn't
  // change with zoom, so subsequent passes shouldn't re-trigger consumers
  // (content.js uploads the document text on this event).
  if (myGen === renderGeneration && !textExtractedFired) {
    textExtractedFired = true;
    window.__pdfPageTexts = pageTexts;
    document.dispatchEvent(new CustomEvent('pdftextextracted', { detail: { pageTexts } }));
  }
}

function fitToWidth() {
  if (!pdfDoc) return;
  const containerWidth = document.getElementById('viewer-container').clientWidth - 40;
  // Get the first page to determine the base width
  pdfDoc.getPage(1).then(page => {
    const baseViewport = page.getViewport({ scale: 1.0 });
    currentScale = containerWidth / baseViewport.width;
    document.getElementById('zoom-level').textContent = `${Math.round(currentScale * 100)}%`;
    rerender();
  });
}

// Toolbar controls
document.getElementById('zoom-in').addEventListener('click', () => {
  if (currentScale < MAX_SCALE) {
    currentScale = Math.min(currentScale + SCALE_STEP, MAX_SCALE);
    document.getElementById('zoom-level').textContent = `${Math.round(currentScale * 100)}%`;
    rerender();
  }
});

document.getElementById('zoom-out').addEventListener('click', () => {
  if (currentScale > MIN_SCALE) {
    currentScale = Math.max(currentScale - SCALE_STEP, MIN_SCALE);
    document.getElementById('zoom-level').textContent = `${Math.round(currentScale * 100)}%`;
    rerender();
  }
});

document.getElementById('zoom-fit').addEventListener('click', fitToWidth);

document.getElementById('prev-page').addEventListener('click', () => {
  const input = document.getElementById('page-input');
  const page = Math.max(1, parseInt(input.value) - 1);
  input.value = page;
  scrollToPage(page);
});

document.getElementById('next-page').addEventListener('click', () => {
  const input = document.getElementById('page-input');
  const page = Math.min(pdfDoc.numPages, parseInt(input.value) + 1);
  input.value = page;
  scrollToPage(page);
});

document.getElementById('page-input').addEventListener('change', (e) => {
  const page = Math.max(1, Math.min(pdfDoc.numPages, parseInt(e.target.value) || 1));
  e.target.value = page;
  scrollToPage(page);
});

function scrollToPage(pageNum) {
  const pageEl = document.querySelector(`.pdf-page[data-page-number="${pageNum}"]`);
  if (pageEl) {
    pageEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

// Update page indicator on scroll
document.getElementById('viewer-container').addEventListener('scroll', () => {
  const pages = document.querySelectorAll('.pdf-page');
  const container = document.getElementById('viewer-container');
  const scrollTop = container.scrollTop + 60; // offset for toolbar

  for (const page of pages) {
    const rect = page.getBoundingClientRect();
    if (rect.top + rect.height / 2 > 0) {
      document.getElementById('page-input').value = page.dataset.pageNumber;
      break;
    }
  }
});

// Find in PDF ─────────────────────────────────────────────────────────────
//
// Walks the text-layer spans (already rendered by renderTextLayer) and
// builds a concatenated string per page plus a span->range map. For a
// query, indexOf scans the concatenated string and we mark every span whose
// range overlaps a hit. The current match's spans get an extra class so
// the active hit stands out and we can scrollIntoView on it.
//
// Highlights live on the text-layer spans themselves, which means zoom
// rerenders wipe them — we re-run the find after each page renders.

const findBar = document.getElementById('find-bar');
const findInput = document.getElementById('find-input');
const findCount = document.getElementById('find-count');
const findPrev = document.getElementById('find-prev');
const findNext = document.getElementById('find-next');
const findClose = document.getElementById('find-close');

let findQuery = '';
let findMatches = [];
let findCurrent = -1;

function buildFindIndex() {
  const pages = [];
  for (let i = 0; i < pageDivs.length; i++) {
    const spans = Array.from(pageDivs[i].querySelectorAll('.text-layer span'));
    let text = '';
    const ranges = [];
    for (const span of spans) {
      const t = span.textContent;
      const start = text.length;
      text += t;
      ranges.push({ start, end: text.length, span });
      // Pad with a space so adjacent spans don't accidentally form
      // false-positive matches across visual word breaks.
      text += ' ';
    }
    pages.push({ pageNum: i + 1, text, lower: text.toLowerCase(), ranges });
  }
  return pages;
}

function clearFindHighlights() {
  document.querySelectorAll('.text-layer span.find-match, .text-layer span.find-match-current')
    .forEach(el => el.classList.remove('find-match', 'find-match-current'));
}

function runFind(preserveCurrent = false) {
  clearFindHighlights();
  findMatches = [];
  const q = findQuery.toLowerCase();
  if (!q) {
    findCurrent = -1;
    updateFindUI();
    return;
  }

  const pages = buildFindIndex();
  for (const page of pages) {
    let from = 0;
    while (from <= page.lower.length) {
      const idx = page.lower.indexOf(q, from);
      if (idx === -1) break;
      const hitEnd = idx + q.length;
      const spans = page.ranges.filter(r => r.start < hitEnd && r.end > idx).map(r => r.span);
      findMatches.push({ pageNum: page.pageNum, idx, spans });
      from = idx + Math.max(1, q.length);
    }
  }

  for (const m of findMatches) {
    for (const span of m.spans) span.classList.add('find-match');
  }

  if (findMatches.length === 0) {
    findCurrent = -1;
  } else if (!preserveCurrent || findCurrent < 0 || findCurrent >= findMatches.length) {
    findCurrent = 0;
  }
  if (findCurrent >= 0) markCurrent(false);
  updateFindUI();
}

function markCurrent(scroll = true) {
  document.querySelectorAll('.text-layer span.find-match-current')
    .forEach(el => el.classList.remove('find-match-current'));
  const m = findMatches[findCurrent];
  if (!m) return;
  for (const span of m.spans) span.classList.add('find-match-current');
  if (scroll && m.spans.length > 0) {
    m.spans[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.getElementById('page-input').value = m.pageNum;
  }
}

function updateFindUI() {
  const has = findMatches.length > 0;
  if (findQuery && !has) {
    findInput.classList.add('find-no-results');
    findCount.textContent = '0/0';
  } else {
    findInput.classList.remove('find-no-results');
    findCount.textContent = has ? `${findCurrent + 1}/${findMatches.length}` : (findQuery ? '0/0' : '');
  }
  findPrev.disabled = !has;
  findNext.disabled = !has;
}

function gotoNext(delta) {
  if (findMatches.length === 0) return;
  findCurrent = (findCurrent + delta + findMatches.length) % findMatches.length;
  markCurrent(true);
  updateFindUI();
}

function openFindBar() {
  findBar.hidden = false;
  findInput.focus();
  findInput.select();
}

function closeFindBar() {
  findBar.hidden = true;
  findQuery = '';
  findInput.value = '';
  clearFindHighlights();
  findMatches = [];
  findCurrent = -1;
}

findInput.addEventListener('input', () => {
  findQuery = findInput.value;
  runFind(false);
});
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    gotoNext(e.shiftKey ? -1 : 1);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeFindBar();
  }
});
findPrev.addEventListener('click', () => gotoNext(-1));
findNext.addEventListener('click', () => gotoNext(1));
findClose.addEventListener('click', closeFindBar);

// Text-layer spans are rebuilt on every zoom/rerender, so previously applied
// highlights vanish. Re-run the find after each page renders to restore them.
document.addEventListener('pdfpagerendered', () => {
  if (!findBar.hidden && findQuery) runFind(true);
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  // Ctrl/Cmd+F: open the find bar regardless of focus.
  if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault();
    openFindBar();
    return;
  }
  // Escape closes the find bar even when focus has moved away.
  if (e.key === 'Escape' && !findBar.hidden) {
    e.preventDefault();
    closeFindBar();
    return;
  }
  // Don't hijack keys while the user is typing in any editable field. The
  // sidebar's note editor and the text-note overlay are TEXTAREAs (not INPUTs),
  // so a tagName check alone let `+` `-` `=` leak through to PDF zoom.
  if (e.target.closest?.('input, textarea, [contenteditable=""], [contenteditable="true"]')) return;

  if (e.key === '+' || e.key === '=') {
    document.getElementById('zoom-in').click();
  } else if (e.key === '-') {
    document.getElementById('zoom-out').click();
  }
});
