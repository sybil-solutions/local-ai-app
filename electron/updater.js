// How the desktop app puts a new version of itself in place. The server has already downloaded the release's file and
// checked it against the signed release (server/release.js), and checks it again just before it is handed over here.
//   Mac      the app in the zip must also be signed by the same Apple developer as this one, notarized (Gatekeeper
//            accepts it) and be the version expected. Once this app has quit, it takes this one's place and is opened.
//   Windows  the installer is run without asking anything (as electron-builder's own updater does), and opens the app.
// Anywhere else, or run from source, the app does not update itself.
import { execFile, spawn } from 'node:child_process';
import { accessSync, constants, mkdtempSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const run = (cmd, args) => new Promise((done) => execFile(cmd, args, { timeout: 180000, maxBuffer: 4 << 20 }, (e, stdout, stderr) => done({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out: `${stdout}${stderr}` })));

export function installerFor(app) {
  if (!app.isPackaged) return null;
  if (process.platform === 'darwin') return (file, version) => mac(app, file, version);
  if (process.platform === 'win32') return (file) => windows(app, file);
  return null;
}

// The developer an app is signed by, as Apple names them (its team), or null when it is not signed by one.
const teamOf = async (bundle) => /^TeamIdentifier=(\w+)$/m.exec((await run('/usr/bin/codesign', ['-dv', '--verbose=2', bundle])).out)?.[1] || null;

// Waits for this app to quit, moves it aside, puts the new one in its place (or the old one back, if that fails) and
// opens it. Paths are given as arguments, never written into the script.
const SWAP = 'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; old="$2.old-$$"; mv "$2" "$old" || { open "$2"; exit 1; }; if mv "$3" "$2"; then rm -rf "$old"; else mv "$old" "$2"; fi; rm -rf "$4"; open "$2"';

async function mac(app, zip, version) {
  const bundle = resolve(app.getPath('exe'), '..', '..', '..');
  if (!bundle.endsWith('.app') || bundle.includes('/AppTranslocation/')) throw new Error('Move Local AI to your Applications folder, open it from there, then update');
  try { accessSync(dirname(bundle), constants.W_OK); } catch { throw new Error(`Local AI can’t replace itself in ${dirname(bundle)}. Download the new version and drag it to Applications`); }
  const dir = mkdtempSync(join(dirname(zip), `${version}-unpacked-`)), next = join(dir, 'Local AI.app');
  const step = async (what, cmd, args) => { const r = await run(cmd, args); if (r.code) throw new Error(`${what}: ${r.out.trim().split('\n').pop() || `${cmd} failed`}`.slice(0, 200)); return r.out; };
  await step('The update could not be unpacked', '/usr/bin/ditto', ['-x', '-k', zip, dir]);
  await step('The update’s signature does not check out', '/usr/bin/codesign', ['--verify', '--deep', '--strict', next]);
  const [mine, theirs] = await Promise.all([teamOf(bundle), teamOf(next)]);
  if (!mine || mine !== theirs) throw new Error('The update is not signed by the same developer as this app, so it was not installed');
  await step('macOS would not open the update', '/usr/sbin/spctl', ['--assess', '--type', 'execute', next]);
  const said = (await run('/usr/bin/defaults', ['read', join(next, 'Contents', 'Info'), 'CFBundleShortVersionString'])).out.trim();
  if (said !== version) throw new Error(`The update says it is ${said || 'no version'}, not ${version}`);
  spawn('/bin/sh', ['-c', SWAP, 'swap', String(process.pid), bundle, next, dir], { detached: true, stdio: 'ignore' }).unref();
  setTimeout(() => app.quit(), 300);
}

function windows(app, exe) {
  // /S: no questions. --updated: it is an update of the installed app. --force-run: the app is opened afterwards.
  spawn(exe, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
  setTimeout(() => app.quit(), 300);
}
