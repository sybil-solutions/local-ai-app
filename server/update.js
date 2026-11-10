import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, event, fail, run } from './util.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => run('git', ['-C', ROOT, ...args], { timeout: 120000 });
const version = () => JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
// can: this copy was cloned from a repo, so it has somewhere to update from.
const state = { version: version(), started: Date.now(), latest: null, notes: [], phase: 'idle', error: null, can: existsSync(join(ROOT, '.git')) };
let notify = () => {};
export const onChange = (fn) => { notify = fn; };
export const view = () => ({ ...state, auto: !!config.autoUpdate });

export async function check() {
  if (!state.can || state.phase === 'updating' || (await git('fetch', '--quiet')).code) return view();
  const behind = (await git('log', '--format=%s', 'HEAD..@{u}')).stdout.trim().split('\n').filter(Boolean);
  let next = null;
  try { next = JSON.parse((await git('show', '@{u}:package.json')).stdout).version; } catch { /* no upstream yet */ }
  Object.assign(state, { latest: behind.length ? (next && next !== state.version ? next : 'a newer build') : null, notes: behind.slice(0, 6) });
  notify();
  if (state.latest && config.autoUpdate) update();
  return view();
}

// Engines live in Docker, so restarting the app never stops a model.
export async function update() {
  if (!state.latest) fail(409, 'Already up to date');
  if (state.phase === 'updating') return { ok: true };
  Object.assign(state, { phase: 'updating', error: null });
  notify();
  const pulled = await git('pull', '--ff-only', '--quiet');
  if (pulled.code) {
    Object.assign(state, { phase: 'failed', error: (pulled.stderr.trim().split('\n').pop() || 'Could not download it').slice(0, 160) });
    event('error', 'app.update', { error: state.error });
    notify();
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
