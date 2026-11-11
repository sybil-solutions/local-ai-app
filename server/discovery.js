// Models someone else started on this machine, found by asking every listening port. They are shown, never stopped.
import { probe, probeApis } from './health.js';
import { innerPorts } from './hosts.js';
import * as machines from './machines.js';
import { changed, runs, update } from './runs.js';
import * as usage from './usage.js';
import { event, PORT, run } from './util.js';

// An engine serves one model, or says what it is on /metrics. A proxy in front of cloud APIs (or of several engines)
// lists many models and has no engine counters, so it is not shown as a model running here. Returns the model id.
async function isEngine(url, models) {
  const id = Array.isArray(models) ? models[0]?.id : null;
  if (!id || models.length === 1) return id || null;
  try {
    const res = await fetch(`${url}/metrics`, { signal: AbortSignal.timeout(800) });
    return res.ok && /^(vllm|sglang|llamacpp)[:_]/m.test(await res.text()) ? id : null;
  } catch { return null; }
}

// A forwarder on this machine in front of a model on a connected machine answers exactly like that model, counters
// and all. It is that machine's model, not one running here. It is recognised by the same model id being ready there
// and by being the same engine: the same process start time where the engine reports one, else the same counters
// (read here, there, then here again, the numbers there fall between the two readings here).
async function forwards(here, model) {
  const read = async (url) => usage.parseMetrics(await (await fetch(`${url}/metrics`, { signal: AbortSignal.timeout(1500) })).text());
  const totals = (m) => [m.prompt_tokens_total, m.generation_tokens_total ?? m.tokens_predicted_total, m.request_success_total];
  for (const d of machines.views()) {
    for (const r of d.online && Array.isArray(d.state?.runs) ? d.state.runs : []) {
      if (r.phase !== 'ready' || r.served !== model || r.reachable === false) continue;
      try {
        const a = await read(here), far = await read(`http://${new URL(d.url).hostname}:${r.id}`);
        if (a.process_start && far.process_start) { if (a.process_start === far.process_start) return d.name; continue; }
        const first = totals(a), there = totals(far), second = totals(await read(here));
        if (there.some((v) => v > 0) && there.every((v, i) => v !== undefined && first[i] <= v && v <= second[i])) return d.name;
      } catch { /* one of them has no counters, so nothing says it is a forwarder */ }
    }
  }
  return null;
}

// Models someone else started: anything on this machine that answers like an OpenAI server. They are shown, never stopped.
let scanned = 0;
const booted = Date.now();
export async function discover(now) {
  // A model someone else started is dropped once its port is closed, or after five minutes without an answer. One that
  // is only slow (an engine under load answers late) stays, shown as not replying, so Home does not lose it and find it again.
  for (const r of runs.values()) {
    if (!r.external) continue;
    const up = await probe(r);
    if (!up && (r.closed >= 3 || r.misses >= 150)) { runs.delete(r.id); event('info', 'run.gone', { id: r.id }); changed(); continue; }
    if (!up && r.misses >= 15 && r.phase === 'ready') { update(r, { phase: 'unresponsive', heard: now - r.misses * 2000 }); event('warn', 'run.unresponsive', { id: r.id }); }
    if (!up) continue;
    if (r.phase !== 'ready') update(r, { phase: 'ready', heard: null });
    if (!r.apis) await probeApis(r);
    await usage.scrape(r, now);
  }
  // Right after the app starts, connected machines have not answered yet, so a forwarder to one of them could not be
  // told from a model running here. New finds wait for them, for a few seconds at most.
  if (now - scanned < 30000 || (!machines.settled() && now - booted < 8000)) return;
  scanned = now;
  for (const r of runs.values()) {
    const to = r.external && r.phase === 'ready' && await forwards(r.url, r.served);
    if (to) { runs.delete(r.id); usage.forget(r); event('info', 'run.forwarded', { id: r.id, model: r.served, to }); changed(); }
  }
  const text = (process.platform === 'darwin' ? await run('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n']) : await run('ss', ['-ltnH'])).stdout;
  // Each listening port with the address to ask it on: loopback, unless it listens on one address only (a server bound
  // to the tailnet address alone does not answer on loopback).
  const open = new Map();
  for (const [, where, port] of text.matchAll(/(\S+):(\d+)\s/g)) {
    const ip = where.replace(/%.*$/, ''), only = /^\d+\.\d+\.\d+\.\d+$/.test(ip) && ip !== '0.0.0.0' && !ip.startsWith('127.') ? ip : null;
    if (!open.has(+port) || !only) open.set(+port, { host: only || '127.0.0.1', outside: !/^(127\.|\[::1\])/.test(where) });
  }
  const found = await Promise.all([...open.keys()].filter((p) => p > 1024 && p !== PORT && !runs.has(p) && !innerPorts().has(p)).sort((a, b) => a - b).map(async (port) => {
    try { const res = await fetch(`http://${open.get(port).host}:${port}/v1/models`, { signal: AbortSignal.timeout(800) }); return [port, res.ok && (await isEngine(`http://${open.get(port).host}:${port}`, (await res.json()).data))]; } catch { return [port, null]; }
  }));
  const known = new Set([...runs.values()].map((r) => r.served));
  for (const [port, model] of found) {
    if (!model || known.has(model)) continue; // the same model behind a proxy is still one model
    known.add(model);
    if (await forwards(`http://${open.get(port).host}:${port}`, model)) continue; // a forwarder to a connected machine's model
    runs.set(port, { id: port, recipe: null, external: true, reachable: open.get(port).outside, name: model, url: `http://${open.get(port).host}:${port}`, served: model, gpus: [], phase: 'ready', detail: null, progress: null, error: null, since: now, readyAt: now, apis: null, stats: null, misses: 0 });
    event('info', 'run.found', { id: port, model });
    changed();
  }
}
