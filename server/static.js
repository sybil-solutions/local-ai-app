// The page's own files, served from web/.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import * as machines from './machines.js';
import { config, fail } from './util.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const TYPES = { svg: 'image/svg+xml', png: 'image/png', html: 'text/html', js: 'text/javascript', css: 'text/css', webp: 'image/webp', woff2: 'font/woff2' };

// A file of the page, kept in memory with a compressed copy and a tag that names this version of it. It is read
// again only when the file on disk changed.
const SQUASHED = new Set(['html', 'js', 'css', 'svg']), files = new Map();
function fileOf(name) {
  let stat;
  try { stat = statSync(join(WEB, name)); } catch { return null; }
  const hit = files.get(name);
  if (hit?.changed === stat.mtimeMs) return hit;
  const data = readFileSync(join(WEB, name)), kind = name.split('.').pop();
  const file = { changed: stat.mtimeMs, data, zipped: SQUASHED.has(kind) ? gzipSync(data) : null, tag: `"${stat.size.toString(36)}-${Math.round(stat.mtimeMs).toString(36)}"` };
  files.set(name, file);
  return file;
}
// Every script of the page, named in its head, so the browser fetches them side by side and not one after another
// as each one asks for the next.
const scripts = (dir) => readdirSync(join(WEB, dir)).filter((f) => f.endsWith('.js')).map((f) => `<link rel="modulepreload" href="/${dir}${dir ? '/' : ''}${f}">`);
const PRELOAD = [...scripts(''), ...scripts('components')].join('');

// The web app's files. The page gets the key written in only for another of your own Tailscale machines, which
// Tailscale vouches for. Being asked from this machine proves nothing: another user's program, or anything that
// forwards connections here, asks from loopback too. On this machine the key comes with the address instead
// (#key=…), which the desktop app and the installer take from the config file only this user can read.
export async function sendStatic(req, res, path) {
  const name = path === '/' ? 'index.html' : path.slice(1), type = TYPES[name.split('.').pop()];
  const file = type && /^[\w-]+(\/[\w-]+)?\.\w+$/.test(name) ? fileOf(name) : null;
  if (!file) fail(404, 'Not found');
  if (name === 'index.html') {
    // The page itself is written for whoever asks (the key, or not), so it is never kept by a browser.
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    return res.end(String(file.data).replace('__KEY__', (await machines.isMine(req)) ? config.key : '').replace('</head>', `${PRELOAD}</head>`));
  }
  // Everything else is kept by the browser and checked each time it is used: unchanged, it is not sent again.
  const headers = { 'content-type': type, 'cache-control': 'no-cache', etag: file.tag };
  if (req.headers['if-none-match'] === file.tag) { res.writeHead(304, headers); return res.end(); }
  const squash = file.zipped && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  res.writeHead(200, { ...headers, ...(squash ? { 'content-encoding': 'gzip', vary: 'accept-encoding' } : {}) });
  return res.end(squash ? file.zipped : file.data);
}
