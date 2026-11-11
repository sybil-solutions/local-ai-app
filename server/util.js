import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOME = process.env.LOCAL_AI_HOME || join(homedir(), '.local-ai');
export const HOST = process.env.LOCAL_AI_HOST || '127.0.0.1';
export const PORT = +(process.env.LOCAL_AI_PORT || 18700);
export const ENGINE_HOST = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
export const at = (...parts) => join(HOME, ...parts);
// The app's own files as a plain folder, for sending to another machine with tar. Run from source that is the repo.
// In the packaged app the code sits inside an archive only Electron can read, so a copy is kept beside it.
const packed = process.resourcesPath && join(process.resourcesPath, 'payload');
export const PAYLOAD = packed && existsSync(packed) ? packed : join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(HOME, { recursive: true, mode: 0o700 });

// A value stored under a name that came from outside (a recipe id, a model name): only what was really put there,
// never something every object has, such as `constructor`.
export const own = (map, key) => (map && typeof key === 'string' && Object.hasOwn(map, key) ? map[key] : undefined);
export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
// One at a time: whoever asks while the question is still being answered waits for that answer instead of asking
// again. Without it, every request that arrives during a slow lookup starts the lookup over.
export const once = (ask) => { let going = null; return (...args) => going || (going = ask(...args).finally(() => { going = null; })); };
export const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
// An answer from the network, read only up to `max` bytes. Whoever sent it can't make this machine hold more.
export async function bytesUpTo(res, max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body || []) {
    size += chunk.length;
    if (size > max) throw new Error('Sent more than Local AI reads');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export const jsonUpTo = async (res, max) => JSON.parse((await bytesUpTo(res, max)).toString('utf8'));
// Runs jobs side by side. If one fails, the rest are told to stop and waited for before the failure is passed on, so nothing is left running.
export async function together(signal, jobs) {
  const stop = new AbortController(), either = AbortSignal.any([signal, stop.signal]);
  const done = await Promise.allSettled(jobs.map((job) => job(either).catch((e) => { stop.abort(); throw e; })));
  const failed = done.find((d) => d.status === 'rejected');
  if (failed) throw failed.reason;
  return done.map((d) => d.value);
}

// Everything that happens is one JSON line, on stdout and in ~/.local-ai/events.jsonl.
export function event(level, name, data = {}) {
  const entry = { at: new Date().toISOString(), level, name, ...data };
  console.log(JSON.stringify(entry));
  try {
    const file = at('events.jsonl');
    if (existsSync(file) && statSync(file).size > 5e6) renameSync(file, `${file}.1`);
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch { /* losing a log line must never take the server down */ }
}

// A corrupt state file is moved aside, never overwritten, so its contents can still be recovered.
export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    renameSync(file, `${file}.corrupt`);
    event('error', 'state.corrupt', { file, error: e.message });
    return fallback;
  }
}

export function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, file);
}

// Never rejects: callers branch on code, and a missing binary is code 127.
export const run = (cmd, args, { timeout = 30000, signal, env } = {}) => new Promise((done) => {
  execFile(cmd, args, { timeout, signal, env, maxBuffer: 32e6, windowsHide: true }, (e, stdout, stderr) => {
    done({ code: e ? (e.code === 'ENOENT' ? 127 : typeof e.code === 'number' ? e.code : 1) : 0, stdout: String(stdout), stderr: String(stderr || e?.message || '') });
  });
});

const configFile = at('config.json');
export const config = { key: randomBytes(24).toString('hex'), devices: [], folder: homedir(), agent: 'pi', ...readJson(configFile, {}) };
export const saveConfig = () => writeJson(configFile, config);
saveConfig();
