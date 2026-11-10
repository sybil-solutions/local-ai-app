import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { hostname, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as engine from './engine.js';
import * as harness from './harness.js';
import * as recipes from './recipes.js';
import * as speed from './speed.js';
import * as update from './update.js';
import { at, config, ENGINE_HOST, event, events, fail, HOST, PORT, run, saveConfig } from './util.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const TYPES = { png: 'image/png', html: 'text/html', js: 'text/javascript', css: 'text/css', webp: 'image/webp', woff2: 'font/woff2', svg: 'image/svg+xml' };
const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i;
const remote = new Map();

const body = (req) => new Promise((done, reject) => {
  let size = 0; const chunks = [];
  req.on('data', (c) => { size += c.length; if (size > 12e6) reject(Object.assign(new Error('Request too large'), { status: 413 })); else chunks.push(c); });
  req.on('error', reject);
  req.on('end', () => {
    try { done(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch { reject(Object.assign(new Error('Body must be JSON'), { status: 400 })); }
  });
});

function localState() {
  const groups = recipes.groups(engine.status.gpus);
  for (const g of groups) for (const r of g.recipes) r.ready = engine.onDisk(r.id);
  return { name: hostname(), platform: platform(), docker: engine.status.docker,
    gpus: engine.status.gpus, free: engine.freeGpus().map((g) => g.index), groups, runs: engine.listRuns(),
    usage: engine.usageView(), catalog: { ...recipes.feed, count: recipes.recipeCount(), id: recipes.registryId() } };
}

// Tailscale: this machine's own address, and the other machines on the tailnet with whether each already answers as Local AI.
let tail = { at: 0, status: null }, seenPeers = { at: 0, list: [] };
async function tailStatus() {
  if (Date.now() - tail.at > 15000) {
    let status = null;
    try { status = JSON.parse((await run('tailscale', ['status', '--json'], { timeout: 5000 })).stdout); } catch { /* no Tailscale here */ }
    tail = { at: Date.now(), status };
  }
  return tail.status;
}
const tailSelf = async () => { const me = (await tailStatus())?.Self; return me?.TailscaleIPs?.[0] ? { name: (me.DNSName || '').replace(/\.$/, ''), ip: me.TailscaleIPs[0], user: me.UserID } : null; };
async function tailPeers() {
  if (Date.now() - seenPeers.at < 10000) return seenPeers.list;
  const linked = new Set(config.devices.map((d) => new URL(d.url).hostname));
  const status = await tailStatus();
  // Only your own computers: not phones, and not the VPN exit nodes or shared machines Tailscale also lists.
  const list = await Promise.all(Object.values(status?.Peer || {}).filter((p) => p.UserID === status.Self.UserID && !/ios|android|tvos/i.test(p.OS || '')).map(async (p) => {
    const ip = p.TailscaleIPs?.[0];
    const app = p.Online && await fetch(`http://${ip}:${PORT}/api/health`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
    return { name: p.HostName, ip, os: p.OS, online: !!p.Online, seen: p.LastSeen, app: !!app, linked: linked.has(ip) };
  }));
  seenPeers = { at: Date.now(), list: list.sort((a, b) => b.online - a.online || a.name.localeCompare(b.name)) };
  return seenPeers.list;
}
// Tailscale already proves which machines are yours. Those may connect, and fetch the installer, without typing a key.
async function isMine(req) {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, ''), me = await tailSelf();
  // The Host must be this machine's own tailnet name or address, so a rebound DNS name can't borrow the trust.
  if (!me || ![me.ip, me.name, me.name.split('.')[0]].includes((req.headers.host || '').replace(/:\d+$/, ''))) return false;
  try { return JSON.parse((await run('tailscale', ['whois', '--json', ip], { timeout: 4000 })).stdout).Node.User === me.user; } catch { return false; }
}
// With Tailscale up, the app and its engines also answer on this machine's tailnet address, so your other machines can use them.
let shared = null;
async function share() {
  const me = !process.env.LOCAL_AI_HOST && process.env.LOCAL_AI_SHARE !== '0' && await tailSelf();
  if (!me || shared === me.ip) return;
  shared = me.ip;
  createServer(handle).once('error', (e) => { shared = null; event('warn', 'server.tailnet', { error: e.message }); })
    .listen(PORT, me.ip, () => { engine.shareOn(me.ip); event('info', 'server.shared', { ip: me.ip }); });
}

async function endpoints() {
  const self = shared || !/^127\./.test(HOST) ? await tailSelf() : null;
  const ready = engine.listRuns().filter((r) => r.phase === 'ready');
  return { runs: ready.map((r) => ({ id: r.id, name: r.name, local: `${engine.urlOf(r)}/v1`, tailnet: self && r.reachable !== false ? `http://${self.name}:${r.id}/v1` : null, apis: r.apis })),
    app: self ? `http://${self.name}:${PORT}` : null, key: config.key, sources: await engine.sources() };
}

async function startDocker() {
  const tries = process.platform === 'darwin' ? [['open', ['-a', 'Docker']]] : [['systemctl', ['start', 'docker']], ['systemctl', ['--user', 'start', 'docker']]];
  for (const [cmd, args] of tries) if (!(await run(cmd, args, { timeout: 20000 })).code) { await engine.tick(); return { ok: true }; }
  return fail(500, 'Could not start Docker. Start it yourself, then come back');
}

function saveSettings(b) {
  for (const k of ['folder', 'harness', 'background']) if (typeof b[k] === 'string') config[k] = b[k];
  if (Array.isArray(b.home?.order) && Array.isArray(b.home?.on)) config.home = { order: b.home.order.map(String), on: b.home.on.map(String) };
  if (typeof b.autoUpdate === 'boolean') config.autoUpdate = b.autoUpdate;
  if ('hfToken' in b) engine.saveToken(b.hfToken);
  if (typeof b.picture === 'string') {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(b.picture) || fail(400, 'Choose a picture');
    writeFileSync(at('background'), Buffer.from(m[2], 'base64'), { mode: 0o600 });
    Object.assign(config, { background: 'own', picture: { type: m[1], at: Date.now() } });
  }
  saveConfig();
  return { ok: true };
}

async function pollDevice(device) {
  try {
    const res = await fetch(`${device.url}/api/state`, { headers: { authorization: `Bearer ${device.key}` }, signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(res.status === 401 ? 'Wrong key' : `Answered ${res.status}`);
    remote.set(device.url, { online: true, error: null, state: await res.json() });
  } catch (e) {
    const was = remote.get(device.url);
    remote.set(device.url, { online: false, error: e.name === 'TimeoutError' ? 'Not responding' : e.cause?.code || e.message, state: was?.state || null });
    if (was?.online !== false) event('warn', 'device.offline', { url: device.url, error: remote.get(device.url).error });
  }
}

let snapshot = '{}', signature = '', version = 0;
let waiters = [];
async function publish() {
  const harnesses = await harness.list();
  const chosen = harnesses.find((h) => h.id === config.harness && h.installed) || harnesses.find((h) => h.installed);
  const state = { ...localState(), harnesses, folder: config.folder, harness: chosen?.id || config.harness, last: config.last || null, devices: deviceViews(), events: events().slice(-120), url: `http://${HOST}:${PORT}`,
    home: config.home || null, background: config.background || 'gray', picture: config.picture?.at || null, app: update.view(), hfToken: engine.tokenHint() };
  const text = JSON.stringify(state);
  if (text === signature) return;
  signature = text;
  snapshot = JSON.stringify({ ...state, v: ++version });
  waiters.forEach((done) => done());
  waiters = [];
}
const changed = (ms) => new Promise((done) => { const t = setTimeout(done, ms); waiters.push(() => { clearTimeout(t); done(); }); });

const deviceViews = () => config.devices.map((d, i) => ({ i, name: d.name, url: d.url, ...(remote.get(d.url) || { online: false, error: 'Connecting', state: null }) }));

// Everything a harness can be pointed at, here or on another device.
function targets() {
  const toTarget = (device, host, key) => (r) => ({ key: `la-${key}-${r.id}`, device, url: host ? `http://${host}:${r.id}` : engine.urlOf(r), model: r.served || r.name, name: r.name, ctx: r.ctx, vision: r.vision, apis: r.apis, id: r.id, deviceIndex: key });
  const ready = (runs) => runs.filter((r) => r.phase === 'ready');
  const own = ready(engine.listRuns()).map(toTarget(hostname(), null, 'self'));
  const others = deviceViews().flatMap((d) => (d.state ? ready(d.state.runs).map(toTarget(d.name, new URL(d.url).hostname, d.i)) : []));
  return [...own, ...others];
}

async function addDevice({ url, key, name }) {
  if (!/^https?:\/\/[^\s/]+\/?$/.test(url || '')) fail(400, 'Enter a URL such as http://100.90.62.80:18700');
  const clean = url.replace(/\/$/, '');
  // One of your own Tailscale machines hands over its key when asked; anything else needs it typed.
  key ||= (await fetch(`${clean}/api/pair`, { method: 'POST', signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? r.json() : null), () => null))?.key;
  if (!key) fail(401, 'That machine needs its key. It’s under API endpoints there');
  if (config.devices.some((d) => d.url === clean)) fail(409, 'That device is already added');
  const res = await fetch(`${clean}/api/state`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) }).catch((e) => fail(502, `Could not reach it: ${e.cause?.code || e.message}`));
  if (!res.ok) fail(res.status === 401 ? 401 : 502, res.status === 401 ? 'That key is wrong' : `It answered ${res.status}`);
  config.devices.push({ url: clean, key, name: name?.trim() || (await res.json()).name });
  saveConfig();
  event('info', 'device.added', { url: clean });
  return { ok: true };
}

async function forward(req, res, device, rest, search) {
  const data = ['POST', 'PUT', 'DELETE'].includes(req.method) ? JSON.stringify(await body(req)) : undefined;
  const reply = await fetch(`${device.url}/api/${rest}${search}`, { method: req.method, body: data, headers: { authorization: `Bearer ${device.key}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(60000) })
    .catch((e) => fail(502, `${device.name} is unreachable: ${e.cause?.code || e.message}`));
  res.writeHead(reply.status, { 'content-type': 'application/json' });
  res.end(await reply.text());
}

async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  const proxied = /^\/api\/devices\/(\d+)\/(.+)$/.exec(url.pathname);
  const run = /^\/api\/runs\/(\d+)(\/logs)?$/.exec(url.pathname);
  if (proxied) {
    const device = config.devices[+proxied[1]] || fail(404, 'No such device');
    await forward(req, res, device, proxied[2], url.search);
    return undefined;
  }
  if (url.pathname.endsWith('/measure') && req.method === 'POST') return engine.measureNow(url.pathname.split('/').at(-2));
  if (run && req.method === 'DELETE') return engine.remove(run[1]);
  if (run?.[2] && req.method === 'GET') return engine.logs(run[1], url.searchParams.get('tail'));
  switch (route) {
    case 'GET /api/state': {
      if (+url.searchParams.get('v') === version) await changed(20000);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(snapshot);
      return undefined;
    }
    case 'POST /api/runs': { const b = await body(req); if (typeof b.recipe !== 'string') fail(400, 'Choose a recipe'); return engine.start(b.recipe, b.gpus); }
    case 'GET /api/recipe': return recipes.raw(url.searchParams.get('id'));
    case 'POST /api/recipes': { const saved = recipes.save(await body(req)); speed.forget(saved.id); return saved; }
    case 'DELETE /api/recipes': return recipes.reset(url.searchParams.get('id'));
    case 'POST /api/refresh': await recipes.refresh(); return { ...recipes.feed };
    case 'POST /api/devices': return addDevice(await body(req));
    case 'DELETE /api/devices': { const i = +url.searchParams.get('i'); if (!config.devices[i]) fail(404, 'No such device'); config.devices.splice(i, 1); saveConfig(); return { ok: true }; }
    case 'POST /api/settings': return saveSettings(await body(req));
    case 'GET /api/background': {
      if (!config.picture || !existsSync(at('background'))) fail(404, 'No picture yet');
      res.writeHead(200, { 'content-type': config.picture.type, 'cache-control': 'no-store' });
      res.end(readFileSync(at('background')));
      return undefined;
    }
    case 'POST /api/agents': return harness.change((await body(req)).id);
    case 'GET /api/usage': return engine.usageDetail();
    case 'GET /api/card': return recipes.card(url.searchParams.get('id'));
    case 'GET /api/endpoints': return endpoints();
    case 'GET /api/tailscale': { const me = await tailSelf(); return { peers: await tailPeers(), install: me ? `curl -fsSL http://${me.ip}:${PORT}/install | bash` : null }; }
    case 'POST /api/docker/start': return startDocker();
    case 'POST /api/app/check': return update.check();
    case 'POST /api/app/update': return update.update();
    case 'POST /api/open': {
      const b = await body(req);
      const target = targets().find((t) => String(t.deviceIndex) === String(b.device) && t.id === b.port) || fail(404, 'That model is not ready');
      harness.syncPi(targets());
      if (target.deviceIndex === 'self') engine.cancelMeasure(target.id);
      return harness.open(b.harness, target, b.folder || config.folder);
    }
    default: return fail(404, 'Unknown route');
  }
}

async function sendStatic(req, res, path) {
  const file = path === '/' ? 'index.html' : path.slice(1);
  const type = TYPES[file.split('.').pop()];
  if (!type || !/^[\w-]+(\/[\w-]+)?\.\w+$/.test(file) || !existsSync(join(WEB, file))) fail(404, 'Not found');
  let data = readFileSync(join(WEB, file));
  if (file === 'index.html') {
    // A page opened on this machine, or on another of your Tailscale machines, gets the key inlined. The Host check stops DNS rebinding from reading it.
    const local = /^(127\.|::1|::ffff:127\.)/.test(req.socket.remoteAddress) && LOOPBACK.test(req.headers.host || '');
    const trusted = local || (shared && req.socket.localAddress?.replace(/^::ffff:/, '') === shared && await isMine(req));
    data = String(data).replace('__KEY__', trusted ? config.key : '');
  }
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(data);
}

async function handle(req, res) {
  try {
    const url = new URL(req.url, 'http://local');
    if (url.pathname === '/api/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true,"app":"local-ai"}'); }
    if (url.pathname === '/api/pair' || url.pathname.startsWith('/install')) {
      if (!(await isMine(req))) fail(403, 'Only your own Tailscale machines can do this without a key');
      if (url.pathname === '/api/pair') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ key: config.key, name: hostname() })); }
      if (url.pathname === '/install.tgz') { res.writeHead(200, { 'content-type': 'application/gzip' }); return spawn('tar', ['-czf', '-', '-C', join(WEB, '..'), 'server', 'web', 'package.json', 'install.sh', 'README.md']).stdout.pipe(res); }
      const from = /^[\w.-]+(:\d+)?$/.test(req.headers.host || '') ? req.headers.host : fail(400, 'Bad address');
      res.writeHead(200, { 'content-type': 'text/x-shellscript' });
      return res.end(`#!/bin/bash\n# Copies Local AI from the machine that served this, then installs it for this user.\nset -e\nT="$(mktemp -d)"\ncurl -fsSL http://${from}/install.tgz | tar -xz -C "$T"\n"$T/install.sh"\n`);
    }
    if (!url.pathname.startsWith('/api/')) {
      return await sendStatic(req, res, url.pathname);
    }
    if (req.headers.authorization !== `Bearer ${config.key}`) fail(401, 'Enter this device\'s key');
    const result = await api(req, res, url);
    if (result !== undefined) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result)); publish(); }
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) event('error', 'http.error', { path: req.url, error: e.message });
    if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

export async function start() {
  const server = createServer(handle);
  await new Promise((done, reject) => { server.once('error', reject); server.listen(PORT, HOST, done); });
  if (!/^(127\.|0\.0\.0\.0$)/.test(HOST)) createServer(handle).once('error', (e) => event('warn', 'server.loopback', { error: e.message })).listen(PORT, '127.0.0.1');
  recipes.refresh();
  const every = (ms, fn) => setInterval(() => fn().catch?.((e) => event('error', 'loop.failed', { error: e.message })), ms);
  let queued = false;
  const soon = () => { if (!queued) { queued = true; setTimeout(() => { queued = false; publish(); }, 150); } };
  engine.onChange(soon); harness.onChange(soon); update.onChange(soon);
  update.check();
  await share();
  await engine.tick();
  await publish();
  every(2000, async () => { await engine.tick(); await publish(); });
  every(3000, async () => { await Promise.all(config.devices.map(pollDevice)); harness.syncPi(targets()); });
  every(30000, share);
  every(3600e3, recipes.refresh);
  every(6 * 3600e3, update.check);
  every(30000, async () => engine.flushUsage());
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { engine.flushUsage(); process.exit(0); });
  event('info', 'server.started', { host: HOST, port: PORT });
  return { server, url: `http://127.0.0.1:${PORT}`, key: config.key, stop: () => engine.flushUsage() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) start().catch((e) => { event('error', 'server.fatal', { error: e.message }); process.exit(1); });
