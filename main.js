const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, net, shell, screen } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const apiStub = require('./api-stub');
const { getSettingsStore } = require('./services/settings-store');
const { getRecentFiles } = require('./services/recent-files');

const PROJECT_ROOT = __dirname;
const START_HTML = path.join(__dirname, 'start.html');
const SETTINGS_HTML = path.join(__dirname, 'settings.html');
const APP_ICON = path.join(__dirname, 'icon', 'noun-transcript-2989894-FFB258.png');

// All app and PDF resources are served under a single privileged scheme so
// the renderer runs with the default `webSecurity: true`. Single-host
// (`pdfc://local/...`) keeps PDF and app responses same-origin.
const APP_URL = 'pdfc://local/app/app.html';

let mainWindow = null;
let settingsWindow = null;

protocol.registerSchemesAsPrivileged([{
  scheme: 'pdfc',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
    codeCache: true,
  },
}]);

function registerProtocol() {
  protocol.handle('pdfc', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'local') return new Response('Forbidden host', { status: 403 });

    const segments = url.pathname.split('/').filter(Boolean);
    const ns = segments[0];
    const rest = segments.slice(1);

    if (ns === 'app') {
      const rel = rest.map((s) => decodeURIComponent(s)).join('/');
      const safe = path.normalize(rel);
      if (safe.startsWith('..') || path.isAbsolute(safe)) {
        return new Response('Forbidden path', { status: 403 });
      }
      const target = path.join(PROJECT_ROOT, safe);
      return net.fetch(pathToFileURL(target).href);
    }

    if (ns === 'pdf') {
      // /<base64url(abs path)>
      const enc = decodeURIComponent(rest.join('/'));
      let abs;
      try {
        abs = Buffer.from(enc, 'base64url').toString('utf-8');
      } catch {
        return new Response('Bad pdf id', { status: 400 });
      }
      return net.fetch(pathToFileURL(abs).href);
    }

    return new Response('Not found', { status: 404 });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'PDF Converser',
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      // webSecurity stays on (default). The pdfc:// protocol handler keeps
      // app files and PDFs on the same origin so cross-origin checks pass.
    },
  });

  // Route any window.open(url) (e.g. PDF link annotations that fall back to
  // the default href) to the OS browser instead of opening a child Electron
  // window. http(s) only — file:// and other schemes are denied.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadFile(START_HTML);
}

// Remember the Settings window size/position across runs.
function settingsWindowStatePath() {
  return path.join(app.getPath('userData'), 'settings-window.json');
}
function readSettingsWindowState() {
  try {
    return JSON.parse(require('node:fs').readFileSync(settingsWindowStatePath(), 'utf-8'));
  } catch { return null; }
}
function writeSettingsWindowState(state) {
  try {
    require('node:fs').writeFileSync(settingsWindowStatePath(), JSON.stringify(state), 'utf-8');
  } catch { /* best effort */ }
}

// Keep restored Settings bounds within a currently connected display.
function visibleSettingsBounds(bounds) {
  const displays = screen.getAllDisplays();
  const display = displays.find(({ workArea }) =>
    bounds.x < workArea.x + workArea.width
    && bounds.x + bounds.width > workArea.x
    && bounds.y < workArea.y + workArea.height
    && bounds.y + bounds.height > workArea.y
  ) || screen.getPrimaryDisplay();
  const area = display.workArea;
  return {
    ...bounds,
    x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - bounds.width)),
    y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - bounds.height)),
  };
}

function openSettingsWindow(tab) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    if (tab && typeof tab === 'string') {
      settingsWindow.webContents.send('desktop:switchSettingsTab', tab);
    }
    return;
  }

  const saved = readSettingsWindowState();
  let bounds;
  if (saved && saved.width && saved.height) {
    bounds = {
      width: saved.width,
      height: saved.height,
      x: Number.isInteger(saved.x) ? saved.x : 0,
      y: Number.isInteger(saved.y) ? saved.y : 0,
    };
  } else if (mainWindow && !mainWindow.isDestroyed()) {
    // Default to nearly the full main-window area, centered over it.
    const b = mainWindow.getBounds();
    const width = Math.round(b.width * 0.92);
    const height = Math.round(b.height * 0.92);
    bounds = { width, height, x: b.x + Math.round((b.width - width) / 2), y: b.y + Math.round((b.height - height) / 2) };
  } else {
    bounds = { width: 1000, height: 760 };
  }

  bounds = visibleSettingsBounds(bounds);

  settingsWindow = new BrowserWindow({
    ...bounds,
    minWidth: 520,
    minHeight: 480,
    parent: mainWindow || undefined,
    modal: false,
    resizable: true,
    minimizable: true,
    maximizable: true,
    title: 'Settings',
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(SETTINGS_HTML, tab && typeof tab === 'string' ? { hash: tab } : undefined)
    .catch((err) => {
      console.error('[settings] failed to load settings window:', err);
    });
  settingsWindow.show();
  settingsWindow.focus();

  // Persist the size/position the user left it at (use the un-maximized rect so
  // a maximized window restores to a sensible size next time).
  settingsWindow.on('close', () => {
    if (!settingsWindow || settingsWindow.isDestroyed()) return;
    const b = settingsWindow.getNormalBounds();
    writeSettingsWindowState({
      x: b.x, y: b.y, width: b.width, height: b.height,
    });
  });
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

function buildMenu() {
  const recent = getRecentFiles().list();

  const recentSubmenu = recent.length > 0
    ? [
        ...recent.map((p) => ({
          label: shortPath(p),
          toolTip: p,
          click: () => loadPdf(p),
        })),
        { type: 'separator' },
        { label: 'Clear Recent', click: async () => { await getRecentFiles().clear(); buildMenu(); } },
      ]
    : [{ label: 'No recent files', enabled: false }];

  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open PDF…',
          accelerator: 'CmdOrCtrl+O',
          click: () => openPdfDialog(),
        },
        { label: 'Open Recent', submenu: recentSubmenu },
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => openSettingsWindow(),
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function shortPath(absPath) {
  // Show the filename plus the parent directory for disambiguation.
  const dir = path.basename(path.dirname(absPath));
  const file = path.basename(absPath);
  return dir ? `${dir}${path.sep}${file}` : file;
}

async function openPdfDialog() {
  if (!mainWindow) return;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open PDF',
    properties: ['openFile'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return;
  loadPdf(result.filePaths[0]);
}

async function loadPdf(absolutePath) {
  if (!mainWindow) return;
  // Verify file still exists; if not, drop it from recents and notify.
  const fs = require('node:fs');
  if (!fs.existsSync(absolutePath)) {
    await getRecentFiles().remove(absolutePath);
    buildMenu();
    dialog.showErrorBox('PDF not found', `Could not open:\n${absolutePath}\n\nThe file may have been moved or deleted.`);
    return;
  }
  const pdfUrl = `pdfc://local/pdf/${Buffer.from(absolutePath).toString('base64url')}`;
  const target = `${APP_URL}?file=${encodeURIComponent(pdfUrl)}`;
  mainWindow.loadURL(target);
  await getRecentFiles().add(absolutePath);
  buildMenu();
}

ipcMain.handle('desktop:openPdfDialog', () => openPdfDialog());
ipcMain.handle('desktop:openPdfPath', (_e, absPath) => loadPdf(absPath));
ipcMain.handle('desktop:getRecentFiles', () => getRecentFiles().list());
ipcMain.handle('desktop:openSettings', (_e, tab) => openSettingsWindow(tab));
ipcMain.handle('desktop:getSettings', () => getSettingsStore().get());
ipcMain.handle('desktop:saveSettings', async (_e, updates) => {
  const result = await getSettingsStore().save(updates || {});
  // The bib library path may have changed — warm-reload before the broadcast
  // so the sidebar's refreshed status is already current.
  require('./services/bib-library-service').getBibLibrary().refresh().catch(() => {});
  // Settings live in their own window; ping the main window so the PDF pane can
  // re-render highlights (the auto-color toggle changes their colors).
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('desktop:settingsChanged');
  }
  return result;
});
ipcMain.handle('desktop:testConnection', (_e, provider, params) => {
  const { testConnection } = require('./services/llm-service');
  return testConnection(provider, params || {});
});
// Deterministic (no-network) LLM readiness check for renderer preflights.
// `cleanupEnabled` rides along so note flows know whether saving invokes the
// LLM at all.
ipcMain.handle('desktop:llmStatus', (_e, opts) => {
  const { llmConfigStatus } = require('./services/llm-service');
  const status = llmConfigStatus(opts || {});
  status.cleanupEnabled = getSettingsStore().get().cleanup_enabled !== false;
  return status;
});

// Folder/file pickers used by the Settings window (e.g. the Review tab's
// example-reviews folder and instructions file). Parent the dialog to whichever
// window invoked it so it's modal to Settings, not the main window.
async function pickPath(event, properties, filters) {
  const parent = BrowserWindow.fromWebContents(event.sender);
  const opts = { properties };
  if (filters) opts.filters = filters;
  const result = parent
    ? await dialog.showOpenDialog(parent, opts)
    : await dialog.showOpenDialog(opts);
  if (result.canceled || result.filePaths.length === 0) return '';
  return result.filePaths[0];
}
ipcMain.handle('desktop:selectDirectory', (e) => pickPath(e, ['openDirectory']));
ipcMain.handle('desktop:selectFile', (e, filters) =>
  pickPath(e, ['openFile'], Array.isArray(filters) && filters.length
    ? filters
    : [{ name: 'Text', extensions: ['txt', 'md'] }]));

// Native "Save As" dialog for the generated review file. Returns the chosen
// absolute path, or '' if cancelled.
ipcMain.handle('desktop:chooseSavePath', async (e, defaultPath) => {
  const parent = BrowserWindow.fromWebContents(e.sender);
  const opts = { filters: [{ name: 'Markdown', extensions: ['md'] }] };
  if (defaultPath) opts.defaultPath = defaultPath;
  const result = parent
    ? await dialog.showSaveDialog(parent, opts)
    : await dialog.showSaveDialog(opts);
  return result.canceled ? '' : (result.filePath || '');
});
ipcMain.handle('api:request', (_event, req) => apiStub.handleRequest(req));

// Streaming review generation: runs the LLM with a streaming callback, relaying
// each {thinking, text} snapshot to the renderer as a `desktop:reviewChunk`
// event, and resolves with the saved record when done. Errors reject the invoke.
ipcMain.handle('desktop:generateReview', (e, pdfIdentifier) => {
  const { generateReview } = require('./services/review-generate-service');
  return generateReview({
    pdfIdentifier,
    onChunk: (payload) => {
      if (!e.sender.isDestroyed()) e.sender.send('desktop:reviewChunk', payload);
    },
  });
});

// Generate a review style guide from the example reviews folder. Returns a
// result object rather than rejecting: Electron strips custom `code`/`status`
// props from errors that cross the invoke boundary, and the Settings UI needs
// the code to show a friendly message.
ipcMain.handle('desktop:generateStyleGuide', async (_e, overrides) => {
  const { generateStyleGuide } = require('./services/style-guide-service');
  try {
    const result = await generateStyleGuide(overrides || {});
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, code: err.code || '', message: err.message || String(err) };
  }
});
ipcMain.handle('desktop:openExternal', (_e, url) => {
  // Only allow web URLs — never let arbitrary input invoke shell with file://
  // or custom-scheme handlers.
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
  shell.openExternal(url);
  return true;
});

app.whenReady().then(() => {
  const userData = app.getPath('userData');
  getSettingsStore(path.join(userData, 'settings.json'));
  getRecentFiles(path.join(userData, 'recent-files.json'));
  apiStub.initialize({ notesDir: path.join(userData, 'notes') });
  // Warm-load the .bib reference library so the first References-tab visit
  // gets an instant status; failures land in the library's status object.
  require('./services/bib-library-service').getBibLibrary().refresh().catch(() => {});
  // Start the bundled claude-max-api-proxy unless one is already listening.
  require('./services/proxy-launcher').ensureProxy();
  registerProtocol();
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  require('./services/proxy-launcher').stopProxy();
});
