// PDF Converser - Sidebar Panel

const api = new ApiClient();
let currentPdfId = null;
let currentTab = 'notes';

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

  // Listen for new notes, Q&A answers, tab switches, and scroll-to-note requests
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'noteCreated' && msg.pdfIdentifier === currentPdfId) {
      if (currentTab === 'notes') loadNotes();
    }
    if (msg.action === 'questionAnswered' && msg.pdfIdentifier === currentPdfId) {
      if (currentTab === 'questions') loadQuestions();
    }
    if (msg.action === 'scrollToNote') {
      scrollToAndFlashNote(msg.noteId);
    }
    if (msg.action === 'tabChanged') {
      const newId = msg.pdfIdentifier;
      if (newId && newId !== currentPdfId) {
        currentPdfId = newId;
        document.getElementById('pdf-title').textContent = msg.pdfTitle || 'Untitled PDF';
        document.getElementById('view-mode').value = 'chronological';
        document.getElementById('questions-sort').value = 'date';
        if (currentTab === 'notes') loadNotes();
        else loadQuestions();
      } else if (!newId) {
        currentPdfId = null;
        document.getElementById('pdf-title').textContent = 'No PDF open';
        document.getElementById('notes-container').innerHTML =
          '<p class="empty-state">Open a PDF to see annotations.</p>';
        document.getElementById('questions-container').innerHTML =
          '<p class="empty-state">Open a PDF to see questions.</p>';
      }
    }
  });

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // View mode switching (notes)
  document.getElementById('view-mode').addEventListener('change', (e) => {
    loadNotes(e.target.value);
  });

  // Sort switching (questions)
  document.getElementById('questions-sort').addEventListener('change', (e) => {
    loadQuestions(e.target.value);
  });

  // Export button
  document.getElementById('export-btn').addEventListener('click', exportMarkdown);
}

function switchTab(tab) {
  currentTab = tab;

  // Update active tab button
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  // Show/hide toolbars and containers
  const notesToolbar = document.getElementById('notes-toolbar');
  const questionsToolbar = document.getElementById('questions-toolbar');
  const notesContainer = document.getElementById('notes-container');
  const questionsContainer = document.getElementById('questions-container');

  if (tab === 'notes') {
    notesToolbar.style.display = 'flex';
    questionsToolbar.style.display = 'none';
    notesContainer.style.display = '';
    questionsContainer.style.display = 'none';
    loadNotes();
  } else {
    notesToolbar.style.display = 'none';
    questionsToolbar.style.display = 'flex';
    notesContainer.style.display = 'none';
    questionsContainer.style.display = '';
    loadQuestions();
  }
}

async function loadNotes(viewMode = null) {
  if (!currentPdfId) return;
  viewMode = viewMode || document.getElementById('view-mode').value;

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

async function loadQuestions(sortMode = null) {
  if (!currentPdfId) return;
  sortMode = sortMode || document.getElementById('questions-sort').value;

  const container = document.getElementById('questions-container');
  const loading = document.getElementById('loading');
  loading.style.display = 'flex';

  try {
    const data = await api.getQuestions(currentPdfId);
    let entries = data.entries || [];

    // Sort client-side
    if (sortMode === 'page') {
      entries.sort((a, b) => (a.page_number || 0) - (b.page_number || 0) || a.created_at.localeCompare(b.created_at));
    } else {
      // 'date' — newest first
      entries.sort((a, b) => b.created_at.localeCompare(a.created_at));
    }

    renderQuestionsList(entries, container);
  } catch (err) {
    container.innerHTML = `<p class="error-state">Failed to load questions. Is the backend running?</p>`;
    console.error('PDF Converser sidebar error:', err);
  } finally {
    loading.style.display = 'none';
  }
}

function renderQuestionsList(entries, container) {
  if (!entries || entries.length === 0) {
    container.innerHTML = '<p class="empty-state">No questions yet. Highlight text and click Ask to get started.</p>';
    return;
  }

  container.innerHTML = entries.map(entry => `
    <div class="qa-card" data-id="${entry.id}" data-page="${entry.page_number || 0}">
      <div class="qa-meta">
        <span class="qa-page">${entry.page_number ? 'Page ' + entry.page_number : ''}</span>
        <span class="qa-time">${formatTime(entry.created_at)}</span>
      </div>
      <div class="qa-question">${escapeHtml(entry.question)}</div>
      <div class="qa-answer">${escapeHtml(entry.answer)}</div>
      ${entry.selected_text ? '<blockquote class="qa-context">' + escapeHtml(entry.selected_text) + '</blockquote>' : ''}
      <div class="qa-actions">
        <button class="qa-delete" data-id="${entry.id}" title="Delete this question">Delete</button>
      </div>
    </div>
  `).join('');

  // Delete handlers
  container.querySelectorAll('.qa-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm('Delete this question?')) {
        await api.deleteQuestion(btn.dataset.id, currentPdfId);
        loadQuestions();
      }
    });
  });

  // Card click — scroll PDF to that page
  container.querySelectorAll('.qa-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.qa-actions')) return;
      const pageNumber = parseInt(card.dataset.page, 10) || 0;
      if (pageNumber > 0) {
        chrome.runtime.sendMessage({
          action: 'scrollToHighlight',
          noteId: null,
          pageNumber,
        }).catch(() => {});
      }
    });
  });
}

function renderNotesList(notes, container) {
  if (!notes || notes.length === 0) {
    container.innerHTML = '<p class="empty-state">No annotations yet. Highlight text in the PDF and click the microphone button to begin.</p>';
    return;
  }

  container.innerHTML = notes.map(note => renderNoteCard(note)).join('');

  attachNoteActionHandlers(container);
  attachNoteCardClickHandlers(container);
}

// Renders a single note card. Used by the chronological list, the grouped
// views, and the by-type view (where one note may appear under multiple tag
// groups).
function renderNoteCard(note, { withActions = true } = {}) {
  const tags = (Array.isArray(note.comment_tags) && note.comment_tags.length > 0)
    ? note.comment_tags
    : [note.comment_type || 'summary'];
  const badges = tags
    .map(t => `<span class="note-type-badge note-type-${escapeAttr(t)}">${formatType(t)}</span>`)
    .join(' ');
  const sectionPill = note.section
    ? `<span class="note-section-pill">${escapeHtml(formatSection(note.section))}</span>`
    : '';
  const swatchStyle = note.color_override
    ? `style="background:${escapeAttr(note.color_override)}"`
    : '';
  const actions = withActions ? `
      <div class="note-actions">
        <button class="note-color" data-id="${note.id}" ${swatchStyle} title="Change highlight color">●</button>
        <button class="note-reclean" data-id="${note.id}" title="Re-clean with LLM">Re-clean</button>
        <button class="note-delete" data-id="${note.id}" title="Delete this note">Delete</button>
      </div>` : '';
  const raw = withActions ? `
      <details class="note-raw">
        <summary>Raw transcript</summary>
        <p>${escapeHtml(note.raw_transcript)}</p>
      </details>` : '';
  return `
    <div class="note-card" data-id="${note.id}">
      <div class="note-meta">
        ${badges}
        ${sectionPill}
        <span class="note-page">${note.page_number ? 'Page ' + note.page_number : 'Page ?'}</span>
        <span class="note-time">${formatTime(note.created_at)}</span>
      </div>
      <blockquote class="note-highlight">${escapeHtml(note.selected_text)}</blockquote>
      <div class="note-comment">${escapeHtml(note.cleaned_comment)}</div>${raw}${actions}
    </div>
  `;
}

function attachNoteActionHandlers(container) {
  container.querySelectorAll('.note-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm('Delete this annotation?')) {
        await api.deleteNote(btn.dataset.id, currentPdfId);
        loadNotes(document.getElementById('view-mode').value);
      }
    });
  });

  container.querySelectorAll('.note-reclean').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      btn.textContent = 'Cleaning...';
      btn.disabled = true;
      try {
        await api.recleanNote(btn.dataset.id, currentPdfId);
        loadNotes(document.getElementById('view-mode').value);
      } catch (err) {
        btn.textContent = 'Re-clean';
        btn.disabled = false;
        alert('Failed to re-clean note.');
      }
    });
  });

  container.querySelectorAll('.note-color').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openColorPicker(btn);
    });
  });
}

// Inline picker that anchors itself under the swatch button. Sends the
// selected color (or null = reset to type-derived) to the server, then
// reloads the notes list and asks the PDF pane to refresh highlights.
function openColorPicker(anchorBtn) {
  // Close any existing picker first.
  document.querySelectorAll('.note-color-picker').forEach(p => p.remove());

  const palette = [
    { hex: '#ffee58', label: 'Yellow' },
    { hex: '#42a5f5', label: 'Blue' },
    { hex: '#ef5350', label: 'Red' },
    { hex: '#66bb6a', label: 'Green' },
    { hex: '#ffa726', label: 'Orange' },
    { hex: '#ab47bc', label: 'Purple' },
    { hex: '#26a69a', label: 'Teal' },
  ];
  const picker = document.createElement('div');
  picker.className = 'note-color-picker';
  picker.innerHTML = palette.map(p =>
    `<button class="note-color-swatch" data-color="${p.hex}" title="${p.label}" style="background:${p.hex}"></button>`
  ).join('') + `<button class="note-color-reset" data-color="" title="Reset to default">Reset</button>`;
  document.body.appendChild(picker);

  const rect = anchorBtn.getBoundingClientRect();
  picker.style.left = `${rect.left}px`;
  picker.style.top = `${rect.bottom + 4}px`;

  const onPick = async (e) => {
    const target = e.target.closest('[data-color]');
    if (!target) return;
    const color = target.dataset.color || null;
    picker.remove();
    document.removeEventListener('mousedown', onOutside, true);
    try {
      await api.updateNote(anchorBtn.dataset.id, currentPdfId, { color_override: color });
      loadNotes(document.getElementById('view-mode').value);
      chrome.runtime.sendMessage({
        action: 'notesChanged',
        pdfIdentifier: currentPdfId,
      }).catch(() => {});
    } catch (err) {
      alert('Failed to update color.');
    }
  };
  picker.addEventListener('click', onPick);

  const onOutside = (e) => {
    if (!picker.contains(e.target) && e.target !== anchorBtn) {
      picker.remove();
      document.removeEventListener('mousedown', onOutside, true);
    }
  };
  // Defer attaching the outside-click guard until after this click bubbles.
  setTimeout(() => document.addEventListener('mousedown', onOutside, true), 0);
}

function renderNotesByType(notes, container) {
  if (!notes || notes.length === 0) {
    container.innerHTML = '<p class="empty-state">No annotations to organize.</p>';
    return;
  }
  // Multi-tag dispatch: a note appears under each of its tags' groups, since
  // the whole point of multi-tag classification is that a comment can span
  // categories.
  const typeOrder = ['summary', 'strength', 'critique', 'question', 'suggestion', 'related_work', 'follow_up'];
  const grouped = {};
  for (const note of notes) {
    const tags = (Array.isArray(note.comment_tags) && note.comment_tags.length > 0)
      ? note.comment_tags
      : [note.comment_type || 'summary'];
    for (const t of tags) {
      if (!grouped[t]) grouped[t] = [];
      grouped[t].push(note);
    }
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
      ${group.notes.map(note => renderNoteCard(note, { withActions: false })).join('')}
    </div>
  `).join('');

  attachNoteCardClickHandlers(container);
}

function scrollToAndFlashNote(noteId) {
  const card = document.querySelector(`.note-card[data-id="${noteId}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.add('note-flash');
  card.addEventListener('animationend', () => card.classList.remove('note-flash'), { once: true });
}

function attachNoteCardClickHandlers(container) {
  container.querySelectorAll('.note-card').forEach(card => {
    card.addEventListener('click', (e) => {
      // Don't trigger on button clicks or details toggle
      if (e.target.closest('.note-actions') || e.target.closest('.note-raw')) return;
      const noteId = card.dataset.id;
      const pageSpan = card.querySelector('.note-page');
      const pageMatch = pageSpan?.textContent?.match(/\d+/);
      const pageNumber = pageMatch ? parseInt(pageMatch[0], 10) : 0;
      chrome.runtime.sendMessage({
        action: 'scrollToHighlight',
        noteId,
        pageNumber,
      }).catch(() => {});
    });
  });
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

function formatSection(section) {
  const labels = {
    abstract: 'Abstract',
    introduction: 'Introduction',
    background: 'Background',
    related_work_section: 'Related Work',
    methods: 'Methods',
    results: 'Results',
    discussion: 'Discussion',
    conclusion: 'Conclusion',
    references: 'References',
  };
  return labels[section] || section;
}

// HTML attribute escape — same idea as escapeHtml but for inline attrs where
// quotes would break out of the attribute value.
function escapeAttr(str) {
  return String(str ?? '').replace(/[&"<>]/g, (c) =>
    ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]
  );
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
