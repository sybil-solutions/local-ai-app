import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { blocked, cardFor, find, flagsOf, isLocal, label } from './recipes.js';
import { loadSeconds, measure, saveLoad, speedOf } from './speed.js';
import { at, config, ENGINE_HOST, event, fail, HOST, PORT, readJson, run, saveConfig, sleep, writeJson } from './util.js';

const MODELS = process.env.LOCAL_AI_MODELS || at('models');
const HF_HOME = process.env.HF_HOME || join(homedir(), '.cache/huggingface');
const HF = process.env.HF_ENDPOINT || 'https://huggingface.co';
const OWNED_FLAGS = new Set(['--network', '--net', '--gpus', '--name', '--rm', '-d', '--detach', '-p', '--publish', '--label', '--entrypoint', '--restart']);
const START_DEADLINE = 2 * 3600e3;
const METRICS_FLAGS = [[/sglang/, '--enable-metrics'], [/llama-server/, '--metrics']];
const docker = (args, opts) => run('docker', args, opts);
const usageFile = at('usage.json');

const runs = new Map();
const removed = new Map();
const usage = { days: {}, hours: {}, last: {}, ...readJson(usageFile, {}) };
let usageDirty = false;
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

const tokenFile = join(HF_HOME, 'token');
const hfToken = () => process.env.HF_TOKEN || (existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '');
const hfHeaders = () => (hfToken() ? { authorization: `Bearer ${hfToken()}` } : {});
export const tokenHint = () => (hfToken() ? hfToken().slice(-4) : null);
export function saveToken(token) {
  mkdirSync(HF_HOME, { recursive: true });
  writeFileSync(tokenFile, String(token || '').trim(), { mode: 0o600 });
}

async function hfFiles(repo, revision, signal) {
  const files = [];
  let url = `${HF}/api/models/${repo}/tree/${revision}?recursive=true`;
  while (url) {
    const res = await fetch(url, { headers: hfHeaders(), signal });
    if (res.status === 401 || res.status === 403) throw new Error(`${repo} is gated: add a token to ${join(HF_HOME, 'token')}`);
    if (!res.ok) throw new Error(`Hugging Face answered ${res.status} for ${repo}`);
    files.push(...(await res.json()).filter((f) => f.type === 'file'));
    url = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') || '')?.[1];
  }
  return files;
}

const sha256 = async (file, signal) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest('hex');
};

async function fetchFile(repo, revision, file, dest, onBytes, signal) {
  const target = join(dest, file.path);
  const wanted = file.lfs?.oid;
  const good = async (p) => statSync(p).size === file.size && (!wanted || (await sha256(p, signal)) === wanted);
  if (existsSync(target) && (await good(target))) return onBytes(file.size);
  mkdirSync(dirname(target), { recursive: true });
  const part = `${target}.part`;
  for (let attempt = 1; ; attempt++) {
    try {
      const have = existsSync(part) ? statSync(part).size : 0;
      onBytes(0);
      if (have < file.size) {
        const res = await fetch(`${HF}/${repo}/resolve/${revision}/${file.path}`, { headers: { ...hfHeaders(), range: `bytes=${have}-` }, signal });
        if (![200, 206].includes(res.status)) throw new Error(`download answered ${res.status}`);
        const resume = res.status === 206;
        if (resume) onBytes(have);
        const count = new Transform({ transform(chunk, _, next) { onBytes(chunk.length); next(null, chunk); } });
        await pipeline(Readable.fromWeb(res.body), count, createWriteStream(part, { flags: resume ? 'a' : 'w' }), { signal });
      } else {
        onBytes(have);
        if (!existsSync(part)) writeFileSync(part, '');
      }
      if (!(await good(part))) { writeFileSync(part, ''); throw new Error(`${file.path} failed its checksum`); }
      return renameSync(part, target);
    } catch (e) {
      if (signal.aborted || attempt >= 4) throw e;
      event('warn', 'download.retry', { file: file.path, attempt, error: e.message });
      await sleep(2000 * attempt);
    }
  }
}

const size = (n, scale) => (scale >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);
const weightsOf = (launch) => [].concat(launch.weights || []).filter(Boolean);
const weightDir = (w) => (w.layout === 'hub' ? join(HF_HOME, 'hub', `models--${w.repo.replace('/', '--')}`, 'snapshots', w.revision) : join(MODELS, `${w.repo.split('/').pop()}-${w.revision.slice(0, 8)}`));
const weightMount = (w) => (w.path ? `${w.path}:${w.at}:ro` : w.layout === 'hub' ? `${join(HF_HOME, 'hub')}:${w.at}/hub:ro` : `${weightDir(w)}:${w.at}:ro`);

const markerOf = (w) => join(weightDir(w), `.complete-${createHash('sha256').update(String(w.files || '')).digest('hex').slice(0, 12)}`);
export const onDisk = (id) => weightsOf(find(id).launch).every((w) => existsSync(w.path || markerOf(w)));

async function fetchWeights(r, launch, signal) {
  for (const w of weightsOf(launch)) {
    if (w.path) { if (!existsSync(w.path)) throw new Error(`Weights folder ${w.path} does not exist`); continue; }
    const dest = weightDir(w);
    const marker = markerOf(w);
    if (existsSync(marker)) continue;
    update(r, { phase: 'weights', detail: `Listing ${w.repo}`, progress: 0 });
    const only = String(w.files || '').split(',').filter(Boolean);
    const files = (await hfFiles(w.repo, w.revision, signal)).filter((f) => !only.length || only.includes(f.path));
    if (only.length && files.length < only.length) throw new Error(`${w.repo} is missing some recipe files`);
    const total = files.reduce((n, f) => n + f.size, 0);
    mkdirSync(dest, { recursive: true });
    const space = statfsSync(dest);
    const needed = files.filter((f) => !existsSync(join(dest, f.path))).reduce((n, f) => n + f.size, 0);
    if (space.bavail * space.bsize < needed) throw new Error(`Needs ${Math.ceil(needed / 1e9)} GB free in ${dest}`);
    const seen = new Map();
    const pending = [...files];
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (let f = pending.shift(); f; f = pending.shift()) {
        seen.set(f.path, 0);
        const onBytes = (n) => {
          seen.set(f.path, n === 0 ? 0 : seen.get(f.path) + n);
          const done = [...seen.values()].reduce((a, b) => a + b, 0);
          update(r, { detail: `${size(done, total)} of ${size(total, total)}`, progress: total ? Math.min(1, done / total) : 1 });
        };
        await fetchFile(w.repo, w.revision, f, dest, onBytes, signal);
      }
    }));
    writeFileSync(marker, new Date().toISOString());
  }
}

function dockerArgs(r, recipe, name) {
  const launch = recipe.launch;
  const entry = [].concat(launch.entrypoint || []);
  const hub = weightsOf(launch).some((w) => w.layout === 'hub');
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
    '--label', `local-ai.gpus=${r.gpus.join('+')}`, '--label', `local-ai.since=${r.since}`, '--gpus', `"device=${r.gpus.join(',')}"`,
    '-p', `${HOST}:${r.id}:${launch.port}`, ...(shared ? ['-p', `${shared}:${r.id}:${launch.port}`] : []), ...(isLocal(r.recipe) ? [] : ['--security-opt', 'no-new-privileges']), ...(launch.shm ? ['--shm-size', launch.shm] : []), ...keep,
    ...env.flatMap(([k, v]) => ['-e', `${k}=${v}`]), ...(hub ? ['-e', 'HF_HUB_OFFLINE=1'] : []),
    ...weightsOf(launch).flatMap((w) => ['-v', weightMount(w)]), ...(configFile ? ['-v', `${configFile}:${launch.config.at}:ro`] : []),
    ...(entry[0] ? ['--entrypoint', entry[0]] : []), launch.image, ...entry.slice(1), ...(launch.args || []), ...(metrics ? [metrics] : [])];
}

async function launch(r, recipe) {
  const { signal } = r.abort;
  try {
    await fetchWeights(r, recipe.launch, signal);
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

export async function start(id, picked) {
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
  if (gpus.length !== need || gpus.some((g) => !free.includes(g))) fail(409, `Needs ${need} free GPU${need > 1 ? 's' : ''}; ${free.length} free`);
  const r = { id: port, recipe: id, gpus, phase: 'queued', detail: 'Queued', progress: null, error: null, since: Date.now(), busy: true, abort: new AbortController(), apis: null, stats: null, misses: 0 };
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
  delete usage.last[r.container];
  usageDirty = true;
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
    const res = await fetch(`http://${ENGINE_HOST}:${r.id}/v1/models`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) { update(r, { served: (await res.json()).data?.[0]?.id ?? r.served, misses: 0 }); return true; }
  } catch { /* still loading, or busy */ }
  r.misses++;
  return false;
}

async function testReply(r) {
  try {
    const res = await fetch(`http://${ENGINE_HOST}:${r.id}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer local' }, signal: AbortSignal.timeout(90000),
      body: JSON.stringify({ model: r.served, max_tokens: 4, messages: [{ role: 'user', content: 'Say OK.' }] }) });
    return res.ok && !!(await res.json()).choices?.length;
  } catch { return false; }
}

export function startMeasure(r) {
  const recipe = find(r.recipe);
  update(r, { tried: true, measureAbort: new AbortController(), measuring: 1 });
  measure({ id: r.recipe, url: `http://${ENGINE_HOST}:${r.id}`, model: r.served, seqs: recipe?.launch.seqs || 1, signal: r.measureAbort.signal, onLevel: (c) => { r.measuring = c; } })
    .catch((e) => { if (!r.measureAbort?.signal.aborted) event('warn', 'speed.failed', { id: r.recipe, error: e.message }); })
    .finally(() => update(r, { measuring: 0, measureAbort: null }));
}
export const cancelMeasure = (rawId) => runs.get(+rawId)?.measureAbort?.abort();
export function measureNow(rawId) {
  const r = runs.get(+rawId) || fail(404, 'No such run');
  if (r.phase !== 'ready') fail(409, 'The model is not ready');
  if (r.measuring) fail(409, 'Already measuring');
  if (r.stats?.active) fail(409, 'It is busy answering');
  startMeasure(r);
  return { id: r.id };
}

async function probeApis(r) {
  const paths = { chat: '/v1/chat/completions', responses: '/v1/responses', messages: '/v1/messages' };
  const found = await Promise.all(Object.entries(paths).map(async ([api, path]) => {
    try {
      const res = await fetch(`http://${ENGINE_HOST}:${r.id}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(4000) });
      return ![404, 405].includes(res.status) && api;
    } catch { return null; }
  }));
  if (found.includes(null)) return;
  r.apis = found.filter(Boolean);
  event('info', 'run.apis', { id: r.id, apis: r.apis });
}

function parseMetrics(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^(?:vllm|sglang|llamacpp)[:_]([a-z_0-9]+)(?:\{.*\})? ([-0-9.e+]+)$/.exec(line);
    if (m) out[m[1]] = (out[m[1]] || 0) + +m[2];
  }
  return out;
}

async function scrape(r, now) {
  let m;
  try {
    const res = await fetch(`http://${ENGINE_HOST}:${r.id}/metrics`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return;
    m = parseMetrics(await res.text());
  } catch { return; }
  const cur = { in: m.prompt_tokens_total || 0, out: m.generation_tokens_total || m.tokens_predicted_total || 0, req: m.request_success_total || 0 };
  const key = r.container;
  const last = usage.last[key] || cur;
  const delta = Object.fromEntries(Object.keys(cur).map((k) => [k, cur[k] >= last[k] ? cur[k] - last[k] : cur[k]]));
  usage.last[key] = cur;
  r.used ||= { in: 0, out: 0, req: 0 };
  if (!r.measuring && (delta.in || delta.out || delta.req)) {
    const stamp = new Date(now).toISOString();
    const row = ((usage.days[stamp.slice(0, 10)] ||= {})[nameOf(r)] ||= { in: 0, out: 0, req: 0 });
    const hour = ((usage.hours[stamp.slice(0, 13)] ||= {})[nameOf(r)] ||= { in: 0, out: 0, req: 0 });
    for (const k of Object.keys(delta)) { row[k] += delta[k]; hour[k] += delta[k]; r.used[k] += delta[k]; }
    usageDirty = true;
  }
  r.series ||= [];
  if (!r.series.length || now - r.series.at(-1)[0] >= 60000) { r.series.push([now, r.used.in + r.used.out]); if (r.series.length > 240) r.series.shift(); }
  const seconds = r.scraped ? (now - r.scraped) / 1000 : 0;
  const ttftN = m.time_to_first_token_seconds_count;
  r.stats = {
    tps: seconds ? Math.round((delta.out / seconds) * 10) / 10 : 0, pps: seconds ? Math.round(delta.in / seconds) : 0, used: r.used.in + r.used.out, active: m.num_requests_running ?? m.num_running_reqs ?? m.requests_processing ?? 0,
    queued: m.num_requests_waiting ?? m.num_queue_reqs ?? 0, ttft: ttftN ? Math.round((m.time_to_first_token_seconds_sum / ttftN) * 100) / 100 : null,
    in: cur.in, out: cur.out, req: cur.req,
  };
  r.scraped = now;
}

const nameOf = (r) => label(r.recipe);
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
    r = { id, recipe: c.labels['local-ai.recipe'], gpus: (c.labels['local-ai.gpus'] || '').split('+').filter(Boolean).map(Number), phase: 'starting', detail: 'Loading model', progress: null, error: null, since: +c.labels['local-ai.since'] || Date.now(), busy: false, container: c.name, apis: null, stats: null, misses: 0, seen: true };
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
  if (up && r.phase !== 'ready' && !r.replying) {
    update(r, { phase: 'testing', detail: 'Asking it one question', replying: true });
    testReply(r).then((ok) => {
      r.replying = false;
      if (!ok || runs.get(r.id) !== r || r.phase !== 'testing') return;
      const seconds = Math.round((Date.now() - r.since) / 1000);
      update(r, { phase: 'ready', detail: null, error: null, failure: null, seen: true, readyAt: Date.now() });
      saveLoad(r.recipe, seconds);
      event('info', 'run.ready', { id: r.id, recipe: r.recipe, seconds });
    });
  }
  if (r.phase === 'ready') {
    if (!r.apis && up) await probeApis(r);
    if (!up && r.misses >= 15) { update(r, { phase: 'unresponsive', detail: null, heard: now - r.misses * 2000 }); event('warn', 'run.unresponsive', { id: r.id }); }
    else {
      await scrape(r, now);
      if (up && !r.measuring && !r.tried && !speedOf(r.recipe) && !r.stats?.active && now - r.readyAt > 3000) startMeasure(r);
    }
  } else if (!r.seen && r.phase !== 'failed' && now - r.since > START_DEADLINE) {
    setFailed(r, 'The engine did not become ready within 2 hours');
  }
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
  } catch (e) {
    event('error', 'tick.failed', { error: e.message });
  } finally { ticking = false; }
}

export function flushUsage() {
  if (!usageDirty) return;
  const old = new Date(Date.now() - 48 * 3600e3).toISOString().slice(0, 13);
  for (const h of Object.keys(usage.hours)) if (h < old) delete usage.hours[h];
  writeJson(usageFile, usage);
  usageDirty = false;
}

function describe(r) {
  const expected = loadSeconds(r.recipe);
  const elapsed = (Date.now() - r.since) / 1000;
  const left = expected ? Math.max(1, Math.ceil((expected - elapsed) / 60)) : 0;
  const waking = expected ? `About ${left} minute${left > 1 ? 's' : ''}` : 'Loading the model';
  const heard = r.heard ? Math.max(1, Math.round((Date.now() - r.heard) / 60000)) : 0;
  return {
    queued: { word: 'Waking', line: 'Getting ready', p: 0.02 },
    weights: { word: 'Downloading', line: r.detail || 'Getting the model', p: 0.05 + (r.progress || 0) * 0.3 },
    image: { word: 'Waking', line: r.detail || 'Preparing the engine', p: 0.38 },
    starting: { word: 'Waking', line: waking, p: 0.42 + 0.48 * Math.min(1, expected ? elapsed / expected : 0.5) },
    testing: { word: 'Waking', line: 'Asking it one question', p: 0.95 },
    ready: { word: 'Awake', line: r.measuring ? `Measuring speed, ${r.measuring} at once` : r.stats?.tps ? `${Math.round(r.stats.tps)} tokens a second` : 'Listening. Nothing leaves this machine.', p: 1 },
    unresponsive: { word: 'No reply', line: `Last heard ${heard} minute${heard > 1 ? 's' : ''} ago`, p: 0.6 },
    failed: { ...(r.failure || { word: 'Stopped', line: r.error || '' }), p: -1 },
    stopping: { word: 'Going to sleep', line: 'Freeing the GPU', p: 0.3 },
  }[r.phase] || { word: 'Waking', line: '', p: 0.1 };
}

export const listRuns = () => [...runs.values()].sort((a, b) => a.id - b.id).map(({ abort, measureAbort, busy, misses, scraped, seen, touched, replying, tried, heard, series, used, ...r }) => ({
  ...r, view: describe(runs.get(r.id)), expected: loadSeconds(r.recipe), name: nameOf(r), ctx: find(r.recipe)?.launch.ctx || 0, vision: !!find(r.recipe)?.launch.vision, card: find(r.recipe)?.card || null,
}));

export function usageView() {
  const days = Object.keys(usage.days).sort();
  const total = (d) => Object.values(usage.days[d]).reduce((n, row) => n + row.in + row.out, 0);
  const sum = (list) => list.reduce((n, d) => n + total(d), 0);
  const models = {};
  for (const d of days) for (const [name, row] of Object.entries(usage.days[d])) {
    const m = (models[name] ||= { name, in: 0, out: 0, req: 0 });
    for (const k of ['in', 'out', 'req']) m[k] += row[k];
  }
  const today = new Date().toISOString().slice(0, 10);
  const week = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);
  return { today: days.includes(today) ? total(today) : 0, week: sum(days.filter((d) => d >= week)), all: sum(days), days: days.slice(-84).map((d) => ({ d, v: total(d) })), models: Object.values(models).sort((a, b) => b.out - a.out) };
}

// Everything the Usage screen draws: every day split by model, the last two days by hour, and each running model's own count.
export function usageDetail() {
  const days = Object.keys(usage.days).sort().map((d) => {
    const rows = Object.entries(usage.days[d]);
    return { d, out: rows.reduce((n, [, r]) => n + r.out, 0), req: rows.reduce((n, [, r]) => n + r.req, 0), models: Object.fromEntries(rows.map(([name, r]) => [name, r.in + r.out])) };
  });
  const live = [...runs.values()].filter((r) => r.phase === 'ready' && r.used).map((r) => ({ id: r.id, name: nameOf(r), since: r.readyAt, tokens: r.used.in + r.used.out, out: r.used.out, req: r.used.req, series: r.series || [] }));
  return { days, hours: usage.hours, runs: live };
}

// Who has been calling the engines today, read from their own access logs. Requests are counted, never kept.
const names = new Map();
async function whoIs(ip) {
  if (/^(127\.|172\.(1[6-9]|2\d|3[01])\.|::1)/.test(ip)) return { device: 'This computer', known: true };
  if (!names.has(ip)) {
    const r = await run('tailscale', ['whois', '--json', ip], { timeout: 4000 });
    let name = null;
    try { name = JSON.parse(r.stdout).Node?.ComputedName || null; } catch { /* not on the tailnet */ }
    names.set(ip, name);
  }
  return { device: names.get(ip) || ip, known: !!names.get(ip) };
}
export async function sources() {
  const since = new Date(); since.setHours(0, 0, 0, 0);
  const seen = new Map();
  for (const r of runs.values()) {
    if (!r.container) continue;
    const out = await docker(['logs', '-t', '--since', since.toISOString(), r.container], { timeout: 20000 });
    for (const line of `${out.stdout}${out.stderr}`.split('\n')) {
      const m = /^(\S+) .*?(\d{1,3}(?:\.\d{1,3}){3}):\d+ - "POST \/v1\//.exec(line) || /^(\S+) .*request: POST \/v1\/\S+ (\d{1,3}(?:\.\d{1,3}){3}) /.exec(line);
      if (!m) continue;
      const row = seen.get(m[2]) || { ip: m[2], requests: 0, last: m[1] };
      row.requests++; if (m[1] > row.last) row.last = m[1];
      seen.set(m[2], row);
    }
  }
  const rows = await Promise.all([...seen.values()].map(async (row) => ({ ...row, ...(await whoIs(row.ip)) })));
  const merged = new Map();
  for (const row of rows) { const had = merged.get(row.device); if (had) { had.requests += row.requests; if (row.last > had.last) had.last = row.last; } else merged.set(row.device, row); }
  return [...merged.values()].sort((a, b) => b.requests - a.requests);
}
