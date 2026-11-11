// Whether an engine answers, its first reply, which APIs it has, then its speed and usage once it is ready. The same
// for a container, a host run and a model someone else started.
import { find } from './recipes.js';
import { runs, setFailed, update } from './runs.js';
import { measure, saveLoad, speedOf } from './speed.js';
import * as usage from './usage.js';
import { event, fail } from './util.js';

const START_DEADLINE = 2 * 3600e3;

// Asks the engine whether it is up. `closed` counts answers in a row that say nothing listens on the port at all, which
// is different from an engine too busy to answer in time.
export async function probe(r) {
  try {
    const res = await fetch(`${r.url}/v1/models`, { signal: AbortSignal.timeout(2000) });
    r.closed = 0;
    if (res.ok) {
      const model = (await res.json()).data?.[0], served = model?.id ?? r.served;
      update(r, { served, window: +model?.max_model_len || r.window || 0, misses: 0, ...(r.external && served ? { name: served } : {}) });
      return true;
    }
  } catch (e) { r.closed = e.cause?.code === 'ECONNREFUSED' ? (r.closed || 0) + 1 : 0; /* still loading, or busy */ }
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

export async function probeApis(r) {
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

// Whether the engine answers, its first reply, then speed and usage once it is ready. Containers and host runs alike.
export async function health(r) {
  const id = r.id;
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
