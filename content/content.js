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
  // Load existing highlights once pages start rendering
  document.addEventListener('pdfpagerendered', (e) => {
    renderHighlightsForPage(e.detail.pageNum);
  });
  // Upload document text when extraction completes
  document.addEventListener('pdftextextracted', (e) => {
    const pdfId = getPdfIdentifier();
    if (pdfId) {
      apiClient.uploadDocumentText(pdfId, e.detail.pageTexts).catch(err => {
        console.log('PDF Converser: Could not upload document text', err.message);
      });
    }
  });
  // Initial load of notes (delay to let pages render)
  setTimeout(() => loadAndRenderHighlights(), 1000);
})();

// === Text Selection Detection ===

document.addEventListener('mouseup', (e) => {
  // Small delay lets the selection finalize
  setTimeout(() => {
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim();

    if (selectedText && selectedText.length > 0) {
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

  speechCapture.onResult = (finalText, interimText) => {
    updateRecordingTranscript(finalText + (interimText ? ' ' + interimText : ''));
  };

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

  document.getElementById('pcr-stop-btn').onclick = () => {
    askMode = false;
    speechCapture.stop();
  };
  document.getElementById('pcr-ask-btn').onclick = () => {
    askMode = true;
    speechCapture.stop();
  };
  document.getElementById('pcr-cancel-btn').onclick = () => {
    speechCapture.transcript = ''; // Clear transcript so onEnd doesn't submit
    speechCapture.stop();
    hideRecordingUI();
  };
}

function updateRecordingTranscript(text) {
  const el = document.getElementById('pcr-live-transcript');
  if (el) el.textContent = text || 'Listening...';
}

function hideRecordingUI() {
  if (recordingOverlay) {
    recordingOverlay.remove();
    recordingOverlay = null;
  }
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

  const textarea = document.getElementById('pcr-text-area');
  textarea.focus();

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

  hideTextInputUI();
  submitQuestion(selectedText, text);
}

function hideTextInputUI() {
  if (textInputOverlay) {
    textInputOverlay.remove();
    textInputOverlay = null;
  }
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

function renderNoteHighlight(note) {
  const { highlight_data, page_number, comment_type, id } = note;
  if (!highlight_data) return;

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

    const rects = range.getClientRects();
    const pageRect = page.getBoundingClientRect();

    for (const rect of rects) {
      if (rect.width === 0 || rect.height === 0) continue;
      const highlight = document.createElement('div');
      highlight.className = `pcr-highlight pcr-highlight-${comment_type}`;
      highlight.dataset.noteId = id;
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
});

// === Utilities ===

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
