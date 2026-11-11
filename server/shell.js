// Running other programs the way you would: with the PATH your terminal has, quoted for a shell, or set loose.
import { spawn } from 'node:child_process';
import { userInfo } from 'node:os';
import { event, once, run } from './util.js';

export const WIN = process.platform === 'win32';
// Your shell: what the environment names, else the one your account logs in with (an app can be started with no SHELL set).
export const shell = process.env.SHELL || (() => { try { return userInfo().shell; } catch { return null; } })() || 'sh';

// A terminal reads your shell's startup files, and those often put newer tools first on PATH (a Node, a Bun). A
// program started by an app gets none of that: an agent that runs in your terminal could fail when started from here.
// So the app asks your shell once what PATH a terminal would have, the way editors do, and looks for agents and
// starts them with it. A shell that does not answer in ten seconds is asked again later; until then the login
// shell's own PATH is used.
let asked = 0, termPath = null;
export const terminalPath = once(async () => {
  if (WIN || Date.now() - asked < 600e3) return termPath;
  const out = await run(shell, ['-lic', 'echo __LOCAL_AI_ENV__; command env'], { timeout: 10000 });
  asked = Date.now();
  termPath = /__LOCAL_AI_ENV__[\s\S]*?^PATH=(.+)$/m.exec(out.stdout)?.[1] || null;
  if (!termPath) event('warn', 'agents.path', { error: 'the shell did not say its PATH; using the login shell' });
  return termPath;
});
// Runs a command line where a terminal of yours would find its programs.
export async function inShell(command, timeout) {
  if (WIN) return run('cmd', ['/c', command], { timeout });
  const path = await terminalPath();
  return path ? run('/bin/sh', ['-c', command], { timeout, env: { ...process.env, PATH: path } }) : run(shell, ['-lc', command], { timeout });
}

// A word as a shell reads one word: plain when it can be, else in single quotes.
export const q = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

// Starts a program and lets it go: whether it started.
export const launched = (cmd, args) => new Promise((done) => {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.once('error', () => done(false));
  child.once('spawn', () => { child.unref(); done(true); });
});
