// PDF Converser - Sidebar Panel

const api = new ApiClient();
let currentPdfId = null;
let currentTab = 'notes';
let rubricTemplates = []; // cached saved rubric templates (dropdown + dup-name check)

// True while an inline note editor (the comment textarea) is open. While set,
// loadNotes() defers its destructive `container.innerHTML` re-render so a note
// created/changed in the background (e.g. a voice annotation finishing its
// async pipeline) can't wipe the textarea the user is typing in. The deferred
// reload is replayed when the editor closes.
let noteEditorOpen = false;
let pendingNotesViewMode; // undefined = no reload pending

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
      // The visible pdf-title element was removed from the side panel; the
      // window title still reflects the PDF name. Keep a null-safe update
      // so any future reintroduction of the element just works.
      const titleEl = document.getElementById('pdf-title');
      if (titleEl) titleEl.textContent = response.pdfTitle || 'Untitled PDF';
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
        const titleEl = document.getElementById('pdf-title');
        if (titleEl) titleEl.textContent = msg.pdfTitle || 'Untitled PDF';
        document.getElementById('view-mode').value = 'chronological';
        document.getElementById('questions-sort').value = 'date';
        if (currentTab === 'notes') loadNotes();
        else if (currentTab === 'questions') loadQuestions();
        else if (currentTab === 'references') loadReferences();
        else if (currentTab === 'rubric') loadRubric();
        else if (currentTab === 'review' && !reviewGenerating) loadReview();
      } else if (!newId) {
        currentPdfId = null;
        const titleEl = document.getElementById('pdf-title');
        if (titleEl) titleEl.textContent = 'No PDF open';
        document.getElementById('notes-container').innerHTML =
          '<p class="empty-state">Open a PDF to see annotations.</p>';
        document.getElementById('questions-container').innerHTML =
          '<p class="empty-state">Open a PDF to see questions.</p>';
        document.getElementById('references-container').innerHTML =
          '<p class="empty-state">Open a PDF to manage references.</p>';
        document.getElementById('rubric-container').innerHTML =
          '<p class="empty-state">Open a PDF to manage rubric sections.</p>';
        document.getElementById('review-container').innerHTML =
          '<p class="empty-state">Open a PDF to generate a review.</p>';
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
  document.getElementById('export-json-btn').addEventListener('click', exportJson);

  // Check Review button — opens a modal that compares notes against a
  // pasted conference rubric. The last rubric + result is persisted per
  // PDF, so reopening shows the previous state and a Re-check button.
  document.getElementById('check-review-btn').addEventListener('click', openReviewCheckModal);

  // Generate Review button (in the Review tab) — streams a full review inline,
  // then prompts for a file to save it to. Drafts from notes, rubric, and
  // manuscript text using the model/instructions from the Review tab of Settings.
  document.getElementById('generate-review-btn').addEventListener('click', runGenerateReview);

  // Add Reference button — appends an empty row that the user fills in.
  document.getElementById('add-reference-btn').addEventListener('click', () => {
    addBlankReference();
  });

  // Add Rubric section button — appends an empty row that the user fills in.
  document.getElementById('add-rubric-btn').addEventListener('click', () => {
    addBlankRubricItem();
  });

  // Paste Rubric Text button — opens a modal that takes free-form rubric
  // text and asks the LLM to extract structured section/description pairs.
  document.getElementById('paste-rubric-btn').addEventListener('click', openPasteRubricModal);

  // Saved rubric templates: load one from the dropdown, or save the current one.
  document.getElementById('rubric-template-select').addEventListener('change', onRubricTemplateSelected);
  document.getElementById('save-rubric-btn').addEventListener('click', saveRubricAsTemplate);
  populateRubricTemplates();
}

function switchTab(tab) {
  currentTab = tab;

  // Update active tab button
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  // Reset the scroll area when switching tabs — otherwise a tall scrolled
  // notes list followed by a short (empty) refs tab leaves the viewport
  // scrolled down, making the empty-state text look like it's floating in
  // the middle of the sidebar.
  const scrollArea = document.querySelector('#sidebar-pane .sidebar-content');
  if (scrollArea) scrollArea.scrollTop = 0;

  const notesToolbar = document.getElementById('notes-toolbar');
  const questionsToolbar = document.getElementById('questions-toolbar');
  const referencesToolbar = document.getElementById('references-toolbar');
  const rubricToolbar = document.getElementById('rubric-toolbar');
  const notesContainer = document.getElementById('notes-container');
  const questionsContainer = document.getElementById('questions-container');
  const referencesContainer = document.getElementById('references-container');
  const rubricContainer = document.getElementById('rubric-container');
  const reviewToolbar = document.getElementById('review-toolbar');
  const reviewContainer = document.getElementById('review-container');

  notesToolbar.style.display = 'none';
  questionsToolbar.style.display = 'none';
  referencesToolbar.style.display = 'none';
  rubricToolbar.style.display = 'none';
  reviewToolbar.style.display = 'none';
  notesContainer.style.display = 'none';
  questionsContainer.style.display = 'none';
  referencesContainer.style.display = 'none';
  rubricContainer.style.display = 'none';
  reviewContainer.style.display = 'none';

  if (tab === 'notes') {
    notesToolbar.style.display = 'flex';
    notesContainer.style.display = '';
    loadNotes();
  } else if (tab === 'questions') {
    questionsToolbar.style.display = 'flex';
    questionsContainer.style.display = '';
    loadQuestions();
  } else if (tab === 'references') {
    referencesToolbar.style.display = 'flex';
    referencesContainer.style.display = '';
    loadReferences();
  } else if (tab === 'rubric') {
    rubricToolbar.style.display = 'flex';
    rubricContainer.style.display = '';
    loadRubric();
  } else if (tab === 'review') {
    reviewToolbar.style.display = 'flex';
    reviewContainer.style.display = '';
    // Don't reload over a live generation — it would clobber the stream.
    if (!reviewGenerating) loadReview();
  }
}

async function loadNotes(viewMode = null) {
  if (!currentPdfId) return;
  // An inline editor is open — don't blow it away. Queue the reload (keeping
  // the most recent requested view mode) and replay it when editing ends.
  if (noteEditorOpen) {
    pendingNotesViewMode = viewMode;
    return;
  }
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

// ─── References ───────────────────────────────────────────────────────────
//
// A small per-PDF library of citations the user wants the cleanup LLM to
// recognize. Each card is rendered as inline inputs so the user can edit
// authors/title/link in place — saves are debounced via blur.

async function loadReferences() {
  if (!currentPdfId) return;
  const container = document.getElementById('references-container');
  const loading = document.getElementById('loading');
  loading.style.display = 'flex';
  try {
    const data = await api.listReferences(currentPdfId);
    renderReferencesList(data.references || [], container);
  } catch (err) {
    container.innerHTML = `<p class="error-state">Failed to load references. Is the backend running?</p>`;
    console.error('PDF Converser sidebar error:', err);
  } finally {
    loading.style.display = 'none';
  }
}

function renderReferencesList(refs, container) {
  if (!refs || refs.length === 0) {
    container.innerHTML =
      '<p class="empty-state">No references yet. Add a reference and the LLM will use it when cleaning notes that mention the work.</p>';
    return;
  }
  container.innerHTML = refs.map(renderReferenceCard).join('');
  attachReferenceHandlers(container);
}

function renderReferenceCard(ref) {
  return `
    <div class="ref-card" data-id="${escapeAttr(ref.id)}">
      <div class="ref-row">
        <label class="ref-label">Authors</label>
        <input class="ref-input" data-field="authors" type="text" value="${escapeAttr(ref.authors || '')}" placeholder="e.g. Gottsacker et al.">
      </div>
      <div class="ref-row">
        <label class="ref-label">Title</label>
        <input class="ref-input" data-field="title" type="text" value="${escapeAttr(ref.title || '')}" placeholder="Paper title">
      </div>
      <div class="ref-row">
        <label class="ref-label">Link</label>
        <input class="ref-input" data-field="link" type="text" value="${escapeAttr(ref.link || '')}" placeholder="https://...">
      </div>
      <div class="ref-actions">
        ${ref.link ? `<button class="ref-open" data-link="${escapeAttr(ref.link)}" title="Open link">Open</button>` : ''}
        <button class="ref-delete" title="Delete this reference">Delete</button>
      </div>
    </div>
  `;
}

function attachReferenceHandlers(container) {
  container.querySelectorAll('.ref-card').forEach((card) => {
    const refId = card.dataset.id;

    card.querySelectorAll('.ref-input').forEach((input) => {
      const originalAttr = input.getAttribute('value') || '';
      input.addEventListener('blur', async () => {
        const value = input.value;
        if (value === originalAttr) return;
        try {
          await api.updateReference(refId, currentPdfId, { [input.dataset.field]: value });
          input.setAttribute('value', value);
          // If link changed, toggle the Open button visibility.
          if (input.dataset.field === 'link') refreshOpenButton(card, value);
        } catch (err) {
          alert('Failed to save reference.');
          console.error('Reference save error:', err);
        }
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          input.blur();
        }
      });
    });

    const openBtn = card.querySelector('.ref-open');
    if (openBtn) {
      openBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const link = openBtn.dataset.link;
        if (link && window.desktop?.openExternal) window.desktop.openExternal(link);
      });
    }

    card.querySelector('.ref-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Delete this reference?')) return;
      try {
        await api.deleteReference(refId, currentPdfId);
        loadReferences();
      } catch (err) {
        alert('Failed to delete reference.');
        console.error('Reference delete error:', err);
      }
    });
  });
}

function refreshOpenButton(card, linkValue) {
  const actions = card.querySelector('.ref-actions');
  let openBtn = card.querySelector('.ref-open');
  if (linkValue) {
    if (!openBtn) {
      openBtn = document.createElement('button');
      openBtn.className = 'ref-open';
      openBtn.title = 'Open link';
      openBtn.textContent = 'Open';
      actions.insertBefore(openBtn, actions.firstChild);
      openBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const l = openBtn.dataset.link;
        if (l && window.desktop?.openExternal) window.desktop.openExternal(l);
      });
    }
    openBtn.dataset.link = linkValue;
  } else if (openBtn) {
    openBtn.remove();
  }
}

async function addBlankReference() {
  if (!currentPdfId) {
    alert('Open a PDF first.');
    return;
  }
  try {
    await api.createReference(currentPdfId, { authors: '', title: '', link: '' });
    await loadReferences();
    // Focus the first input of the newest card so the user can type.
    const container = document.getElementById('references-container');
    const cards = container.querySelectorAll('.ref-card');
    const last = cards[cards.length - 1];
    if (last) {
      last.scrollIntoView({ block: 'nearest' });
      const firstInput = last.querySelector('.ref-input');
      if (firstInput) firstInput.focus();
    }
  } catch (err) {
    alert('Failed to add reference.');
    console.error('Reference add error:', err);
  }
}

// ─── Rubric ───────────────────────────────────────────────────────────────
//
// A per-PDF list of sections the review should cover. Each item is a
// short section name plus a description of what belongs in that section.
// Saved alongside references in the JSON export.

async function loadRubric() {
  if (!currentPdfId) return;
  const container = document.getElementById('rubric-container');
  const loading = document.getElementById('loading');
  loading.style.display = 'flex';
  try {
    const data = await api.listRubric(currentPdfId);
    renderRubricList(data.items || [], container);
  } catch (err) {
    container.innerHTML = `<p class="error-state">Failed to load rubric. Is the backend running?</p>`;
    console.error('PDF Converser sidebar error:', err);
  } finally {
    loading.style.display = 'none';
  }
}

function renderRubricList(items, container) {
  if (!items || items.length === 0) {
    container.innerHTML =
      '<p class="empty-state">No rubric sections yet. Add a section the review should cover (e.g. Novelty, Soundness, Clarity).</p>';
    return;
  }
  container.innerHTML = items.map(renderRubricCard).join('');
  attachRubricHandlers(container);
}

function renderRubricCard(item) {
  return `
    <div class="rubric-card" data-id="${escapeAttr(item.id)}">
      <div class="rubric-row">
        <label class="rubric-label">Section</label>
        <input class="rubric-input" data-field="section" type="text" value="${escapeAttr(item.section || '')}" placeholder="e.g. Novelty">
      </div>
      <div class="rubric-row">
        <label class="rubric-label">Description</label>
        <textarea class="rubric-input rubric-textarea" data-field="description" placeholder="What this section should address">${escapeHtml(item.description || '')}</textarea>
      </div>
      <div class="rubric-actions">
        <button class="rubric-delete" title="Delete this rubric section">Delete</button>
      </div>
    </div>
  `;
}

function attachRubricHandlers(container) {
  container.querySelectorAll('.rubric-card').forEach((card) => {
    const itemId = card.dataset.id;

    card.querySelectorAll('.rubric-input').forEach((input) => {
      const isTextarea = input.tagName === 'TEXTAREA';
      const originalAttr = isTextarea ? (input.textContent || '') : (input.getAttribute('value') || '');
      input.addEventListener('blur', async () => {
        const value = input.value;
        if (value === originalAttr) return;
        try {
          await api.updateRubricItem(itemId, currentPdfId, { [input.dataset.field]: value });
          if (isTextarea) input.textContent = value;
          else input.setAttribute('value', value);
        } catch (err) {
          alert('Failed to save rubric section.');
          console.error('Rubric save error:', err);
        }
      });
      input.addEventListener('keydown', (e) => {
        // Enter saves on single-line inputs; textarea keeps Enter for newlines
        // and uses Ctrl/Cmd+Enter to save.
        if (e.key === 'Enter' && (!isTextarea || e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          input.blur();
        }
      });
    });

    card.querySelector('.rubric-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Delete this rubric section?')) return;
      try {
        await api.deleteRubricItem(itemId, currentPdfId);
        loadRubric();
      } catch (err) {
        alert('Failed to delete rubric section.');
        console.error('Rubric delete error:', err);
      }
    });
  });
}

async function addBlankRubricItem() {
  if (!currentPdfId) {
    alert('Open a PDF first.');
    return;
  }
  try {
    await api.createRubricItem(currentPdfId, { section: '', description: '' });
    await loadRubric();
    const container = document.getElementById('rubric-container');
    const cards = container.querySelectorAll('.rubric-card');
    const last = cards[cards.length - 1];
    if (last) {
      last.scrollIntoView({ block: 'nearest' });
      const firstInput = last.querySelector('.rubric-input');
      if (firstInput) firstInput.focus();
    }
  } catch (err) {
    alert('Failed to add rubric section.');
    console.error('Rubric add error:', err);
  }
}

// ─── Saved rubric templates ───────────────────────────────────────────────
//
// Save the current paper's rubric under a name (e.g. a conference) and reload
// it into any paper from the dropdown, skipping the paste / LLM-extract step.

// Read the rubric currently shown in the tab (including unsaved edits still in
// the inputs) as plain {section, description} pairs.
function currentRubricItemsFromDom() {
  const items = [];
  document.querySelectorAll('#rubric-container .rubric-card').forEach((card) => {
    const section = (card.querySelector('[data-field="section"]')?.value || '').trim();
    const description = (card.querySelector('[data-field="description"]')?.value || '').trim();
    if (section || description) items.push({ section, description });
  });
  return items;
}

async function populateRubricTemplates() {
  const select = document.getElementById('rubric-template-select');
  if (!select) return;
  try {
    rubricTemplates = (await api.listRubricTemplates()).templates || [];
  } catch (err) {
    rubricTemplates = [];
    console.error('Failed to load rubric templates:', err);
  }
  const options = rubricTemplates.map((t) => {
    const label = t.item_count ? `${t.name} (${t.item_count})` : t.name;
    return `<option value="${escapeAttr(t.id)}">${escapeHtml(label)}</option>`;
  });
  select.innerHTML = '<option value="">Load saved rubric…</option>' + options.join('');
}

// Apply the picked template to the current paper (replaces its rubric), then
// reset the dropdown back to its placeholder.
async function onRubricTemplateSelected(e) {
  const select = e.target;
  const id = select.value;
  if (!id) return;
  if (!currentPdfId) {
    alert('Open a PDF first.');
    select.value = '';
    return;
  }
  const tpl = rubricTemplates.find((t) => t.id === id);
  const name = tpl ? tpl.name : 'the saved rubric';
  const current = currentRubricItemsFromDom();
  if (current.length > 0
      && !confirm(`Replace the current ${current.length} rubric section(s) with "${name}"?`)) {
    select.value = '';
    return;
  }
  try {
    await api.applyRubricTemplate(currentPdfId, id);
    await loadRubric();
  } catch (err) {
    alert('Failed to load the saved rubric.');
    console.error('Apply rubric template error:', err);
  } finally {
    select.value = '';
  }
}

// Electron's renderer has no window.prompt(), so collect the name with a small
// modal (reusing the shared .review-modal-* styling). Resolves the trimmed name
// or null if cancelled.
function promptRubricName() {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'review-modal-backdrop';
    backdrop.innerHTML = `
      <div class="review-modal" role="dialog" aria-label="Save rubric">
        <div class="review-modal-header">
          <span>Save rubric</span>
          <button class="review-modal-close" title="Close" aria-label="Close">&times;</button>
        </div>
        <div class="review-modal-body">
          <p class="review-modal-hint">Save the current rubric under a name (e.g. the conference) so you can load it into other papers.</p>
          <input type="text" class="rubric-name-input" placeholder="e.g. CHI 2026">
        </div>
        <div class="review-modal-footer">
          <button class="toolbar-btn review-cancel">Cancel</button>
          <button class="toolbar-btn review-primary" disabled>Save</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);

    const input = backdrop.querySelector('.rubric-name-input');
    const saveBtn = backdrop.querySelector('.review-primary');
    let escHandler;
    const done = (value) => {
      backdrop.remove();
      if (escHandler) document.removeEventListener('keydown', escHandler);
      resolve(value);
    };

    const sync = () => { saveBtn.disabled = input.value.trim().length === 0; };
    sync();
    const submit = () => { const v = input.value.trim(); if (v) done(v); };

    input.addEventListener('input', sync);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    saveBtn.addEventListener('click', submit);
    backdrop.querySelector('.review-cancel').addEventListener('click', () => done(null));
    backdrop.querySelector('.review-modal-close').addEventListener('click', () => done(null));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) done(null); });
    escHandler = (e) => { if (e.key === 'Escape') done(null); };
    document.addEventListener('keydown', escHandler);

    input.focus();
  });
}

async function saveRubricAsTemplate() {
  if (!currentPdfId) {
    alert('Open a PDF first.');
    return;
  }
  const items = currentRubricItemsFromDom();
  if (items.length === 0) {
    alert('Add at least one rubric section before saving.');
    return;
  }
  const name = await promptRubricName();
  if (!name) return;
  const existing = rubricTemplates.find((t) => (t.name || '').toLowerCase() === name.toLowerCase());
  if (existing && !confirm(`A saved rubric named "${existing.name}" already exists. Overwrite it?`)) return;
  try {
    await api.saveRubricTemplate(name, items);
    await populateRubricTemplates();
  } catch (err) {
    alert('Failed to save the rubric.');
    console.error('Save rubric template error:', err);
  }
}

// ─── Paste Rubric Text modal ──────────────────────────────────────────────
//
// Free-form rubric text → LLM → structured section/description pairs that
// get appended to the rubric store. Re-uses the .review-modal-* styles
// because the layout is identical (header + scrollable body + footer).

let pasteRubricModalEl = null;
let pasteRubricEscHandler = null;

function closePasteRubricModal() {
  if (pasteRubricModalEl) {
    pasteRubricModalEl.remove();
    pasteRubricModalEl = null;
  }
  if (pasteRubricEscHandler) {
    document.removeEventListener('keydown', pasteRubricEscHandler);
    pasteRubricEscHandler = null;
  }
}

function openPasteRubricModal() {
  if (!currentPdfId) {
    alert('Open a PDF first.');
    return;
  }
  if (pasteRubricModalEl) return;

  pasteRubricModalEl = document.createElement('div');
  pasteRubricModalEl.className = 'review-modal-backdrop';
  pasteRubricModalEl.innerHTML = `
    <div class="review-modal" role="dialog" aria-label="Paste Rubric Text">
      <div class="review-modal-header">
        <span>Paste Rubric Text</span>
        <button class="review-modal-close" title="Close" aria-label="Close">×</button>
      </div>
      <div class="review-modal-body">
        <p class="review-modal-hint">Paste the rubric text below. The LLM will extract distinct sections and short descriptions, and append them to your rubric tab. You can edit each item afterward.</p>
        <textarea class="review-rubric-input" placeholder="Paste rubric / reviewing guidelines here..."></textarea>
      </div>
      <div class="review-modal-footer">
        <button class="toolbar-btn paste-rubric-cancel">Cancel</button>
        <button class="toolbar-btn review-primary paste-rubric-parse" disabled>Extract Sections</button>
      </div>
    </div>
  `;
  document.body.appendChild(pasteRubricModalEl);

  pasteRubricModalEl.querySelector('.review-modal-close').addEventListener('click', closePasteRubricModal);
  pasteRubricModalEl.addEventListener('click', (e) => {
    if (e.target === pasteRubricModalEl) closePasteRubricModal();
  });
  pasteRubricEscHandler = (e) => { if (e.key === 'Escape') closePasteRubricModal(); };
  document.addEventListener('keydown', pasteRubricEscHandler);

  const textarea = pasteRubricModalEl.querySelector('.review-rubric-input');
  const parseBtn = pasteRubricModalEl.querySelector('.paste-rubric-parse');
  textarea.focus();
  textarea.addEventListener('input', () => {
    parseBtn.disabled = textarea.value.trim().length === 0;
  });
  pasteRubricModalEl.querySelector('.paste-rubric-cancel').addEventListener('click', closePasteRubricModal);
  parseBtn.addEventListener('click', () => runPasteRubricParse(textarea.value.trim()));
}

async function runPasteRubricParse(rubricText) {
  if (!pasteRubricModalEl) return;
  if (!rubricText) return;

  const body = pasteRubricModalEl.querySelector('.review-modal-body');
  const footer = pasteRubricModalEl.querySelector('.review-modal-footer');
  const prevBody = body.innerHTML;
  const prevFooter = footer.innerHTML;

  body.innerHTML = `
    <div class="loading" style="padding: 32px;">
      <div class="spinner"></div>
      <span>Extracting rubric sections...</span>
    </div>
  `;
  footer.innerHTML = '';

  try {
    const result = await api.parseRubricText(currentPdfId, rubricText);
    const items = Array.isArray(result?.items) ? result.items : [];
    if (items.length === 0) {
      // Restore the input view with an error message so the user can edit
      // and retry without losing what they pasted.
      body.innerHTML = `
        <div class="review-error">The LLM couldn't extract any sections from that text${result?.parse_error ? ' (response was not valid JSON)' : ''}. Try pasting more detail or rephrasing, then extract again.</div>
        <p class="review-modal-hint">Paste the rubric text below.</p>
        <textarea class="review-rubric-input" placeholder="Paste rubric / reviewing guidelines here...">${escapeHtml(rubricText)}</textarea>
      `;
      footer.innerHTML = `
        <button class="toolbar-btn paste-rubric-cancel">Close</button>
        <button class="toolbar-btn review-primary paste-rubric-parse">Extract Sections</button>
      `;
      const ta = body.querySelector('.review-rubric-input');
      ta.focus();
      footer.querySelector('.paste-rubric-cancel').addEventListener('click', closePasteRubricModal);
      footer.querySelector('.paste-rubric-parse').addEventListener('click', () => runPasteRubricParse(ta.value.trim()));
      return;
    }
    await loadRubric();
    closePasteRubricModal();
  } catch (err) {
    const msg = String(err?.message || err);
    const friendly = /not configured/i.test(msg)
      ? 'No LLM is configured. Open Settings and add an API key for OpenAI, Anthropic, Ollama, or an OpenAI-compatible endpoint.'
      : `Extraction failed: ${msg}`;
    body.innerHTML = `
      <div class="review-error">${escapeHtml(friendly)}</div>
      <p class="review-modal-hint">Paste the rubric text below.</p>
      <textarea class="review-rubric-input">${escapeHtml(rubricText)}</textarea>
    `;
    footer.innerHTML = `
      <button class="toolbar-btn paste-rubric-cancel">Close</button>
      <button class="toolbar-btn review-primary paste-rubric-parse">Try again</button>
    `;
    const ta = body.querySelector('.review-rubric-input');
    footer.querySelector('.paste-rubric-cancel').addEventListener('click', closePasteRubricModal);
    footer.querySelector('.paste-rubric-parse').addEventListener('click', () => runPasteRubricParse(ta.value.trim()));
    // Reference prev* so we don't trip the linter; if the user closes mid-flight
    // we never need to restore the original input, but keep them for clarity.
    void prevBody; void prevFooter;
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
    .map(t => {
      const removeBtn = withActions
        ? `<button class="note-tag-remove" data-id="${note.id}" data-tag="${escapeAttr(t)}" title="Remove this tag" aria-label="Remove ${escapeAttr(t)} tag">×</button>`
        : '';
      return `<span class="note-type-badge note-type-${escapeAttr(t)}">${formatType(t)}${removeBtn}</span>`;
    })
    .join(' ');
  const addTagBtn = withActions
    ? `<button class="note-tag-add" data-id="${note.id}" title="Add another tag" aria-label="Add tag">+</button>`
    : '';
  const sectionPill = withActions
    ? `<button class="note-section-pill${note.section ? '' : ' note-section-pill-empty'}" data-id="${note.id}" data-section="${escapeAttr(note.section || '')}" title="Change section"><span class="note-section-label">${note.section ? escapeHtml(formatSection(note.section)) : 'Set section'}</span><span class="note-section-caret" aria-hidden="true">▾</span></button>`
    : (note.section
      ? `<span class="note-section-pill">${escapeHtml(formatSection(note.section))}</span>`
      : '');
  const swatchStyle = note.color_override
    ? `style="background:${escapeAttr(note.color_override)}"`
    : '';
  // Color swatch sits at the left of the meta row, before the tag badges.
  const colorBtn = withActions
    ? `<button class="note-color" data-id="${note.id}" ${swatchStyle} title="Change highlight color">●</button>`
    : '';
  const actions = withActions ? `
      <div class="note-actions">
        <button class="note-edit" data-id="${note.id}" title="Edit cleaned text">Edit</button>
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
        ${colorBtn}
        ${badges}
        ${addTagBtn}
        ${sectionPill}
        <span class="note-page">${note.page_number ? 'Page ' + note.page_number : 'Page ?'}</span>
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
        // Tell the PDF pane to drop the highlight immediately, otherwise the
        // user has to reload to see it disappear.
        chrome.runtime.sendMessage({
          action: 'notesChanged',
          pdfIdentifier: currentPdfId,
        }).catch(() => {});
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

  // Clicking the body of a tag badge (but not its × remove button) recolors the
  // note's highlight to that badge's own text color, saved as a color override.
  container.querySelectorAll('.note-type-badge').forEach(badge => {
    badge.addEventListener('click', async (e) => {
      if (e.target.closest('.note-tag-remove')) return; // × has its own handler
      e.stopPropagation();
      const noteId = badge.closest('.note-card')?.dataset.id;
      const hex = rgbToHex(getComputedStyle(badge).color);
      if (!noteId || !hex) return;
      try {
        await api.updateNote(noteId, currentPdfId, { color_override: hex });
        loadNotes(document.getElementById('view-mode').value);
        chrome.runtime.sendMessage({
          action: 'notesChanged',
          pdfIdentifier: currentPdfId,
        }).catch(() => {});
      } catch (err) {
        alert('Failed to set highlight color.');
        console.error('Badge color set error:', err);
      }
    });
  });

  container.querySelectorAll('.note-edit').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openCommentEditor(btn);
    });
  });

  container.querySelectorAll('button.note-section-pill').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openSectionPicker(btn);
    });
  });

  container.querySelectorAll('.note-tag-add').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openTagPicker(btn);
    });
  });

  container.querySelectorAll('.note-tag-remove').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const noteId = btn.dataset.id;
      const tag = btn.dataset.tag;
      const card = btn.closest('.note-card');
      const currentTags = Array.from(
        card.querySelectorAll('.note-tag-remove'),
      ).map((b) => b.dataset.tag);
      const next = currentTags.filter((t) => t !== tag);
      if (next.length === 0) {
        alert('A note must keep at least one tag. Re-clean it if all tags are wrong.');
        return;
      }
      try {
        await api.updateNote(noteId, currentPdfId, { comment_tags: next });
        loadNotes(document.getElementById('view-mode').value);
      } catch (err) {
        alert('Failed to remove tag.');
        console.error('Tag removal error:', err);
      }
    });
  });
}

// Replay a notes reload that was deferred while an inline editor was open.
// No-op when nothing was queued.
function flushPendingNotesReload() {
  if (pendingNotesViewMode !== undefined) {
    const vm = pendingNotesViewMode;
    pendingNotesViewMode = undefined;
    loadNotes(vm);
  }
}

// Swap the cleaned-comment div for an inline textarea + save/cancel.
// Saves via updateNote and reloads the list on success.
function openCommentEditor(editBtn) {
  const card = editBtn.closest('.note-card');
  if (!card) return;
  const commentEl = card.querySelector('.note-comment');
  if (!commentEl || commentEl.dataset.editing === '1') return;

  const noteId = editBtn.dataset.id;
  const original = commentEl.textContent;
  commentEl.dataset.editing = '1';
  noteEditorOpen = true;
  const prevHtml = commentEl.innerHTML;
  commentEl.innerHTML = `
    <textarea class="note-comment-edit">${escapeHtml(original)}</textarea>
    <div class="note-comment-edit-actions">
      <button class="note-comment-save">Save</button>
      <button class="note-comment-cancel">Cancel</button>
    </div>
  `;
  const textarea = commentEl.querySelector('textarea');
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  // Re-assert focus on the next frame in case a same-tick handler or layout
  // pass (e.g. a list re-render racing the click) dropped it.
  requestAnimationFrame(() => {
    if (commentEl.dataset.editing === '1' && document.activeElement !== textarea) {
      textarea.focus();
    }
  });

  // While editing, swallow clicks so the card-level scroll-to-highlight
  // handler doesn't fire when the user clicks the textarea or buttons.
  const swallow = (e) => e.stopPropagation();
  commentEl.addEventListener('click', swallow);
  commentEl.addEventListener('mousedown', swallow);

  const restore = () => {
    commentEl.removeEventListener('click', swallow);
    commentEl.removeEventListener('mousedown', swallow);
    commentEl.innerHTML = prevHtml;
    delete commentEl.dataset.editing;
    noteEditorOpen = false;
    // A reload that arrived while editing (e.g. a background note creation) was
    // deferred — apply it now that the editor is closed.
    flushPendingNotesReload();
  };

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      restore();
    }
  });

  commentEl.querySelector('.note-comment-cancel').addEventListener('click', (e) => {
    e.stopPropagation();
    restore();
  });

  commentEl.querySelector('.note-comment-save').addEventListener('click', async (e) => {
    e.stopPropagation();
    const value = textarea.value.trim();
    if (!value) {
      alert('Cleaned text cannot be empty.');
      return;
    }
    try {
      await api.updateNote(noteId, currentPdfId, { cleaned_comment: value });
      // Editing is done; allow this reload to run and drop any reload that was
      // deferred during the edit so we don't render the list twice.
      noteEditorOpen = false;
      pendingNotesViewMode = undefined;
      loadNotes(document.getElementById('view-mode').value);
    } catch (err) {
      alert('Failed to save edit.');
      console.error('Edit save error:', err);
      restore();
    }
  });
}

// Convert a CSS "rgb(r, g, b)" / "rgba(...)" string to a #rrggbb hex string.
// Returns null if the input can't be parsed. The notes API only accepts
// 6-digit hex for color_override, so badge-derived colors go through this.
function rgbToHex(rgb) {
  const m = String(rgb).match(/\d+/g);
  if (!m || m.length < 3) return null;
  return '#' + m.slice(0, 3).map(n => Number(n).toString(16).padStart(2, '0')).join('');
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

// All valid comment tags. Mirrors VALID_TAGS in services/cleanup-service.js —
// keep them in sync.
const TAG_OPTIONS = [
  'summary', 'critique', 'strength', 'question',
  'related_work', 'suggestion', 'follow_up',
  'edit', 'presentation', 'novelty', 'technical', 'general',
];

// Dropdown anchored under the "+" button on a note card. Lists tags not
// already on the note; clicking one appends it and saves via updateNote.
function openTagPicker(anchorBtn) {
  document.querySelectorAll('.note-tag-picker').forEach(p => p.remove());

  const card = anchorBtn.closest('.note-card');
  if (!card) return;
  const currentTags = Array.from(card.querySelectorAll('.note-tag-remove'))
    .map((b) => b.dataset.tag);
  const available = TAG_OPTIONS.filter(t => !currentTags.includes(t));

  const picker = document.createElement('div');
  picker.className = 'note-tag-picker';
  picker.innerHTML = available.length > 0
    ? available.map(t =>
        `<button class="note-tag-option" data-tag="${escapeAttr(t)}">${escapeHtml(formatType(t))}</button>`
      ).join('')
    : `<div class="note-tag-option-empty">All tags already applied.</div>`;
  document.body.appendChild(picker);

  const rect = anchorBtn.getBoundingClientRect();
  picker.style.left = `${rect.left}px`;
  picker.style.top = `${rect.bottom + 4}px`;

  const onPick = async (e) => {
    const target = e.target.closest('[data-tag]');
    if (!target) return;
    const newTag = target.dataset.tag;
    picker.remove();
    document.removeEventListener('mousedown', onOutside, true);
    if (!newTag || currentTags.includes(newTag)) return;
    try {
      await api.updateNote(anchorBtn.dataset.id, currentPdfId, {
        comment_tags: [...currentTags, newTag],
      });
      loadNotes(document.getElementById('view-mode').value);
    } catch (err) {
      alert('Failed to add tag.');
      console.error('Tag add error:', err);
    }
  };
  picker.addEventListener('click', onPick);

  const onOutside = (e) => {
    if (!picker.contains(e.target) && !anchorBtn.contains(e.target) && e.target !== anchorBtn) {
      picker.remove();
      document.removeEventListener('mousedown', onOutside, true);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', onOutside, true), 0);
}

// Paper section options shown in the section picker. Mirrors the
// VALID_SECTIONS list in services/cleanup-service.js — keep them in sync.
const SECTION_OPTIONS = [
  'abstract',
  'introduction',
  'background',
  'related_work_section',
  'methods',
  'results',
  'discussion',
  'conclusion',
  'references',
  'other',
];

// Inline dropdown that lets the user override the auto-assigned section
// for a note. Posts the chosen value (or null = clear) via updateNote.
function openSectionPicker(anchorBtn) {
  document.querySelectorAll('.note-section-picker').forEach(p => p.remove());

  const current = anchorBtn.dataset.section || '';
  const picker = document.createElement('div');
  picker.className = 'note-section-picker';
  picker.innerHTML = SECTION_OPTIONS.map(s =>
    `<button class="note-section-option${s === current ? ' is-selected' : ''}" data-section="${escapeAttr(s)}">${escapeHtml(formatSection(s))}</button>`
  ).join('') + `<button class="note-section-option note-section-option-clear" data-section="">Clear</button>`;
  document.body.appendChild(picker);

  const rect = anchorBtn.getBoundingClientRect();
  picker.style.left = `${rect.left}px`;
  picker.style.top = `${rect.bottom + 4}px`;

  const onPick = async (e) => {
    const target = e.target.closest('[data-section]');
    if (!target) return;
    const nextSection = target.dataset.section || null;
    const prev = anchorBtn.dataset.section || null;
    picker.remove();
    document.removeEventListener('mousedown', onOutside, true);
    if (nextSection === prev) return;
    try {
      await api.updateNote(anchorBtn.dataset.id, currentPdfId, { section: nextSection });
      loadNotes(document.getElementById('view-mode').value);
    } catch (err) {
      alert('Failed to update section.');
      console.error('Section update error:', err);
    }
  };
  picker.addEventListener('click', onPick);

  const onOutside = (e) => {
    if (!picker.contains(e.target) && !anchorBtn.contains(e.target) && e.target !== anchorBtn) {
      picker.remove();
      document.removeEventListener('mousedown', onOutside, true);
    }
  };
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
  const typeOrder = [
    'summary', 'strength', 'critique', 'question',
    'suggestion', 'related_work', 'follow_up',
    'edit', 'presentation', 'novelty', 'technical', 'general',
  ];
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

// Default download base name: the open PDF's original filename (no extension),
// derived from the app URL by lib/pdf-identifier.js. Falls back to
// 'annotations' when no PDF filename is available.
function notesFilenameBase() {
  return (typeof getPdfBaseName === 'function' ? getPdfBaseName() : '') || 'annotations';
}

async function exportMarkdown() {
  if (!currentPdfId) return;

  try {
    const markdown = await api.exportMarkdown(currentPdfId);
    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${notesFilenameBase()}_notes.md`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert('Failed to export. Is the backend running?');
    console.error('Export error:', err);
  }
}

async function exportJson() {
  if (!currentPdfId) return;

  try {
    const [{ notes }, refsResp, rubricResp] = await Promise.all([
      api.getNotes(currentPdfId),
      api.listReferences(currentPdfId).catch(() => ({ references: [] })),
      api.listRubric(currentPdfId).catch(() => ({ items: [] })),
    ]);
    const exportedNotes = notes.map((n) => ({
      selected_text: n.selected_text || '',
      page_number: n.page_number || 0,
      raw_transcript: n.raw_transcript || '',
      cleaned_comment: n.cleaned_comment || '',
      comment_tags: Array.isArray(n.comment_tags) ? n.comment_tags : [],
      section: n.section || null,
      created_at: n.created_at || null,
    }));
    const exportedRefs = (refsResp.references || []).map((r) => ({
      authors: r.authors || '',
      title: r.title || '',
      link: r.link || '',
      created_at: r.created_at || null,
    }));
    const exportedRubric = (rubricResp.items || []).map((i) => ({
      section: i.section || '',
      description: i.description || '',
      created_at: i.created_at || null,
    }));
    const payload = {
      notes: exportedNotes,
      references: exportedRefs,
      rubric: exportedRubric,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${notesFilenameBase()}_notes.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert('Failed to export. Is the backend running?');
    console.error('Export error:', err);
  }
}

// ─── Review Check modal ───────────────────────────────────────────────────
//
// Single live modal at a time. The DOM tree is built once per open; phase
// changes (input → loading → loaded → error) just swap the body + footer
// contents so we don't lose textarea state on transient renders.

let reviewModalEl = null;
let reviewEscHandler = null;

function closeReviewModal() {
  if (reviewModalEl) {
    reviewModalEl.remove();
    reviewModalEl = null;
  }
  if (reviewEscHandler) {
    document.removeEventListener('keydown', reviewEscHandler);
    reviewEscHandler = null;
  }
}

async function openReviewCheckModal() {
  if (!currentPdfId) {
    alert('Open a PDF first.');
    return;
  }
  if (reviewModalEl) return; // already open

  reviewModalEl = document.createElement('div');
  reviewModalEl.className = 'review-modal-backdrop';
  reviewModalEl.innerHTML = `
    <div class="review-modal" role="dialog" aria-label="Check Review">
      <div class="review-modal-header">
        <span>Check Review</span>
        <button class="review-modal-close" title="Close" aria-label="Close">×</button>
      </div>
      <div class="review-modal-body"></div>
      <div class="review-modal-footer"></div>
    </div>
  `;
  document.body.appendChild(reviewModalEl);

  reviewModalEl.querySelector('.review-modal-close').addEventListener('click', closeReviewModal);
  // Backdrop click closes; click inside the inner card must not bubble out
  // and trigger the close.
  reviewModalEl.addEventListener('click', (e) => {
    if (e.target === reviewModalEl) closeReviewModal();
  });
  reviewEscHandler = (e) => { if (e.key === 'Escape') closeReviewModal(); };
  document.addEventListener('keydown', reviewEscHandler);

  // Fetch persisted state. On error (e.g. backend down) fall back to the
  // empty input view so the user can still attempt to run a check.
  let saved = null;
  try {
    const resp = await api.getReviewCheck(currentPdfId);
    if (resp && !resp.empty) saved = resp;
  } catch (err) {
    console.error('Review check: failed to load saved state', err);
  }

  if (saved && Array.isArray(saved.components) && saved.rubric_text) {
    renderReviewLoaded(saved);
  } else {
    renderReviewInput('');
  }
}

function renderReviewInput(prefill) {
  if (!reviewModalEl) return;
  const body = reviewModalEl.querySelector('.review-modal-body');
  const footer = reviewModalEl.querySelector('.review-modal-footer');
  body.innerHTML = `
    <p class="review-modal-hint">Paste the conference's reviewing standards or rubric below. The LLM will extract the main components and check how well your annotations cover each one.</p>
    <textarea class="review-rubric-input" placeholder="e.g. 1. Novelty — is the contribution new?&#10;2. Soundness — is the methodology rigorous?&#10;3. Clarity, significance, ..."></textarea>
  `;
  footer.innerHTML = `
    <button class="toolbar-btn review-cancel">Cancel</button>
    <button class="toolbar-btn review-primary" disabled>Analyze</button>
  `;
  const textarea = body.querySelector('.review-rubric-input');
  textarea.value = prefill || '';
  textarea.focus();
  const analyzeBtn = footer.querySelector('.review-primary');
  analyzeBtn.disabled = textarea.value.trim().length === 0;
  textarea.addEventListener('input', () => {
    analyzeBtn.disabled = textarea.value.trim().length === 0;
  });
  footer.querySelector('.review-cancel').addEventListener('click', closeReviewModal);
  analyzeBtn.addEventListener('click', () => runReviewCheck(textarea.value.trim()));
}

function renderReviewLoading() {
  if (!reviewModalEl) return;
  const body = reviewModalEl.querySelector('.review-modal-body');
  const footer = reviewModalEl.querySelector('.review-modal-footer');
  body.innerHTML = `
    <div class="loading" style="padding: 32px;">
      <div class="spinner"></div>
      <span>Analyzing review against rubric...</span>
    </div>
  `;
  footer.innerHTML = '';
}

function renderReviewLoaded(saved) {
  if (!reviewModalEl) return;
  const body = reviewModalEl.querySelector('.review-modal-body');
  const footer = reviewModalEl.querySelector('.review-modal-footer');

  const rubricText = saved.rubric_text || '';
  const checkedAtLine = saved.checked_at
    ? `<div class="review-checked-at">Last checked: ${formatTime(saved.checked_at)}</div>`
    : '';
  const parseErrorLine = saved.parse_error
    ? `<div class="review-error">The model returned non-JSON output. Try Re-check, or adjust the rubric text.</div>`
    : '';
  const emptyLine = (saved.note_count === 0)
    ? `<div class="review-empty">No annotations yet — highlight text in the PDF and add some notes, then come back.</div>`
    : '';

  body.innerHTML = `
    <details class="review-rubric-details">
      <summary>Rubric</summary>
      <textarea class="review-rubric-input">${escapeHtml(rubricText)}</textarea>
    </details>
    ${checkedAtLine}
    ${parseErrorLine}
    ${emptyLine}
    <div class="review-components"></div>
  `;
  renderReviewComponents(saved.components || [], body.querySelector('.review-components'));

  footer.innerHTML = `
    <button class="toolbar-btn review-cancel">Close</button>
    <button class="toolbar-btn review-primary">Re-check</button>
  `;
  footer.querySelector('.review-cancel').addEventListener('click', closeReviewModal);
  footer.querySelector('.review-primary').addEventListener('click', () => {
    const ta = body.querySelector('.review-rubric-input');
    runReviewCheck((ta?.value || rubricText).trim());
  });
}

function renderReviewError(message, rubricText, showRetry = true) {
  if (!reviewModalEl) return;
  const body = reviewModalEl.querySelector('.review-modal-body');
  const footer = reviewModalEl.querySelector('.review-modal-footer');
  body.innerHTML = `
    <div class="review-error">${escapeHtml(message)}</div>
    <details class="review-rubric-details" open>
      <summary>Rubric</summary>
      <textarea class="review-rubric-input">${escapeHtml(rubricText || '')}</textarea>
    </details>
  `;
  footer.innerHTML = `
    <button class="toolbar-btn review-cancel">Close</button>
    ${showRetry ? '<button class="toolbar-btn review-primary">Try again</button>' : ''}
  `;
  footer.querySelector('.review-cancel').addEventListener('click', closeReviewModal);
  const retry = footer.querySelector('.review-primary');
  if (retry) {
    retry.addEventListener('click', () => {
      const ta = body.querySelector('.review-rubric-input');
      runReviewCheck((ta?.value || rubricText || '').trim());
    });
  }
}

function renderReviewComponents(components, container) {
  if (!container) return;
  if (!components || components.length === 0) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = components.map((c) => {
    const status = ['covered', 'partial', 'missing'].includes(c.status) ? c.status : 'partial';
    const evidence = Array.isArray(c.evidence) ? c.evidence : [];
    const evidenceHtml = evidence.length
      ? `<div class="review-component-evidence">Evidence: ${evidence.map((e) =>
          `<a data-note-id="${escapeAttr(e.id)}" data-page="${e.page_number || 0}" title="Scroll to this annotation">page ${e.page_number || '?'} — "${escapeHtml(e.preview || '')}"</a>`
        ).join(', ')}</div>`
      : '';
    const gapHtml = c.gap_summary
      ? `<div class="review-component-gap">${escapeHtml(c.gap_summary)}</div>`
      : '';
    const descHtml = c.description
      ? `<div class="review-component-desc">${escapeHtml(c.description)}</div>`
      : '';
    return `
      <div class="review-component">
        <div class="review-component-header">
          <span class="review-status-dot review-status-${status}" title="${status}"></span>
          <span>${escapeHtml(c.title || 'Untitled')}</span>
        </div>
        ${descHtml}
        ${evidenceHtml}
        ${gapHtml}
      </div>
    `;
  }).join('');

  container.querySelectorAll('.review-component-evidence a').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const noteId = a.dataset.noteId;
      const pageNumber = parseInt(a.dataset.page, 10) || 0;
      chrome.runtime.sendMessage({
        action: 'scrollToHighlight',
        noteId,
        pageNumber,
      }).catch(() => {});
    });
  });
}

async function runReviewCheck(rubricText) {
  if (!currentPdfId) return;
  if (!rubricText) {
    renderReviewError('Rubric text is empty. Paste a rubric and try again.', '', false);
    return;
  }
  renderReviewLoading();
  try {
    const result = await api.runReviewCheck(currentPdfId, rubricText);
    if (result && result.note_count === 0) {
      // No notes — server returned a stub with no components.
      renderReviewLoaded({
        rubric_text: rubricText,
        components: [],
        note_count: 0,
        checked_at: null,
      });
      return;
    }
    renderReviewLoaded(result);
  } catch (err) {
    const msg = String(err?.message || err);
    if (/not configured/i.test(msg)) {
      renderReviewError(
        'No LLM is configured. Open Settings and add an API key for OpenAI, Anthropic, Ollama, or an OpenAI-compatible endpoint.',
        rubricText,
        false,
      );
      // Settings link wired up below if/when we add one in the template.
    } else {
      renderReviewError(`Check failed: ${msg}`, rubricText, true);
    }
  }
}

// ─── Review tab ───────────────────────────────────────────────────────────
//
// Drafts a full peer review (free-form Markdown) from the manuscript text,
// notes, and rubric, guided by the Review-tab settings. Streams live (thinking
// + output) inline in the tab, prompts for a file to save to, then shows an
// editable draft whose Save overwrites that file.

let reviewGenerating = false;     // true while a generation is streaming
let reviewStreamHandler = null;   // window listener for pdfc-review-chunk

function stopReviewStream() {
  if (reviewStreamHandler) {
    window.removeEventListener('pdfc-review-chunk', reviewStreamHandler);
    reviewStreamHandler = null;
  }
}

async function loadReview() {
  const container = document.getElementById('review-container');
  if (!currentPdfId) {
    container.innerHTML = '<p class="empty-state">Open a PDF to generate a review.</p>';
    return;
  }
  const loading = document.getElementById('loading');
  loading.style.display = 'flex';
  try {
    const saved = await api.getGeneratedReview(currentPdfId);
    if (!saved || saved.empty || !saved.review_text) {
      container.innerHTML = '<p class="empty-state">No review yet. Click Generate Review to draft one.</p>';
    } else {
      renderReviewEditor(saved);
    }
  } catch (err) {
    container.innerHTML = '<p class="error-state">Failed to load review. Is the backend running?</p>';
    console.error('PDF Converser sidebar error:', err);
  } finally {
    loading.style.display = 'none';
  }
}

// Live streaming view rendered into the Review tab: a dim Thinking feed
// (revealed once reasoning arrives) above a read-only output preview. Returns an
// update(payload) function; DOM writes are throttled to one per animation frame.
function renderReviewStreaming() {
  const container = document.getElementById('review-container');
  container.innerHTML = `
    <div class="loading" style="padding: 4px 0 12px;">
      <div class="spinner"></div>
      <span>Generating review…</span>
    </div>
    <details class="review-thinking-wrap" hidden>
      <summary>Thinking</summary>
      <div class="review-thinking"></div>
    </details>
    <div class="review-stream-output" placeholder="The review will appear here as it is written…"></div>
  `;
  const thinkWrap = container.querySelector('.review-thinking-wrap');
  const thinkEl = container.querySelector('.review-thinking');
  const outEl = container.querySelector('.review-stream-output');

  let latest = { thinking: '', text: '' };
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    if (latest.thinking) {
      if (thinkWrap.hidden) { thinkWrap.hidden = false; thinkWrap.open = true; }
      thinkEl.textContent = latest.thinking;
      thinkEl.scrollTop = thinkEl.scrollHeight;
    }
    outEl.textContent = latest.text;
    outEl.scrollTop = outEl.scrollHeight;
  };
  return (payload) => {
    latest = payload || latest;
    if (!scheduled) { scheduled = true; requestAnimationFrame(flush); }
  };
}

async function runGenerateReview() {
  if (!currentPdfId) { alert('Open a PDF first.'); return; }
  if (reviewGenerating) return;
  if (currentTab !== 'review') switchTab('review');

  reviewGenerating = true;
  const genBtn = document.getElementById('generate-review-btn');
  if (genBtn) genBtn.disabled = true;

  const update = renderReviewStreaming();
  // Subscribe before kicking off generation so no early chunks are missed.
  stopReviewStream();
  reviewStreamHandler = (e) => update(e.detail);
  window.addEventListener('pdfc-review-chunk', reviewStreamHandler);

  try {
    const result = await window.desktop.generateReview(currentPdfId);
    stopReviewStream();
    // Ask where to save; default to the previously chosen path or <paper>_review.md.
    const def = result.review_file_path || `${notesFilenameBase()}_review.md`;
    const path = await window.desktop.chooseSavePath(def);
    if (path) {
      const saved = await api.saveGeneratedReview(currentPdfId, result.review_text, path);
      renderReviewEditor(saved);
    } else {
      // Cancelled the save dialog — show the draft unsaved; Save will prompt.
      renderReviewEditor(result);
    }
  } catch (err) {
    stopReviewStream();
    const msg = String(err?.message || err);
    const container = document.getElementById('review-container');
    if (/not configured/i.test(msg)) {
      container.innerHTML = '<p class="error-state">No LLM is configured for review generation. Open Settings → Review (or Text Processing) and add an API key for the chosen provider.</p>';
    } else if (/document text/i.test(msg)) {
      container.innerHTML = '<p class="error-state">Document text is not available yet. Make sure the PDF has fully loaded, then try again.</p>';
    } else {
      container.innerHTML = `<p class="error-state">Generation failed: ${escapeHtml(msg)}</p>`;
    }
  } finally {
    reviewGenerating = false;
    if (genBtn) genBtn.disabled = false;
  }
}

// Editable draft view: textarea + meta (timestamp / saved path) + Save / Copy.
// Save writes the textarea content to the paper's review file (prompting for a
// location the first time), overwriting it.
function renderReviewEditor(saved) {
  const container = document.getElementById('review-container');
  const reviewText = saved.review_text || '';
  const filePath = saved.review_file_path || '';

  const metaBits = [];
  if (saved.generated_at) metaBits.push(`Generated: ${formatTime(saved.generated_at)}`);
  if (filePath) metaBits.push(`Saved to: ${escapeHtml(filePath)}`);
  const metaLine = metaBits.length ? `<div class="review-meta">${metaBits.join(' · ')}</div>` : '';
  const missingLine = saved.file_missing
    ? `<div class="review-error">The saved file could not be found (moved or deleted). Showing the last cached copy — click Save to write it again.</div>`
    : '';
  const unsavedLine = (!filePath)
    ? `<div class="review-meta">Not saved to a file yet — click Save to choose a location.</div>`
    : '';
  const emptyNotesLine = (saved.note_count === 0)
    ? `<div class="review-empty">Generated without any annotations — add notes for a more grounded review.</div>`
    : '';

  container.innerHTML = `
    ${metaLine}
    ${missingLine}
    ${unsavedLine}
    ${emptyNotesLine}
    <textarea class="generated-review-edit" spellcheck="false">${escapeHtml(reviewText)}</textarea>
    <div class="review-editor-actions">
      <button class="toolbar-btn review-copy-btn">Copy</button>
      <button class="toolbar-btn review-primary review-save-btn" disabled>Save</button>
    </div>
  `;

  const textarea = container.querySelector('.generated-review-edit');
  const saveBtn = container.querySelector('.review-save-btn');
  // Edits enable Save; the latest text is always read live from the textarea.
  textarea.addEventListener('input', () => {
    saveBtn.disabled = textarea.value === reviewText;
    saveBtn.textContent = 'Save';
  });

  const copyBtn = container.querySelector('.review-copy-btn');
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(textarea.value);
      copyBtn.textContent = 'Copied';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
    } catch {
      alert('Copy failed.');
    }
  });

  saveBtn.addEventListener('click', async () => {
    let path = filePath;
    if (!path) {
      path = await window.desktop.chooseSavePath(`${notesFilenameBase()}_review.md`);
      if (!path) return; // cancelled
    }
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      const updated = await api.saveGeneratedReview(currentPdfId, textarea.value, path);
      // Re-render from the saved record so the baseline tracks the new text.
      renderReviewEditor(updated);
    } catch (err) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
      alert(`Save failed: ${err?.message || err}`);
    }
  });
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
    edit: 'Edit',
    presentation: 'Presentation',
    novelty: 'Novelty',
    technical: 'Technical',
    general: 'General',
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
    other: 'Other',
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
