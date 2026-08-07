// PDF Converser - Toolbar status indicator
// A colored light + one-word label in the top-right of the PDF toolbar.
// Replaces the info/success toasts: red blinking = recording, yellow =
// transcribing (speech-to-text) or processing (LLM work), green = ready.
// Errors still use toasts, which can carry a message and an action button.
//
// Multiple flows (annotations in content.js, reflections and review
// generation in sidebar.js) can overlap, so states are refcounted:
//   const release = statusIndicator.begin('recording' | 'transcribing' | 'processing');
//   ... release();   // idempotent
// Recording wins over transcribing, which wins over processing; ready when
// nothing is held.

(function () {
  const toolbar = document.getElementById('toolbar');
  if (!toolbar) return;

  const el = document.createElement('div');
  el.id = 'pcr-status';
  el.className = 'pcr-status pcr-status-ready';
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = '<span class="pcr-status-dot"></span><span class="pcr-status-label">Ready</span>';
  toolbar.appendChild(el);

  const counts = { recording: 0, transcribing: 0, processing: 0 };
  const labelEl = el.querySelector('.pcr-status-label');

  function render() {
    let state, label;
    if (counts.recording > 0) {
      state = 'recording';
      label = 'Recording';
    } else if (counts.transcribing > 0) {
      state = 'transcribing';
      label = 'Transcribing';
    } else if (counts.processing > 0) {
      state = 'processing';
      label = 'Processing';
    } else {
      state = 'ready';
      label = 'Ready';
    }
    el.className = `pcr-status pcr-status-${state}`;
    labelEl.textContent = label;
  }

  window.statusIndicator = {
    begin(kind) {
      if (!(kind in counts)) kind = 'processing';
      counts[kind]++;
      render();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        counts[kind]--;
        render();
      };
    },
  };
})();
