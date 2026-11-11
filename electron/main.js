import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron';

const PORT = +(process.env.LOCAL_AI_PORT || 18700);
const URL_ = `http://127.0.0.1:${PORT}`;

// An already-running server (a service, another install) is reused instead of fought over.
const existing = () => fetch(`${URL_}/api/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.json()).then((j) => j.app === 'local-ai').catch(() => false);

// The panel is drawn 260 by 480 and shown at up to one and a half times that. When the page shows the panel, the
// window takes exactly that shape, so there is nothing around it, and keeps the shape while it is resized. When the
// page goes back to the desktop layout the window gets back the size it had.
const PANEL = { w: 260, h: 480, most: 1.5 }, ROOMY = { w: 420, h: 500 };
let before = null;
function fit(win, compact, tries = 0) {
  if (win.isDestroyed()) return;
  if (win.isFullScreen()) { if (compact && tries < 20) setTimeout(() => fit(win, compact, tries + 1), 150); return; } // still leaving fullscreen
  const [ow, oh] = win.getSize(), [cw, ch] = win.getContentSize(), dw = ow - cw, dh = oh - ch; // the window's own edges and title bar
  if (compact) {
    const room = screen.getDisplayMatching(win.getBounds()).workAreaSize;
    const k = Math.max(1, Math.min(PANEL.most, (room.height - dh) / PANEL.h, (room.width - dw) / PANEL.w));
    before ||= win.getBounds();
    win.setMinimumSize(PANEL.w + dw, PANEL.h + dh);
    win.setMaximumSize(Math.round(PANEL.w * k) + dw, Math.round(PANEL.h * k) + dh);
    win.setAspectRatio(PANEL.w / PANEL.h, { width: dw, height: dh });
    win.setContentSize(Math.round(PANEL.w * k), Math.round(PANEL.h * k));
  } else if (before) {
    win.setAspectRatio(0);
    win.setMaximumSize(10000, 10000);
    win.setMinimumSize(ROOMY.w, ROOMY.h);
    win.setBounds(before);
    before = null;
  }
}
ipcMain.handle('compact', (e, on) => { const win = BrowserWindow.fromWebContents(e.sender); if (win) fit(win, on === true); });

async function boot() {
  let server = null;
  if (!(await existing())) server = await (await import('../server/index.js')).start();
  const win = new BrowserWindow({ width: 1080, height: 820, minWidth: ROOMY.w, minHeight: ROOMY.h, backgroundColor: '#161616', autoHideMenuBar: true, title: 'Local AI',
    webPreferences: { preload: join(dirname(fileURLToPath(import.meta.url)), 'preload.cjs') } });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  await win.loadURL(URL_);
  app.on('before-quit', () => server?.stop());
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => BrowserWindow.getAllWindows()[0]?.focus());
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(boot).catch((e) => { dialog.showErrorBox('Local AI could not start', e.message); app.quit(); });
}
