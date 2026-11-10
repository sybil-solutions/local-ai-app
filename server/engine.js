import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname } from 'node:path';
import { blocked, cardFor, find, flagsOf, isLocal, label } from './recipes.js';
import { loadSeconds, measure, saveLoad, speedOf } from './speed.js';
import * as usage from './usage.js';
import { at, config, ENGINE_HOST, event, fail, HOST, PORT, run, saveConfig } from './util.js';
import * as weights from './weights.js';

const OWNED_FLAGS = new Set(['--network', '--net', '--gpus', '--name', '--rm', '-d', '--detach', '-p', '--publish', '--label', '--entrypoint', '--restart']);
const START_DEADLINE = 2 * 3600e3;
const METRICS_FLAGS = [[/sglang/, '--enable-metrics'], [/llama-server/, '--metrics']];
const docker = (args, opts) => run('docker', args, opts);

const runs = new Map();
const removed = new Map();
export const status = { gpus: [], docker: { ok: false, error: 'Checking Docker' } };

let notify = () => {};
export const onChange = (fn) => { notify = fn; };
let shared = null;
export const shareOn = (ip) => { shared = ip; };
const update = (r, fields) => { Object.assign(r, fields); notify(); };
const FAILURES = [
  [/out of memory|OutOfMemory|CUBLAS|failed to allocate|Not enough GPU memory/i, 'Ran out of room', 'Too big for the free GPU memory'],
  [/nvidia-container|runtime.*nvidia|libnvidia/i, 'GPU not reaching Docker', 'Install the NVIDIA container toolkit'],
  [/driver.*(old|version|mismatch)|Failed to initialize NVML/i, 'Driver problem', 'Update your NVIDIA driver'],
  [/Engine stopped/, 'Stopped', 'It quit on its own'],
  [/within 2 hours/, 'Never woke up', 'Gave up after 2 hours'],
  [/gated|\b40[13]\b/, 'Locked model', 'Needs a Hugging Face token'],
  [/GB free in/, 'Not enough space', null],
  [/checksum/, 'Download damaged', 'One file came through wrong'],
  [/manifest|pull access|Could not pull/i, 'No engine', 'Could not get the engine'],
  [/fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN/i, 'No connection', 'Check your network and try again'],
];
function classify(text) {
  const hit = FAILURES.find(([re]) => re.test(text));
  return hit ? { word: hit[1], line: hit[2] ?? text.trim().split('\n').pop().slice(0, 90) } : { word: 'Did not start', line: text.trim().split('\n').pop().slice(0, 90) };
}

function setFailed(r, error, logs = '') {
  update(r, { phase: 'failed', error, failure: classify(`${logs}\n${error}`), detail: null, progress: null, busy: false });
  event('error', 'run.failed', { id: r.id, recipe: r.recipe, error });
}

async function readGpus() {
  const q = 'index,name,memory.total,memory.used,utilization.gpu,power.draw,temperature.gpu';
  const r = await run('nvidia-smi', [`--query-gpu=${q}`, '--format=csv,noheader,nounits'], { timeout: 8000 });
  if (r.code) return [];
  const num = (s) => (Number.isFinite(+s) ? +s : null);
  return r.stdout.trim().split('\n').filter(Boolean).map((line) => {
    const [index, name, total, used, util, power, temp] = line.split(', ');
    return { index: +index, name, total: +total, used: num(used), util: num(util), power: num(power), temp: num(temp) };
  });
}

const claimed = () => new Set([...runs.values()].filter((r) => r.phase !== 'failed').flatMap((r) => r.gpus));
export const freeGpus = () => {
  const taken = claimed();
  return status.gpus.filter((g) => !taken.has(g.index) && (g.used ?? 0) < 2048);
};

const portFree = (port) => new Promise((done) => {
  const s = createServer();
  s.once('error', () => done(false));
  s.listen(port, HOST, () => s.close(() => done(true)));
});

function dockerArgs(r, recipe, name) {
  const launch = recipe.launch;
  r.reachable = !!shared || !/^127\./.test(HOST); // whether the port is published where another machine can call it
  const entry = [].concat(launch.entrypoint || []);
  const flags = flagsOf(launch);
  const keep = [];
  for (let i = 0; i < flags.length; i++) {
    const part = flags.slice(i, flags[i + 1] && !flags[i + 1].startsWith('-') ? i + 2 : i + 1);
    i += part.length - 1;
    if (!OWNED_FLAGS.has(part[0])) keep.push(...part);
  }
  const configFile = launch.config && at('runs', String(r.id), basename(launch.config.at));
  if (configFile) { mkdirSync(dirname(configFile), { recursive: true }); writeFileSync(configFile, launch.config.text); }
  const command = [...entry, ...(launch.args || [])];
  const metrics = METRICS_FLAGS.find(([re, flag]) => re.test(command.join(' ')) && !command.includes(flag))?.[1];
  const env = Object.entries(launch.env || {}).filter(([k]) => !['NVIDIA_VISIBLE_DEVICES', 'CUDA_VISIBLE_DEVICES'].includes(k));
  return ['run', '-d', '--name', name, '--label', 'local-ai=1', '--label', `local-ai.port=${r.id}`, '--label', `local-ai.recipe=${r.recipe}`,
    '--label', `local-ai.gpus=${r.gpus.join('+')}`, '--label', `local-ai.since=${r.since}`, '--label', `local-ai.reach=${+r.reachable}`, '--gpus', `"device=${r.gpus.join(',')}"`,
    '-p', `${HOST}:${r.id}:${launch.port}`, ...(shared ? ['-p', `${shared}:${r.id}:${launch.port}`] : []), ...(isLocal(r.recipe) ? [] : ['--security-opt', 'no-new-privileges']), ...(launch.shm ? ['--shm-size', launch.shm] : []), ...keep,
    ...env.flatMap(([k, v]) => ['-e', `${k}=${v}`]), ...weights.mounts(launch), ...(configFile ? ['-v', `${configFile}:${launch.config.at}:ro`] : []),
    ...(entry[0] ? ['--entrypoint', entry[0]] : []), launch.image, ...entry.slice(1), ...(launch.args || []), ...(metrics ? [metrics] : [])];
}

async function launch(r, recipe) {
  const { signal } = r.abort;
  try {
    await weights.download(recipe.launch, signal, (fields) => update(r, fields));
    update(r, { phase: 'image', detail: 'Checking engine image', progress: null });
    if ((await docker(['image', 'inspect', recipe.launch.image], { signal })).code) {
      update(r, { detail: 'Pulling engine image' });
      const pulled = await docker(['pull', recipe.launch.image], { timeout: 4 * 3600e3, signal });
      if (pulled.code) throw new Error(pulled.stderr.trim().slice(-400) || 'Could not pull the engine image');
    }
    const name = `local-ai-${r.id}`;
    update(r, { phase: 'starting', detail: 'Loading model', container: name, since: Date.now() });
    const started = await docker(dockerArgs(r, recipe, name), { timeout: 120000, signal });
    if (started.code) {
      await docker(['rm', '-f', name]);
      r.container = null;
      throw new Error(started.stderr.trim().slice(-400) || 'docker run failed');
    }
    update(r, { busy: false, touched: Date.now() });
    event('info', 'run.container', { id: r.id, recipe: r.recipe, gpus: r.gpus });
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
  const why = blocked(id);
  if (why) fail(409, why);
  if (!status.docker.ok) fail(503, status.docker.error);
  if ([...runs.values()].some((r) => r.recipe === id && r.phase !== 'failed')) fail(409, 'This recipe is already running');
  let port = PORT + 1;
  while (port < PORT + 100 && (runs.has(port) || !(await portFree(port)))) port++;
  if (port >= PORT + 100) fail(409, 'No free port left');
  if (runs.has(port)) fail(409, 'Another launch just started, try again');
  const need = recipe.launch.cards || 1;
  const free = freeGpus().filter((g) => cardFor(g) === recipe.card).map((g) => g.index);
  const gpus = picked?.length ? picked : free.slice(0, need);
  if (gpus.length !== need || new Set(gpus).size !== need || gpus.some((g) => !free.includes(g))) fail(409, `Needs ${need} free GPU${need > 1 ? 's' : ''}; ${free.length} free`);
  const r = { id: port, recipe: id, name: label(id), url: `http://${ENGINE_HOST}:${port}`, gpus, phase: 'queued', detail: 'Queued', progress: null, error: null, since: Date.now(), busy: true, abort: new AbortController(), apis: null, stats: null, misses: 0 };
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
  if (r.external) fail(409, 'Local AI didn’t start this model, so it can’t stop it');
  const previous = r.phase;
  r.abort?.abort();
  r.measureAbort?.abort();
  update(r, { phase: 'stopping', detail: 'Stopping', progress: null });
  if (r.container) {
    if (previous !== 'failed') await docker(['stop', '-t', '15', r.container], { timeout: 40000 });
    const gone = await docker(['rm', '-f', r.container], { timeout: 20000 });
    if (gone.code && !/No such container/i.test(gone.stderr)) {
      setFailed(r, `Could not remove the container: ${gone.stderr.trim().slice(-300)}`);
      fail(500, r.error);
    }
  }
  if (r.container) removed.set(r.container, Date.now());
  runs.delete(r.id);
  usage.forget(r);
  event('info', 'run.removed', { id: r.id, recipe: r.recipe });
  return { id: r.id };
}

export async function logs(rawId, tail) {
  const r = runs.get(+rawId) || fail(404, 'No such run');
  if (!r.container) return { text: r.error || r.detail || '' };
  const out = await docker(['logs', '--tail', String(Math.min(+tail || 400, 5000)), r.container], { timeout: 10000 });
  return { text: `${out.stdout}${out.stderr}` };
}

async function probe(r) {
  try {
    const res = await fetch(`${r.url}/v1/models`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) { update(r, { served: (await res.json()).data?.[0]?.id ?? r.served, misses: 0 }); return true; }
  } catch { /* still loading, or busy */ }
  r.misses++;
  return false;
}

async function testReply(r) {
  try {
    const res = await fetch(`${r.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer local' }, signal: AbortSignal.timeout(90000),
      body: JSON.stringify({ model: r.served, max_tokens: 4, messages: [{ role: 'user', content: 'Say OK.' }] }) });
    return res.ok && !!(await res.json()).choices?.length;
  } catch { return false; }
}

function startMeasure(r) {
  const recipe = find(r.recipe);
  update(r, { tried: true, measureAbort: new AbortController(), measuring: 1 });
  measure({ id: r.recipe, url: r.url, model: r.served, seqs: recipe?.launch.seqs || 1, signal: r.measureAbort.signal, onLevel: (c) => { r.measuring = c; } })
    .catch((e) => { if (!r.measureAbort?.signal.aborted) event('warn', 'speed.failed', { id: r.recipe, error: e.message }); })
    .finally(() => update(r, { measuring: 0, measureAbort: null, benchmarked: true }));
}
export const cancelMeasure = (rawId) => runs.get(+rawId)?.measureAbort?.abort();
export function measureNow(rawId) {
  const r = runs.get(+rawId) || fail(404, 'No such run');
  if (r.phase !== 'ready' || r.external) fail(409, 'The model is not ready');
  if (r.measuring) fail(409, 'Already measuring');
  if (r.stats?.active) fail(409, 'It is busy answering');
  startMeasure(r);
  return { id: r.id };
}

async function probeApis(r) {
  const paths = { chat: '/v1/chat/completions', responses: '/v1/responses', messages: '/v1/messages' };
  const found = await Promise.all(Object.entries(paths).map(async ([api, path]) => {
    try {
      const res = await fetch(`${r.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(4000) });
      return ![404, 405].includes(res.status) && api;
    } catch { return null; }
  }));
  if (found.includes(null)) return;
  r.apis = found.filter(Boolean);
  event('info', 'run.apis', { id: r.id, apis: r.apis });
}

const parseLabels = (text) => Object.fromEntries(text.split(',').map((p) => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)]; }));

async function inspectAll() {
  const ps = await docker(['ps', '-a', '--filter', 'label=local-ai=1', '--format', '{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Labels}}'], { timeout: 10000 });
  if (ps.code) {
    update(status.docker, { ok: false, error: ps.code === 127 ? 'Docker is not installed' : `Docker is not reachable: ${ps.stderr.trim().slice(0, 200)}` });
    return null;
  }
  update(status.docker, { ok: true, error: null });
  return ps.stdout.trim().split('\n').filter(Boolean).map((line) => {
    const [name, state, text, labels] = line.split('\t');
    return { name, state, text, labels: parseLabels(labels) };
  });
}

async function reconcile(c, listedAt) {
  if (removed.get(c.name) >= listedAt) return;
  const id = +c.labels['local-ai.port'];
  let r = runs.get(id);
  if (!r) {
    r = { id, recipe: c.labels['local-ai.recipe'], name: label(c.labels['local-ai.recipe']), url: `http://${ENGINE_HOST}:${id}`, reachable: c.labels['local-ai.reach'] ? c.labels['local-ai.reach'] === '1' : !/^127\./.test(HOST), gpus: (c.labels['local-ai.gpus'] || '').split('+').filter(Boolean).map(Number), phase: 'starting', detail: 'Loading model', progress: null, error: null, since: +c.labels['local-ai.since'] || Date.now(), busy: false, container: c.name, apis: null, stats: null, misses: 0, seen: true };
    runs.set(id, r);
    event('info', 'run.adopted', { id, recipe: r.recipe });
  }
  if (r.busy || r.phase === 'stopping') return;
  if (c.state !== 'running') {
    if (r.phase !== 'failed') {
      const logs = await docker(['logs', '--tail', '120', c.name], { timeout: 8000 });
      setFailed(r, `Engine stopped: ${c.text}`, `${logs.stdout}${logs.stderr}`);
    }
    return;
  }
  const up = await probe(r);
  const now = Date.now();
  if (runs.get(id) !== r || r.phase === 'stopping') return; // stopped while we were asking
  if (up && r.phase !== 'ready' && !r.replying) {
    update(r, { phase: 'testing', detail: 'Asking it one question', replying: true });
    testReply(r).then((ok) => {
      r.replying = false;
      if (!ok || runs.get(r.id) !== r || r.phase !== 'testing') return;
      const adopted = r.seen; // already running when we found it, so its age is not a load time
      const seconds = Math.round((Date.now() - r.since) / 1000);
      update(r, { phase: 'ready', detail: null, error: null, failure: null, seen: true, readyAt: Date.now() });
      if (!adopted) saveLoad(r.recipe, seconds);
      event('info', 'run.ready', { id: r.id, recipe: r.recipe, seconds });
    });
  }
  if (r.phase === 'ready') {
    if (!r.apis && up) await probeApis(r);
    if (!up && r.misses >= 15) { update(r, { phase: 'unresponsive', detail: null, heard: now - r.misses * 2000 }); event('warn', 'run.unresponsive', { id: r.id }); }
    else {
      await usage.scrape(r, now);
      const still = runs.get(id) === r && r.phase === 'ready'; // it may have been stopped while we were reading it
      if (still && up && !r.measuring && !r.tried && !speedOf(r.recipe) && !r.stats?.active && now - r.readyAt > 3000) startMeasure(r);
    }
  } else if (!r.seen && r.phase !== 'failed' && now - r.since > START_DEADLINE) {
    setFailed(r, 'The engine did not become ready within 2 hours');
  }
}

// Models someone else started: anything on this machine that answers like an OpenAI server. They are shown, never stopped.
let scanned = 0;
async function discover(now) {
  for (const r of runs.values()) {
    if (!r.external) continue;
    if (!(await probe(r)) && r.misses >= 3) { runs.delete(r.id); event('info', 'run.gone', { id: r.id }); continue; }
    if (!r.apis) await probeApis(r);
    await usage.scrape(r, now);
  }
  if (now - scanned < 30000) return;
  scanned = now;
  const text = (process.platform === 'darwin' ? await run('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n']) : await run('ss', ['-ltnH'])).stdout;
  const open = new Map([...text.matchAll(/(\S+):(\d+)\s/g)].map((m) => [+m[2], !/^(127\.|\[::1\])/.test(m[1])]));
  const found = await Promise.all([...open.keys()].filter((p) => p > 1024 && p !== PORT && !runs.has(p)).sort((a, b) => a - b).map(async (port) => {
    try { const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(800) }); return [port, res.ok && (await res.json()).data?.[0]?.id]; } catch { return [port, null]; }
  }));
  const known = new Set([...runs.values()].map((r) => r.served));
  for (const [port, model] of found) {
    if (!model || known.has(model)) continue; // the same model behind a proxy is still one model
    known.add(model);
    runs.set(port, { id: port, recipe: null, external: true, reachable: open.get(port), name: model, url: `http://127.0.0.1:${port}`, served: model, gpus: [], phase: 'ready', detail: null, progress: null, error: null, since: now, readyAt: now, apis: null, stats: null, misses: 0 });
    event('info', 'run.found', { id: port, model });
    notify();
  }
}

export async function startDocker() {
  const tries = process.platform === 'darwin' ? [['open', ['-a', 'Docker']]] : [['systemctl', ['start', 'docker']], ['systemctl', ['--user', 'start', 'docker']]];
  for (const [cmd, args] of tries) if (!(await run(cmd, args, { timeout: 20000 })).code) { await tick(); return { ok: true }; }
  return fail(500, 'Could not start Docker. Start it yourself, then come back');
}

let ticking = false;
export async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    status.gpus = await readGpus();
    const listedAt = Date.now();
    const containers = await inspectAll();
    if (containers) {
      const names = new Set(containers.map((c) => c.name));
      for (const r of runs.values()) {
        if (r.container && !r.busy && r.phase !== 'stopping' && !names.has(r.container) && !(r.touched >= listedAt)) {
          runs.delete(r.id);
          event('warn', 'run.vanished', { id: r.id, recipe: r.recipe });
        }
      }
      await Promise.all(containers.map((c) => reconcile(c, listedAt)));
      for (const [name, at_] of removed) if (at_ < listedAt) removed.delete(name);
    }
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
const SHOWN = ['id', 'recipe', 'name', 'url', 'gpus', 'since', 'readyAt', 'phase', 'detail', 'progress', 'error', 'failure', 'served', 'apis', 'stats', 'external', 'reachable'];
export const listRuns = () => all().sort((a, b) => a.id - b.id).map((r) => ({
  ...Object.fromEntries(SHOWN.map((k) => [k, r[k]])), view: describe(r), expected: loadSeconds(r.recipe), ctx: find(r.recipe)?.launch?.ctx || 0, vision: !!find(r.recipe)?.launch?.vision,
}));

