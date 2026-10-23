'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu } = require('electron');
const path = require('path');
const { createHandlers } = require('./handlers');

let win;
// a separate data folder, for tests or a second set of snapshots
if (process.env.FPP_DATA_DIR) app.setPath('userData', process.env.FPP_DATA_DIR);
const SNAPSHOT_FILTER = [{ name: 'Forever Profile Porter snapshot', extensions: ['ffpsnap', 'zip'] }];

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#14110f',
    title: 'Forever Profile Porter',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  const handlers = createHandlers({
    dataDir: app.getPath('userData'),
    version: app.getVersion(),
    pickFolder: async (title, defaultPath) => {
      const r = await dialog.showOpenDialog(win, { title, defaultPath: defaultPath || undefined, properties: ['openDirectory'] });
      return r.canceled ? null : r.filePaths[0];
    },
    saveFile: async (title, defaultPath) => {
      const r = await dialog.showSaveDialog(win, { title, defaultPath, filters: SNAPSHOT_FILTER });
      return r.canceled ? null : r.filePath;
    },
    openFile: async (title) => {
      const r = await dialog.showOpenDialog(win, { title, properties: ['openFile'], filters: SNAPSHOT_FILTER });
      return r.canceled ? null : r.filePaths[0];
    },
    openPath: (p) => shell.openPath(p),
    writeClipboard: (text) => clipboard.writeText(text),
  });
  // Every call resolves to { ok, value } or { ok: false, error } so the UI can show the message.
  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (_e, ...args) => {
      try {
        return { ok: true, value: await fn(...args) };
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
      }
    });
  }
  createWindow();
});
app.on('window-all-closed', () => app.quit());
