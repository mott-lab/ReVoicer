// PDF Converser - PDF.js Viewer
// Renders PDFs with a selectable text layer so our content script can access selections

import * as pdfjsLib from './pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('viewer/pdfjs/pdf.worker.min.mjs');

let pdfDoc = null;
let currentScale = 1.5;
const MIN_SCALE = 0.5;
const MAX_SCALE = 4.0;
const SCALE_STEP = 0.25;

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
  document.getElementById('pdf-title').textContent = decodeURIComponent(pdfUrl.split('/').pop().split('?')[0]);
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

    pagesContainer.innerHTML = '';

    // Render all pages
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      await renderPage(i, pagesContainer);
    }

    // Fit to width on initial load
    fitToWidth();
  } catch (err) {
    console.error('PDF load error:', err);
    pagesContainer.innerHTML = `<div id="loading-msg">Failed to load PDF: ${err.message}</div>`;
  }
}

async function renderPage(pageNum, container) {
  const page = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale: currentScale });

  // Create page wrapper
  const pageDiv = document.createElement('div');
  pageDiv.className = 'pdf-page';
  pageDiv.dataset.pageNumber = pageNum;
  pageDiv.style.width = `${viewport.width}px`;
  pageDiv.style.height = `${viewport.height}px`;

  // Canvas for rendering
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  pageDiv.appendChild(canvas);

  // Text layer for selection
  const textLayerDiv = document.createElement('div');
  textLayerDiv.className = 'text-layer';
  pageDiv.appendChild(textLayerDiv);

  container.appendChild(pageDiv);

  // Render the page to canvas
  await page.render({ canvasContext: ctx, viewport }).promise;

  // Render text layer
  const textContent = await page.getTextContent();
  renderTextLayer(textContent, textLayerDiv, viewport);
}

function renderTextLayer(textContent, container, viewport) {
  const items = textContent.items;

  for (const item of items) {
    if (!item.str) continue;

    const span = document.createElement('span');
    span.textContent = item.str;

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

async function rerender() {
  const pagesContainer = document.getElementById('pages');
  pagesContainer.innerHTML = '';
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    await renderPage(i, pagesContainer);
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

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;

  if (e.key === '+' || e.key === '=') {
    document.getElementById('zoom-in').click();
  } else if (e.key === '-') {
    document.getElementById('zoom-out').click();
  }
});
