// The server. One port serves the web app, the API in ROUTES below, and a long-polled snapshot of everything on this machine.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as agents from './agents.js';
import * as engine from './engine.js';
import * as machines from './machines.js';
import * as recipes from './recipes.js';
import * as speed from './speed.js';
import * as update from './update.js';
import * as usage from './usage.js';
import { at, config, event, fail, HOST, PORT, saveConfig } from './util.js';
import * as weights from './weights.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'), WEB = join(ROOT, 'web');
const TYPES = { png: 'image/png', html: 'text/html', js: 'text/javascript', css: 'text/css', webp: 'image/webp', woff2: 'font/woff2' };
const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i;
const JSON_TYPE = { 'content-type': 'application/json' };
let shared = null; // this machine's tailnet address, once the app is also listening there

// The snapshot: what GET /api/state returns. Clients long-poll it and redraw from it; nothing else pushes.
let snapshot = '{}', signature = '', version = 0, waiters = [];
async function publish() {
  const groups = recipes.groups(engine.status.gpus), list = await agents.list(), term = await agents.terminalChoice();
  for (const g of groups) for (const r of g.recipes) r.ready = weights.onDisk(recipes.find(r.id).launch);
  const state = {
    // Apple silicon runs its recipes as host programs, so Docker is only asked for where a container recipe needs it.
    name: hostname(), docker: engine.status.docker, needsDocker: !engine.status.gpus.length || !engine.status.gpus.every((g) => g.unified), gpus: engine.status.gpus, free: engine.freeGpus().map((g) => g.index), groups, runs: engine.listRuns(),
    usage: usage.view(), catalog: recipes.registry(), last: config.last || null, devices: machines.views(),
    agents: list, agent: (list.find((a) => a.id === config.agent && a.installed) || list.find((a) => a.installed))?.id || config.agent, folder: config.folder, ...term,
    home: config.home || null, background: config.background || 'fresco', tone: config.tone || null, picture: config.picture?.at || null, app: update.view(), hfToken: weights.tokenHint(),
  };
  const text = JSON.stringify(state);
  if (text === signature) return;
  signature = text;
  snapshot = JSON.stringify({ ...state, v: ++version });
  [...waiters].forEach((wake) => wake());
}
const changed = (ms) => new Promise((done) => {
  const wake = () => { clearTimeout(timer); waiters = waiters.filter((w) => w !== wake); done(); }, timer = setTimeout(wake, ms);
  waiters.push(wake);
});

// Everything an agent can be pointed at: the models ready here and on connected machines.
function targets() {
  const toTarget = (device, host, key) => (r) => ({ key: `la-${key}-${r.id}`, device, url: host ? `http://${host}:${r.id}` : r.url, model: r.served || r.name, name: r.name, ctx: r.ctx, vision: r.vision, apis: r.apis, id: r.id, deviceIndex: key });
  const ready = (runs) => runs.filter((r) => r.phase === 'ready');
  return [...ready(engine.listRuns()).map(toTarget(hostname(), null, 'self')), ...machines.views().flatMap((d) => (d.state ? ready(d.state.runs).filter((r) => r.reachable !== false).map(toTarget(d.name, new URL(d.url).hostname, d.i)) : []))];
}

// A model whose machine does not say its context length (an older Local AI there, or a model it found and has no
// recipe for) is asked for it directly: vLLM and SGLang report max_model_len in /v1/models. Asked again after ten
// minutes when it did not answer.
const windows = new Map();
async function sized() {
  const list = targets();
  await Promise.all(list.filter((t) => !t.ctx).map(async (t) => {
    const k = `${t.url} ${t.model}`, hit = windows.get(k);
    if (!hit || (!hit.ctx && Date.now() - hit.at > 600e3)) {
      let ctx = 0;
      try { ctx = +(await (await fetch(`${t.url}/v1/models`, { signal: AbortSignal.timeout(4000) })).json()).data?.find((m) => m.id === t.model)?.max_model_len || 0; } catch { /* asked again later */ }
      windows.set(k, { ctx, at: Date.now() });
    }
    t.ctx = windows.get(k).ctx;
  }));
  return list;
}

async function openAgent({ b }) {
  const all = await sized(), target = all.find((t) => String(t.deviceIndex) === String(b.device) && t.id === b.port) || fail(404, 'That model is not ready');
  agents.syncPi(all);
  if (target.deviceIndex === 'self') engine.cancelMeasure(target.id);
  return agents.open(b.agent, target, b.folder || config.folder);
}

async function endpoints() {
  const me = shared || !/^127\./.test(HOST) ? await machines.self() : null;
  const runs = engine.listRuns().filter((r) => r.phase === 'ready').map((r) => ({ id: r.id, name: r.name, local: `${r.url}/v1`, tailnet: me && r.reachable !== false ? `http://${me.name}:${r.id}/v1` : null, apis: r.apis }));
  return { runs, key: config.key, sources: await usage.sources(engine.all()) };
}

async function saveSettings({ b }) {
  if (typeof b.terminal === 'string') await agents.setTerminal(b.terminal);
  for (const k of ['folder', 'agent']) if (typeof b[k] === 'string') config[k] = b[k];
  if (['fresco', 'own', 'none'].includes(b.background)) config.background = b.background;
  if (['gray', 'color'].includes(b.tone)) config.tone = b.tone;
  if (Array.isArray(b.home?.order) && Array.isArray(b.home?.on)) config.home = { order: b.home.order.map(String), on: b.home.on.map(String) };
  if (typeof b.autoUpdate === 'boolean') config.autoUpdate = b.autoUpdate;
  if ('hfToken' in b) weights.saveToken(b.hfToken);
  if (typeof b.picture === 'string') {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(b.picture) || fail(400, 'Choose a picture');
    writeFileSync(at('background'), Buffer.from(m[2], 'base64'), { mode: 0o600 });
    Object.assign(config, { background: 'own', picture: { type: m[1], at: Date.now() } });
  }
  saveConfig();
  return { ok: true };
}

// A handler gets { q: query, b: JSON body, p: path parameters, req, res }. What it returns is sent as JSON; returning nothing means it answered itself.
const ROUTES = compile({
  'GET /api/state': async ({ q, res }) => { if (+q.get('v') === version || !version) await changed(20000); res.writeHead(200, JSON_TYPE); res.end(snapshot); },
  'POST /api/runs': ({ b }) => (typeof b.recipe === 'string' ? engine.start(b.recipe, b.gpus) : fail(400, 'Choose a recipe')),
  'DELETE /api/runs/:id': ({ p }) => engine.remove(p.id),
  'GET /api/runs/:id/logs': ({ p, q }) => engine.logs(p.id, q.get('tail')),
  'POST /api/runs/:id/measure': ({ p }) => engine.measureNow(p.id),
  'GET /api/recipe': ({ q }) => recipes.raw(q.get('id')),
  'POST /api/recipes': ({ b }) => { const saved = recipes.save(b); speed.forget(saved.id); return saved; },
  'DELETE /api/recipes': ({ q }) => recipes.reset(q.get('id')),
  'POST /api/refresh': async () => { await recipes.refresh(); return recipes.registry(); },
  'GET /api/card': ({ q }) => recipes.card(q.get('id')),
  'GET /api/usage': () => usage.detail(engine.all()),
  'GET /api/endpoints': endpoints,
  'POST /api/open': openAgent,
  'POST /api/agents': ({ b }) => agents.change(b.id),
  'POST /api/settings': saveSettings,
  'GET /api/background': ({ res }) => {
    if (!config.picture || !existsSync(at('background'))) fail(404, 'No picture yet');
    res.writeHead(200, { 'content-type': config.picture.type, 'cache-control': 'no-store' });
    res.end(readFileSync(at('background')));
  },
  'GET /api/tailscale': async () => { const me = await machines.self(); return { peers: await machines.peers(), install: me ? `curl -fsSL http://${me.ip}:${PORT}/install | bash` : null }; },
  'POST /api/devices': ({ b }) => machines.add(b),
  'DELETE /api/devices': ({ q }) => machines.remove(q.get('i')),
  'ANY /api/devices/:i/:rest': async ({ req, res, p, q, b }) => { const out = await machines.forward(+p.i, req.method, `${p.rest}${q.size ? `?${q}` : ''}`, b); res.writeHead(out.status, { 'content-type': out.type }); res.end(out.body); },
  'POST /api/docker/start': engine.startDocker,
  'POST /api/app/check': update.check,
  'POST /api/app/update': update.update,
});

// Routes that need no key. Health is public; the rest answer only to your own Tailscale machines.
const mine = (run) => async (ctx) => ((await machines.isMine(ctx.req)) ? run(ctx) : fail(403, 'Only your own Tailscale machines can do this without a key'));
const OPEN = compile({
  'GET /api/health': () => ({ ok: true, app: 'local-ai' }),
  'POST /api/pair': mine(() => ({ key: config.key, name: hostname() })),
  'GET /install.tgz': mine(({ res }) => { res.writeHead(200, { 'content-type': 'application/gzip' }); spawn('tar', ['-czf', '-', '-C', ROOT, 'server', 'web', 'package.json', 'install.sh', 'README.md']).stdout.pipe(res); }),
  'GET /install': mine(({ req, res }) => {
    res.writeHead(200, { 'content-type': 'text/x-shellscript' });
    res.end(`#!/bin/bash\n# Copies Local AI from the machine that served this, then installs it for this user.\nset -e\nT="$(mktemp -d)"\ncurl -fsSL http://${req.headers.host}/install.tgz | tar -xz -C "$T"\n"$T/install.sh"\n`);
  }),
});

function compile(table) {
  return Object.entries(table).map(([key, run]) => {
    const [method, path] = key.split(' ');
    return { method, run, path: new RegExp(`^${path.replace(/\./g, '\\.').replace(':rest', '(?<rest>.+)').replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`) };
  });
}
function match(routes, method, path) {
  for (const r of routes) { const m = (r.method === 'ANY' || r.method === method) && r.path.exec(path); if (m) return [r.run, m.groups || {}]; }
  return null;
}

const body = (req) => new Promise((done, reject) => {
  let size = 0;
  const chunks = [];
  req.on('data', (c) => { size += c.length; if (size > 12e6) reject(Object.assign(new Error('Request too large'), { status: 413 })); else chunks.push(c); });
  req.on('error', reject);
  req.on('end', () => {
    let parsed = null;
    try { parsed = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}; } catch { /* rejected below */ }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) done(parsed); else reject(Object.assign(new Error('Body must be a JSON object'), { status: 400 }));
  });
});

// The web app's files. The page itself gets the key written in when it is opened on this machine or on another of your Tailscale machines.
async function sendStatic(req, res, path) {
  const file = path === '/' ? 'index.html' : path.slice(1), type = TYPES[file.split('.').pop()];
  if (!type || !/^[\w-]+(\/[\w-]+)?\.\w+$/.test(file) || !existsSync(join(WEB, file))) fail(404, 'Not found');
  let data = readFileSync(join(WEB, file));
  if (file === 'index.html') {
    // The Host check stops a rebound DNS name from reading the key.
    const local = /^(127\.|::1|::ffff:127\.)/.test(req.socket.remoteAddress) && LOOPBACK.test(req.headers.host || '');
    const trusted = local || await machines.isMine(req);
    data = String(data).replace('__KEY__', trusted ? config.key : '');
  }
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(data);
}

async function handle(req, res) {
  try {
    const url = new URL(req.url, 'http://local'), open = match(OPEN, req.method, url.pathname);
    if (!open && !url.pathname.startsWith('/api/')) return await sendStatic(req, res, url.pathname);
    if (!open && req.headers.authorization !== `Bearer ${config.key}`) fail(401, 'Enter this device\'s key');
    const [run, p] = open || match(ROUTES, req.method, url.pathname) || fail(404, 'Unknown route');
    const result = await run({ req, res, p, q: url.searchParams, b: req.method === 'GET' ? {} : await body(req) });
    if (result === undefined) return undefined;
    res.writeHead(200, JSON_TYPE);
    res.end(JSON.stringify(result));
    if (!open) publish().catch((e) => event('error', 'publish.failed', { error: e.message }));
    return undefined;
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) event('error', 'http.error', { path: req.url, error: e.message });
    if (!res.headersSent) res.writeHead(status, JSON_TYPE);
    return res.end(JSON.stringify({ error: e.message }));
  }
}

// With Tailscale up, the app and its engines also answer on this machine's tailnet address, so your other machines can use them.
async function share() {
  const me = !process.env.LOCAL_AI_HOST && process.env.LOCAL_AI_SHARE !== '0' && await machines.self();
  if (!me || shared === me.ip) return;
  shared = me.ip;
  createServer(handle).once('error', (e) => { shared = null; event('warn', 'server.tailnet', { error: e.message }); })
    .listen(PORT, me.ip, () => { engine.shareOn(me.ip); event('info', 'server.shared', { ip: me.ip }); });
}

export async function start() {
  const server = createServer(handle);
  await new Promise((done, reject) => { server.once('error', reject); server.listen(PORT, HOST, done); });
  if (!/^(127\.|0\.0\.0\.0$)/.test(HOST)) createServer(handle).once('error', (e) => event('warn', 'server.loopback', { error: e.message })).listen(PORT, '127.0.0.1');
  const every = (ms, fn) => setInterval(() => fn().catch?.((e) => event('error', 'loop.failed', { error: e.message })), ms);
  let queued = false;
  const soon = () => { if (!queued) { queued = true; setTimeout(() => { queued = false; publish().catch((e) => event('error', 'publish.failed', { error: e.message })); }, 150); } };
  for (const part of [engine, agents, update]) part.onChange(soon);
  recipes.refresh();
  update.check();
  await share();
  await engine.tick();
  await publish();
  every(2000, async () => { await engine.tick(); await publish(); });
  every(3000, async () => { await machines.poll(); agents.syncPi(await sized()); });
  every(30000, async () => { usage.flush(); await share(); });
  every(3600e3, recipes.refresh);
  every(6 * 3600e3, update.check);
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { usage.flush(); process.exit(0); });
  event('info', 'server.started', { host: HOST, port: PORT });
  return { server, url: `http://127.0.0.1:${PORT}`, key: config.key, stop: usage.flush };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) start().catch((e) => { event('error', 'server.fatal', { error: e.message }); process.exit(1); });
