import { app, BrowserWindow, dialog, shell } from 'electron';

const PORT = +(process.env.LOCAL_AI_PORT || 18700);
const URL_ = `http://127.0.0.1:${PORT}`;

// An already-running server (a service, another install) is reused instead of fought over.
const existing = () => fetch(`${URL_}/api/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.json()).then((j) => j.app === 'local-ai').catch(() => false);

async function boot() {
  let server = null;
  if (!(await existing())) server = await (await import('../server/index.js')).start();
  const win = new BrowserWindow({ width: 1080, height: 820, minWidth: 420, minHeight: 500, backgroundColor: '#161616', autoHideMenuBar: true, title: 'Local AI' });
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
