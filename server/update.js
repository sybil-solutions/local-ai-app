// Updating this copy of Local AI. Which way depends on how it got here (`kind`):
//   git     cloned from its repo: it follows the branch it is on, with `git pull`
//   linux   installed on Linux (install.sh): the newest release's files, signed, unpacked and installed by its installer
//   app     the Mac or Windows app: the newest release's app, signed, put in place by the app (electron/updater.js)
// The last two take only what release.js trusts. Like T3 Code's: it looks 15 seconds after it starts and every four
// hours, says when a newer version is out, and downloads it when asked (Download), then installs it when asked
// (Restart to update). "Update automatically" does both by itself: the server restarts on its own (models run in
// Docker, so they keep running); the app downloads by itself and waits to be restarted.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as release from './release.js';
import { at, config, event, fail, run } from './util.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => run('git', ['-C', ROOT, ...args], { timeout: 120000 });
const version = () => JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const TESTING = process.env.LOCAL_AI_STAND_INS === '1';

// The desktop app says how it puts a new version of itself in place (setInstaller). The file it is given is the one
// for this system and processor, of which there is only the one each release holds.
let installer = null;
export const setInstaller = (fn) => { installer = fn; state.kind = 'app'; state.can = !!assetFor('app'); notify(); };
const assetFor = (kind) => (kind === 'linux' ? 'local-ai-linux.tar.gz'
  : kind === 'app' ? { 'darwin-arm64': 'Local-AI-mac-arm64.zip', 'win32-x64': 'Local-AI-windows-x64.exe' }[`${process.platform}-${process.arch}`] : null);
const kindOf = () => {
  if (TESTING && process.env.LOCAL_AI_UPDATE_KIND) return process.env.LOCAL_AI_UPDATE_KIND;
  if (existsSync(join(ROOT, '.git'))) return 'git';
  if (process.platform === 'linux' && existsSync(join(ROOT, 'install.sh'))) return 'linux';
  return null; // until the app says it can install (setInstaller), or for good: a copy that has no way to update
};

// phase: idle, checking, available, downloading, ready (downloaded, to be installed), installing, failed.
// latest: the newer version (or, for git, 'a newer build' when its package.json says the same version).
const kind = kindOf();
const state = { version: version(), kind, can: !!kind && (kind === 'git' || !!assetFor(kind)), started: Date.now(), checked: null, latest: null, notes: [], url: null, phase: 'idle', progress: null, error: null };
let found = null, file = null; // the release that is newer, and its downloaded file
let notify = () => {};
export const onChange = (fn) => { notify = fn; };
export const view = () => ({ ...state, auto: !!config.autoUpdate });
const set = (part) => { Object.assign(state, part); notify(); };
const busy = () => ['checking', 'downloading', 'installing'].includes(state.phase);

// Left from earlier updates: what was unpacked, a download cut short, and downloads of this version or an older one.
// A finished download of a newer version is kept, and used again if it still matches the signed list.
try {
  for (const name of readdirSync(at('updates'))) {
    if (name.includes('-unpacked-') || name.endsWith('.part') || !release.newer(name.split('-')[0], state.version)) rmSync(at('updates', name), { recursive: true, force: true });
  }
} catch { /* nothing downloaded yet */ }

export async function check() {
  if (!state.can || busy() || state.phase === 'ready') return view();
  set({ phase: 'checking', error: null });
  try {
    if (state.kind === 'git') await checkGit();
    else {
      const r = await release.latest();
      found = release.newer(r.version, state.version) ? r : null;
      set({ latest: found?.version || null, notes: found?.notes || [], url: found ? release.pageOf(found.version) : null });
    }
    set({ phase: state.latest ? 'available' : 'idle', checked: Date.now() });
  } catch (e) {
    set({ phase: 'idle', checked: Date.now(), error: `Couldn’t check: ${e.message}`.slice(0, 200) });
    return view();
  }
  if (state.latest && config.autoUpdate) automatically();
  return view();
}
async function checkGit() {
  if ((await git('fetch', '--quiet')).code) throw new Error('git could not reach the repo');
  const behind = (await git('log', '--format=%s', 'HEAD..@{u}')).stdout.trim().split('\n').filter(Boolean);
  let next = null;
  try { next = JSON.parse((await git('show', '@{u}:package.json')).stdout).version; } catch { /* no upstream yet */ }
  set({ latest: behind.length ? (next && next !== state.version ? next : 'a newer build') : null, notes: behind.slice(0, 6), url: null });
}
// The server installs as soon as it has the update; the app is restarted by its person.
const automatically = () => (state.kind === 'app' ? download() : state.kind === 'git' ? update() : download().then((ok) => ok && update())).catch(() => {});

// Downloads the newer release's file for this machine and checks it against the signed list. Resolves whether it did.
export async function download() {
  if (state.kind === 'git') return update();
  if (state.phase === 'ready') return true;
  if (!found) fail(409, 'Already up to date');
  if (state.phase === 'downloading') return false;
  set({ phase: 'downloading', progress: 0, error: null });
  try {
    file = await release.download(found, assetFor(state.kind), (p) => set({ progress: p }));
    set({ phase: 'ready', progress: 1 });
    event('info', 'app.downloaded', { version: found.version });
    return true;
  } catch (e) {
    set({ phase: 'failed', progress: null, error: e.message.slice(0, 200) });
    event('warn', 'app.download', { version: found.version, error: state.error });
    return false;
  }
}

// Puts the downloaded version in place and restarts into it. Engines live in Docker, so this never stops a model.
export async function update() {
  if (state.kind === 'git') return pull();
  if (state.phase !== 'ready' || !file) fail(409, state.latest ? 'Download it first' : 'Already up to date');
  set({ phase: 'installing', error: null });
  event('info', 'app.installing', { to: found.version, kind: state.kind });
  try {
    file = await release.download(found, assetFor(state.kind)); // checked again: it is what the signed release says, still
    if (state.kind === 'app') await installer(file, found.version);
    else await installLinux(file, found.version);
    return { ok: true };
  } catch (e) {
    set({ phase: 'failed', error: e.message.slice(0, 200) });
    event('error', 'app.update', { error: state.error });
    return { ok: false };
  }
}

async function pull() {
  if (!state.latest) fail(409, 'Already up to date');
  if (state.phase === 'installing') return { ok: true };
  set({ phase: 'installing', error: null });
  const pulled = await git('pull', '--ff-only', '--quiet');
  if (pulled.code) {
    set({ phase: 'failed', error: (pulled.stderr.trim().split('\n').pop() || 'Could not download it').slice(0, 160) });
    event('error', 'app.update', { error: state.error });
    return { ok: false };
  }
  event('info', 'app.updated', { to: state.latest });
  setTimeout(() => {
    // A service manager restarts us; anywhere else we start our own replacement.
    if (!process.env.INVOCATION_ID) spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: 'ignore' }).unref();
    process.emit('SIGTERM');
  }, 400);
  return { ok: true };
}

// The release is unpacked in Local AI's own folder and its installer run as an update of this copy, with this
// service's PATH (so it finds the Node this runs on) and this copy's folder. It is started as a unit of its own,
// outside this service: the installer restarts the service, and would otherwise be stopped with it half way.
async function installLinux(tarball, to) {
  const dir = mkdtempSync(at('updates', `${to}-unpacked-`));
  const unpacked = await run('tar', ['-xzf', tarball, '-C', dir, '--no-same-owner'], { timeout: 120000 });
  if (unpacked.code) throw new Error(`The update could not be unpacked: ${unpacked.stderr.trim().split('\n').pop() || 'tar failed'}`);
  let said = null;
  try { said = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version; } catch { /* checked below */ }
  if (said !== to || !existsSync(join(dir, 'install.sh')) || !existsSync(join(dir, 'server', 'index.js'))) throw new Error('The update is not a copy of Local AI');
  const unit = `local-ai-update-${Date.now()}`, path = [dirname(process.execPath), ...(process.env.PATH || '').split(':')].filter(Boolean).join(':');
  const env = { LOCAL_AI_SHIPPED: 'update', LOCAL_AI_DIR: ROOT, PATH: path, ...(process.env.SHELL ? { SHELL: process.env.SHELL } : {}) };
  const started = await run('systemd-run', ['--user', '--collect', '--quiet', `--unit=${unit}`, ...Object.entries(env).map(([k, v]) => `--setenv=${k}=${v}`), 'bash', join(dir, 'install.sh')], { timeout: 20000 });
  if (started.code) throw new Error(`The installer could not be started: ${started.stderr.trim().split('\n').pop() || 'systemd-run failed'}`);
  // The installer restarts this service, which ends this process. Still here after three minutes, it did not finish.
  setTimeout(() => { if (state.phase === 'installing') { set({ phase: 'failed', error: `The installer did not finish. See: journalctl --user -u ${unit}` }); event('error', 'app.update', { error: state.error }); } }, 180e3).unref();
}
