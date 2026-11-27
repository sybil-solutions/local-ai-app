// Starting, stopping and watching models. A run is a Docker container (containers.js) or, on Apple silicon, a
// program on this machine (hosts.js); models someone else started are found and shown too (discovery.js). Whether
// an engine answers is asked the same way of all three (health.js). What they share is in runs.js.
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { containerLogs, isHeld, launchContainer, stopContainer, sweepContainers } from './containers.js';
import { docker } from './dockercmd.js';
import { discover } from './discovery.js';
import { readGpus } from './gpus.js';
import { adoptHosts, checkHost, hostLog, launchHost, stopHost } from './hosts.js';
import { blocked, cardFor, find, fitsCard, label, shortNow } from './recipes.js';
import { freeGpus, runs, setFailed, status, update } from './runs.js';
import { loadSeconds } from './speed.js';
import * as usage from './usage.js';
import * as studio from './studio.js';
import { config, ENGINE_HOST, event, fail, HOST, PORT, run, saveConfig } from './util.js';
import * as weights from './weights.js';

import { health } from './health.js';

export { cancelMeasure, measureNow } from './health.js';
export { freeGpus, onChange, shareOn, status } from './runs.js';

const portFree = (port) => new Promise((done) => {
  const s = createServer();
  s.once('error', () => done(false));
  s.listen(port, HOST, () => s.close(() => done(true)));
});

// Gets the weights, then starts the engine. A failure on the way is the run's failure, unless it was cancelled.
async function launch(r, recipe) {
  const { signal } = r.abort;
  try {
    await weights.download(recipe.launch, signal, (fields) => update(r, fields));
    await (r.host ? launchHost(r, recipe, signal) : launchContainer(r, recipe, signal));
  } catch (e) {
    if (!signal.aborted) { setFailed(r, e.message); r.abort.abort(); }
  }
}

let starting = Promise.resolve();
export function start(id, picked) {
  const begun = starting.then(() => begin(id, picked));
  starting = begun.catch(() => {});
  return begun;
}
async function begin(id, picked) {
  const recipe = find(id) || fail(404, 'No such recipe');
  const why = blocked(id) || shortNow(id);
  if (why) fail(409, why);
  const host = recipe.launch.kind === 'host';
  if (!host && !status.docker.ok) fail(503, status.docker.error);
  if ([...runs.values()].some((r) => r.recipe === id && r.phase !== 'failed')) fail(409, 'This recipe is already running');
  let port = PORT + 1;
  while (port < PORT + 100 && (runs.has(port) || !(await portFree(port)))) port++;
  if (port >= PORT + 100) fail(409, 'No free port left');
  if (runs.has(port)) fail(409, 'Another launch just started, try again');
  const need = recipe.launch.cards || 1;
  const free = freeGpus().filter((g) => fitsCard(recipe, cardFor(g))).map((g) => g.index);
  const gpus = picked?.length ? picked : free.slice(0, need);
  if (gpus.length !== need || new Set(gpus).size !== need || gpus.some((g) => !free.includes(g))) fail(409, `Needs ${need} free GPU${need > 1 ? 's' : ''}; ${free.length} free`);
  const r = { id: port, recipe: id, host, name: label(id), url: `http://${ENGINE_HOST}:${port}`, gpus, phase: 'queued', detail: 'Queued', progress: null, error: null, since: Date.now(), busy: true, abort: new AbortController(), apis: null, stats: null, misses: 0 };
  runs.set(port, r);
  config.last = id;
  saveConfig();
  event('info', 'run.start', { id: port, recipe: id, gpus });
  launch(r, recipe);
  return { id: port };
}

export async function remove(rawId) {
  const r = runs.get(+rawId) || fail(404, 'No such run');
  if (r.phase === 'stopping') return { id: r.id };
  if (r.external) return stopStudio(r);
  const alreadyFailed = r.phase === 'failed';
  r.abort?.abort();
  r.measureAbort?.abort();
  update(r, { phase: 'stopping', detail: 'Stopping', progress: null });
  if (r.host) await stopHost(r);
  if (r.container) await stopContainer(r, alreadyFailed);
  runs.delete(r.id);
  usage.forget(r);
  event('info', 'run.removed', { id: r.id, recipe: r.recipe });
  return { id: r.id };
}

// A model someone else started is stopped only when Local Studio started it: by asking Local Studio (studio.js).
async function stopStudio(r) {
  if (!r.byStudio || !(await studio.owns(r.served))) fail(409, 'Local AI didn’t start this model, so it can’t stop it');
  update(r, { phase: 'stopping', detail: 'Local Studio is stopping it', progress: null });
  try { await studio.stop(r.served); } catch (e) {
    if (runs.get(r.id) === r) update(r, { phase: 'ready', detail: null });
    event('warn', 'run.stop', { id: r.id, by: 'local-studio', error: e.message });
    fail(502, e.message);
  }
  runs.delete(r.id);
  event('info', 'run.removed', { id: r.id, model: r.served, by: 'local-studio' });
  return { id: r.id };
}

export async function logs(rawId, tail) {
  const r = runs.get(+rawId) || fail(404, 'No such run'), lines = Math.min(+tail || 400, 5000);
  if (r.host && r.pid) return { text: hostLog(r, lines) || r.error || r.detail || '' };
  return { text: r.container ? await containerLogs(r, lines) : r.error || r.detail || '' };
}

// Docker is asked what it is running on every tick while a container is on its way up or down or has stopped
// answering, and every fifth tick otherwise. A machine whose runs are never containers (Apple silicon) is not asked
// at all, and one with no Docker installed is asked twice a minute.
let sweeps = 0;
function dockerIsDue() {
  const containers = [...runs.values()].filter((r) => r.container || (!r.host && !r.external));
  if (!containers.length && status.gpus.length && status.gpus.every((g) => g.unified)) return false;
  const every = /not installed/.test(status.docker.error || '') ? 15 : containers.some((r) => r.busy || r.misses || !['ready', 'failed'].includes(r.phase)) || !status.docker.ok ? 1 : 5;
  return sweeps++ % every === 0;
}

// Docker is an app on a Mac and on Windows (Docker Desktop, in the place its installer puts it), a service on Linux.
const DESKTOP = join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'Docker Desktop.exe');
export async function startDocker() {
  // A socket-activated Docker (the usual setup) starts on its first connection; no service manager call is needed.
  if (!(await docker(['ps', '-q'], { timeout: 20000 })).code) { sweeps = 0; await tick(); return { ok: true }; }
  const tries = process.platform === 'darwin' ? [['open', ['-a', 'Docker']]] : process.platform === 'win32' ? (existsSync(DESKTOP) ? [['cmd', ['/c', 'start', '', DESKTOP]]] : [])
    : [['systemctl', ['start', 'docker']], ['systemctl', ['--user', 'start', 'docker']]];
  for (const [cmd, args] of tries) if (!(await run(cmd, args, { timeout: 20000 })).code) { sweeps = 0; await tick(); return { ok: true }; }
  // A user service cannot start a system service directly; polkit can ask the person at the machine to allow it.
  if (process.platform === 'linux' && !(await run('pkexec', ['systemctl', 'start', 'docker'], { timeout: 60000 })).code) { sweeps = 0; await tick(); return { ok: true }; }
  return fail(500, 'Could not start Docker. Start it yourself, then come back');
}

// One look at everything, every two seconds: the GPUs, each host run, Docker, and the models started elsewhere.
let ticking = false;
export async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    status.gpus = await readGpus();
    const listedAt = Date.now();
    await adoptHosts();
    await Promise.all([...runs.values()].filter((r) => r.host).map(checkHost));
    // Every running engine is asked how it is on every tick. Docker itself is asked less often (see dockerIsDue).
    if (dockerIsDue()) await sweepContainers(listedAt);
    else await Promise.all([...runs.values()].filter((r) => r.container && !r.busy && !['stopping', 'failed'].includes(r.phase)).map(health));
    for (const gpu of status.gpus) if (isHeld(gpu)) gpu.busy = true; // an Intel card another program's container holds
    await discover(listedAt);
  } catch (e) {
    event('error', 'tick.failed', { error: e.message });
  } finally { ticking = false; }
}

// How a run looks to the app: how far along it is (p), one line about it, and for a failure the word that names it.
function describe(r) {
  const expected = loadSeconds(r.recipe), elapsed = (Date.now() - r.since) / 1000;
  const heard = r.heard ? Math.max(1, Math.round((Date.now() - r.heard) / 60000)) : 0;
  return {
    queued: { line: 'Getting ready', p: 0.02 },
    weights: { line: r.detail || 'Getting the model', p: 0.05 + (r.progress || 0) * 0.3 },
    image: { line: r.detail || 'Preparing the engine', p: 0.38 },
    starting: { line: expected ? `About ${Math.max(1, Math.ceil((expected - elapsed) / 60))} min` : 'Loading the model', p: 0.42 + 0.48 * Math.min(1, expected ? elapsed / expected : 0.5) },
    testing: { line: 'Asking it one question', p: 0.95 },
    ready: { line: 'Running', p: 1 },
    unresponsive: { line: `Last heard ${heard} min ago`, p: 0.6 },
    failed: { ...(r.failure || { word: 'Stopped', line: r.error || '' }), p: -1 },
    stopping: { line: 'Freeing the GPU', p: 0.3 },
  }[r.phase];
}

export const all = () => [...runs.values()];
// What the app is told about a run. Anything not named here stays inside the server.
const SHOWN = ['id', 'host', 'recipe', 'name', 'url', 'gpus', 'since', 'readyAt', 'phase', 'detail', 'progress', 'error', 'failure', 'served', 'apis', 'stats', 'external', 'byStudio', 'reachable', 'born'];
export const listRuns = () => all().sort((a, b) => a.id - b.id).map((r) => ({
  ...Object.fromEntries(SHOWN.map((k) => [k, r[k]])), view: describe(r), expected: loadSeconds(r.recipe), ctx: find(r.recipe)?.launch?.ctx || r.window || 0, vision: !!find(r.recipe)?.launch?.vision,
}));
