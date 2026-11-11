// Model weights: downloaded from Hugging Face, resumable, checked against their checksums, and mounted read-only into engines.
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Worker } from 'node:worker_threads';
import { at, event, own, readJson, sleep, together, writeJson } from './util.js';

// LOCAL_AI_MODELS may name several folders. Downloads go to the first; the others hold weights you already have and
// are only ever read (see `matches`).
const [MODELS = at('models'), ...LOOK] = (process.env.LOCAL_AI_MODELS || '').split(delimiter).filter(Boolean);
const HF_HOME = process.env.HF_HOME || join(homedir(), '.cache/huggingface');
const HF = process.env.HF_ENDPOINT || 'https://huggingface.co';
const tokenFile = join(HF_HOME, 'token');
const hfToken = () => process.env.HF_TOKEN || (existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '');
const hfHeaders = () => (hfToken() ? { authorization: `Bearer ${hfToken()}` } : {});
export const tokenHint = () => (hfToken() ? hfToken().slice(-4) : null);
export function saveToken(token) {
  mkdirSync(HF_HOME, { recursive: true });
  writeFileSync(tokenFile, String(token || '').trim(), { mode: 0o600 });
}

// A file's name in a listing from the network must be a plain path inside the repo (a/b/c.bin). Anything else could
// be written wherever this user can write, so one such name refuses the whole download.
export const safeName = (path) => typeof path === 'string' && /^[\w.@+-]+(\/[\w.@+-]+)*$/.test(path) && !path.split('/').some((part) => part === '..' || part === '.');

async function hfFiles(repo, revision, signal) {
  const files = [];
  let url = `${HF}/api/models/${repo}/tree/${revision}?recursive=true`;
  while (url) {
    const res = await fetch(url, { headers: hfHeaders(), signal });
    if (res.status === 401 || res.status === 403) throw new Error(`${repo} is gated: add a token to ${join(HF_HOME, 'token')}`);
    if (!res.ok) throw new Error(`Hugging Face answered ${res.status} for ${repo}`);
    for (const f of (await res.json()).filter((x) => x.type === 'file')) {
      if (!safeName(f.path) || !Number.isFinite(f.size) || f.size < 0) throw new Error(`${repo} lists a file with an unsafe name, so nothing was downloaded`);
      files.push(f);
    }
    // The next page is asked for with the token, so it must be on the same server as this one.
    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') || '')?.[1];
    url = next && new URL(next, url).origin === new URL(HF).origin ? new URL(next, url).href : null;
    if (next && !url) throw new Error(`${repo}: the file list continues on another server, so nothing was downloaded`);
  }
  return files;
}

// A file's checksum, worked out on a thread of its own: weights are hundreds of gigabytes, several files are read at
// once, and the app goes on answering meanwhile. `start` is hashed in front of the file (git's header for a blob);
// `onBytes` hears each piece read.
const HASHER = `const { parentPort, workerData: d } = require('node:worker_threads'), { createHash } = require('node:crypto'), { openSync, readSync, closeSync } = require('node:fs');
const hash = createHash(d.kind).update(d.start), piece = Buffer.allocUnsafe(1 << 23), fd = openSync(d.file, 'r');
for (let n; (n = readSync(fd, piece, 0, piece.length, null)) > 0;) { hash.update(n === piece.length ? piece : piece.subarray(0, n)); parentPort.postMessage(n); }
closeSync(fd);
parentPort.postMessage(hash.digest('hex'));`;
const digest = (file, signal, { kind = 'sha256', start = '', onBytes } = {}) => new Promise((done, failed) => {
  if (signal?.aborted) { failed(signal.reason); return; }
  const worker = new Worker(HASHER, { eval: true, workerData: { file, kind, start } }), stop = () => { worker.terminate(); failed(signal.reason); };
  signal?.addEventListener('abort', stop, { once: true });
  worker.on('message', (m) => (typeof m === 'number' ? onBytes?.(m) : done(m)));
  worker.on('error', failed);
  worker.on('exit', () => { signal?.removeEventListener('abort', stop); failed(new Error(`Could not read ${file}`)); }); // a no-op once it has answered
});
const sha256 = (file, signal) => digest(file, signal);

async function fetchFile(repo, revision, file, dest, onBytes, signal) {
  const target = join(dest, file.path);
  if (!target.startsWith(`${dest}${sep}`)) throw new Error(`${file.path} would be written outside ${dest}`); // checked when listed; checked again where it is written
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
const weightMount = (w) => (w.path ? `${w.path}:${w.at}:ro` : w.layout === 'hub' ? `${join(HF_HOME, 'hub')}:${w.at}/hub:ro` : `${dirOf(w)}:${w.at}:ro`);

// Weights you already have: a folder named like the repo inside one of the extra folders. It is used where it is,
// read-only, once every file the recipe needs has been checked against Hugging Face's list for the pinned commit.
// What passed is kept in found.json, so the check is made once.
const foundFile = at('found.json'), found = Object.assign(Object.create(null), readJson(foundFile, {}));
const keyOf = (w) => `${w.repo}@${w.revision}${w.files ? `#${w.files}` : ''}`;
const foundAt = (w) => { const hit = own(found, keyOf(w)); return typeof hit?.path === 'string' && existsSync(hit.path) ? hit.path : null; };
const candidate = (w) => (w.layout === 'hub' || typeof w.repo !== 'string' ? null : LOOK.map((dir) => join(dir, w.repo.split('/').pop())).find((dir) => existsSync(dir)) ?? null);

// Where a weight lives on this machine: its own folder, one found and checked, or the one it is downloaded to.
export const dirOf = (w) => w.path || foundAt(w) || weightDir(w);
const markerOf = (w) => join(weightDir(w), `.complete-${createHash('sha256').update(String(w.files || '')).digest('hex').slice(0, 12)}`);
// The docker arguments that put the weights inside the engine's container.
export const mounts = (launch) => [...weightsOf(launch).map((w) => `--volume=${weightMount(w)}`), ...(weightsOf(launch).some((w) => w.layout === 'hub') ? ['--env=HF_HUB_OFFLINE=1'] : [])];
// A folder that is here but not yet checked counts as on disk: starting the recipe checks it, and downloads only if it differs.
export const onDisk = (launch) => weightsOf(launch).every((w) => existsSync(w.path || markerOf(w)) || !!foundAt(w) || !!candidate(w));

// Fetches whatever the recipe's weights still need. report() is told the phase, the detail line and the progress.
const busy = new Map(); // one download at a time per folder, because two recipes can share the same weights
export async function download(launch, signal, report) {
  for (const w of weightsOf(launch)) {
    if (w.path) { if (!existsSync(w.path)) throw new Error(`Weights folder ${w.path} does not exist`); continue; }
    const dest = weightDir(w), marker = markerOf(w);
    while (busy.has(dest) && !existsSync(marker)) {
      report({ phase: 'weights', detail: 'Waiting for another download of these weights', progress: null });
      await busy.get(dest).catch(() => {});
      signal.throwIfAborted();
    }
    if (existsSync(marker) || foundAt(w)) continue;
    const job = (async () => {
      const there = candidate(w), differs = there && await matches(w, there, signal, report);
      if (there && !differs) return;
      try { await fetchAll(w, dest, signal, report); } catch (e) { throw differs && !signal.aborted ? new Error(`${e.message}. The copy in ${there} was not used: ${differs}`) : e; }
      writeFileSync(marker, new Date().toISOString());
    })();
    busy.set(dest, job);
    try { await job; } finally { busy.delete(dest); }
  }
}

// The files of the repo that the recipe needs, as Hugging Face lists them at the pinned commit.
async function wanted(w, signal) {
  const only = String(w.files || '').split(',').filter(Boolean);
  const files = (await hfFiles(w.repo, w.revision, signal)).filter((f) => !only.length || only.includes(f.path));
  if (only.length && files.length < only.length) throw new Error(`${w.repo} is missing some recipe files`);
  return files;
}

// Checks a folder you already have against the pinned commit: every file the recipe needs is there, of the listed
// size, with the checksum Hugging Face gives (SHA-256 for a large file, git's own for a small one). Nothing in the
// folder is written or changed. Says what differs, or null when it is the same and has been noted as found.
async function matches(w, dir, signal, report) {
  report({ phase: 'weights', detail: `Checking the weights in ${dir}`, progress: 0 });
  const files = await wanted(w, signal), total = files.reduce((n, f) => n + f.size, 0), pending = [...files];
  let done = 0, told = 0, differs = null;
  const onBytes = (n) => {
    done += n;
    if (Date.now() - told < 250) return;
    told = Date.now();
    report({ detail: `Checking the weights in ${dir}: ${size(done, total)} of ${size(total, total)}`, progress: total ? Math.min(1, done / total) : 1 });
  };
  const same = async (f, either) => {
    const file = join(dir, f.path);
    if (!existsSync(file)) return `${f.path} is missing`;
    if (statSync(file).size !== f.size) return `${f.path} has another size`;
    const sum = f.lfs?.oid ? await digest(file, either, { onBytes }) : /^[0-9a-f]{40}$/.test(f.oid || '') ? await digest(file, either, { kind: 'sha1', start: `blob ${f.size}\0`, onBytes }) : null;
    return sum === null || sum === (f.lfs?.oid || f.oid) ? null : `${f.path} has other contents`;
  };
  await together(signal, Array.from({ length: 4 }, () => async (either) => {
    for (let f = pending.shift(); f && !differs; f = pending.shift()) differs = (await same(f, either)) || differs;
  }));
  if (differs) { event('warn', 'weights.differ', { repo: w.repo, folder: dir, why: differs }); return differs; }
  found[keyOf(w)] = { path: dir, at: new Date().toISOString() };
  writeJson(foundFile, found);
  event('info', 'weights.found', { repo: w.repo, folder: dir, files: files.length });
  return null;
}

async function fetchAll(w, dest, signal, report) {
  report({ phase: 'weights', detail: `Listing ${w.repo}`, progress: 0 });
  const files = await wanted(w, signal);
  const total = files.reduce((n, f) => n + f.size, 0);
  mkdirSync(dest, { recursive: true });
  const space = statfsSync(dest), have = (p) => (existsSync(p) ? statSync(p).size : 0); // a part already downloaded needs no more room
  const needed = files.filter((f) => !existsSync(join(dest, f.path))).reduce((n, f) => n + f.size - have(join(dest, `${f.path}.part`)), 0);
  if (space.bavail * space.bsize < needed) throw new Error(`Needs ${Math.ceil(needed / 1e9)} GB free in ${dest}`);
  const seen = new Map(), pending = [...files];
  await together(signal, Array.from({ length: 4 }, () => async (either) => {
    for (let f = pending.shift(); f; f = pending.shift()) {
      seen.set(f.path, 0);
      const onBytes = (n) => {
        seen.set(f.path, n === 0 ? 0 : seen.get(f.path) + n);
        const done = [...seen.values()].reduce((a, b) => a + b, 0);
        report({ detail: `${size(done, total)} of ${size(total, total)}`, progress: total ? Math.min(1, done / total) : 1 });
      };
      await fetchFile(w.repo, w.revision, f, dest, onBytes, either);
    }
  }));
}
