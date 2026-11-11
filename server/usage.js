// Tokens served. Each running engine's own counters are read every tick and added up per day, per hour and per model.
import { at, readJson, run, writeJson } from './util.js';

const file = at('usage.json');
const usage = { days: {}, hours: {}, last: {}, ...readJson(file, {}) };
let dirty = false;
const keyOf = (r) => r.container || `port-${r.id}`;
// A counter row by name. Names come from engines, so one like "__proto__" must still be an ordinary key.
function rowOf(rows, name) {
  if (!Object.hasOwn(rows, name)) Object.defineProperty(rows, name, { value: { in: 0, out: 0, req: 0 }, enumerable: true, writable: true, configurable: true });
  return rows[name];
}
export const forget = (r) => { delete usage.last[keyOf(r)]; dirty = true; };

export function parseMetrics(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^(?:vllm|sglang|llamacpp)[:_]([a-z_0-9]+)(?:\{.*\})? ([-0-9.e+]+)$/.exec(line);
    if (m) out[m[1]] = (out[m[1]] || 0) + +m[2];
    else if (line.startsWith('process_start_time_seconds ')) out.process_start = +line.split(' ')[1]; // when the engine's process started: the same engine, however it is reached
  }
  return out;
}

// How fast the engine reads prompts, as { pps, est }, or null before there is anything to go on. Prompt tokens served
// from the prefix cache are not prefill, and a prompt is read in one burst, so prompt tokens over the scrape window
// would mostly show 0, and a cache hit as a huge number. Instead, from the best source the engine has:
//   engine: the tokens it computed while prefilling over the seconds it says that took. vLLM's histograms, the
//     timings a host engine reports in its answers (meter.js), or llama.cpp's prompt speed gauge.
//   ttft (est): for a host engine that reports no timings, uncached prompt tokens over the wait for the first
//     token, which also holds queueing and the first decode step.
//   window (est): for the rest, prompt tokens that missed the cache over the scrape window.
// A prefill under PREFILL_MIN tokens times overhead more than speed, so it is left out. The speed is tokens over
// seconds across the prefills of the last PREFILL_WINDOW (the last ones, when idle), and before the app has seen one,
// the engine's average over its whole life. Sources are never mixed: when a better one appears, the others are dropped.
const PREFILL_MIN = 1000, PREFILL_WINDOW = 300e3;
const PREFILL_SOURCES = [
  ['engine', 'request_prefill_kv_computed_tokens_sum', 'request_prefill_time_seconds_sum'],
  ['engine', 'engine_prefill_tokens_sum', 'engine_prefill_seconds_sum'],
  ['ttft', 'ttft_prompt_tokens_sum', 'ttft_seconds_sum'],
];
function prefillSpeed(r, m, seconds, now) {
  const prev = r.counters;
  r.counters = m;
  if (m.prompt_tokens_seconds > 0 && m.request_prefill_time_seconds_sum === undefined) return { pps: m.prompt_tokens_seconds, est: false };
  const d = (k) => (prev ? (m[k] ?? 0) - (prev[k] ?? 0) : 0);
  const [kind, tok, sec] = PREFILL_SOURCES.find(([, , s]) => m[s] > 0) || PREFILL_SOURCES.find(([, , s]) => m[s] !== undefined) || ['window'];
  if (kind !== r.prefillKind) { r.prefillKind = kind; r.prefills = []; }
  const [tokens, secs] = kind === 'window' ? [d('prompt_tokens_total') - d('cached_tokens_total'), seconds] : [d(tok), d(sec)];
  if (tokens >= PREFILL_MIN && secs > 0) r.prefills = [...r.prefills.filter(([at]) => now - at < PREFILL_WINDOW), [now, tokens, secs]];
  const est = kind !== 'engine';
  if (r.prefills.length) return { pps: r.prefills.reduce((n, p) => n + p[1], 0) / r.prefills.reduce((n, p) => n + p[2], 0), est };
  return m[sec] > 0 ? { pps: m[tok] / m[sec], est } : null;
}

// Reads one engine's counters, adds what changed to the totals, and leaves its live numbers on the run.
export async function scrape(r, now) {
  let m;
  if (r.meter) m = { ...r.meter.counts }; // a host run has no /metrics; the app counts what passes through its port instead
  else {
    try {
      const res = await fetch(`${r.url}/metrics`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return;
      m = parseMetrics(await res.text());
    } catch { return; }
  }
  const cur = { in: m.prompt_tokens_total || 0, out: m.generation_tokens_total || m.tokens_predicted_total || 0, req: m.request_success_total || 0 };
  const last = usage.last[keyOf(r)] || cur;
  const delta = Object.fromEntries(Object.keys(cur).map((k) => [k, cur[k] >= last[k] ? cur[k] - last[k] : cur[k]]));
  usage.last[keyOf(r)] = cur;
  r.used ||= { in: 0, out: 0, req: 0 };
  // Tokens a speed measurement wrote are not usage. The scrape just after one still holds some, so it is skipped too.
  const benchmark = r.measuring || r.benchmarked, moved = delta.in || delta.out || delta.req;
  r.benchmarked = false;
  if (moved) dirty = true;
  if (moved && !benchmark) {
    const stamp = new Date(now).toISOString(), row = rowOf(usage.days[stamp.slice(0, 10)] ||= {}, r.name), hour = rowOf(usage.hours[stamp.slice(0, 13)] ||= {}, r.name);
    for (const k of Object.keys(delta)) { row[k] += delta[k]; hour[k] += delta[k]; r.used[k] += delta[k]; }
  }
  r.series ||= [];
  if (!r.series.length || now - r.series.at(-1)[0] >= 60000) { r.series.push([now, r.used.in + r.used.out]); if (r.series.length > 240) r.series.shift(); }
  const seconds = r.scraped ? (now - r.scraped) / 1000 : 0;
  const prefill = prefillSpeed(r, m, seconds, now);
  r.stats = { tps: seconds ? Math.round((delta.out / seconds) * 10) / 10 : 0, pps: Math.round(prefill?.pps ?? 0), ppsEst: !!prefill?.est, used: r.used.in + r.used.out, active: m.num_requests_running ?? m.num_running_reqs ?? m.requests_processing ?? 0 };
  r.scraped = now;
}

export function flush() {
  if (!dirty) return;
  const old = new Date(Date.now() - 48 * 3600e3).toISOString().slice(0, 13);
  for (const h of Object.keys(usage.hours)) if (h < old) delete usage.hours[h];
  writeJson(file, usage);
  dirty = false;
}

// The short version every snapshot carries: totals and the last twelve weeks by day.
export function view() {
  const days = Object.keys(usage.days).sort().map((d) => ({ d, v: Object.values(usage.days[d]).reduce((n, row) => n + row.in + row.out, 0) }));
  return { all: days.reduce((n, x) => n + x.v, 0), days: days.slice(-84) };
}

// Everything the Usage screen draws: every day split by model, the last two days by hour, and each running model's own count.
export function detail(runs) {
  const days = Object.keys(usage.days).sort().map((d) => {
    const rows = Object.entries(usage.days[d]);
    return { d, out: rows.reduce((n, [, r]) => n + r.out, 0), req: rows.reduce((n, [, r]) => n + r.req, 0), models: Object.fromEntries(rows.map(([name, r]) => [name, r.in + r.out])) };
  });
  const live = runs.filter((r) => r.phase === 'ready' && r.used).map((r) => ({ id: r.id, name: r.name, since: r.readyAt, tokens: r.used.in + r.used.out, out: r.used.out, req: r.used.req, series: r.series || [] }));
  return { days, hours: usage.hours, runs: live };
}

// Who has been calling the engines today, read from their own access logs. Requests are counted, never kept.
const names = new Map();
async function whoIs(ip) {
  if (/^(127\.|172\.(1[6-9]|2\d|3[01])\.|::1)/.test(ip)) return { device: 'This computer', known: true };
  if (!names.has(ip)) {
    const r = await run('tailscale', ['whois', '--json', ip], { timeout: 4000 });
    let name = null;
    try { name = JSON.parse(r.stdout).Node?.ComputedName || null; } catch { /* not on the tailnet */ }
    names.set(ip, name);
  }
  return { device: names.get(ip) || ip, known: !!names.get(ip) };
}
export async function sources(runs) {
  const since = new Date(); since.setHours(0, 0, 0, 0);
  const seen = new Map();
  for (const r of runs) {
    for (const row of r.meter?.callers.values() || []) {
      if (row.last < since.toISOString()) continue;
      const had = seen.get(row.ip) || { ip: row.ip, requests: 0, last: row.last };
      had.requests += row.requests; if (row.last > had.last) had.last = row.last;
      seen.set(row.ip, had);
    }
    if (!r.container) continue;
    const out = await run('docker', ['logs', '-t', '--since', since.toISOString(), r.container], { timeout: 20000 });
    for (const line of `${out.stdout}${out.stderr}`.split('\n')) {
      const m = /^(\S+) .*?(\d{1,3}(?:\.\d{1,3}){3}):\d+ - "POST \/v1\//.exec(line) || /^(\S+) .*request: POST \/v1\/\S+ (\d{1,3}(?:\.\d{1,3}){3}) /.exec(line);
      if (!m) continue;
      const row = seen.get(m[2]) || { ip: m[2], requests: 0, last: m[1] };
      row.requests++; if (m[1] > row.last) row.last = m[1];
      seen.set(m[2], row);
    }
  }
  const rows = await Promise.all([...seen.values()].map(async (row) => ({ ...row, ...(await whoIs(row.ip)) })));
  const merged = new Map();
  for (const row of rows) { const had = merged.get(row.device); if (had) { had.requests += row.requests; if (row.last > had.last) had.last = row.last; } else merged.set(row.device, row); }
  return [...merged.values()].sort((a, b) => b.requests - a.requests);
}
