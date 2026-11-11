// The desktop app: a window onto the page the server serves. It starts the server if none is running, keeps the page
// from going anywhere else, and fits the window to the layout the page shows.
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, screen, session, shell } from 'electron';

const PORT = +(process.env.LOCAL_AI_PORT || 18700);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const HERE = dirname(fileURLToPath(import.meta.url));
const ICON = join(HERE, 'icon.png');

// An app opened from Finder gets a short PATH. The tools the server runs (docker, tailscale, python from Homebrew)
// live in these folders, so they are added before the server starts.
if (process.platform !== 'win32') process.env.PATH = [...new Set([...(process.env.PATH || '').split(':'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].filter(Boolean).join(':');

// This user's key, from the config file only this user can read. Null before Local AI has ever run here.
function savedKey() {
  try { return JSON.parse(readFileSync(join(process.env.LOCAL_AI_HOME || join(homedir(), '.local-ai'), 'config.json'), 'utf8')).key || null; } catch { return null; }
}
// An already-running server (a service, another install) is reused instead of fought over, but only once it has
// proved it holds this user's key. Anything else that answers on the port is not given the window, or the key.
// Returns the key, or null when the app should start its own server.
async function existing() {
  const key = savedKey(), nonce = randomBytes(16).toString('hex');
  if (!key) return null;
  const answer = await fetch(`${ORIGIN}/api/health?nonce=${nonce}`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json()).catch(() => null);
  if (answer?.app !== 'local-ai') return null;
  if (answer.proof === createHmac('sha256', key).update(nonce).digest('hex')) return key;
  throw new Error('Another copy of Local AI is already running here, and it is an older one or not yours. Quit it, then open this again.');
}

// The panel is drawn in units of its own: the page says how wide and how tall (taller when Home shows more), and it
// is shown at up to one and a half times that. When the page shows the panel, the window takes exactly that shape,
// so there is nothing around it and nothing cut off, and keeps the shape while it is resized. When the page goes back
// to the desktop layout the window gets back the size it had.
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

// What the page may do, and nothing more. It is this app's own page, but it shows text from other machines and from
// model cards, so the window is locked down as if that text could one day get the better of it.
const ours = (url) => { try { return new URL(url).origin === ORIGIN; } catch { return false; } };
const web = (url) => { try { return ['https:', 'http:'].includes(new URL(url).protocol); } catch { return false; } };
const ALLOWED = new Set(['fullscreen', 'clipboard-sanitized-write']); // the layout switch and the Copy buttons
function lockDown(contents) {
  // A link leaves the app for the browser, and only to a web address: never to a file or to another program.
  contents.setWindowOpenHandler(({ url }) => { if (web(url) && !ours(url)) shell.openExternal(url); return { action: 'deny' }; });
  contents.on('will-navigate', (event, url) => { if (ours(url)) return; event.preventDefault(); if (web(url)) shell.openExternal(url); });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}
app.on('web-contents-created', (_event, contents) => lockDown(contents));
// The one thing the page may ask of its window, and only the app's own page may ask it.
ipcMain.handle('compact', (e, on, height, width) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && ours(e.senderFrame?.url || '')) fit(win, on === true, +height || 0, +width || 0);
});

async function boot() {
  app.dock?.setIcon(ICON); // run from source there is no bundle to carry the icon
  session.defaultSession.setPermissionRequestHandler((_contents, permission, done) => done(ALLOWED.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => ALLOWED.has(permission));
  let server = null, key = await existing();
  if (!key) {
    try { server = await (await import('../server/index.js')).start(); } catch (e) { throw e.code === 'EADDRINUSE' ? new Error(`Port ${PORT} is in use by another program`, { cause: e }) : e; }
    key = server.key;
  }
  const win = new BrowserWindow({ width: 1080, height: 820, minWidth: ROOMY.w, minHeight: ROOMY.h, backgroundColor: '#161616', autoHideMenuBar: true, title: 'Local AI', icon: ICON,
    webPreferences: { preload: join(HERE, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, webviewTag: false, spellcheck: false } });
  await win.loadURL(`${ORIGIN}/#key=${key}`); // the page takes the key from the address and removes it
  app.on('before-quit', () => server?.stop());
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { const win = BrowserWindow.getAllWindows()[0]; if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(boot).catch((e) => { dialog.showErrorBox('Local AI could not start', e.message); app.quit(); });
}
