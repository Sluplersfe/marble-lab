const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1500, height: 920, backgroundColor: '#f3f5f8', title: 'Marble Lab',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile('index.html');
  // The renderer reports unsaved edits; ask before throwing them away.
  win.on('close', (e) => {
    if (!dirty) return;
    const c = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['Discard changes', 'Cancel'], defaultId: 1, cancelId: 1,
      message: 'This track has unsaved changes.', detail: 'Close Marble Lab anyway?' });
    if (c === 1) e.preventDefault();
  });
}
let dirty = false;
ipcMain.on('dirty', (e, d) => { dirty = !!d; });

ipcMain.handle('save-file', async (e, { name, data, filters, binary }) => {
  const r = await dialog.showSaveDialog({ defaultPath: name, filters });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, binary ? Buffer.from(data, 'base64') : data);
  return r.filePath;
});
ipcMain.handle('write-file', async (e, { path: file, data }) => { fs.writeFileSync(file, data); return file; });
ipcMain.handle('open-file', async () => {
  const r = await dialog.showOpenDialog({ filters: [{ name: 'Marble track', extensions: ['marble', 'json'] }], properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return null;
  return { path: r.filePaths[0], data: fs.readFileSync(r.filePaths[0], 'utf8') };
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
