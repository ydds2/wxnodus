// WxNodus Electron Fixture — 同构控制模型（invoke 按钮/selection 列表/value 文本框/status 文本）
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({ width: 420, height: 300, title: 'WxNodus UIA Fixture' });
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.on('invoke', () => { console.log('invoked'); });
