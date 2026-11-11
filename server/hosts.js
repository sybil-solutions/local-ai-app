import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, fstatSync, ftruncateSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { health } from './health.js';
import { meter } from './meter.js';
import { label } from './recipes.js';
import { runs, setFailed, share, update } from './runs.js';
import { at, ENGINE_HOST, event, HOST, PORT, readJson, run, sleep, writeJson } from './util.js';
import * as weights from './weights.js';

// Host runs: a pinned recipe that runs as a program on this machine (MLX on Apple silicon). Each gets its own folder
// with the recipe's script and links to its weights, and a Python venv built from the recipe's pinned packages and
// share.ip by recipes that pin the same ones. The engine listens on an inner port; the app answers on the run's port and
// counts the tokens that pass (see meter.js). The engine outlives the app; hosts.json remembers it so a restarted app
// adopts it and opens its port again.
const hostsFile = at('hosts.json');
const hosts = readJson(hostsFile, {});
const saveHosts = () => writeJson(hostsFile, hosts);
const ENVS = at('envs');
const ENV_DAYS = 30; // a venv no recipe has used for this long is deleted
const LOG_MAX = 20e6; // engine.log is rotated to engine.log.1 past this
const runDir = (id) => at('runs', String(id));
const realDir = (id) => { try { return realpathSync(runDir(id)); } catch { return runDir(id); } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export const innerPorts = () => new Set(Object.values(hosts).map((h) => h.inner));
const loopFree = (port) => new Promise((done) => {
  const s = createServer();
  s.once('error', () => done(false));
  s.listen(port, '127.0.0.1', () => s.close(() => done(true)));
});

// The first Python 3.11+ found. An app opened from Finder has a bare PATH whose python3 is the system 3.9, too old for
// the pinned engines, so the usual install places are tried by name first.
const PYTHONS = ['3.13', '3.12', '3.11'].flatMap((v) => [`/opt/homebrew/bin/python${v}`, `/usr/local/bin/python${v}`])
  .concat(['/opt/homebrew/bin/python3', '/usr/local/bin/python3', 'python3']);
async function basePython() {
  for (const py of PYTHONS) {
    const v = await run(py, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2]); sys.exit(sys.version_info < (3, 11))'], { timeout: 10000 });
    if (!v.code) return { py, version: v.stdout.trim() };
  }
  throw new Error('Needs Python 3.11 or newer. Install it (brew install python@3.13), then try again');
}

// One build at a time per venv, because two recipes that pin the same packages share one.
const building = new Map();
async function venvFor(pip, r, signal) {
  const base = await basePython();
  const name = createHash('sha256').update(`${base.version}\n${pip.join('\n')}`).digest('hex').slice(0, 12), dir = join(ENVS, name);
  const python = join(dir, 'bin', 'python3');
  while (building.has(dir)) {
    update(r, { phase: 'image', detail: 'Waiting for another install of this engine', progress: null });
    await building.get(dir).catch(() => {});
    signal.throwIfAborted();
  }
  if (!(existsSync(join(dir, '.complete')) && !(await run(python, ['-c', '1'], { timeout: 20000 })).code)) {
    const job = buildVenv(base, dir, python, pip, r, signal);
    building.set(dir, job);
    try { await job; } finally { building.delete(dir); }
  }
  writeFileSync(join(dir, '.used'), new Date().toISOString());
  cleanEnvs(name);
  return { python, env: name };
}

async function buildVenv(base, dir, python, pip, r, signal) {
  update(r, { phase: 'image', detail: 'Installing the engine', progress: null });
  rmSync(dir, { recursive: true, force: true });
  const made = await run(base.py, ['-m', 'venv', dir], { timeout: 120000, signal });
  if (made.code) throw new Error(`Could not create a Python environment: ${made.stderr.trim().slice(-300)}`);
  if (pip.length) {
    const got = await run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--retries', '8', '--timeout', '60', ...pip], { timeout: 3600e3, signal });
    if (got.code) throw new Error(`Could not install the engine: ${got.stderr.trim().slice(-300)}`);
  }
  writeFileSync(join(dir, '.complete'), new Date().toISOString());
}

// Deletes venvs that no run is using and none has used for ENV_DAYS, and half-built ones nothing is building.
function cleanEnvs(keep) {
  const using = new Set([keep, ...Object.values(hosts).map((h) => h.env), ...[...runs.values()].map((r) => r.env)]);
  let names;
  try { names = readdirSync(ENVS); } catch { return; }
  for (const name of names) {
    const dir = join(ENVS, name);
    if (using.has(name) || building.has(dir)) continue;
    let used = 0;
    try { used = statSync(join(dir, '.used')).mtimeMs; } catch { /* never finished, or from before .used */ }
    if (!existsSync(join(dir, '.complete')) || Date.now() - used > ENV_DAYS * 864e5) {
      rmSync(dir, { recursive: true, force: true });
      event('info', 'env.removed', { env: name });
    }
  }
}

// The recipe's command with this machine's venv Python, listening on loopback at the inner port. recipes.js has
// already made sure there is one --port and at most one --host, each followed by its value.
function hostCommand(launch, port, python) {
  const cmd = launch.command.map(String);
  if (/^python3?$/.test(cmd[0])) cmd[0] = python;
  const at_ = (flag) => cmd.indexOf(flag);
  if (at_('--port') < 1 || at_('--port') === cmd.length - 1) throw new Error('The recipe does not say which port it listens on');
  cmd[at_('--port') + 1] = String(port);
  if (at_('--host') > 0 && at_('--host') < cmd.length - 1) cmd[at_('--host') + 1] = '127.0.0.1';
  return cmd;
}
// What an engine that runs on this machine is told about it: where things are and how text is written, and whatever
// its recipe sets. Not the rest of this app's environment, which may hold tokens and keys the engine has no use for.
const PASSED = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE'];
const hostEnv = (launch) => ({ ...Object.fromEntries(PASSED.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])), ...Object.fromEntries(Object.entries(launch.env || {}).map(([k, v]) => [k, String(v)])) });

async function freeInner() {
  const taken = innerPorts();
  for (let port = PORT + 100; port < PORT + 200; port++) if (!taken.has(port) && !runs.has(port) && (await loopFree(port))) return port;
  throw new Error('No free port left for the engine');
}

// Opens the run's own port in front of the engine, where a container would have published it.
async function openFront(r, inner) {
  const m = meter(inner, () => [HOST, share.ip, ...share.names]);
  const where = [HOST, ...(share.ip && share.ip !== HOST ? [share.ip] : [])];
  r.close = await m.listen(r.id, where);
  r.meter = m;
  r.reachable = !!share.ip || !/^127\./.test(HOST);
}

export async function launchHost(r, recipe, signal) {
  const launch = recipe.launch;
  const dir = runDir(r.id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const { python, env } = await venvFor(launch.pip || [], r, signal);
  r.env = env;
  if (launch.config) writeFileSync(join(dir, launch.config.at), launch.config.text);
  for (const w of [].concat(launch.weights || []).filter(Boolean)) {
    const link = join(dir, w.at);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(weights.dirOf(w), link);
  }
  const inner = await freeInner();
  const [cmd, ...args] = hostCommand(launch, inner, python);
  signal.throwIfAborted();
  update(r, { phase: 'starting', detail: 'Loading model', since: Date.now() });
  const out = openSync(join(dir, 'engine.log'), 'a');
  const child = spawn(cmd, args, { cwd: dir, detached: true, stdio: ['ignore', out, out], env: hostEnv(launch) });
  closeSync(out);
  await new Promise((done, failed) => { child.once('spawn', done); child.once('error', failed); });
  child.unref();
  r.pid = child.pid;
  hosts[r.id] = { pid: child.pid, inner, env, recipe: r.recipe, gpus: r.gpus, since: r.since, started: await startedAt(child.pid) };
  saveHosts();
  if (signal.aborted) return stopHost(r);
  try { await openFront(r, inner); } catch (e) { await stopHost(r); throw new Error(`Could not open port ${r.id}: ${e.message}`, { cause: e }); }
  update(r, { busy: false, touched: Date.now() });
  event('info', 'run.host', { id: r.id, recipe: r.recipe, pid: child.pid, inner });
}

export async function stopHost(r) {
  r.close?.();
  r.close = null;
  if (r.pid && alive(r.pid)) {
    const kill = (sig) => { try { process.kill(-r.pid, sig); } catch { try { process.kill(r.pid, sig); } catch { /* already gone */ } } };
    kill('SIGTERM');
    for (let i = 0; i < 30 && alive(r.pid); i++) await sleep(500);
    if (alive(r.pid)) kill('SIGKILL');
  }
  delete hosts[r.id];
  saveHosts();
}

// The last lines of a host run's log, read from the end of the file so a long-running engine's log stays cheap.
export function hostLog(r, lines) {
  try {
    const fd = openSync(join(runDir(r.id), 'engine.log'), 'r');
    const size = fstatSync(fd).size, take = Math.min(size, 512 * 1024), buf = Buffer.alloc(take);
    readSync(fd, buf, 0, take, size - take);
    closeSync(fd);
    return buf.toString('utf8').split('\n').slice(-lines).join('\n');
  } catch { return ''; }
}

// Once a minute: marks the run's venv as in use, and rotates its log. The engine writes the log in append mode, so
// emptying the file in place is safe: its next line lands at the new end.
function housekeep(r) {
  if (Date.now() - (r.rotated || 0) < 60000) return;
  r.rotated = Date.now();
  try { if (r.env) utimesSync(join(ENVS, r.env, '.used'), new Date(), new Date()); } catch { /* the venv was removed by hand */ }
  const file = join(runDir(r.id), 'engine.log');
  try {
    if (statSync(file).size < LOG_MAX) return;
    copyFileSync(file, `${file}.1`);
    const fd = openSync(file, 'r+');
    ftruncateSync(fd, 0);
    closeSync(fd);
  } catch { /* a log that can't be rotated keeps growing; the engine is unaffected */ }
}

export async function checkHost(r) {
  if (r.busy || !r.pid || r.phase === 'stopping') return;
  if (!alive(r.pid)) {
    if (r.phase !== 'failed') { r.close?.(); r.close = null; setFailed(r, 'Engine stopped', hostLog(r, 120)); delete hosts[r.id]; saveHosts(); }
    return;
  }
  housekeep(r);
  await health(r);
}

const startedAt = async (pid) => (await run('ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 4000 })).stdout.trim() || null;
const cwdOf = async (pid) => /^n(.*)$/m.exec((await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 4000 })).stdout)?.[1] ?? null;

// After a restart: a remembered pid counts only if it still runs in that run's folder and started when it did, so a
// recycled pid is never taken for the engine. (macOS framework Pythons show as Python.app, so the command can't tell.)
let adopted = false;
export async function adoptHosts() {
  if (adopted) return;
  adopted = true;
  for (const [key, h] of Object.entries(hosts)) {
    const id = +key;
    if (!h.inner || !alive(h.pid) || (await cwdOf(h.pid)) !== realDir(id) || (h.started && (await startedAt(h.pid)) !== h.started)) { delete hosts[key]; continue; }
    if (runs.has(id)) continue;
    const r = { id, recipe: h.recipe, host: true, name: label(h.recipe), url: `http://${ENGINE_HOST}:${id}`, gpus: h.gpus, phase: 'starting', detail: 'Loading model', progress: null, error: null, since: h.since, busy: false, pid: h.pid, env: h.env, apis: null, stats: null, misses: 0, seen: true };
    try { await openFront(r, h.inner); } catch (e) {
      r.url = `http://127.0.0.1:${h.inner}`; r.reachable = false; // its port is taken; the engine is still usable on loopback
      event('warn', 'run.port', { id, error: e.message });
    }
    runs.set(id, r);
    event('info', 'run.adopted', { id, recipe: h.recipe, pid: h.pid });
  }
  saveHosts();
}
