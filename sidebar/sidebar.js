// PDF Converser - Sidebar Panel

const api = new ApiClient();
let currentPdfId = null;
let currentTab = 'notes';
let rubricTemplates = []; // cached saved rubric templates (dropdown + dup-name check)
let rubricCheck = null; // latest persisted coverage check for the open PDF
let rubricCheckError = null; // message from the most recent failed/empty check attempt

// True while an inline note editor (the comment textarea) is open. While set,
// loadNotes() defers its destructive `container.innerHTML` re-render so a note
// created/changed in the background (e.g. a voice annotation finishing its
// async pipeline) can't wipe the textarea the user is typing in. The deferred
// reload is replayed when the editor closes.
let noteEditorOpen = false;
let pendingNotesViewMode; // undefined = no reload pending

// Render an error state into a tab container using the shared classifier
// (lib/error-messages.js). Configuration errors get an "Open Settings" button;
// everything else shows the action + error detail (no HTTP backend exists, so
// failures are config or internal errors).
function renderErrorState(container, err, actionLabel) {
  const d = describeApiError(err, actionLabel);
  container.innerHTML = `<p class="error-state">${escapeHtml(d.text)}${
    d.openSettings ? ' <button class="toolbar-btn open-settings-btn" type="button">Open Settings</button>' : ''
  }</p>`;
  const btn = container.querySelector('.open-settings-btn');
  if (btn) btn.addEventListener('click', () => window.desktop.openSettings());
}

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
    // Settings saved (e.g. offline mode toggled) — refresh the notes view so
    // the "Clean pending" button state reflects the new mode. The bib library
    // path may also have changed, so refresh its status when visible.
    if (msg.action === 'settingsChanged') {
      if (currentTab === 'notes') loadNotes();
      if (currentTab === 'references') loadBibStatus();
    }
    if (msg.action === 'tabChanged') {
      const newId = msg.pdfIdentifier;
      if (newId && newId !== currentPdfId) {
        currentPdfId = newId;
        rubricCheck = null;
        rubricCheckError = null;
        const titleEl = document.getElementById('pdf-title');
        if (titleEl) titleEl.textContent = msg.pdfTitle || 'Untitled PDF';
        document.getElementById('view-mode').value = 'chronological';
        document.getElementById('questions-sort').value = 'date';
        if (currentTab === 'notes') loadNotes();
        else if (currentTab === 'questions') loadQuestions();
        else if (currentTab === 'references') loadReferences();
        else if (currentTab === 'rubric') loadRubric();
        else if (currentTab === 'review') {
          loadReflections();
          if (!reviewGenerating) loadReview();
        }
      } else if (!newId) {
        currentPdfId = null;
        rubricCheck = null;
        rubricCheckError = null;
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
        document.getElementById('reflections-container').innerHTML = '';
        document.getElementById('review-container').innerHTML =
          '<p class="empty-state">Open a PDF to generate a review.</p>';
        updateCheckReviewButtonState();
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

  // Check Review button (in the Rubric toolbar) — judges each rubric section
  // against the notes and paints the verdicts onto the section cards. The
  // result is persisted per PDF so the coverage stays visible across visits.
  // Disabled until the rubric has at least one non-empty section.
  document.getElementById('check-review-btn').addEventListener('click', runRubricCoverageCheck);
  document.getElementById('rubric-container').addEventListener('input', (e) => {
    updateCheckReviewButtonState();
    markCoverageStaleness(e.target.closest('.rubric-card'));
  });

  // Clean pending button — LLM-cleans notes that were saved in offline mode,
  // one at a time. Hidden unless the current PDF has pending notes.
  document.getElementById('clean-pending-btn').addEventListener('click', cleanAllPending);

  // Offline toggle (header, right corner) — flips the offline_mode setting.
  // The saveSettings broadcast drives everything else: preload re-syncs the
  // offline-mode class on <html> (button styling) and the relayed
  // settingsChanged message refreshes the notes view.
  document.getElementById('offline-toggle').addEventListener('click', async () => {
    try {
      const s = await window.desktop.getSettings();
      await window.desktop.saveSettings({ offline_mode: !s.offline_mode });
    } catch (err) {
      console.error('PDF Converser: failed to toggle offline mode', err);
    }
  });

  // Generate Review button (in the Review tab) — streams a full review inline,
  // then prompts for a file to save it to. Drafts from notes, rubric, and
  // manuscript text using the model/instructions from the Review tab of Settings.
  document.getElementById('generate-review-btn').addEventListener('click', runGenerateReview);

  // Add Reference button — appends an empty row that the user fills in.
  document.getElementById('add-reference-btn').addEventListener('click', () => {
    addBlankReference();
  });

  // Bib library search (References tab) — debounced dropdown; Escape closes.
  const bibInput = document.getElementById('bib-search-input');
  bibInput.addEventListener('input', () => {
    clearTimeout(bibSearchTimer);
    bibSearchTimer = setTimeout(runBibSearch, 200);
  });
  bibInput.addEventListener('focus', () => {
    if (bibInput.value.trim()) runBibSearch();
  });
  bibInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideBibDropdown();
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
  const scrollArea = document.getElementById('sidebar-pane');
  if (scrollArea) scrollArea.scrollTop = 0;

  // The Review tab swaps the sidebar's intrinsic-height layout for a
  // flex-fill one so the draft textarea takes most of the window height.
  if (scrollArea) scrollArea.classList.toggle('review-tab-active', tab === 'review');

  const notesToolbar = document.getElementById('notes-toolbar');
  const questionsToolbar = document.getElementById('questions-toolbar');
  const referencesToolbar = document.getElementById('references-toolbar');
  const rubricToolbar = document.getElementById('rubric-toolbar');
  const notesContainer = document.getElementById('notes-container');
  const questionsContainer = document.getElementById('questions-container');
  const referencesContainer = document.getElementById('references-container');
  const rubricContainer = document.getElementById('rubric-container');
  const reviewGenerateRow = document.getElementById('review-generate-row');
  const reflectionsContainer = document.getElementById('reflections-container');
  const reviewContainer = document.getElementById('review-container');

  notesToolbar.style.display = 'none';
  questionsToolbar.style.display = 'none';
  referencesToolbar.style.display = 'none';
  document.getElementById('bib-search-row').style.display = 'none';
  hideBibDropdown();
  rubricToolbar.style.display = 'none';
  reviewGenerateRow.style.display = 'none';
  notesContainer.style.display = 'none';
  questionsContainer.style.display = 'none';
  referencesContainer.style.display = 'none';
  rubricContainer.style.display = 'none';
  reflectionsContainer.style.display = 'none';
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
    loadBibStatus(); // shows #bib-search-row itself when the library is ok
  } else if (tab === 'rubric') {
    rubricToolbar.style.display = 'flex';
    rubricContainer.style.display = '';
    loadRubric();
  } else if (tab === 'review') {
    reviewGenerateRow.style.display = 'flex';
    reflectionsContainer.style.display = '';
    reviewContainer.style.display = '';
    loadReflections();
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
      updatePendingButton(data.notes);
      renderNotesList(data.notes, container);
    } else if (viewMode === 'by-type') {
      const data = await api.getNotes(currentPdfId);
      updatePendingButton(data.notes);
      renderNotesByType(data.notes, container);
    } else if (viewMode === 'by-section') {
      const data = await api.organizeBySection(currentPdfId);
      renderGroupedNotes(data.groups, container);
    } else if (viewMode === 'by-theme') {
      const data = await api.organizeByTheme(currentPdfId);
      renderGroupedNotes(data.groups, container);
    }
  } catch (err) {
    // The by-section/by-theme views are LLM-backed, so this genuinely can be
    // a not-configured error; renderErrorState shows the Settings prompt then.
    renderErrorState(container, err, 'Loading notes');
    console.error('PDF Converser sidebar error:', err);
  } finally {
    loading.style.display = 'none';
  }
}

// Show/hide the "Clean pending (N)" toolbar button based on how many of the
// current PDF's notes were saved in offline mode and not yet LLM-cleaned.
// Only called from the flat views (chronological/by-type); the grouped views
// are LLM-backed and unavailable offline anyway, so the last count stands.
function updatePendingButton(notes) {
  const btn = document.getElementById('clean-pending-btn');
  if (!btn || btn.disabled) return; // don't fight the in-progress queue label
  const count = (notes || []).filter((n) => n.cleanup_status === 'pending').length;
  btn.style.display = count > 0 ? '' : 'none';
  btn.textContent = `Clean pending (${count})`;
}

// Sequentially LLM-clean every pending note for the current PDF, one at a
// time. Failures leave the note pending; an offline error (mode re-enabled
// mid-run) stops the queue, other errors skip to the next note.
async function cleanAllPending() {
  if (!currentPdfId) return;
  const btn = document.getElementById('clean-pending-btn');
  try {
    // Deterministic preflight: offline mode off and provider credentials
    // present — otherwise every note in the queue would fail the same way.
    const st = await window.desktop?.llmStatus?.();
    if (st && !st.ok) {
      alert(st.message);
      return;
    }
  } catch { /* status unavailable; let the server-side guard decide */ }

  btn.disabled = true;
  try {
    const data = await api.getNotes(currentPdfId);
    const pending = (data.notes || []).filter((n) => n.cleanup_status === 'pending');
    let done = 0;
    const failures = [];
    for (const note of pending) {
      btn.textContent = `Cleaning ${done + 1}/${pending.length}…`;
      try {
        await api.recleanNote(note.id, currentPdfId);
        done++;
        // Refresh the panel and PDF highlights per note so cleaned text/tags
        // appear as the queue progresses, not all at once at the end.
        // (updatePendingButton skips while this button is disabled, so the
        // progress label above survives the reload.)
        await loadNotes(document.getElementById('view-mode').value);
        chrome.runtime.sendMessage({
          action: 'notesChanged',
          pdfIdentifier: currentPdfId,
        }).catch(() => {});
      } catch (err) {
        failures.push({ note, err });
        if (/offline/i.test(err.message || '')) break; // mode re-enabled mid-run
      }
    }
    if (failures.length) {
      const d = describeApiError(failures[0].err, 'Cleaning');
      alert(`${failures.length} note(s) failed to clean and remain pending:\n${d.text}`);
    }
  } finally {
    btn.disabled = false;
    loadNotes(document.getElementById('view-mode').value);
    // Cleaning changes tags → highlight colors; tell the PDF pane to re-render.
    chrome.runtime.sendMessage({
      action: 'notesChanged',
      pdfIdentifier: currentPdfId,
    }).catch(() => {});
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
    renderErrorState(container, err, 'Loading questions');
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
    renderErrorState(container, err, 'Loading references');
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
        <input class="ref-input" data-field="authors" type="text" value="${escapeAttr(ref.authors || '')}" placeholder="e.g. Author et al.">
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

// ─── Bib library (References tab) ─────────────────────────────────────────
//
// Status + search over the user's global .bib file (Settings → References).
// The library lives in the main process (services/bib-library-service.js) and
// auto-reloads when the file changes; here we just render its status and a
// debounced search dropdown whose results one-click-add to the per-PDF
// reference list above.

let bibSearchTimer = null;
let bibSearchSeq = 0; // discard stale async search responses
let bibDropdownDismiss = null; // document-level outside-click listener

async function loadBibStatus() {
  const statusEl = document.getElementById('bib-status');
  const searchRow = document.getElementById('bib-search-row');
  try {
    const status = await api.getBibStatus();
    renderBibStatus(status);
    searchRow.style.display = status.ok && currentTab === 'references' ? 'flex' : 'none';
  } catch (err) {
    statusEl.innerHTML = '<span class="bib-status-dot bib-status-err"></span> bib status unavailable';
    searchRow.style.display = 'none';
    console.error('PDF Converser sidebar error:', err);
  }
}

function renderBibStatus(status) {
  const statusEl = document.getElementById('bib-status');
  statusEl.innerHTML = '';
  if (!status.configured) {
    const label = document.createElement('span');
    label.textContent = 'No .bib library configured';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toolbar-btn';
    btn.textContent = 'Configure…';
    btn.title = 'Choose a .bib file in Settings → References';
    btn.addEventListener('click', () => window.desktop.openSettings('references'));
    statusEl.append(label, btn);
    return;
  }
  const dot = document.createElement('span');
  dot.className = `bib-status-dot ${status.ok ? 'bib-status-ok' : 'bib-status-err'}`;
  const label = document.createElement('span');
  if (status.ok) {
    label.textContent = `${status.entry_count} references loaded`
      + (status.skipped_count ? ` · ${status.skipped_count} skipped` : '');
    label.title = status.path;
  } else {
    label.textContent = 'failed to load .bib file';
    label.title = status.error || '';
  }
  statusEl.append(dot, label);
}

function hideBibDropdown() {
  const dropdown = document.getElementById('bib-search-dropdown');
  dropdown.hidden = true;
  dropdown.innerHTML = '';
  if (bibDropdownDismiss) {
    document.removeEventListener('mousedown', bibDropdownDismiss);
    bibDropdownDismiss = null;
  }
}

function showBibDropdown() {
  const dropdown = document.getElementById('bib-search-dropdown');
  dropdown.hidden = false;
  if (!bibDropdownDismiss) {
    bibDropdownDismiss = (e) => {
      if (!e.target.closest('.bib-search-wrap')) hideBibDropdown();
    };
    document.addEventListener('mousedown', bibDropdownDismiss);
  }
}

async function runBibSearch() {
  const q = document.getElementById('bib-search-input').value.trim();
  if (!q) {
    hideBibDropdown();
    return;
  }
  const seq = ++bibSearchSeq;
  try {
    const data = await api.searchBib(q);
    if (seq !== bibSearchSeq) return; // a newer search superseded this one
    renderBibDropdown(data.results || []);
  } catch (err) {
    if (seq === bibSearchSeq) hideBibDropdown();
    console.error('PDF Converser sidebar error:', err);
  }
}

function renderBibDropdown(results) {
  const dropdown = document.getElementById('bib-search-dropdown');
  dropdown.innerHTML = '';
  if (!results.length) {
    const empty = document.createElement('div');
    empty.className = 'bib-result-empty';
    empty.textContent = 'No matches in library.';
    dropdown.appendChild(empty);
    showBibDropdown();
    return;
  }
  for (const r of results) {
    const item = document.createElement('div');
    item.className = 'bib-result';
    const title = document.createElement('div');
    title.className = 'bib-result-title';
    title.textContent = r.title || '(untitled)';
    const meta = document.createElement('div');
    meta.className = 'bib-result-meta';
    meta.textContent = [r.authors, r.year, r.venue].filter(Boolean).join(' · ');
    item.append(title, meta);
    item.addEventListener('click', () => addBibResult(r));
    dropdown.appendChild(item);
  }
  showBibDropdown();
}

async function addBibResult(r) {
  if (!currentPdfId) {
    alert('Open a PDF first.');
    return;
  }
  try {
    await api.createReference(currentPdfId, {
      authors: r.authors || '',
      title: r.title || '',
      link: r.link || '',
    });
    hideBibDropdown();
    document.getElementById('bib-search-input').value = '';
    await loadReferences();
    const container = document.getElementById('references-container');
    const cards = container.querySelectorAll('.ref-card');
    const last = cards[cards.length - 1];
    if (last) last.scrollIntoView({ block: 'nearest' });
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
    const [data, check] = await Promise.all([
      api.listRubric(currentPdfId),
      // A failed read of the saved coverage check shouldn't block the editor.
      api.getReviewCheck(currentPdfId).catch(() => null),
    ]);
    rubricCheck = (check && !check.empty && Array.isArray(check.sections)) ? check : null;
    renderRubricList(data.items || [], container);
  } catch (err) {
    renderErrorState(container, err, 'Loading the rubric');
    console.error('PDF Converser sidebar error:', err);
  } finally {
    loading.style.display = 'none';
    updateCheckReviewButtonState();
  }
}

function renderRubricList(items, container) {
  if (!items || items.length === 0) {
    container.innerHTML =
      '<p class="empty-state">No rubric sections yet. Add a section the review should cover (e.g. Novelty, Soundness, Clarity).</p>';
    return;
  }
  const resultsById = new Map(
    (rubricCheck?.sections || []).map((s) => [s.rubric_item_id, s])
  );
  container.innerHTML = renderCoverageMeta()
    + items.map((item) => renderRubricCard(item, resultsById.get(item.id))).join('');
  attachRubricHandlers(container);
  attachCoverageEvidenceHandlers(container);
}

// Header line above the cards: last-checked time plus any message from the
// most recent check attempt. Empty when no check has run and nothing failed.
function renderCoverageMeta() {
  const errorLine = rubricCheckError
    ? `<div class="review-error">${escapeHtml(rubricCheckError)}</div>`
    : '';
  const checkedLine = (rubricCheck && rubricCheck.checked_at)
    ? `<div class="rubric-coverage-meta">Coverage last checked: ${formatTime(rubricCheck.checked_at)}</div>`
    : '';
  return errorLine + checkedLine;
}

function renderRubricCard(item, coverageResult) {
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
      ${renderCoverageBlock(item, coverageResult)}
      <div class="rubric-actions">
        <button class="rubric-delete" title="Delete this rubric section">Delete</button>
      </div>
    </div>
  `;
}

// Coverage verdict painted onto a rubric card. Three cases: no check has run
// (nothing rendered), a check exists but didn't include this section ("not
// checked yet"), or a verdict with a gap summary and evidence links. The
// snapshot data attributes let the input listener flag live edits as stale
// without a re-render.
function renderCoverageBlock(item, result) {
  if (!rubricCheck) return '';
  if (!result) {
    return '<div class="rubric-coverage rubric-coverage-none">Not checked yet — click Check Review to include this section.</div>';
  }
  const status = ['covered', 'partial', 'missing'].includes(result.status) ? result.status : 'partial';
  const snapSection = result.section || '';
  const snapDescription = result.description || '';
  const stale = snapSection !== (item.section || '').trim()
    || snapDescription !== (item.description || '').trim();
  const evidence = Array.isArray(result.evidence) ? result.evidence : [];
  const evidenceHtml = evidence.length
    ? `<div class="review-component-evidence">Evidence: ${evidence.map((e) =>
        `<a data-note-id="${escapeAttr(e.id)}" data-page="${e.page_number || 0}" title="Scroll to this annotation">page ${e.page_number || '?'} — "${escapeHtml(e.preview || '')}"</a>`
      ).join(', ')}</div>`
    : '';
  const gapHtml = result.gap_summary
    ? `<div class="review-component-gap">${escapeHtml(result.gap_summary)}</div>`
    : '';
  return `
    <div class="rubric-coverage${stale ? ' rubric-coverage-stale' : ''}"
         data-snap-section="${escapeAttr(snapSection)}"
         data-snap-description="${escapeAttr(snapDescription)}">
      <div class="review-component-header">
        <span class="review-status-dot review-status-${status}" title="${status}"></span>
        <span class="rubric-coverage-status">${status}</span>
        <span class="rubric-coverage-stale-note">edited since last check</span>
      </div>
      ${gapHtml}
      ${evidenceHtml}
    </div>
  `;
}

function attachCoverageEvidenceHandlers(container) {
  container.querySelectorAll('.rubric-coverage .review-component-evidence a').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.runtime.sendMessage({
        action: 'scrollToHighlight',
        noteId: a.dataset.noteId,
        pageNumber: parseInt(a.dataset.page, 10) || 0,
      }).catch(() => {});
    });
  });
}

// Live staleness: when a card's fields diverge from the snapshot its verdict
// ran against, flag the verdict; un-flag if the user reverts the edit.
function markCoverageStaleness(card) {
  const cov = card?.querySelector('.rubric-coverage');
  if (!cov || !('snapSection' in cov.dataset)) return;
  const section = (card.querySelector('[data-field="section"]')?.value || '').trim();
  const description = (card.querySelector('[data-field="description"]')?.value || '').trim();
  const stale = section !== cov.dataset.snapSection
    || description !== cov.dataset.snapDescription;
  cov.classList.toggle('rubric-coverage-stale', stale);
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
  return currentRubricItemsWithIds().map(({ section, description }) => ({ section, description }));
}

// Same, but keeps each card's store id — the coverage check needs ids so
// verdicts map back onto the cards. Kept separate so template saving doesn't
// persist ids it doesn't use.
function currentRubricItemsWithIds() {
  const items = [];
  document.querySelectorAll('#rubric-container .rubric-card').forEach((card) => {
    const section = (card.querySelector('[data-field="section"]')?.value || '').trim();
    const description = (card.querySelector('[data-field="description"]')?.value || '').trim();
    if (section || description) items.push({ id: card.dataset.id, section, description });
  });
  return items;
}

// Enabled iff the rubric tab currently shows at least one non-empty section.
function updateCheckReviewButtonState() {
  const btn = document.getElementById('check-review-btn');
  if (btn) btn.disabled = currentRubricItemsFromDom().length === 0;
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
    const friendly = describeApiError(err, 'Extraction').text;
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
  const isPending = note.cleanup_status === 'pending';
  const pendingBadge = isPending
    ? '<span class="note-pending-badge" title="Saved offline — raw transcript, not yet cleaned">Pending cleanup</span>'
    : '';
  const actions = withActions ? `
      <div class="note-actions">
        <button class="note-edit" data-id="${note.id}" title="Edit cleaned text">Edit</button>
        <button class="note-reclean" data-id="${note.id}" title="${isPending ? 'Clean with LLM' : 'Re-clean with LLM'}">${isPending ? 'Clean' : 'Re-clean'}</button>
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
        ${pendingBadge}
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
        // Surface a classified message — e.g. offline mode or a missing API
        // key both point the user at Settings.
        alert(describeApiError(err, 'Cleaning the note').text);
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

// Default Save-As path for the generated review: the previously chosen file,
// else <pdf directory>\<paper>_review.md, else the bare filename when the
// PDF's folder can't be determined.
function defaultReviewSavePath(saved) {
  if (saved && saved.review_file_path) return saved.review_file_path;
  const base = `${notesFilenameBase()}_review.md`;
  const dir = (typeof getPdfDirectory === 'function' ? getPdfDirectory() : '') || '';
  if (!dir) return base;
  return dir + (dir.includes('\\') ? '\\' : '/') + base;
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
    alert(describeApiError(err, 'Export').text);
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
    alert(describeApiError(err, 'Export').text);
    console.error('Export error:', err);
  }
}

// ─── Review coverage check ─────────────────────────────────────────────────
//
// Judges each rubric section against the notes (one verdict per section) and
// persists the result. The report renders directly on the Rubric tab's cards
// (see renderRubricCard / renderCoverageBlock) so it stays visible instead of
// living in a dismissable modal.

async function runRubricCoverageCheck() {
  if (!currentPdfId) {
    alert('Open a PDF first.');
    return;
  }
  const items = currentRubricItemsWithIds();
  // The button is disabled until the rubric has a non-empty section, so this
  // is just a defensive guard.
  if (items.length === 0) return;

  const btn = document.getElementById('check-review-btn');
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = 'Checking…';
  try {
    const result = await api.runReviewCheck(currentPdfId, items);
    if (result && result.note_count === 0) {
      rubricCheckError = 'No annotations yet — highlight text in the PDF and add some notes, then check again.';
    } else if (result && result.parse_error) {
      rubricCheckError = 'The model returned unexpected output. Try Check Review again.';
    } else {
      rubricCheckError = null;
    }
  } catch (err) {
    rubricCheckError = describeApiError(err, 'Check').text;
  } finally {
    btn.textContent = originalLabel;
    // loadRubric re-renders the cards with the fresh result and restores the
    // button's enabled state via updateCheckReviewButtonState.
    await loadRubric();
  }
}

// ─── Reflections (Review tab) ─────────────────────────────────────────────
//
// The reviewer's overall impressions of the paper, captured (typed or spoken)
// in the Review tab before generating a review. Stored per PDF via
// /api/reflections/ and fed to review generation as a distinct prompt section
// that frames the draft. Voice input reuses SpeechCapture (lib/speech.js) and
// content.js's shouldSkipServerTranscribe — all three scripts share this
// document's global scope.

const REFLECTION_MIC_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
  <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
  <line x1="12" y1="19" x2="12" y2="23"/>
  <line x1="8" y1="23" x2="16" y2="23"/>
</svg>`;

// Sidebar-local capture instance — content.js's global `speechCapture` has
// onEnd/onError handlers belonging to the viewer's annotation flow.
let reflectionCapture = null;

// Wire a mic button: click starts recording (pulsing button + a temporary
// Cancel next to it), clicking again stops. The final transcript — Whisper's
// when available, else the live one — is passed to onFinal(text).
function wireReflectionMic(micBtn, onFinal) {
  let cancelBtn = null;
  const setRecording = (on) => {
    micBtn.classList.toggle('recording', on);
    micBtn.title = on ? 'Stop recording' : 'Record a reflection';
    if (on) {
      cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'toolbar-btn reflection-cancel-btn';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => {
        reflectionCapture.cancel();
        setRecording(false);
      });
      micBtn.after(cancelBtn);
    } else if (cancelBtn) {
      cancelBtn.remove();
      cancelBtn = null;
    }
  };

  micBtn.addEventListener('click', () => {
    if (!reflectionCapture) reflectionCapture = new SpeechCapture();
    if (micBtn.classList.contains('recording')) {
      reflectionCapture.stop();
      return;
    }
    reflectionCapture.onEnd = async (transcript, audioBlob) => {
      setRecording(false);
      let finalText = (transcript || '').trim();
      const skipServer = await shouldSkipServerTranscribe();
      if (!skipServer && audioBlob && audioBlob.size > 0) {
        try {
          const whisperResult = await api.transcribe(audioBlob);
          if (whisperResult.text) finalText = whisperResult.text;
        } catch (err) {
          console.log('PDF Converser: Whisper unavailable for reflection, using live transcript', err.message);
        }
      }
      if (finalText) onFinal(finalText);
      else alert('No speech detected. Try again.');
    };
    reflectionCapture.onError = (error) => {
      setRecording(false);
      alert(error === 'not-allowed'
        ? 'Microphone permission denied. Please allow microphone access and try again.'
        : `Speech recognition error: ${error}`);
    };
    setRecording(true);
    reflectionCapture.start();
  });
}

async function loadReflections() {
  const container = document.getElementById('reflections-container');
  if (!currentPdfId) {
    container.innerHTML = '';
    return;
  }
  try {
    const data = await api.getReflections(currentPdfId);
    renderReflections(data.reflections || []);
  } catch (err) {
    renderErrorState(container, err, 'Loading reflections');
    console.error('PDF Converser sidebar error:', err);
  }
}

function renderReflections(reflections) {
  const container = document.getElementById('reflections-container');
  container.innerHTML = `
    <div class="reflection-header">Overall reflections</div>
    <p class="reflection-hint">Your overall impressions of the paper — they frame the generated review.</p>
    <div class="reflection-list"></div>
    <div class="reflection-add-row">
      <textarea class="reflection-input" placeholder="Overall impressions, final thoughts…"></textarea>
      <button class="toolbar-btn reflection-mic-btn" title="Record a reflection">${REFLECTION_MIC_SVG}</button>
      <button class="toolbar-btn review-primary reflection-add-btn" disabled>Add</button>
    </div>
  `;

  const list = container.querySelector('.reflection-list');
  for (const r of reflections) {
    const card = document.createElement('div');
    card.className = 'reflection-card';

    const textEl = document.createElement('div');
    textEl.className = 'reflection-text';
    textEl.textContent = r.cleaned_text || r.raw_transcript || '';

    // Same disclosure as note cards (reuses .note-raw styling).
    const raw = document.createElement('details');
    raw.className = 'note-raw';
    const rawSummary = document.createElement('summary');
    rawSummary.textContent = 'Raw transcript';
    const rawText = document.createElement('p');
    rawText.textContent = r.raw_transcript || '';
    raw.append(rawSummary, rawText);

    const meta = document.createElement('div');
    meta.className = 'reflection-meta';
    meta.textContent = r.created_at ? formatTime(r.created_at) : '';
    if (r.cleanup_status === 'pending') {
      const badge = document.createElement('span');
      badge.className = 'reflection-pending';
      badge.textContent = 'not cleaned';
      badge.title = 'Saved as spoken — it could not be LLM-cleaned (offline or no API key). The raw text still feeds the review.';
      meta.appendChild(badge);
    }

    // Same actions row as note cards (reuses .note-actions styling).
    const actions = document.createElement('div');
    actions.className = 'note-actions';
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.title = 'Edit reflection text';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => openReflectionEditor(card, r));
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'note-delete';
    delBtn.title = 'Delete this reflection';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', async () => {
      if (!confirm('Delete this reflection?')) return;
      try {
        await api.deleteReflection(r.id, currentPdfId);
        await loadReflections();
      } catch (err) {
        alert(`Failed to delete the reflection: ${err?.message || err}`);
      }
    });
    actions.append(editBtn, delBtn);

    card.append(textEl, raw, meta, actions);
    list.appendChild(card);
  }

  const input = container.querySelector('.reflection-input');
  const addBtn = container.querySelector('.reflection-add-btn');
  input.addEventListener('input', () => {
    addBtn.disabled = input.value.trim().length === 0;
  });
  addBtn.addEventListener('click', async () => {
    const text = input.value.trim();
    if (!text) return;
    addBtn.disabled = true;
    addBtn.textContent = 'Adding…';
    try {
      // Typed text is stored verbatim; only voice transcripts get LLM cleanup.
      await submitReflection(text, { skipCleanup: true });
    } catch (err) {
      addBtn.disabled = false;
      addBtn.textContent = 'Add';
      alert(`Failed to add the reflection: ${err?.message || err}`);
    }
  });

  wireReflectionMic(container.querySelector('.reflection-mic-btn'), async (text) => {
    try {
      await submitReflection(text, { skipCleanup: false });
    } catch (err) {
      alert(`Failed to add the reflection: ${err?.message || err}`);
    }
  });
}

// Swap the reflection text for an inline textarea + save/cancel, mirroring
// the note-card comment editor (and reusing its .note-comment-edit styling).
// Saving updates cleaned_text and re-renders the list.
function openReflectionEditor(card, reflection) {
  const textEl = card.querySelector('.reflection-text');
  if (!textEl || textEl.dataset.editing === '1') return;
  textEl.dataset.editing = '1';
  const prevHtml = textEl.innerHTML;
  textEl.innerHTML = `
    <textarea class="note-comment-edit"></textarea>
    <div class="note-comment-edit-actions">
      <button class="note-comment-save">Save</button>
      <button class="note-comment-cancel">Cancel</button>
    </div>
  `;
  const textarea = textEl.querySelector('textarea');
  textarea.value = reflection.cleaned_text || reflection.raw_transcript || '';
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);

  const restore = () => {
    textEl.innerHTML = prevHtml;
    delete textEl.dataset.editing;
  };

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      restore();
    }
  });
  textEl.querySelector('.note-comment-cancel').addEventListener('click', restore);
  textEl.querySelector('.note-comment-save').addEventListener('click', async () => {
    const value = textarea.value.trim();
    if (!value) {
      alert('Reflection text cannot be empty.');
      return;
    }
    try {
      await api.updateReflection(reflection.id, currentPdfId, { cleaned_text: value });
      await loadReflections();
    } catch (err) {
      alert(`Failed to save the edit: ${err?.message || err}`);
      restore();
    }
  });
}

// Saves a reflection and re-renders the list (which rebuilds the add row).
async function submitReflection(text, { skipCleanup } = {}) {
  await api.createReflection({
    pdf_identifier: currentPdfId,
    raw_transcript: text,
    skip_cleanup: !!skipCleanup,
  });
  await loadReflections();
}

// Pre-generation nudge shown when the paper has no reflections yet. Resolves
// 'skip' (generate without one), { text, fromVoice } (save it, then
// generate), or null (cancel — don't generate). fromVoice tracks whether the
// textarea content came from the mic so the transcript still gets LLM-cleaned
// unless the user edited it.
function promptReflectionNudge() {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'review-modal-backdrop';
    backdrop.innerHTML = `
      <div class="review-modal" role="dialog" aria-label="Add a reflection">
        <div class="review-modal-header">
          <span>Add a reflection first?</span>
          <button class="review-modal-close" title="Close" aria-label="Close">&times;</button>
        </div>
        <div class="review-modal-body">
          <p class="review-modal-hint">Before drafting, take a moment to capture your overall impression of the paper — it frames and structures the generated review. Type or record it below, or skip straight to generating.</p>
          <div class="reflection-add-row">
            <textarea class="reflection-input" placeholder="Overall impressions, final thoughts…"></textarea>
            <button class="toolbar-btn reflection-mic-btn" title="Record a reflection">${REFLECTION_MIC_SVG}</button>
          </div>
        </div>
        <div class="review-modal-footer">
          <button class="toolbar-btn reflection-skip">Skip</button>
          <button class="toolbar-btn review-primary reflection-continue" disabled>Add &amp; Generate</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);

    const textarea = backdrop.querySelector('.reflection-input');
    const continueBtn = backdrop.querySelector('.reflection-continue');
    let fromVoice = false;
    let escHandler;
    const done = (value) => {
      if (reflectionCapture) reflectionCapture.cancel();
      backdrop.remove();
      if (escHandler) document.removeEventListener('keydown', escHandler);
      resolve(value);
    };

    const sync = () => { continueBtn.disabled = textarea.value.trim().length === 0; };
    textarea.addEventListener('input', () => { fromVoice = false; sync(); });
    wireReflectionMic(backdrop.querySelector('.reflection-mic-btn'), (text) => {
      textarea.value = text;
      fromVoice = true;
      sync();
    });

    continueBtn.addEventListener('click', () => {
      const text = textarea.value.trim();
      if (text) done({ text, fromVoice });
    });
    backdrop.querySelector('.reflection-skip').addEventListener('click', () => done('skip'));
    backdrop.querySelector('.review-modal-close').addEventListener('click', () => done(null));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) done(null); });
    escHandler = (e) => { if (e.key === 'Escape') done(null); };
    document.addEventListener('keydown', escHandler);

    textarea.focus();
  });
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
    if (!saved || saved.empty || (!saved.review_text && !saved.thinking_text)) {
      container.innerHTML = '<p class="empty-state">No review yet. Click Generate Review to draft one.</p>';
    } else {
      renderReviewEditor(saved);
    }
  } catch (err) {
    renderErrorState(container, err, 'Loading the review');
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

  // No reflections yet — nudge for one before drafting. A failed count check
  // must not block generation, so the default is to proceed as if skipped.
  let nudgeChoice = 'skip';
  try {
    const { total } = await api.getReflections(currentPdfId);
    if (total === 0) nudgeChoice = await promptReflectionNudge();
  } catch (err) {
    console.error('PDF Converser: reflection check failed, generating anyway', err);
  }
  if (nudgeChoice === null) return; // modal cancelled — don't generate
  if (nudgeChoice !== 'skip') {
    try {
      await submitReflection(nudgeChoice.text, { skipCleanup: !nudgeChoice.fromVoice });
    } catch (err) {
      alert(`Failed to save the reflection: ${err?.message || err}`);
      return;
    }
  }

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
    // The draft is already persisted in the store; writing an .md file happens
    // only when the user clicks Save.
    renderReviewEditor(result);
  } catch (err) {
    stopReviewStream();
    const msg = String(err?.message || err);
    const container = document.getElementById('review-container');
    const d = describeApiError(err, 'Generation');
    if (d.kind === 'not_configured') {
      // Review generation has its own provider tab, so point at it explicitly.
      container.innerHTML = '<p class="error-state">No LLM is configured for review generation. Open Settings → Review (or Text Processing) and add an API key for the chosen provider.</p>';
    } else if (/document text/i.test(msg)) {
      container.innerHTML = '<p class="error-state">Document text is not available yet. Make sure the PDF has fully loaded, then try again.</p>';
    } else {
      container.innerHTML = `<p class="error-state">${escapeHtml(d.text)}</p>`;
    }
  } finally {
    reviewGenerating = false;
    if (genBtn) genBtn.disabled = false;
  }
}

// Editable draft view: textarea + meta (timestamp / saved path) + Save / Copy,
// plus a collapsed read-only box with the model's reasoning/commentary from
// generation. Save always opens a Save-As dialog (defaulting to the current
// file or the PDF's folder) and writes the textarea content there.
function renderReviewEditor(saved) {
  const container = document.getElementById('review-container');
  const reviewText = saved.review_text || '';
  const thinkingText = saved.thinking_text || '';
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

  const commentaryBlock = thinkingText
    ? `<details class="review-thinking-wrap">
        <summary>Model commentary</summary>
        <div class="review-thinking review-commentary"></div>
      </details>`
    : '';

  container.innerHTML = `
    ${metaLine}
    ${missingLine}
    ${unsavedLine}
    ${emptyNotesLine}
    ${commentaryBlock}
    <textarea class="generated-review-edit" spellcheck="false">${escapeHtml(reviewText)}</textarea>
    <div class="review-editor-actions">
      <button class="toolbar-btn review-copy-btn">Copy</button>
      <button class="toolbar-btn review-primary review-save-btn">Save</button>
    </div>
  `;

  // Injected via textContent, not markup — the commentary is untrusted model
  // output and can be large.
  const commentaryEl = container.querySelector('.review-commentary');
  if (commentaryEl) commentaryEl.textContent = thinkingText;

  const textarea = container.querySelector('.generated-review-edit');
  const saveBtn = container.querySelector('.review-save-btn');

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
    const path = await window.desktop.chooseSavePath(defaultReviewSavePath(saved));
    if (!path) return; // cancelled — no state change
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      const updated = await api.saveGeneratedReview(currentPdfId, textarea.value, path);
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
