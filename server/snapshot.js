// The snapshot: everything the app shows about this machine, as one piece of JSON. GET /api/state returns it.
// Clients long-poll it and redraw from it; nothing else pushes.
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { gzipSync } from 'node:zlib';
import * as agents from './agents.js';
import * as engine from './engine.js';
import * as machines from './machines.js';
import { showRuns } from './omarchy.js';
import * as recipes from './recipes.js';
import * as update from './update.js';
import * as usage from './usage.js';
import { at, config } from './util.js';
import * as weights from './weights.js';

const JSON_TYPE = { 'content-type': 'application/json' };
const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;

// `zipped` is the same snapshot compressed, made the first time another machine asks for this version.
let snapshot = '{}', zipped = null, signature = '', version = 0, waiters = [];
export async function publish() {
  const groups = recipes.groups(engine.status.gpus), list = await agents.list(), term = await agents.terminalChoice();
  for (const g of groups) for (const r of g.recipes) r.ready = weights.onDisk(recipes.find(r.id).launch);
  const state = {
    // Apple silicon runs its recipes as host programs, so Docker is only asked for where a container recipe needs it.
    name: hostname(), os: process.platform, docker: engine.status.docker, needsDocker: !engine.status.gpus.length || !engine.status.gpus.every((g) => g.unified), gpus: engine.status.gpus, free: engine.freeGpus().map((g) => g.index), groups, runs: engine.listRuns(),
    usage: usage.view(), catalog: recipes.registry(), last: config.last || null, devices: machines.views(),
    agents: list, agent: (list.find((a) => a.id === config.agent && a.installed) || list.find((a) => a.installed))?.id || config.agent, folder: config.folder, ...term,
    home: config.home || null, background: config.background || 'clouds', tone: config.tone || null, picture: (config.picture && existsSync(at('background')) && config.picture.at) || null, app: update.view(), hfToken: weights.tokenHint(),
  };
  showRuns(state.runs); // Omarchy's Agents panel, where there is one
  const text = JSON.stringify(state);
  if (text === signature) return;
  signature = text;
  snapshot = `{"v":${++version},${text.slice(1)}`; // the same text with its version in front, not written out a second time
  zipped = null;
  [...waiters].forEach((wake) => wake());
}
const changed = (ms) => new Promise((done) => {
  const wake = () => { clearTimeout(timer); waiters = waiters.filter((w) => w !== wake); done(); }, timer = setTimeout(wake, ms);
  waiters.push(wake);
});

// GET /api/state?v=N: the snapshot at once when N is not its version, else when it next changes (or after 20 s).
export async function answer({ q, req, res }) {
  if (+q.get('v') === version || !version) await changed(20000);
  // Another machine gets it compressed (a seventh of the size). A page on this machine does not: nothing is saved by it.
  const plain = LOOPBACK.test(req.socket.remoteAddress || '') || !/\bgzip\b/.test(req.headers['accept-encoding'] || '');
  res.writeHead(200, plain ? JSON_TYPE : { ...JSON_TYPE, 'content-encoding': 'gzip', vary: 'accept-encoding' });
  res.end(plain ? snapshot : zipped ||= gzipSync(snapshot));
}

// Models on other machines handed to this one by a peer that asked this machine to run an agent on them. Kept so
// syncPi does not drop them on its next tick.
const external = new Map();
let nextExternal = 1000;
export function rememberTarget(t) {
  const had = external.get(t.url);
  const key = had?.key || `la-${nextExternal++}-${t.id}`;
  const entry = { ...t, key, deviceIndex: 'ext' };
  external.set(t.url, entry);
  if (external.size > 20) external.delete(external.keys().next().value);
  return entry;
}

// Everything an agent can be pointed at: the models ready here and on connected machines.
export function targets() {
  const toTarget = (device, host, key) => (r) => ({ key: `la-${key}-${r.id}`, device, url: host ? `http://${host}:${r.id}` : r.url, model: r.served || r.name, name: r.name, ctx: r.ctx, vision: r.vision, apis: r.apis, id: r.id, deviceIndex: key });
  const ready = (runs) => runs.filter((r) => r.phase === 'ready');
  // One machine that can't be read is left out; it does not take the others with it.
  const there = (d) => { try { const host = new URL(d.url).hostname, loop = /^(127\.|::1$|localhost$)/.test(host); return d.state ? ready(d.state.runs).filter((r) => loop || r.reachable !== false).map(toTarget(d.name, host, d.i)) : []; } catch { return []; } };
  const list = [...ready(engine.listRuns()).map(toTarget(hostname(), null, 'self')), ...machines.views().flatMap(there)];
  const urls = new Set(list.map((t) => t.url));
  for (const t of external.values()) if (!urls.has(t.url)) list.push(t);
  return list;
}

// A model whose machine does not say its context length (an older Local AI there, or a model it found and has no
// recipe for) is asked for it directly: vLLM and SGLang report max_model_len in /v1/models. Asked again after ten
// minutes when it did not answer.
const windows = new Map();
export async function sized() {
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
