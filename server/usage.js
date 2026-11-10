// Tokens served. Each running engine's own counters are read every tick and added up per day, per hour and per model.
import { at, readJson, run, writeJson } from './util.js';

const file = at('usage.json');
const usage = { days: {}, hours: {}, last: {}, ...readJson(file, {}) };
let dirty = false;
const keyOf = (r) => r.container || `port-${r.id}`;
export const forget = (r) => { delete usage.last[keyOf(r)]; dirty = true; };

function parseMetrics(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^(?:vllm|sglang|llamacpp)[:_]([a-z_0-9]+)(?:\{.*\})? ([-0-9.e+]+)$/.exec(line);
    if (m) out[m[1]] = (out[m[1]] || 0) + +m[2];
  }
  return out;
}

// Reads one engine's counters, adds what changed to the totals, and leaves its live numbers on the run.
export async function scrape(r, now) {
  let m;
  try {
    const res = await fetch(`${r.url}/metrics`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return;
    m = parseMetrics(await res.text());
  } catch { return; }
  const cur = { in: m.prompt_tokens_total || 0, out: m.generation_tokens_total || m.tokens_predicted_total || 0, req: m.request_success_total || 0 };
  const last = usage.last[keyOf(r)] || cur;
  const delta = Object.fromEntries(Object.keys(cur).map((k) => [k, cur[k] >= last[k] ? cur[k] - last[k] : cur[k]]));
  usage.last[keyOf(r)] = cur;
  r.used ||= { in: 0, out: 0, req: 0 };
  if (!r.measuring && (delta.in || delta.out || delta.req)) {
    const stamp = new Date(now).toISOString();
    const row = ((usage.days[stamp.slice(0, 10)] ||= {})[r.name] ||= { in: 0, out: 0, req: 0 });
    const hour = ((usage.hours[stamp.slice(0, 13)] ||= {})[r.name] ||= { in: 0, out: 0, req: 0 });
    for (const k of Object.keys(delta)) { row[k] += delta[k]; hour[k] += delta[k]; r.used[k] += delta[k]; }
    dirty = true;
  }
  r.series ||= [];
  if (!r.series.length || now - r.series.at(-1)[0] >= 60000) { r.series.push([now, r.used.in + r.used.out]); if (r.series.length > 240) r.series.shift(); }
  const seconds = r.scraped ? (now - r.scraped) / 1000 : 0;
  const ttftN = m.time_to_first_token_seconds_count;
  r.stats = {
    tps: seconds ? Math.round((delta.out / seconds) * 10) / 10 : 0, pps: seconds ? Math.round(delta.in / seconds) : 0, used: r.used.in + r.used.out, active: m.num_requests_running ?? m.num_running_reqs ?? m.requests_processing ?? 0,
    queued: m.num_requests_waiting ?? m.num_queue_reqs ?? 0, ttft: ttftN ? Math.round((m.time_to_first_token_seconds_sum / ttftN) * 100) / 100 : null,
    in: cur.in, out: cur.out, req: cur.req,
  };
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
  const days = Object.keys(usage.days).sort();
  const total = (d) => Object.values(usage.days[d]).reduce((n, row) => n + row.in + row.out, 0);
  const sum = (list) => list.reduce((n, d) => n + total(d), 0);
  const models = {};
  for (const d of days) for (const [name, row] of Object.entries(usage.days[d])) {
    const m = (models[name] ||= { name, in: 0, out: 0, req: 0 });
    for (const k of ['in', 'out', 'req']) m[k] += row[k];
  }
  const today = new Date().toISOString().slice(0, 10);
  const week = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);
  return { today: days.includes(today) ? total(today) : 0, week: sum(days.filter((d) => d >= week)), all: sum(days), days: days.slice(-84).map((d) => ({ d, v: total(d) })), models: Object.values(models).sort((a, b) => b.out - a.out) };
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
