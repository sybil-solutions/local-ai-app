// Model weights: downloaded from Hugging Face, resumable, checked against their checksums, and mounted read-only into engines.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { at, event, sleep } from './util.js';

const MODELS = process.env.LOCAL_AI_MODELS || at('models');
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
// The docker arguments that put the weights inside the engine's container.
export const mounts = (launch) => [...weightsOf(launch).flatMap((w) => ['-v', weightMount(w)]), ...(weightsOf(launch).some((w) => w.layout === 'hub') ? ['-e', 'HF_HUB_OFFLINE=1'] : [])];
export const onDisk = (launch) => weightsOf(launch).every((w) => existsSync(w.path || markerOf(w)));

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
    if (existsSync(marker)) continue;
    const job = fetchAll(w, dest, signal, report).then(() => writeFileSync(marker, new Date().toISOString()));
    busy.set(dest, job);
    try { await job; } finally { busy.delete(dest); }
  }
}

async function fetchAll(w, dest, signal, report) {
  report({ phase: 'weights', detail: `Listing ${w.repo}`, progress: 0 });
  const only = String(w.files || '').split(',').filter(Boolean);
  const files = (await hfFiles(w.repo, w.revision, signal)).filter((f) => !only.length || only.includes(f.path));
  if (only.length && files.length < only.length) throw new Error(`${w.repo} is missing some recipe files`);
  const total = files.reduce((n, f) => n + f.size, 0);
  mkdirSync(dest, { recursive: true });
  const space = statfsSync(dest), have = (p) => (existsSync(p) ? statSync(p).size : 0); // a part already downloaded needs no more room
  const needed = files.filter((f) => !existsSync(join(dest, f.path))).reduce((n, f) => n + f.size - have(join(dest, `${f.path}.part`)), 0);
  if (space.bavail * space.bsize < needed) throw new Error(`Needs ${Math.ceil(needed / 1e9)} GB free in ${dest}`);
  const seen = new Map(), pending = [...files];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let f = pending.shift(); f; f = pending.shift()) {
      seen.set(f.path, 0);
      const onBytes = (n) => {
        seen.set(f.path, n === 0 ? 0 : seen.get(f.path) + n);
        const done = [...seen.values()].reduce((a, b) => a + b, 0);
        report({ detail: `${size(done, total)} of ${size(total, total)}`, progress: total ? Math.min(1, done / total) : 1 });
      };
      await fetchFile(w.repo, w.revision, f, dest, onBytes, signal);
    }
  }));
}
