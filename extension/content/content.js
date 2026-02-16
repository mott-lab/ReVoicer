// PDF Converser - Content Script
// Handles text selection detection, floating action button, speech recording, and backend submission

const apiClient = new ApiClient();
const speechCapture = new SpeechCapture();

let fab = null;
let recordingOverlay = null;
let textInputOverlay = null;
let currentSelectedText = '';

// Initialize
(async () => {
  await apiClient.init();
})();

// === Text Selection Detection ===

document.addEventListener('mouseup', (e) => {
  // Small delay lets the selection finalize
  setTimeout(() => {
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim();

    if (selectedText && selectedText.length > 0) {
      currentSelectedText = selectedText;
      showFab(e.clientX, e.clientY);
    } else {
      hideFab();
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
  showRecordingUI(selectedText);

  speechCapture.onResult = (finalText, interimText) => {
    updateRecordingTranscript(finalText + (interimText ? ' ' + interimText : ''));
  };

  speechCapture.onEnd = async (transcript, audioBlob) => {
    hideRecordingUI();
    if (transcript.trim() || audioBlob) {
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
      <button class="pcr-stop-btn" id="pcr-stop-btn">Done</button>
    </div>
  `;
  document.body.appendChild(recordingOverlay);

  document.getElementById('pcr-stop-btn').onclick = () => speechCapture.stop();
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
      <span class="pcr-hint">Ctrl+Enter to submit</span>
      <button class="pcr-cancel-btn" id="pcr-text-cancel">Cancel</button>
      <button class="pcr-stop-btn" id="pcr-text-submit">Submit</button>
    </div>
  `;
  document.body.appendChild(textInputOverlay);

  const textarea = document.getElementById('pcr-text-area');
  textarea.focus();

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submitFromTextInput(selectedText);
    }
  });

  document.getElementById('pcr-text-submit').onclick = () => {
    submitFromTextInput(selectedText);
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

function hideTextInputUI() {
  if (textInputOverlay) {
    textInputOverlay.remove();
    textInputOverlay = null;
  }
}

// === Note Submission ===

async function submitNote(selectedText, rawTranscript, audioBlob) {
  const pdfId = getPdfIdentifier();
  const pageNum = getCurrentPageNumber();
  const pdfTitle = getPdfTitle();

  // If we have audio, try Whisper transcription first for better quality
  let finalTranscript = rawTranscript;
  if (audioBlob && audioBlob.size > 0) {
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
    });

    const typeLabel = (note.comment_type || 'summary').replace('_', ' ');
    const preview = note.cleaned_comment.length > 70
      ? note.cleaned_comment.substring(0, 70) + '...'
      : note.cleaned_comment;
    showToast(`[${typeLabel}] ${preview}`, 'success');

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
  const pageNum = getCurrentPageNumber();
  const pdfTitle = getPdfTitle();

  showToast('Processing annotation...', 'info');

  try {
    const note = await apiClient.createNote({
      pdf_identifier: pdfId,
      pdf_title: pdfTitle,
      selected_text: selectedText,
      page_number: pageNum,
      raw_transcript: typedText,
      skip_cleanup: skipCleanup,
    });

    const typeLabel = (note.comment_type || 'summary').replace('_', ' ');
    const preview = note.cleaned_comment.length > 70
      ? note.cleaned_comment.substring(0, 70) + '...'
      : note.cleaned_comment;
    showToast(`[${typeLabel}] ${preview}`, 'success');

    chrome.runtime.sendMessage({
      action: 'noteCreated',
      pdfIdentifier: pdfId,
    }).catch(() => {});
  } catch (err) {
    console.error('PDF Converser - submission error:', err);
    showToast('Failed to save annotation. Is the backend running?', 'error');
  }
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
});

// === Utilities ===

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
