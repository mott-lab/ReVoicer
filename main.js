const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, net, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const apiStub = require('./api-stub');
const { getSettingsStore } = require('./services/settings-store');
const { getRecentFiles } = require('./services/recent-files');

const PROJECT_ROOT = __dirname;
const START_HTML = path.join(__dirname, 'start.html');
const SETTINGS_HTML = path.join(__dirname, 'settings.html');

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

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 580,
    height: 560,
    parent: mainWindow || undefined,
    modal: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Settings',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(SETTINGS_HTML);
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
ipcMain.handle('desktop:openSettings', () => openSettingsWindow());
ipcMain.handle('desktop:getSettings', () => getSettingsStore().get());
ipcMain.handle('desktop:saveSettings', async (_e, updates) => {
  const result = await getSettingsStore().save(updates || {});
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
ipcMain.handle('api:request', (_event, req) => apiStub.handleRequest(req));
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
