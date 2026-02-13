// PDF Converser - Popup (Settings)

const api = new ApiClient();

async function init() {
  // Load saved settings
  const stored = await chrome.storage.local.get('backendUrl');
  const urlInput = document.getElementById('backend-url');
  urlInput.value = stored.backendUrl || 'http://localhost:8000/api';

  // Check backend health
  await checkHealth(urlInput.value);

  // Save button
  document.getElementById('save-btn').addEventListener('click', async () => {
    const newUrl = urlInput.value.trim().replace(/\/$/, '');
    await chrome.storage.local.set({ backendUrl: newUrl });
    showSaveMsg('Settings saved!');
    await checkHealth(newUrl);
  });

  // Open sidebar button
  document.getElementById('sidebar-btn').addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.sidePanel.open({ tabId: tabs[0].id });
      }
    });
  });
}

async function checkHealth(url) {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');

  try {
    const resp = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      dot.className = 'status-dot connected';
      text.textContent = 'Backend connected';
    } else {
      dot.className = 'status-dot error';
      text.textContent = `Backend error (${resp.status})`;
    }
  } catch {
    dot.className = 'status-dot disconnected';
    text.textContent = 'Backend not reachable';
  }
}

function showSaveMsg(msg) {
  const el = document.getElementById('save-msg');
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 2000);
}

init();
