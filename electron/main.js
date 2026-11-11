import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron';

const PORT = +(process.env.LOCAL_AI_PORT || 18700);
const URL_ = `http://127.0.0.1:${PORT}`;

// An already-running server (a service, another install) is reused instead of fought over.
const existing = () => fetch(`${URL_}/api/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.json()).then((j) => j.app === 'local-ai').catch(() => false);

// The panel is drawn in units of its own: the page says how wide and how tall (taller when Home shows more), and it
// is shown at up to one and a half times that.
// When the page shows the panel, the window takes exactly that shape, so there is nothing around it and nothing cut
// off, and keeps the shape while it is resized. When the page goes back to the desktop layout the window gets back the
// size it had.
const PANEL = { w: 312, h: 432, widest: 600, tallest: 1400, most: 1.5 }, ROOMY = { w: 640, h: 500 }; // the desktop layout needs 640; narrower than that the page would show the panel with room around it
let before = null;
function fit(win, compact, height = 0, width = 0, tries = 0) {
  if (win.isDestroyed()) return;
  if (win.isFullScreen()) { if (compact && tries < 20) setTimeout(() => fit(win, compact, height, width, tries + 1), 150); return; } // still leaving fullscreen
  const h = Math.min(PANEL.tallest, Math.max(200, Math.round(height) || PANEL.h)), w = Math.min(PANEL.widest, Math.max(200, Math.round(width) || PANEL.w));
  const [ow, oh] = win.getSize(), [cw, ch] = win.getContentSize(), dw = ow - cw, dh = oh - ch; // the window's own edges and title bar
  if (compact) {
    const room = screen.getDisplayMatching(win.getBounds()).workAreaSize;
    const k = Math.max(0.75, Math.min(PANEL.most, (room.height - dh) / h, (room.width - dw) / w));
    before ||= win.getBounds();
    win.setAspectRatio(0);
    win.setMinimumSize(Math.round(w * Math.min(1, k)) + dw, Math.round(h * Math.min(1, k)) + dh);
    win.setMaximumSize(Math.round(w * k) + dw, Math.round(h * k) + dh);
    win.setAspectRatio(w / h, { width: dw, height: dh });
    win.setContentSize(Math.round(w * k), Math.round(h * k));
  } else if (before) {
    win.setAspectRatio(0);
    win.setMaximumSize(10000, 10000);
    win.setMinimumSize(ROOMY.w, ROOMY.h);
    win.setBounds(before);
    before = null;
  }
}
ipcMain.handle('compact', (e, on, height, width) => { const win = BrowserWindow.fromWebContents(e.sender); if (win) fit(win, on === true, +height || 0, +width || 0); });

const ICON = join(dirname(fileURLToPath(import.meta.url)), 'icon.png');

async function boot() {
  app.dock?.setIcon(ICON); // run from source there is no bundle to carry the icon
  let server = null;
  if (!(await existing())) server = await (await import('../server/index.js')).start();
  const win = new BrowserWindow({ width: 1080, height: 820, minWidth: ROOMY.w, minHeight: ROOMY.h, backgroundColor: '#161616', autoHideMenuBar: true, title: 'Local AI', icon: ICON,
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
