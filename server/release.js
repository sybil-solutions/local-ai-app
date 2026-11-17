// Published releases, and whether one can be trusted. A release carries a list of its files (local-ai-update.json):
// the version, what changed, and each file's size and SHA-256. The list is signed with the release key, whose public
// half is below, and nothing in it is believed until the signature checks out. A file is then trusted only when it
// has exactly the size and hash the signed list gives it. So whoever controls the download (GitHub, a proxy, the
// network) can withhold an update, but cannot make this machine install anything that was not published by whoever
// holds the release key; and no release is ever taken for an older one (no going back to a version with a known flaw).
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { at, bytesUpTo } from './util.js';

// The release key (scripts/release-key.mjs). Only a copy under test (LOCAL_AI_STAND_INS=1) may be given another one,
// with the stand-in releases it signs.
const RELEASE_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA3mMeETkKjyAUWMiAbtXuQfiPupsttuIYgyDDK1ToOH0=
-----END PUBLIC KEY-----`;
const TESTING = process.env.LOCAL_AI_STAND_INS === '1';
const KEY = createPublicKey(TESTING && process.env.LOCAL_AI_RELEASE_KEY ? process.env.LOCAL_AI_RELEASE_KEY : RELEASE_KEY);
const BASE = (TESTING && process.env.LOCAL_AI_RELEASES_URL) || 'https://github.com/sybil-solutions/local-ai-releases/releases';
export const LIST = 'local-ai-update.json';
export const pageOf = (version) => `${BASE.startsWith('https://github.com/') ? BASE : 'https://github.com/sybil-solutions/local-ai-releases/releases'}/tag/v${version}`;

// x.y.z only: what releases are numbered with. A prerelease or anything else is not a version to update to.
const VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;
export const newer = (a, b) => {
  const x = VERSION.exec(a), y = VERSION.exec(b);
  if (!x || !y) return false;
  for (let i = 1; i <= 3; i++) if (+x[i] !== +y[i]) return +x[i] > +y[i];
  return false;
};

const get = (url, signal) => fetch(url, { redirect: 'follow', headers: { 'user-agent': 'local-ai' }, signal: AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]) });

// The newest release's list, checked. Returns { version, notes, files }, or throws why it is not to be trusted.
export async function latest() {
  const [list, sig] = await Promise.all([LIST, `${LIST}.sig`].map(async (name) => {
    const res = await get(`${BASE}/latest/download/${name}`);
    if (!res.ok) throw new Error(res.status === 404 ? 'The newest release has no signed list of files yet' : `GitHub answered ${res.status}`);
    return bytesUpTo(res, 64 * 1024);
  }));
  if (!verify(null, list, KEY, Buffer.from(sig.toString('utf8').trim(), 'base64'))) throw new Error('The newest release is not signed with the release key, so it was not used');
  const out = JSON.parse(list.toString('utf8'));
  if (out?.app !== 'local-ai' || !VERSION.test(out.version) || typeof out.files !== 'object' || !out.files) throw new Error('The newest release’s list of files is not one Local AI can read');
  const files = {};
  for (const [name, f] of Object.entries(out.files)) if (/^[\w.-]+$/.test(name) && /^[0-9a-f]{64}$/.test(f?.sha256) && Number.isSafeInteger(f?.size) && f.size > 0) files[name] = { sha256: f.sha256, size: f.size };
  const notes = (Array.isArray(out.notes) ? out.notes : []).filter((n) => typeof n === 'string').slice(0, 12).map((n) => n.slice(0, 200));
  return { version: out.version, notes, files };
}

// Downloads one file of a release into Local AI's own folder, and keeps it only when it is the file the signed list
// names. Returns its path. `progress` is told the fraction done.
export async function download(release, name, progress = () => {}, signal) {
  const want = release.files[name];
  if (!want) throw new Error(`Release ${release.version} has no ${name}`);
  const dir = at('updates'), file = join(dir, `${release.version}-${name}`), part = `${file}.part`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { if (statSync(file).size === want.size && await hashOf(file) === want.sha256) return file; } catch { /* not downloaded yet */ }
  const res = await fetch(`${BASE}/download/v${release.version}/${name}`, { redirect: 'follow', headers: { 'user-agent': 'local-ai' }, signal });
  if (!res.ok || !res.body) throw new Error(`The download stopped: GitHub answered ${res.status}`);
  const hash = createHash('sha256'), out = createWriteStream(part, { mode: 0o600 });
  let size = 0, told = 0;
  try {
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > want.size) throw new Error('The download is larger than the release says, so it was not used');
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((done) => out.once('drain', done));
      if (size - told > want.size / 100) { told = size; progress(size / want.size); }
    }
    await new Promise((done, failed) => out.end((e) => (e ? failed(e) : done())));
    if (size !== want.size || hash.digest('hex') !== want.sha256) throw new Error('The download does not match the signed release, so it was not used');
    renameSync(part, file);
    return file;
  } catch (e) {
    out.destroy();
    rmSync(part, { force: true });
    throw e;
  }
}

async function hashOf(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
