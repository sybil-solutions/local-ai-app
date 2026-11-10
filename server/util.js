import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOME = process.env.LOCAL_AI_HOME || join(homedir(), '.local-ai');
export const HOST = process.env.LOCAL_AI_HOST || '127.0.0.1';
export const PORT = +(process.env.LOCAL_AI_PORT || 18700);
export const ENGINE_HOST = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
export const at = (...parts) => join(HOME, ...parts);
mkdirSync(HOME, { recursive: true, mode: 0o700 });

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
export const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

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
export const run = (cmd, args, { timeout = 30000, signal } = {}) => new Promise((done) => {
  execFile(cmd, args, { timeout, signal, maxBuffer: 32e6, windowsHide: true }, (e, stdout, stderr) => {
    done({ code: e ? (e.code === 'ENOENT' ? 127 : typeof e.code === 'number' ? e.code : 1) : 0, stdout: String(stdout), stderr: String(stderr || e?.message || '') });
  });
});

const configFile = at('config.json');
export const config = { key: randomBytes(24).toString('hex'), devices: [], folder: homedir(), agent: 'pi', ...readJson(configFile, {}) };
export const saveConfig = () => writeJson(configFile, config);
saveConfig();
