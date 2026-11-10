import { at, event, readJson, writeJson } from './util.js';

const speedsFile = at('speeds.json');
const loadsFile = at('loads.json');
const speeds = readJson(speedsFile, {});
const loads = readJson(loadsFile, {});
const LEVELS = [1, 4, 8];
const TOKENS = 256;
const WAVES = 2;

export const speedOf = (id) => speeds[id] || null;
export const loadSeconds = (id) => loads[id] || null;
export function saveLoad(id, seconds) { loads[id] = seconds; writeJson(loadsFile, loads); }
export function forget(id) { if (speeds[id]) { delete speeds[id]; writeJson(speedsFile, speeds); } }

const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];

// One streamed answer: when its first and last token arrived, and how many the engine says it wrote.
async function answer(url, model, signal) {
  const started = performance.now();
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer local' }, signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]),
    body: JSON.stringify({ model, stream: true, stream_options: { include_usage: true }, max_tokens: TOKENS, ignore_eos: true, temperature: 0.7,
      messages: [{ role: 'user', content: `[${Math.random().toString(36).slice(2)}] Write a long, detailed story about a lighthouse keeper.` }] }),
  });
  if (!res.ok) throw new Error(`engine answered ${res.status}`);
  let first = 0, last = 0, chunks = 0, reported = null, tail = '';
  const decoder = new TextDecoder();
  for await (const part of res.body) {
    const lines = (tail + decoder.decode(part, { stream: true })).split('\n');
    tail = lines.pop();
    const now = performance.now();
    for (const line of lines) {
      if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
      let data;
      try { data = JSON.parse(line.slice(5)); } catch { continue; }
      if (data.usage?.completion_tokens) reported = data.usage.completion_tokens;
      const delta = data.choices?.[0]?.delta;
      if (delta && (delta.content || delta.reasoning_content || delta.reasoning)) { first ||= now; last = now; chunks++; }
    }
  }
  if (!first || last === first) throw new Error('engine wrote nothing to time');
  return { started, first, last, tokens: reported ?? chunks, exact: reported !== null };
}

// C is the total tokens a second across C requests at once, timed from the first token to the last.
async function wave(url, model, c, signal) {
  const all = await Promise.all(Array.from({ length: c }, () => answer(url, model, signal)));
  const seconds = (Math.max(...all.map((a) => a.last)) - Math.min(...all.map((a) => a.first))) / 1000;
  return { total: all.reduce((n, a) => n + a.tokens - 1, 0) / seconds, ttft: median(all.map((a) => a.first - a.started)) / 1000, exact: all.every((a) => a.exact) };
}

export async function measure({ id, url, model, seqs, signal, onLevel }) {
  await answer(url, model, signal); // the first answer after a load is always slow, so it does not count
  const result = { at: new Date().toISOString(), exact: true };
  for (const c of LEVELS.filter((level) => level <= seqs)) {
    onLevel(c);
    const waves = [];
    for (let i = 0; i < WAVES; i++) waves.push(await wave(url, model, c, signal));
    result[`c${c}`] = Math.round(median(waves.map((w) => w.total)) * 10) / 10;
    if (c === 1) result.ttft = Math.round(median(waves.map((w) => w.ttft)) * 100) / 100;
    result.exact &&= waves.every((w) => w.exact);
  }
  speeds[id] = result;
  writeJson(speedsFile, speeds);
  event('info', 'speed.measured', { id, ...result });
  return result;
}
