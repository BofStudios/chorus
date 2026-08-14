const path = require('path');
const { app, BrowserWindow, shell, Menu } = require('electron');
const ipc = require('./ipc');
const bridge = require('./bridge');

const isDev = process.argv.includes('--dev');

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// Registering chorus:// lets the browser extension bring this window to the
// front instead of telling the user to go find it themselves.
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('chorus', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('chorus');
}

let win = null;

function focusWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1020,
    minHeight: 660,
    show: false,
    backgroundColor: '#0b0e14',
    title: 'Chorus',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  if (isDev) {
    win.webContents.openDevTools({ mode: 'detach' });
    // Mirror renderer console output to the terminal — otherwise a renderer
    // error is invisible unless you happen to have devtools focused.
    win.webContents.on('console-message', (_event, level, message, line, source) => {
      const tag = ['debug', 'info', 'warn', 'error'][level] || 'log';
      console.log(`[renderer:${tag}] ${message}  (${source}:${line})`);
    });
  }

  // Anything the app links to opens in the real browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());
}

// Windows delivers chorus:// links as a second-instance launch.
app.on('second-instance', () => focusWindow());

// macOS delivers them here instead.
app.on('open-url', (event) => {
  event.preventDefault();
  focusWindow();
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  ipc.register(() => win);
  createWindow();

  // The extension bridge listens on 127.0.0.1 only; failing to bind is not fatal.
  try {
    await bridge.startBridge(() => {
      if (win && !win.isDestroyed()) win.webContents.send('watchlist:changed', {});
    });
  } catch (error) {
    console.error('Extension bridge did not start:', error.message);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  bridge.stopBridge();
  if (process.platform !== 'darwin') app.quit();
});
