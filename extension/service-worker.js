// PDF Converser - Service Worker (Manifest V3 background script)

// Open side panel when extension icon is clicked
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });

// === PDF Navigation Interception ===
// Redirect PDF URLs to our custom viewer so we get a selectable text layer.
// Chrome's built-in PDF viewer uses <embed> which content scripts can't access.

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  // Only intercept top-level navigations (not iframes)
  if (details.frameId !== 0) return;

  const url = details.url;

  // Skip our own viewer page to avoid infinite redirect
  if (url.includes(chrome.runtime.id)) return;

  // Check if this is a PDF URL
  if (isPdfUrl(url)) {
    const viewerUrl = chrome.runtime.getURL('viewer/viewer.html') + '?file=' + encodeURIComponent(url);
    chrome.tabs.update(details.tabId, { url: viewerUrl });
  }
});

function isPdfUrl(url) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    // Match common PDF URL patterns
    if (path.endsWith('.pdf')) return true;
    // Some URLs serve PDFs without .pdf extension but with content-type header
    // We can't check headers here, so rely on the extension pattern
    return false;
  } catch {
    return false;
  }
}

// === Message Relay ===

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'noteCreated') {
    chrome.runtime.sendMessage(message).catch(() => {
      // Sidebar may not be open yet
    });
  }

  if (message.action === 'questionAnswered') {
    chrome.runtime.sendMessage(message).catch(() => {});
  }

  if (message.action === 'getCurrentPdfId') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'getPdfId' }, (response) => {
          if (chrome.runtime.lastError) {
            // Content script not available - try to get info from viewer page URL
            const tabUrl = tabs[0].url || '';
            if (tabUrl.includes('viewer.html')) {
              const fileParam = new URL(tabUrl).searchParams.get('file');
              sendResponse({
                pdfIdentifier: fileParam || null,
                pdfTitle: tabs[0].title || null,
              });
            } else {
              sendResponse({ pdfIdentifier: null, pdfTitle: null });
            }
          } else {
            sendResponse(response || { pdfIdentifier: null, pdfTitle: null });
          }
        });
      } else {
        sendResponse({ pdfIdentifier: null, pdfTitle: null });
      }
    });
    return true;
  }

  if (message.action === 'openSidePanel') {
    chrome.sidePanel.open({ tabId: sender.tab.id });
  }

  // Bidirectional linking: relay scrollToNote from content script to sidebar
  if (message.action === 'scrollToNote') {
    chrome.runtime.sendMessage(message).catch(() => {});
  }

  // Bidirectional linking: relay scrollToHighlight from sidebar to content script
  if (message.action === 'scrollToHighlight') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, message).catch(() => {});
      }
    });
  }
});

// === Tab Switch Detection ===
// When the user switches tabs, notify the sidebar so it can reload notes for the new PDF.

chrome.tabs.onActivated.addListener((activeInfo) => {
  chrome.tabs.sendMessage(activeInfo.tabId, { action: 'getPdfId' }, (response) => {
    if (chrome.runtime.lastError) {
      // Content script not available — try to extract from viewer URL
      chrome.tabs.get(activeInfo.tabId, (tab) => {
        if (chrome.runtime.lastError) return;
        const tabUrl = tab?.url || '';
        let pdfIdentifier = null;
        let pdfTitle = null;
        if (tabUrl.includes('viewer.html')) {
          pdfIdentifier = new URL(tabUrl).searchParams.get('file');
          pdfTitle = tab.title || null;
        }
        chrome.runtime.sendMessage({
          action: 'tabChanged',
          pdfIdentifier,
          pdfTitle,
        }).catch(() => {});
      });
    } else {
      chrome.runtime.sendMessage({
        action: 'tabChanged',
        pdfIdentifier: response?.pdfIdentifier || null,
        pdfTitle: response?.pdfTitle || null,
      }).catch(() => {});
    }
  });
});
