// Models someone else started on this machine, found by asking every listening port. They are shown, never stopped.
import { probeApis, pulse } from './health.js';
import { innerPorts } from './hosts.js';
import * as machines from './machines.js';
import * as studio from './studio.js';
import { changed, runs, update } from './runs.js';
import * as usage from './usage.js';
import { event, PORT, run } from './util.js';

// The stand-in engines of this app's own tests say what they are (owned_by: local-ai-tests). Only a copy under test
// (LOCAL_AI_STAND_INS=1) shows them, so running the tests on a machine never puts a test model on the Home, or its
// tokens in the usage, of the copy in use there.
const STAND_INS = process.env.LOCAL_AI_STAND_INS === '1';

// An engine serves one model, or says what it is on /metrics. A proxy in front of cloud APIs (or of several engines)
// lists many models and has no engine counters, so it is not shown as a model running here. Returns the model id.
async function isEngine(url, models) {
  const id = Array.isArray(models) ? models[0]?.id : null;
  if (id && !STAND_INS && models.some((m) => m?.owned_by === 'local-ai-tests')) return null;
  if (!id || models.length === 1) return id || null;
  try {
    const res = await fetch(`${url}/metrics`, { signal: AbortSignal.timeout(800) });
    return res.ok && /^(vllm|sglang|llamacpp)[:_]/m.test(await res.text()) ? id : null;
  } catch { return null; }
}

// Whether what answers there says how many tokens it served: an engine's counters, or Local Studio's gateway.
async function countable(url) {
  try {
    const res = await fetch(`${url}/metrics`, { signal: AbortSignal.timeout(800) });
    return res.ok && /^((vllm|sglang|llamacpp)[:_]|local_studio_)/m.test(await res.text());
  } catch { return false; }
}

// A forwarder on this machine in front of a model on a connected machine answers exactly like that model, counters
// and all. It is that machine's model, not one running here, and what it serves is that machine's usage. It is
// recognised by the same model id being there and by being the same engine:
//   - the engine's process start time, which each machine puts in its snapshot (`born`). Nothing has to be asked of
//     the other machine, so this works at once, over a slow link, and for a model there that only this forwarder reaches;
//   - where the engine reports no start time (or that machine runs an older Local AI): the same counters, read here,
//     there, then here again, with the numbers there falling between the two readings here.
// Returns that machine's name, or null.
async function forwards(here, model) {
  const read = async (url) => usage.parseMetrics(await (await fetch(`${url}/metrics`, { signal: AbortSignal.timeout(1500) })).text());
  const totals = (m) => [m.prompt_tokens_total, m.generation_tokens_total ?? m.tokens_predicted_total, m.request_success_total];
  let mine = null;
  for (const d of machines.views()) {
    for (const r of Array.isArray(d.state?.runs) ? d.state.runs : []) {
      if (r.served !== model) continue;
      try {
        mine ||= await read(here);
        if (mine.process_start && typeof r.born === 'number') { if (mine.process_start === r.born) return d.name; continue; }
        if (!d.online || r.phase !== 'ready' || r.reachable === false) continue;
        const far = await read(`http://${new URL(d.url).hostname}:${r.id}`);
        if (mine.process_start && far.process_start) { if (mine.process_start === far.process_start) return d.name; continue; }
        const first = totals(mine), there = totals(far), second = totals(await read(here));
        if (there.some((v) => v > 0) && there.every((v, i) => v !== undefined && first[i] <= v && v <= second[i])) return d.name;
      } catch { /* one of them has no counters, so nothing says it is a forwarder */ }
    }
  }
  return null;
}

// The program each system has for listing the ports that are listening, and what it printed read as
// { where, port, who }: the address, the port and the program listening (its name on a Mac, elsewhere its number).
// Windows' netstat lists every connection; one that is listening is the one whose other end is no address at all,
// which holds in every language Windows prints in.
const LISTING = { darwin: ['lsof', '-iTCP', '-sTCP:LISTEN', '-P', '-n'], win32: ['netstat', '-ano', '-p', 'TCP'], linux: ['ss', '-ltnpH'] };
export function listening(text, os = process.platform) {
  const rows = [];
  for (const line of text.split('\n')) {
    const cols = line.trim().split(/\s+/), [, where, port] = /(\S+):(\d+)\s/.exec(`${line} `) || [];
    if (!port || (os === 'win32' && cols[2] !== '0.0.0.0:0')) continue;
    rows.push({ where, port: +port, who: os === 'darwin' ? cols[1] : os === 'win32' ? cols[4] : /pid=(\d+)/.exec(line)?.[1] });
  }
  return rows;
}

// Models someone else started: anything on this machine that answers like an OpenAI server. They are shown, never stopped.
// A port that answered and is not a model is not asked again for five minutes, unless another program takes it.
const DULL_MS = 300e3, dull = new Map(); // "port by program" → when it last said it is not a model
let scanned = 0;
const booted = Date.now();
// LOCAL_AI_DISCOVER=0 turns the looking off: only models this app started are shown.
export async function discover(now) {
  if (process.env.LOCAL_AI_DISCOVER === '0') return;
  // A model someone else started is dropped once its port is closed, or after five minutes without an answer. One that
  // is only slow (an engine under load answers late) stays, shown as not replying, so Home does not lose it and find it again.
  for (const r of runs.values()) {
    if (!r.external) continue;
    const up = await pulse(r, now);
    if (!up && (r.closed >= 3 || r.misses >= 150)) { runs.delete(r.id); event('info', 'run.gone', { id: r.id }); changed(); continue; }
    if (!up && r.misses >= 15 && r.phase === 'ready') { update(r, { phase: 'unresponsive', heard: now - r.misses * 2000 }); event('warn', 'run.unresponsive', { id: r.id }); }
    if (!up) continue;
    if (r.phase !== 'ready') update(r, { phase: 'ready', heard: null });
    if (!r.apis) await probeApis(r);
    if (now - (r.studioAt || 0) > 30000) { r.studioAt = now; const by = await studio.owns(r.served); if (by !== !!r.byStudio) update(r, { byStudio: by }); } // Local Studio's: it can be stopped
    await usage.scrape(r, now);
  }
  // Right after the app starts, connected machines have not answered yet, so a forwarder to one of them could not be
  // told from a model running here. New finds wait for them, for a few seconds at most.
  if (now - scanned < 30000 || (!machines.settled() && now - booted < 8000)) return;
  scanned = now;
  for (const r of runs.values()) {
    const to = r.external && r.phase === 'ready' && await forwards(r.url, r.served);
    if (to) { runs.delete(r.id); usage.uncount(r); usage.forget(r); event('info', 'run.forwarded', { id: r.id, model: r.served, to }); changed(); } // what it counted while it looked like a model here is taken back
  }
  const [tool, ...args] = LISTING[process.platform] || LISTING.linux, text = (await run(tool, args)).stdout;
  // Each listening port with the address to ask it on: loopback, unless it listens on one address only (a server bound
  // to the tailnet address alone does not answer on loopback). `who` is the program listening, where the system says.
  const open = new Map();
  for (const { where, port, who } of listening(text)) {
    const ip = where.replace(/%.*$/, ''), only = /^\d+\.\d+\.\d+\.\d+$/.test(ip) && ip !== '0.0.0.0' && !ip.startsWith('127.') ? ip : null;
    if (!open.has(port) || !only) open.set(port, { host: only || '127.0.0.1', outside: !/^(127\.|\[::1\])/.test(where), who: `${port} by ${who || '?'}` });
  }
  for (const [who, at] of dull) if (now - at > DULL_MS) dull.delete(who);
  const ask = [...open.keys()].filter((p) => p > 1024 && p !== PORT && !runs.has(p) && !innerPorts().has(p) && !dull.has(open.get(p).who)).sort((a, b) => a - b);
  const found = await Promise.all(ask.map(async (port) => {
    const url = `http://${open.get(port).host}:${port}`;
    try {
      const res = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(800) }), model = res.ok && (await isEngine(url, (await res.json()).data));
      if (!model) dull.set(open.get(port).who, now);
      return [port, model];
    } catch { dull.set(open.get(port).who, now); return [port, null]; }
  }));
  for (const [port, model] of found) {
    if (!model) continue;
    // The same model behind a proxy is still one model. Where only one of the two can be counted (an engine with no
    // counters, and Local Studio's gateway in front of it, which keeps its own), that one is the model.
    const same = [...runs.values()].find((r) => r.served === model);
    if (same) {
      if (!same.external || await countable(same.url) || !(await countable(`http://${open.get(port).host}:${port}`))) continue;
      runs.delete(same.id);
      event('info', 'run.moved', { from: same.id, to: port, model });
    }
    if (await forwards(`http://${open.get(port).host}:${port}`, model)) continue; // a forwarder to a connected machine's model
    runs.set(port, { id: port, recipe: null, external: true, reachable: open.get(port).outside, name: model, url: `http://${open.get(port).host}:${port}`, served: model, gpus: [], phase: 'ready', detail: null, progress: null, error: null, since: now, readyAt: now, apis: null, stats: null, misses: 0 });
    event('info', 'run.found', { id: port, model });
    changed();
  }
}
