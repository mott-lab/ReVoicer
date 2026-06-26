// PDF Converser - Content Script
// Handles text selection detection, floating action button, speech recording, and backend submission

const apiClient = new ApiClient();
const speechCapture = new SpeechCapture();

let fab = null;
let recordingOverlay = null;
let textInputOverlay = null;
let currentSelectedText = '';
let currentSelectionRange = null;
let cachedNotes = [];
let answerOverlay = null;
let askMode = false;
// True while a recording or text-input overlay is open. The mouseup listener
// short-circuits in this state so clicking Done/Submit/Ask doesn't re-spawn
// the FAB next to the cursor.
let overlayActive = false;

// Reference numbers found in the parsed bibliography. Only in-text "[N]" tokens
// whose N is in this set are made clickable. Populated once the reference list
// is extracted (on pdftextextracted).
let citationNumbers = new Set();
let citationPages = new Map(); // reference number -> page it appears on
// Session cache keyed by "pdfId:number" -> resolved lookup result or the
// in-flight promise. Dedupes concurrent clicks and avoids re-requesting within
// a session; the backend also persists results across restarts.
const citationLookups = new Map();
let citationModalEl = null;
let citationEscHandler = null;
let citationNav = null; // { nums: number[], index } when a bracket has multiple refs

// Highlight coloring. `autoColorHighlights` mirrors the auto_color_highlights
// setting; when false (default) un-overridden highlights use the flat default
// color below, when true they're colored by the note's primary tag.
const DEFAULT_HIGHLIGHT_COLOR = '#ffee58';
let autoColorHighlights = false;

async function refreshHighlightSettings() {
  try {
    const s = await window.desktop?.getSettings?.();
    autoColorHighlights = s?.auto_color_highlights === true;
  } catch {
    autoColorHighlights = false;
  }
}

// True when the configured speech provider produces the final transcript on
// the client (Vosk in the desktop build) — in that case we skip the
// /api/transcribe round-trip and use the live transcript directly.
async function shouldSkipServerTranscribe() {
  try {
    const s = await window.desktop?.getSettings?.();
    return s?.speech_provider === 'vosk';
  } catch {
    return false;
  }
}

// Initialize
(async () => {
  await apiClient.init();
  await refreshHighlightSettings();
  // Load existing highlights once pages start rendering, and (re-)tag in-text
  // citations on the page — text-layer spans are rebuilt on every zoom/render.
  document.addEventListener('pdfpagerendered', (e) => {
    renderHighlightsForPage(e.detail.pageNum);
    renderCitationMarkersOnPage(e.detail.pageNum);
  });
  // Upload document text when extraction completes, then parse the reference
  // list so in-text [N] citations become clickable.
  document.addEventListener('pdftextextracted', async (e) => {
    const pdfId = getPdfIdentifier();
    if (!pdfId) return;
    try {
      await apiClient.uploadDocumentText(pdfId, e.detail.pageTexts);
    } catch (err) {
      console.log('PDF Converser: Could not upload document text', err.message);
    }
    try {
      const res = await apiClient.extractCitations(pdfId);
      console.log(`PDF Converser: citations extracted — status=${res?.status}, count=${res?.count || 0}`);
      if (res && Array.isArray(res.numbers) && res.numbers.length > 0) {
        citationNumbers = new Set(res.numbers);
        citationPages = new Map(
          Object.entries(res.pages || {}).map(([n, p]) => [parseInt(n, 10), p]),
        );
        renderAllCitationMarkers();
      }
    } catch (err) {
      console.log('PDF Converser: citation extraction failed', err.message);
    }
  });
  // Initial load of notes (delay to let pages render)
  setTimeout(() => loadAndRenderHighlights(), 1000);
})();

// === Text Selection Detection ===

document.addEventListener('mouseup', (e) => {
  // Small delay lets the selection finalize
  setTimeout(() => {
    // Don't spawn while an annotation overlay is open — covers both the
    // click on Done/Submit/Ask (overlay already up) and the click on the
    // FAB mic/text buttons (overlay opens between mouseup and this fire).
    if (overlayActive) return;
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim();

    if (selectedText && selectedText.length > 0) {
      // Restrict the FAB to PDF text. Selecting text in the sidebar pane
      // (note bodies, Q&A answers) must not trigger annotation flow.
      const anchor = selection.anchorNode;
      const anchorEl = anchor?.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor;
      if (!anchorEl?.closest?.('.text-layer')) {
        hideFab();
        return;
      }
      currentSelectedText = selectedText;
      // Clone the range before it's lost on next interaction
      if (selection.rangeCount > 0) {
        currentSelectionRange = selection.getRangeAt(0).cloneRange();
      }
      showFab(e.clientX, e.clientY);
    } else {
      hideFab();
      // Check if this was a click (not drag) on a highlighted span
      const target = e.target.closest?.('[data-note-ids]');
      if (target) {
        const noteIds = target.dataset.noteIds.split(',');
        if (noteIds.length > 0) {
          chrome.runtime.sendMessage({
            action: 'scrollToNote',
            noteId: noteIds[0],
          }).catch(() => {});
        }
      }
    }
  }, 50);
});

document.addEventListener('mousedown', (e) => {
  if (fab && !fab.contains(e.target)) {
    hideFab();
  }
});

// Click on a tagged in-text citation opens the reference popup. Ignored when
// the user just finished selecting text (a drag), so selection still works.
document.addEventListener('click', (e) => {
  const target = e.target.closest?.('[data-citation-nums]');
  if (!target) return;
  const sel = window.getSelection();
  if (sel && sel.toString().trim().length > 0) return;
  e.preventDefault();
  const nums = target.dataset.citationNums
    .split(',')
    .map((n) => parseInt(n, 10))
    .filter((n) => Number.isFinite(n));
  if (nums.length > 0) openCitationModal(nums);
});

// === Floating Action Button ===

function showFab(x, y) {
  if (!fab) {
    fab = document.createElement('div');
    fab.id = 'pdf-converser-fab';
    fab.innerHTML = `
      <button class="pcr-fab-btn" id="pcr-fab-mic" title="Voice annotation">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
          <line x1="12" y1="19" x2="12" y2="23"/>
          <line x1="8" y1="23" x2="16" y2="23"/>
        </svg>
      </button>
      <button class="pcr-fab-btn" id="pcr-fab-text" title="Text annotation">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M17 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z"/>
          <line x1="9" y1="7" x2="15" y2="7"/>
          <line x1="9" y1="11" x2="15" y2="11"/>
          <line x1="9" y1="15" x2="13" y2="15"/>
        </svg>
      </button>
    `;
    document.body.appendChild(fab);
  }

  // Position near the selection, offset slightly above and to the right
  const scrollX = window.scrollX || window.pageXOffset;
  const scrollY = window.scrollY || window.pageYOffset;
  fab.style.left = `${x + scrollX + 10}px`;
  fab.style.top = `${y + scrollY - 45}px`;
  fab.style.display = 'flex';

  document.getElementById('pcr-fab-mic').onclick = (e) => {
    e.stopPropagation();
    startRecording(currentSelectedText);
  };
  document.getElementById('pcr-fab-text').onclick = (e) => {
    e.stopPropagation();
    startTextInput(currentSelectedText);
  };
}

function hideFab() {
  if (fab) {
    fab.style.display = 'none';
  }
}

// === Speech Recording ===

function startRecording(selectedText) {
  hideFab();
  askMode = false;
  showRecordingUI(selectedText);

  // Live partials are intentionally not surfaced — the static "Listening…"
  // indicator in the overlay is enough, and a moving transcript was
  // distracting. speechCapture still accumulates `transcript` internally for
  // the final submit (used when speech_provider === 'vosk').

  speechCapture.onEnd = async (transcript, audioBlob) => {
    hideRecordingUI();
    if (askMode) {
      // Transcribe with Whisper for better quality, then ask. Skipped when
      // the user has chosen Vosk as the final provider — the live transcript
      // is the final transcript.
      let finalQuestion = transcript.trim();
      const skipServer = await shouldSkipServerTranscribe();
      if (!skipServer && audioBlob && audioBlob.size > 0) {
        try {
          const whisperResult = await apiClient.transcribe(audioBlob);
          if (whisperResult.text) finalQuestion = whisperResult.text;
        } catch (err) {
          console.log('PDF Converser: Whisper unavailable for Q&A, using Web Speech API', err.message);
        }
      }
      if (finalQuestion) {
        submitQuestion(selectedText, finalQuestion);
      } else {
        showToast('No speech detected. Try again.', 'error');
      }
    } else if (transcript.trim() || audioBlob) {
      await submitNote(selectedText, transcript.trim(), audioBlob);
    }
  };

  speechCapture.onError = (error) => {
    hideRecordingUI();
    if (error === 'not-allowed') {
      showToast('Microphone permission denied. Please allow microphone access and try again.', 'error');
    } else {
      showToast(`Speech recognition error: ${error}`, 'error');
    }
  };

  speechCapture.start();
}

// === Recording UI ===

function showRecordingUI(selectedText) {
  recordingOverlay = document.createElement('div');
  recordingOverlay.id = 'pdf-converser-recording';

  const truncatedText = selectedText.length > 120
    ? selectedText.substring(0, 120) + '...'
    : selectedText;

  recordingOverlay.innerHTML = `
    <div class="pcr-header">
      <span class="pcr-pulse"></span>
      <span class="pcr-header-text">Recording annotation...</span>
    </div>
    <div class="pcr-selected-text">"${escapeHtml(truncatedText)}"</div>
    <div class="pcr-transcript" id="pcr-live-transcript">Listening...</div>
    <div class="pcr-actions">
      <button class="pcr-cancel-btn" id="pcr-cancel-btn">Cancel</button>
      <button class="pcr-ask-btn" id="pcr-ask-btn">Ask</button>
      <button class="pcr-stop-btn" id="pcr-stop-btn">Done</button>
    </div>
  `;
  document.body.appendChild(recordingOverlay);
  overlayActive = true;

  document.getElementById('pcr-stop-btn').onclick = () => {
    clearSelectionForSubmit();
    askMode = false;
    speechCapture.stop();
  };
  document.getElementById('pcr-ask-btn').onclick = () => {
    clearSelectionForSubmit();
    askMode = true;
    speechCapture.stop();
  };
  document.getElementById('pcr-cancel-btn').onclick = () => {
    speechCapture.transcript = ''; // Clear transcript so onEnd doesn't submit
    speechCapture.stop();
    hideRecordingUI();
  };
}

// Clear the residual PDF selection (and our cached range) so that, after the
// overlay closes, no leftover mouseup re-spawns the FAB.
function clearSelectionForSubmit() {
  try { window.getSelection()?.removeAllRanges(); } catch { /* ignore */ }
  currentSelectedText = '';
  // Note: keep currentSelectionRange — submit handlers still need it for
  // captureHighlightData(). It's cleared in hide*UI() below.
}

function hideRecordingUI() {
  if (recordingOverlay) {
    recordingOverlay.remove();
    recordingOverlay = null;
  }
  overlayActive = false;
  // Don't clear currentSelectionRange here — submitNote() runs after this in
  // the speechCapture.onEnd path and still needs it for captureHighlightData()
  // and getCurrentPageNumber(). The next selection will overwrite it.
}

// === Text Input ===

function startTextInput(selectedText) {
  hideFab();
  showTextInputUI(selectedText);
}

function showTextInputUI(selectedText) {
  textInputOverlay = document.createElement('div');
  textInputOverlay.id = 'pdf-converser-text-input';

  const truncatedText = selectedText.length > 120
    ? selectedText.substring(0, 120) + '...'
    : selectedText;

  textInputOverlay.innerHTML = `
    <div class="pcr-header">
      <span class="pcr-header-text">Type your annotation</span>
    </div>
    <div class="pcr-selected-text">"${escapeHtml(truncatedText)}"</div>
    <textarea class="pcr-textarea" id="pcr-text-area" placeholder="Type your annotation here..." rows="4"></textarea>
    <label class="pcr-cleanup-toggle">
      <input type="checkbox" id="pcr-cleanup-checkbox" checked>
      <span>Clean up with LLM</span>
    </label>
    <div class="pcr-actions">
      <span class="pcr-hint">Ctrl+Enter submit · Ctrl+Shift+Enter ask</span>
      <button class="pcr-cancel-btn" id="pcr-text-cancel">Cancel</button>
      <button class="pcr-ask-btn" id="pcr-text-ask">Ask</button>
      <button class="pcr-stop-btn" id="pcr-text-submit">Submit</button>
    </div>
  `;
  document.body.appendChild(textInputOverlay);
  overlayActive = true;

  const textarea = document.getElementById('pcr-text-area');
  textarea.focus();
  // Re-assert focus on the next frame in case a same-tick handler or layout
  // pass dropped it as the overlay was inserted.
  requestAnimationFrame(() => {
    if (textInputOverlay && document.activeElement !== textarea) textarea.focus();
  });

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.shiftKey) {
      e.preventDefault();
      askFromTextInput(selectedText);
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submitFromTextInput(selectedText);
    }
  });

  document.getElementById('pcr-text-submit').onclick = () => {
    submitFromTextInput(selectedText);
  };

  document.getElementById('pcr-text-ask').onclick = () => {
    askFromTextInput(selectedText);
  };

  document.getElementById('pcr-text-cancel').onclick = () => {
    hideTextInputUI();
  };
}

function submitFromTextInput(selectedText) {
  const textarea = document.getElementById('pcr-text-area');
  const checkbox = document.getElementById('pcr-cleanup-checkbox');
  const text = textarea.value.trim();

  if (!text) {
    showToast('Please type an annotation.', 'error');
    return;
  }

  clearSelectionForSubmit();
  hideTextInputUI();
  submitTypedNote(selectedText, text, !checkbox.checked);
}

function askFromTextInput(selectedText) {
  const textarea = document.getElementById('pcr-text-area');
  const text = textarea.value.trim();

  if (!text) {
    showToast('Please type a question.', 'error');
    return;
  }

  clearSelectionForSubmit();
  hideTextInputUI();
  submitQuestion(selectedText, text);
}

function hideTextInputUI() {
  if (textInputOverlay) {
    textInputOverlay.remove();
    textInputOverlay = null;
  }
  overlayActive = false;
}

// === PDF Q&A ===

async function submitQuestion(selectedText, question) {
  const pdfId = getPdfIdentifier();
  if (!pdfId) {
    showToast('No PDF identifier available.', 'error');
    return;
  }

  const pageNum = getCurrentPageNumber(currentSelectionRange);
  showAnswerOverlay(question, null, true);

  try {
    const result = await apiClient.askQuestion(pdfId, question, selectedText, pageNum);
    showAnswerOverlay(question, result.answer, false);

    // Notify sidebar to refresh questions list
    chrome.runtime.sendMessage({
      action: 'questionAnswered',
      pdfIdentifier: pdfId,
    }).catch(() => {});
  } catch (err) {
    console.error('PDF Converser - Q&A error:', err);
    showAnswerOverlay(question, 'Failed to get answer. Is the backend running?', false, true);
  }
}

function showAnswerOverlay(question, answerText, isLoading, isError = false) {
  hideAnswerOverlay();

  answerOverlay = document.createElement('div');
  answerOverlay.id = 'pdf-converser-answer';

  const truncatedQuestion = question.length > 200
    ? question.substring(0, 200) + '...'
    : question;

  const contentHtml = isLoading
    ? '<div class="pcr-answer-loading"><span class="pcr-pulse"></span> Thinking...</div>'
    : `<div class="pcr-answer-text ${isError ? 'pcr-answer-error' : ''}">${escapeHtml(answerText)}</div>`;

  answerOverlay.innerHTML = `
    <div class="pcr-header">
      <span class="pcr-header-text">Answer</span>
    </div>
    <div class="pcr-selected-text">"${escapeHtml(truncatedQuestion)}"</div>
    ${contentHtml}
    <div class="pcr-actions">
      <button class="pcr-cancel-btn" id="pcr-answer-close">Close</button>
    </div>
  `;
  document.body.appendChild(answerOverlay);

  document.getElementById('pcr-answer-close').onclick = () => hideAnswerOverlay();
}

function hideAnswerOverlay() {
  if (answerOverlay) {
    answerOverlay.remove();
    answerOverlay = null;
  }
}

// === Highlight Data Capture ===

function captureHighlightData() {
  if (!currentSelectionRange) return null;

  const range = currentSelectionRange;
  const startNode = range.startContainer;
  const endNode = range.endContainer;

  // Find the parent text-layer spans
  const startEl = startNode.nodeType === Node.TEXT_NODE ? startNode.parentElement : startNode;
  const endEl = endNode.nodeType === Node.TEXT_NODE ? endNode.parentElement : endNode;

  // Verify they're in a text layer with data-index
  if (!startEl?.dataset?.index || !endEl?.dataset?.index) return null;
  if (!startEl.closest('.text-layer') || !endEl.closest('.text-layer')) return null;

  return {
    startSpanIndex: parseInt(startEl.dataset.index, 10),
    startOffset: range.startOffset,
    endSpanIndex: parseInt(endEl.dataset.index, 10),
    endOffset: range.endOffset,
  };
}

// === Note Submission ===

async function submitNote(selectedText, rawTranscript, audioBlob) {
  const pdfId = getPdfIdentifier();
  const pageNum = getCurrentPageNumber(currentSelectionRange);
  const pdfTitle = getPdfTitle();
  const highlightData = captureHighlightData();

  // If we have audio, try Whisper transcription first for better quality.
  // Skipped when the user has chosen Vosk as the final provider — the live
  // transcript is already the final transcript.
  let finalTranscript = rawTranscript;
  const skipServer = await shouldSkipServerTranscribe();
  if (!skipServer && audioBlob && audioBlob.size > 0) {
    showToast('Transcribing with Whisper...', 'info');
    try {
      const whisperResult = await apiClient.transcribe(audioBlob);
      if (whisperResult.text) {
        finalTranscript = whisperResult.text;
      }
    } catch (err) {
      // Whisper failed (not configured, or API error) — fall back to Web Speech API transcript
      console.log('PDF Converser: Whisper unavailable, using Web Speech API transcript', err.message);
    }
  }

  if (!finalTranscript) {
    showToast('No speech detected. Try again.', 'error');
    return;
  }

  showToast('Processing annotation...', 'info');

  try {
    const note = await apiClient.createNote({
      pdf_identifier: pdfId,
      pdf_title: pdfTitle,
      selected_text: selectedText,
      page_number: pageNum,
      raw_transcript: finalTranscript,
      highlight_data: highlightData,
    });

    const typeLabel = (note.comment_type || 'summary').replace('_', ' ');
    const preview = note.cleaned_comment.length > 70
      ? note.cleaned_comment.substring(0, 70) + '...'
      : note.cleaned_comment;
    showToast(`[${typeLabel}] ${preview}`, 'success');

    // Add to cache and render highlight immediately
    cachedNotes.push(note);
    if (note.highlight_data) renderNoteHighlight(note);

    // Notify sidebar to refresh
    chrome.runtime.sendMessage({
      action: 'noteCreated',
      pdfIdentifier: pdfId,
    }).catch(() => {});
  } catch (err) {
    console.error('PDF Converser - submission error:', err);
    showToast('Failed to save annotation. Is the backend running?', 'error');
  }
}

async function submitTypedNote(selectedText, typedText, skipCleanup) {
  const pdfId = getPdfIdentifier();
  const pageNum = getCurrentPageNumber(currentSelectionRange);
  const pdfTitle = getPdfTitle();
  const highlightData = captureHighlightData();

  showToast('Processing annotation...', 'info');

  try {
    const note = await apiClient.createNote({
      pdf_identifier: pdfId,
      pdf_title: pdfTitle,
      selected_text: selectedText,
      page_number: pageNum,
      raw_transcript: typedText,
      skip_cleanup: skipCleanup,
      highlight_data: highlightData,
    });

    const typeLabel = (note.comment_type || 'summary').replace('_', ' ');
    const preview = note.cleaned_comment.length > 70
      ? note.cleaned_comment.substring(0, 70) + '...'
      : note.cleaned_comment;
    showToast(`[${typeLabel}] ${preview}`, 'success');

    cachedNotes.push(note);
    if (note.highlight_data) renderNoteHighlight(note);

    chrome.runtime.sendMessage({
      action: 'noteCreated',
      pdfIdentifier: pdfId,
    }).catch(() => {});
  } catch (err) {
    console.error('PDF Converser - submission error:', err);
    showToast('Failed to save annotation. Is the backend running?', 'error');
  }
}

// === Highlight Rendering ===

async function loadAndRenderHighlights() {
  const pdfId = getPdfIdentifier();
  if (!pdfId) return;

  try {
    const data = await apiClient.getNotes(pdfId);
    cachedNotes = data.notes || [];
    await refreshHighlightSettings();
    renderAllHighlights();
  } catch (err) {
    console.log('PDF Converser: Could not load highlights', err.message);
  }
}

function renderAllHighlights() {
  // Clear existing highlights
  document.querySelectorAll('.pcr-highlight-layer').forEach(el => el.remove());
  // Clear note-id tags from text spans
  document.querySelectorAll('[data-note-ids]').forEach(el => el.removeAttribute('data-note-ids'));

  for (const note of cachedNotes) {
    if (note.highlight_data && note.page_number) {
      renderNoteHighlight(note);
    }
  }
}

function renderHighlightsForPage(pageNum) {
  // Clear existing highlights for this page
  const page = document.querySelector(`.pdf-page[data-page-number="${pageNum}"]`);
  if (!page) return;
  const existingLayer = page.querySelector('.pcr-highlight-layer');
  if (existingLayer) existingLayer.remove();
  // Clear note-id tags for spans on this page
  page.querySelectorAll('[data-note-ids]').forEach(el => el.removeAttribute('data-note-ids'));

  for (const note of cachedNotes) {
    if (note.highlight_data && note.page_number === pageNum) {
      renderNoteHighlight(note);
    }
  }
}

// Group raw DOMRects from Range.getClientRects() into one rect per visual
// line. Two rects belong to the same line when their vertical centers fall
// within half the smaller rect's height of each other — that's tight enough
// to keep superscripts/subscripts on a separate row, but loose enough to
// merge same-line text runs that have slightly different ascender heights.
function mergeRectsByLine(rects) {
  const filtered = [];
  for (const r of rects) {
    if (r.width > 0 && r.height > 0) filtered.push(r);
  }
  if (filtered.length === 0) return [];

  filtered.sort((a, b) => a.top - b.top || a.left - b.left);

  const lines = [];
  for (const r of filtered) {
    const cur = lines[lines.length - 1];
    if (cur) {
      const tolerance = Math.min(r.height, cur.height) * 0.5;
      const curCenter = cur.top + cur.height / 2;
      const rCenter = r.top + r.height / 2;
      if (Math.abs(curCenter - rCenter) <= tolerance) {
        const newLeft = Math.min(cur.left, r.left);
        const newRight = Math.max(cur.left + cur.width, r.left + r.width);
        const newTop = Math.min(cur.top, r.top);
        const newBottom = Math.max(cur.top + cur.height, r.top + r.height);
        cur.left = newLeft;
        cur.top = newTop;
        cur.width = newRight - newLeft;
        cur.height = newBottom - newTop;
        continue;
      }
    }
    lines.push({ left: r.left, top: r.top, width: r.width, height: r.height });
  }
  return lines;
}

function renderNoteHighlight(note) {
  const { highlight_data, page_number, id } = note;
  if (!highlight_data) return;
  // Color sourcing:
  //   1. color_override (user-picked hex from the side panel)
  //   2. primary tag from comment_tags (CSS class drives the color)
  //   3. legacy comment_type for old notes
  const primaryTag = (Array.isArray(note.comment_tags) && note.comment_tags.length > 0)
    ? note.comment_tags[0]
    : (note.comment_type || 'summary');
  const colorOverride = note.color_override || null;

  const page = document.querySelector(`.pdf-page[data-page-number="${page_number}"]`);
  if (!page) return;

  const textLayer = page.querySelector('.text-layer');
  if (!textLayer) return;

  // Get or create highlight layer
  let highlightLayer = page.querySelector('.pcr-highlight-layer');
  if (!highlightLayer) {
    highlightLayer = document.createElement('div');
    highlightLayer.className = 'pcr-highlight-layer';
    // Insert between canvas and text layer
    page.insertBefore(highlightLayer, textLayer);
  }

  const { startSpanIndex, startOffset, endSpanIndex, endOffset } = highlight_data;

  const startSpan = textLayer.querySelector(`span[data-index="${startSpanIndex}"]`);
  const endSpan = textLayer.querySelector(`span[data-index="${endSpanIndex}"]`);
  if (!startSpan || !endSpan) return;

  const startTextNode = startSpan.firstChild;
  const endTextNode = endSpan.firstChild;
  if (!startTextNode || !endTextNode) return;

  try {
    const range = document.createRange();
    range.setStart(startTextNode, Math.min(startOffset, startTextNode.length));
    range.setEnd(endTextNode, Math.min(endOffset, endTextNode.length));

    // getClientRects() over a multi-line selection often returns several
    // overlapping rects per fully-selected line (one per text-layer span,
    // sometimes plus the parent box) — stacking those produces visibly
    // doubled-up highlight color on middle lines while the partial start/end
    // lines look fine. Merge by line before rendering so each visual line
    // gets exactly one highlight div.
    const lines = mergeRectsByLine(range.getClientRects());
    const pageRect = page.getBoundingClientRect();

    for (const rect of lines) {
      const highlight = document.createElement('div');
      highlight.className = 'pcr-highlight';
      highlight.dataset.noteId = id;
      if (colorOverride) {
        highlight.style.background = colorOverride;
      } else if (autoColorHighlights) {
        highlight.classList.add(`pcr-highlight-${primaryTag}`);
      } else {
        highlight.style.background = DEFAULT_HIGHLIGHT_COLOR;
      }
      highlight.style.left = `${rect.left - pageRect.left}px`;
      highlight.style.top = `${rect.top - pageRect.top}px`;
      highlight.style.width = `${rect.width}px`;
      highlight.style.height = `${rect.height}px`;
      highlightLayer.appendChild(highlight);
    }

    // Tag text spans in the range with note IDs for click detection
    for (let i = startSpanIndex; i <= endSpanIndex; i++) {
      const span = textLayer.querySelector(`span[data-index="${i}"]`);
      if (span) {
        const existing = span.dataset.noteIds || '';
        const ids = existing ? existing.split(',') : [];
        if (!ids.includes(id)) ids.push(id);
        span.dataset.noteIds = ids.join(',');
      }
    }
  } catch (err) {
    console.log('PDF Converser: Could not render highlight for note', id, err.message);
  }
}

function scrollToAndFlashHighlight(noteId) {
  // Find the note in cache to get page number
  const note = cachedNotes.find(n => n.id === noteId);
  if (!note) return;

  const page = document.querySelector(`.pdf-page[data-page-number="${note.page_number}"]`);
  if (page) {
    page.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // Flash the highlight after scroll
  setTimeout(() => {
    const highlights = document.querySelectorAll(`.pcr-highlight[data-note-id="${noteId}"]`);
    highlights.forEach(el => {
      el.classList.add('pcr-highlight-flash');
      el.addEventListener('animationend', () => el.classList.remove('pcr-highlight-flash'), { once: true });
    });
  }, 400);
}

// === In-Text Citations ===

// Expand the text between brackets into individual numbers. Handles single
// "12", lists "1, 2", and ranges "1-3" / "1–3".
function parseCitationNumbers(inner) {
  const nums = [];
  for (const part of inner.split(',')) {
    const piece = part.trim();
    const range = piece.match(/^(\d{1,4})\s*[-–—−‐]\s*(\d{1,4})$/);
    if (range) {
      const lo = parseInt(range[1], 10);
      const hi = parseInt(range[2], 10);
      if (hi >= lo && hi - lo < 100) {
        for (let n = lo; n <= hi; n++) nums.push(n);
      }
    } else {
      const single = piece.match(/^(\d{1,4})$/);
      if (single) nums.push(parseInt(single[1], 10));
    }
  }
  return nums;
}

const CITATION_RE = /\[\s*(\d{1,4}(?:\s*[-–—−‐,]\s*\d{1,4})*)\s*\]/g;

// getClientRects() returns one rect per pdf.js text span a Range crosses, so a
// citation split across many spans (common in justified text) yields a row of
// narrow rects. Merge rects that share a line into one bounding box so each line
// of the citation renders as a single continuous marker (and a clean underline).
function coalesceRectsByLine(rects) {
  const sorted = Array.from(rects)
    .filter((r) => r.width > 0 || r.height > 0)
    .sort((a, b) => a.top - b.top || a.left - b.left);
  const lines = [];
  for (const r of sorted) {
    const line = lines[lines.length - 1];
    // Same visual line when the rect vertically overlaps the current line band.
    if (line && r.top < line.bottom - 1 && r.bottom > line.top + 1) {
      line.left = Math.min(line.left, r.left);
      line.right = Math.max(line.right, r.right);
      line.top = Math.min(line.top, r.top);
      line.bottom = Math.max(line.bottom, r.bottom);
    } else {
      lines.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    }
  }
  return lines;
}

// Draw clickable overlay markers over each in-text "[N]" citation whose number
// exists in the parsed bibliography. Matches against the page's CONCATENATED
// text-layer text (so a "[35]" split across pdf.js spans is still found), and
// positions each marker by measuring each covered text-layer span on its own
// (cross-span Ranges return stray rects over absolutely-positioned spans).
// Rebuilt from scratch each render so zoom re-renders reposition correctly.
function renderCitationMarkersOnPage(pageNum) {
  const page = document.querySelector(`.pdf-page[data-page-number="${pageNum}"]`);
  if (!page) return;
  const existing = page.querySelector('.pcr-citation-layer');
  if (existing) existing.remove();
  if (citationNumbers.size === 0) return;
  const textLayer = page.querySelector('.text-layer');
  if (!textLayer) return;

  // Concatenate span text nodes with no separators (so a split "[","35","]"
  // rejoins to "[35]"), recording each node's offset range for Range building.
  let fullText = '';
  const segs = [];
  for (const span of textLayer.querySelectorAll('span[data-index]')) {
    const node = span.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) continue;
    const len = node.textContent.length;
    if (len === 0) continue;
    segs.push({ node, start: fullText.length, end: fullText.length + len });
    fullText += node.textContent;
  }
  if (fullText.indexOf('[') === -1) return;

  const pageRect = page.getBoundingClientRect();
  let layer = null;
  let m;
  CITATION_RE.lastIndex = 0;
  while ((m = CITATION_RE.exec(fullText)) !== null) {
    const nums = parseCitationNumbers(m[1]).filter((n) => citationNumbers.has(n));
    if (nums.length === 0) continue;
    const mStart = m.index;
    const mEnd = m.index + m[0].length;
    // Measure each covered span on its own (a split citation spans several
    // pdf.js spans). Per-span ranges avoid the stray, mis-positioned rects a
    // single Range returns when it crosses absolutely-positioned spans — those
    // were producing doubled underlines and narrow hover slivers.
    const rects = [];
    for (const s of segs) {
      const from = Math.max(mStart, s.start);
      const to = Math.min(mEnd, s.end);
      if (from >= to) continue;
      try {
        const range = document.createRange();
        range.setStart(s.node, from - s.start);
        range.setEnd(s.node, to - s.start);
        rects.push(range.getBoundingClientRect());
      } catch {
        /* skip unmeasurable span */
      }
    }
    if (rects.length === 0) continue;
    const lines = coalesceRectsByLine(rects);
    if (lines.length === 0) continue;
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'pcr-citation-layer';
      page.appendChild(layer);
    }
    for (const r of lines) {
      const marker = document.createElement('div');
      marker.className = 'pcr-citation-marker';
      marker.dataset.citationNums = nums.join(',');
      marker.style.left = `${r.left - pageRect.left}px`;
      marker.style.top = `${r.top - pageRect.top}px`;
      marker.style.width = `${r.right - r.left}px`;
      marker.style.height = `${r.bottom - r.top}px`;
      layer.appendChild(marker);
    }
  }
}

function renderAllCitationMarkers() {
  for (const page of document.querySelectorAll('.pdf-page[data-page-number]')) {
    const pageNum = parseInt(page.dataset.pageNumber, 10);
    if (pageNum) renderCitationMarkersOnPage(pageNum);
  }
}

function openCitationModal(nums) {
  hideCitationModal();
  citationModalEl = document.createElement('div');
  citationModalEl.className = 'review-modal-backdrop';
  citationModalEl.id = 'pcr-citation-modal';
  citationModalEl.innerHTML = `
    <div class="review-modal" role="dialog" aria-modal="true">
      <div class="review-modal-header">
        <span id="pcr-citation-title">Reference</span>
        <button class="review-modal-close" title="Close">&times;</button>
      </div>
      <div class="pcr-citation-nav" id="pcr-citation-nav"></div>
      <div class="review-modal-body" id="pcr-citation-body"></div>
      <div class="review-modal-footer" id="pcr-citation-footer"></div>
    </div>
  `;
  document.body.appendChild(citationModalEl);

  citationModalEl.querySelector('.review-modal-close').addEventListener('click', hideCitationModal);
  citationModalEl.addEventListener('click', (e) => {
    if (e.target === citationModalEl) hideCitationModal();
  });
  citationEscHandler = (e) => { if (e.key === 'Escape') hideCitationModal(); };
  document.addEventListener('keydown', citationEscHandler);

  // Default to the first reference; the nav bar lets the user move between the
  // others when a bracket lists several (e.g. "[1, 2, 3]").
  citationNav = { nums, index: 0 };
  showCitationAt(0);
}

function hideCitationModal() {
  if (citationModalEl) { citationModalEl.remove(); citationModalEl = null; }
  if (citationEscHandler) {
    document.removeEventListener('keydown', citationEscHandler);
    citationEscHandler = null;
  }
  citationNav = null;
}

// Show the reference at `index` within the current bracket's number list and
// refresh the navigation bar.
function showCitationAt(index) {
  if (!citationNav) return;
  citationNav.index = index;
  renderCitationNav();
  loadCitation(citationNav.nums[index]);
}

// Prev/next arrows + a pill per reference number, shown only when a bracket
// lists more than one reference.
function renderCitationNav() {
  if (!citationModalEl || !citationNav) return;
  const nav = citationModalEl.querySelector('#pcr-citation-nav');
  if (!nav) return;
  const { nums, index } = citationNav;
  if (nums.length <= 1) {
    nav.style.display = 'none';
    nav.innerHTML = '';
    return;
  }
  nav.style.display = '';
  nav.innerHTML = `
    <button class="pcr-cite-arrow" data-nav="prev" ${index === 0 ? 'disabled' : ''} title="Previous reference">&lsaquo;</button>
    <div class="pcr-cite-pills">
      ${nums.map((n, i) => `<button class="pcr-cite-pill${i === index ? ' active' : ''}" data-idx="${i}">[${n}]</button>`).join('')}
    </div>
    <button class="pcr-cite-arrow" data-nav="next" ${index === nums.length - 1 ? 'disabled' : ''} title="Next reference">&rsaquo;</button>`;
  nav.querySelector('[data-nav="prev"]').addEventListener('click', () => { if (index > 0) showCitationAt(index - 1); });
  nav.querySelector('[data-nav="next"]').addEventListener('click', () => { if (index < nums.length - 1) showCitationAt(index + 1); });
  nav.querySelectorAll('.pcr-cite-pill').forEach((b) => {
    b.addEventListener('click', () => showCitationAt(parseInt(b.dataset.idx, 10)));
  });
}

// Look up a reference's metadata at most once per session: return a cached
// result, join an in-flight request for the same reference, or start a new one.
// Successful / not-found results are cached client-side (the backend also
// persists them); errors are not cached so the user can retry.
function lookupCitationOnce(number) {
  const pdfId = getPdfIdentifier();
  const cacheKey = `${pdfId}:${number}`;
  const hit = citationLookups.get(cacheKey);
  if (hit) return Promise.resolve(hit);
  const promise = apiClient.lookupCitation(pdfId, number)
    .then((result) => {
      if (result && result.status !== 'error') citationLookups.set(cacheKey, result);
      else citationLookups.delete(cacheKey);
      return result;
    })
    .catch((err) => {
      citationLookups.delete(cacheKey);
      return { status: 'error', number, message: err.message };
    });
  citationLookups.set(cacheKey, promise);
  return promise;
}

async function loadCitation(number) {
  const myModal = citationModalEl;
  if (!myModal) return;
  myModal.querySelector('#pcr-citation-title').textContent = `Reference [${number}]`;
  myModal.querySelector('#pcr-citation-body').innerHTML =
    '<div class="pcr-citation-loading"><span class="pcr-citation-spinner"></span> Looking up reference…</div>';
  // Show the Jump-to-reference button right away — the page is known from
  // extraction and doesn't depend on the (possibly slow) metadata lookup.
  renderCitationFooter(number, null);

  const result = await lookupCitationOnce(number);
  // Ignore if the modal was closed, or the user navigated to a different
  // reference (in a multi-ref bracket) while this lookup was in flight.
  if (citationModalEl !== myModal) return;
  if (citationNav && citationNav.nums[citationNav.index] !== number) return;
  renderCitationResult(number, result);
}

function renderCitationResult(number, result) {
  if (!citationModalEl) return;
  const body = citationModalEl.querySelector('#pcr-citation-body');

  if (result?.status === 'ok') {
    const authors = (result.authors || []).join(', ');
    const venueLine = [result.year, result.venue].filter(Boolean).join(' · ');
    body.innerHTML = `
      <h3 class="pcr-citation-paper-title">${escapeHtml(result.title || 'Untitled')}</h3>
      ${authors ? `<p class="pcr-citation-meta">${escapeHtml(authors)}</p>` : ''}
      ${venueLine ? `<p class="pcr-citation-meta">${escapeHtml(venueLine)}</p>` : ''}
      ${result.abstract
        ? `<p class="pcr-citation-abstract">${escapeHtml(result.abstract)}</p>${
          result.abstract_source === 'openalex'
            ? '<p class="pcr-citation-source">Abstract via OpenAlex</p>'
            : ''}`
        : '<p class="pcr-citation-empty">No abstract available.</p>'}`;
  } else if (result?.status === 'not_found') {
    body.innerHTML = `
      <p class="pcr-citation-empty">Couldn't match this reference on Semantic Scholar.</p>
      ${result.raw ? `<p class="pcr-citation-raw">${escapeHtml(result.raw)}</p>` : ''}`;
  } else {
    body.innerHTML = `
      <p class="pcr-citation-empty">Lookup failed${result?.message ? `: ${escapeHtml(result.message)}` : ''}.</p>
      ${result?.raw ? `<p class="pcr-citation-raw">${escapeHtml(result.raw)}</p>` : ''}
      <button class="toolbar-btn" id="pcr-citation-retry">Retry</button>`;
  }

  renderCitationFooter(number, result);
  const retry = body.querySelector('#pcr-citation-retry');
  if (retry) retry.addEventListener('click', () => loadCitation(number));
}

// Footer holds: Jump to reference (when the page is known), View paper, and a
// Google Scholar search link. Re-rendered as the lookup state changes.
function renderCitationFooter(number, result) {
  if (!citationModalEl) return;
  const footer = citationModalEl.querySelector('#pcr-citation-footer');
  const btns = [];
  const page = citationPages.get(number);
  if (page) {
    btns.push(`<button class="toolbar-btn" data-jump="${page}" data-jump-num="${number}">Jump to reference</button>`);
  }
  if (result?.url) {
    btns.push(`<button class="toolbar-btn review-primary" data-open="${escapeHtml(result.url)}">View paper</button>`);
  }
  if (result?.google_scholar_url) {
    btns.push(`<button class="toolbar-btn" data-open="${escapeHtml(result.google_scholar_url)}">Search Google Scholar</button>`);
  }
  footer.innerHTML = btns.join('');
  footer.querySelectorAll('button[data-open]').forEach((btn) => {
    btn.addEventListener('click', () => window.desktop?.openExternal?.(btn.dataset.open));
  });
  footer.querySelectorAll('button[data-jump]').forEach((btn) => {
    btn.addEventListener('click', () =>
      jumpToReference(parseInt(btn.dataset.jumpNum, 10), parseInt(btn.dataset.jump, 10)));
  });
}

// Scroll the PDF to the page holding reference [N] and flash its entry — the
// in-modal equivalent of the PDF's built-in "jump to destination" link. Closes
// the modal first so the destination is visible.
function jumpToReference(number, page) {
  hideCitationModal();
  const pageEl = document.querySelector(`.pdf-page[data-page-number="${page}"]`);
  if (!pageEl) return;
  pageEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  // Once the page is in view its text layer exists; locate the "[N]" entry
  // marker, scroll it to center, and flash it.
  setTimeout(() => {
    const textLayer = pageEl.querySelector('.text-layer');
    if (!textLayer) return;
    const marker = `[${number}]`;
    let target = null;
    for (const span of textLayer.querySelectorAll('span[data-index]')) {
      if ((span.textContent || '').includes(marker)) { target = span; break; }
    }
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('pcr-citation-flash');
    target.addEventListener('animationend', () => target.classList.remove('pcr-citation-flash'), { once: true });
  }, 350);
}

// === Toast Notifications ===

function showToast(message, type = 'info') {
  const existing = document.getElementById('pdf-converser-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'pdf-converser-toast';
  toast.className = `pcr-toast pcr-toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  // Auto-dismiss after 4 seconds
  setTimeout(() => {
    toast.classList.add('pcr-toast-fade');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// === Message Handler (for service worker / sidebar communication) ===

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getPdfId') {
    sendResponse({
      pdfIdentifier: getPdfIdentifier(),
      pdfTitle: getPdfTitle(),
    });
  }
  if (message.action === 'scrollToHighlight') {
    scrollToAndFlashHighlight(message.noteId);
  }
  // Triggered by the sidebar after edits that affect the in-PDF highlight
  // (currently: per-note color override). Re-fetches notes and re-renders.
  if (message.action === 'notesChanged') {
    loadAndRenderHighlights();
  }
  // Broadcast by the main process (relayed through preload) when settings are
  // saved — re-render so the auto-color toggle takes effect immediately.
  if (message.action === 'settingsChanged') {
    loadAndRenderHighlights();
  }
});

// === Utilities ===

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
