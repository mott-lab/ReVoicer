// PDF Converser - Sidebar Panel

const api = new ApiClient();
let currentPdfId = null;

async function init() {
  await api.init();

  // Get current PDF identifier from the active tab's content script
  chrome.runtime.sendMessage({ action: 'getCurrentPdfId' }, (response) => {
    if (chrome.runtime.lastError) {
      console.log('PDF Converser: No content script available');
      return;
    }
    if (response?.pdfIdentifier) {
      currentPdfId = response.pdfIdentifier;
      document.getElementById('pdf-title').textContent = response.pdfTitle || 'Untitled PDF';
      loadNotes();
    }
  });

  // Listen for new notes
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'noteCreated' && msg.pdfIdentifier === currentPdfId) {
      loadNotes();
    }
  });

  // View mode switching
  document.getElementById('view-mode').addEventListener('change', (e) => {
    loadNotes(e.target.value);
  });

  // Export button
  document.getElementById('export-btn').addEventListener('click', exportMarkdown);
}

async function loadNotes(viewMode = 'chronological') {
  if (!currentPdfId) return;

  const container = document.getElementById('notes-container');
  const loading = document.getElementById('loading');
  loading.style.display = 'flex';

  try {
    if (viewMode === 'chronological') {
      const data = await api.getNotes(currentPdfId);
      renderNotesList(data.notes, container);
    } else if (viewMode === 'by-type') {
      const data = await api.getNotes(currentPdfId);
      renderNotesByType(data.notes, container);
    } else if (viewMode === 'by-section') {
      const data = await api.organizeBySection(currentPdfId);
      renderGroupedNotes(data.groups, container);
    } else if (viewMode === 'by-theme') {
      const data = await api.organizeByTheme(currentPdfId);
      renderGroupedNotes(data.groups, container);
    }
  } catch (err) {
    container.innerHTML = `<p class="error-state">Failed to load notes. Is the backend running?</p>`;
    console.error('PDF Converser sidebar error:', err);
  } finally {
    loading.style.display = 'none';
  }
}

function renderNotesList(notes, container) {
  if (!notes || notes.length === 0) {
    container.innerHTML = '<p class="empty-state">No annotations yet. Highlight text in the PDF and click the microphone button to begin.</p>';
    return;
  }

  container.innerHTML = notes.map(note => `
    <div class="note-card" data-id="${note.id}">
      <div class="note-meta">
        <span class="note-type-badge note-type-${note.comment_type}">${formatType(note.comment_type)}</span>
        <span class="note-page">${note.page_number ? 'Page ' + note.page_number : 'Page ?'}</span>
        <span class="note-time">${formatTime(note.created_at)}</span>
      </div>
      <blockquote class="note-highlight">${escapeHtml(note.selected_text)}</blockquote>
      <div class="note-comment">${escapeHtml(note.cleaned_comment)}</div>
      <details class="note-raw">
        <summary>Raw transcript</summary>
        <p>${escapeHtml(note.raw_transcript)}</p>
      </details>
      <div class="note-actions">
        <button class="note-reclean" data-id="${note.id}" title="Re-clean with LLM">Re-clean</button>
        <button class="note-delete" data-id="${note.id}" title="Delete this note">Delete</button>
      </div>
    </div>
  `).join('');

  // Attach event handlers
  container.querySelectorAll('.note-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (confirm('Delete this annotation?')) {
        await api.deleteNote(btn.dataset.id);
        loadNotes(document.getElementById('view-mode').value);
      }
    });
  });

  container.querySelectorAll('.note-reclean').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.textContent = 'Cleaning...';
      btn.disabled = true;
      try {
        await api.recleanNote(btn.dataset.id);
        loadNotes(document.getElementById('view-mode').value);
      } catch (err) {
        btn.textContent = 'Re-clean';
        btn.disabled = false;
        alert('Failed to re-clean note.');
      }
    });
  });
}

function renderNotesByType(notes, container) {
  if (!notes || notes.length === 0) {
    container.innerHTML = '<p class="empty-state">No annotations to organize.</p>';
    return;
  }
  // Group notes by comment_type, maintaining a logical order
  const typeOrder = ['summary', 'strength', 'critique', 'question', 'suggestion', 'related_work', 'follow_up'];
  const grouped = {};
  for (const note of notes) {
    const t = note.comment_type || 'summary';
    if (!grouped[t]) grouped[t] = [];
    grouped[t].push(note);
  }
  const groups = typeOrder
    .filter(t => grouped[t])
    .map(t => ({ title: formatType(t), notes: grouped[t] }));
  renderGroupedNotes(groups, container);
}

function renderGroupedNotes(groups, container) {
  if (!groups || groups.length === 0) {
    container.innerHTML = '<p class="empty-state">No annotations to organize.</p>';
    return;
  }

  container.innerHTML = groups.map(group => `
    <div class="note-group">
      <h3 class="group-title">${escapeHtml(group.title)}</h3>
      ${group.notes.map(note => `
        <div class="note-card" data-id="${note.id}">
          <div class="note-meta">
            <span class="note-type-badge note-type-${note.comment_type}">${formatType(note.comment_type)}</span>
            <span class="note-page">${note.page_number ? 'Page ' + note.page_number : 'Page ?'}</span>
          </div>
          <blockquote class="note-highlight">${escapeHtml(note.selected_text)}</blockquote>
          <div class="note-comment">${escapeHtml(note.cleaned_comment)}</div>
        </div>
      `).join('')}
    </div>
  `).join('');
}

async function exportMarkdown() {
  if (!currentPdfId) return;

  try {
    const markdown = await api.exportMarkdown(currentPdfId);
    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'annotations.md';
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert('Failed to export. Is the backend running?');
    console.error('Export error:', err);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatType(type) {
  const labels = {
    summary: 'Summary',
    critique: 'Critique',
    strength: 'Strength',
    question: 'Question',
    related_work: 'Related Work',
    suggestion: 'Suggestion',
    follow_up: 'Follow-up',
  };
  return labels[type] || type;
}

function formatTime(isoStr) {
  return new Date(isoStr).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

init();
