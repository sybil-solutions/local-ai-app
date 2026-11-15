import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { flagProblem, resourceProblem } from './docker.js';
import { loadSeconds, speedOf } from './speed.js';
import { at, bytesUpTo, config, event, fail, jsonUpTo, own, readJson, saveConfig, writeJson } from './util.js';

const FEED = process.env.LOCAL_AI_REGISTRY || 'https://raw.githubusercontent.com/sybil-solutions/local-ai-registry/main/dist/catalog.json';
const HF = process.env.HF_ENDPOINT || 'https://huggingface.co'; // the same Hugging Face the weights come from
const REPO = /^[\w.-]+\/[\w.-]+$/;
const REVISION = /^[0-9a-f]{40}$/;
const ENGINES = { vllm: 'vLLM', sglang: 'SGLang', tabbyapi: 'TabbyAPI', 'llama.cpp': 'llama.cpp', mlx: 'MLX' };
const catalogFile = at('catalog.json');
const localFile = at('recipes.json');

let catalog = readJson(catalogFile, { cards: {}, recipes: {}, models: {}, builds: {} });
const local = Object.assign(Object.create(null), readJson(localFile, {})); // your own recipes, by id. An id can be any text, so the object has no inherited names
const feed = { at: null, error: null };

export async function refresh() {
  try {
    const res = await fetch(FEED, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`registry answered ${res.status}`);
    const next = await jsonUpTo(res, 64e6);
    if (!next || typeof next.cards !== 'object' || typeof next.recipes !== 'object' || !next.cards || !next.recipes) throw new Error('registry returned an unknown format');
    for (const part of ['models', 'builds']) if (!next[part] || typeof next[part] !== 'object') next[part] = {};
    catalog = next;
    writeJson(catalogFile, next);
    Object.assign(feed, { at: new Date().toISOString(), error: null });
    event('info', 'registry.updated', { recipes: Object.keys(next.recipes).length });
  } catch (e) {
    feed.error = e.message;
    event('warn', 'registry.unreachable', { error: e.message, cached: Object.keys(catalog.recipes).length });
  }
}

export const find = (id) => own(local, id) ?? own(catalog.recipes, id);
// A host recipe this machine can run itself: Metal on Apple silicon; Python given the recipe's own script and nothing
// else (no -c, no -m, no other file), the script matching its hash; every package pinned to one version; weights pinned
// to a commit inside the run's folder; and one --port and at most one --host, which the app sets itself.
// None of that makes the script safe: it runs as this user. So a host recipe also waits to be allowed (see `allowed`).
const PIP_PIN = /^[A-Za-z0-9][\w.-]*==[\w.+-]+$/;
const INSIDE = (p) => typeof p === 'string' && /^[\w][\w./-]*$/.test(p) && !p.split('/').includes('..');
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const plainEnv = (env) => env === undefined || (!!env && typeof env === 'object' && !Array.isArray(env) && Object.entries(env).every(([k, v]) => NAME.test(k) && ['string', 'number', 'boolean'].includes(typeof v)));
function hostProblem(launch) {
  const cmd = launch.command, script = launch.config;
  if (launch.backend !== 'metal' || process.platform !== 'darwin' || process.arch !== 'arm64') return 'Runs outside Docker';
  if (!Array.isArray(cmd) || !cmd.every((x) => typeof x === 'string') || !/^python3?$/.test(cmd[0] || '')) return 'Runs outside Docker';
  if (!script || typeof script !== 'object' || !INSIDE(script.at) || script.at.includes('/') || !script.at.endsWith('.py') || typeof script.text !== 'string'
    || createHash('sha256').update(script.text).digest('hex') !== script.sha256) return 'Its script does not match its hash';
  if (cmd[1] !== script.at) return 'Runs something other than its own script';
  const times = (flag) => cmd.filter((x) => x === flag).length;
  if (times('--port') !== 1 || times('--host') > 1 || cmd.some((x) => /^--(port|host)=/.test(x)) || ['--port', '--host'].includes(cmd[cmd.length - 1])) return 'Does not say its port';
  if (!plainEnv(launch.env)) return 'Sets an odd environment variable';
  if ([].concat(launch.pip || []).some((p) => !PIP_PIN.test(p))) return 'Engine packages are not pinned';
  if ([].concat(launch.weights || []).some((w) => !w || typeof w !== 'object' || w.path || w.layout === 'hub' || !REPO.test(w.repo || '') || !REVISION.test(w.revision || '') || !INSIDE(w.at))) return 'Weights are not pinned';
  if (launch.build || launch.setup || launch.prepare || launch.resources || (launch.machines || 1) > 1) return 'Needs manual setup';
  for (const [key, want] of Object.entries(launch.sysctl || {})) {
    if (!/^[\w.]+$/.test(key) || !(sysctlNow(key) >= +want)) return `Needs sudo sysctl ${key}=${want}`;
  }
  return null;
}
const sysctls = new Map();
function sysctlNow(key) {
  const hit = sysctls.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.value;
  let value = NaN;
  try { value = +execFileSync('sysctl', ['-n', key], { timeout: 2000, encoding: 'utf8' }).trim(); } catch { /* unknown key */ }
  sysctls.set(key, { at: Date.now(), value });
  return value;
}

// Why a recipe may not be started, or null. Your own recipes (`trusted`) are yours to write; a registry recipe must be
// pinned and need nothing beyond one docker run, or one pinned host run. Nothing here reads anything but the recipe,
// so tests/fuzz.mjs can ask it about recipes no registry would ever hold.
// A recipe's `setup` is its source's notes on what it ran on (hardware, timings, how the weights got there). It is
// shown with the recipe and stops nothing: the app fetches the pinned weights and image itself. What the app can't
// do for a recipe is a step before the engine (`prepare`), a build, a second container or a second machine.
export function problemWith(recipe, { trusted = false } = {}) {
  const launch = recipe?.launch;
  if (!launch || typeof launch !== 'object') return 'Has no launch';
  if (launch.kind === 'host') return hostProblem(launch) || (recipe.proof?.[0]?.failed ? 'Failed its last test' : null);
  // One engine spread over several machines is started on each of them in step, which this app does not do yet.
  if (whole(launch.machines, 1) > 1) return `Runs across ${whole(launch.machines, 1)} machines; this app starts a model on one`;
  if (typeof launch.image !== 'string' || !launch.image) return launch.build ? 'Image must be built from source' : 'Has no container image';
  if (trusted) return null;
  if (launch.build) return 'Image must be built from source';
  if (launch.prepare) return 'Needs a step before the engine that this app does not run';
  if (launch.companion) return 'Needs a second container beside the engine';
  if (resourceProblem(launch)) return resourceProblem(launch);
  if (!/^[a-z0-9][\w./:-]*@sha256:[0-9a-f]{64}$/i.test(launch.image)) return 'Image is not pinned';
  // Anything a recipe gives Docker must be of the plain shape expected, so none of it can pass for something else.
  const flags = flagProblem(launch);
  if (flags) return flags;
  if (!Number.isInteger(launch.port) || launch.port < 1 || launch.port > 65535) return 'Does not say its port';
  if (launch.shm !== undefined && !/^\d+(\.\d+)?[bkmg]?b?$/i.test(String(launch.shm))) return 'Asks for an odd amount of shared memory';
  if ((launch.args !== undefined && !Array.isArray(launch.args)) || [].concat(launch.entrypoint || [], launch.args || []).some((x) => !['string', 'number'].includes(typeof x))) return 'Has arguments that are not a list of text';
  if (!plainEnv(launch.env)) return 'Sets an odd environment variable';
  if (['cards', 'seqs', 'ctx'].some((k) => launch[k] != null && typeof launch[k] !== 'number')) return 'Has a number that is not a number';
  if ([].concat(launch.weights || []).some((w) => !w || typeof w !== 'object')) return 'Weights are not pinned';
  if (launch.config && (typeof launch.config.text !== 'string' || !/^\/[\w./-]+$/.test(launch.config.at || '') || launch.config.at.includes('..'))) return 'Its config file has an odd place';
  if ([].concat(launch.weights || []).some((w) => w.path || !REPO.test(w.repo || '') || !REVISION.test(w.revision || '') || !/^\/[\w./-]+$/.test(w.at || '') || w.at.includes('..'))) return 'Weights are not pinned';
  if (/(--host[ =]|host:\s*)127\.0\.0\.1/.test(`${(launch.args || []).join(' ')} ${launch.config?.text || ''}`)) return 'Only listens on loopback';
  return recipe.proof?.[0]?.failed ? 'Failed its last test' : null;
}
// What the recipe says the host needs besides the card, held against this machine: memory for what it keeps off the GPU.
const GB = 2 ** 30;
function shortOf(launch) {
  const ram = launch?.needs?.host_ram_gb;
  return typeof ram === 'number' && ram > totalmem() / GB ? `Needs ${Math.ceil(ram)} GB of memory beside the GPUs; this machine has ${Math.floor(totalmem() / GB)}` : null;
}
export const blocked = (id) => problemWith(find(id), { trusted: isLocal(id) }) || shortOf(find(id).launch);
// The same need held against what is free at this moment, when the recipe is about to start. `host_ram_gb` is free
// memory the engine takes beside the GPUs; started without it, the engine loads for minutes and is then killed when
// the machine runs out. On Linux free means MemAvailable: what a new program can be given without swapping.
function freeGb() {
  try { const m = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync('/proc/meminfo', 'utf8')); if (m) return +m[1] / 2 ** 20; } catch { /* not Linux */ }
  return freemem() / GB;
}
export function shortNow(id) {
  const ram = find(id)?.launch?.needs?.host_ram_gb, free = freeGb();
  return typeof ram === 'number' && ram > free ? `Needs ${Math.ceil(ram)} GB of free memory beside the GPUs; ${Math.floor(free)} GB is free on this machine now` : null;
}

// A host recipe runs as this user, outside any container, so the registry naming it is not enough: it starts only once
// the person at this machine has been shown what it runs and allowed it. What was allowed is this exact launch (its
// fingerprint), so a recipe that changes afterwards asks again.
const stable = (v) => (Array.isArray(v) ? `[${v.map(stable).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v) ?? 'null');
const marks = new WeakMap();
function fingerprint(id) {
  const launch = find(id)?.launch;
  if (launch?.kind !== 'host') return null;
  if (!marks.has(launch)) marks.set(launch, createHash('sha256').update(stable(launch)).digest('hex'));
  return marks.get(launch);
}
const asks = (id) => { const mark = fingerprint(id); return mark && own(config.approved, id) !== mark ? mark : null; };
// The id, once it may be started. `approve` is the fingerprint the page was shown; anything else is refused.
export function allowed(id, approve) {
  const mark = asks(id);
  if (!mark) return id;
  if (approve !== mark) fail(409, 'This model runs as a program on this computer, so it has to be allowed first. Open it under Models');
  config.approved = { ...config.approved, [id]: mark };
  saveConfig();
  event('info', 'recipe.allowed', { id, fingerprint: mark.slice(0, 12) });
  return id;
}

function score(model) {
  const aa = own(catalog.models, model)?.aa;
  return (aa?.of ? own(catalog.models, aa.of)?.aa : aa) || null;
}

// Numbers from a recipe or the registry, as numbers: a whole one no smaller than `least`, or an amount (null when it is none).
const whole = (v, least = 0) => Math.max(least, Math.trunc(+v) || 0);
const amount = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
function view(id) {
  const recipe = find(id);
  const model = own(catalog.models, recipe.model);
  const proof = recipe.proof?.find((p) => !p.failed);
  const measured = speedOf(id);
  const aa = score(recipe.model);
  const text = `${(recipe.launch.args || []).join(' ')} ${recipe.launch.config?.text || ''}`;
  return {
    id, local: isLocal(id), host: recipe.launch.kind === 'host', approve: asks(id), name: String(recipe.name || model?.name || recipe.model), card: recipe.card,
    cards: whole(recipe.launch.cards, 1), machines: whole(recipe.launch.machines, 1), engine: ENGINES[String(recipe.engine || '').split(/[-@]/)[0]] || 'Custom', ctx: whole(recipe.launch.ctx),
    vision: !!recipe.launch.vision, tps: measured?.c1 ?? amount(proof?.tps), smart: amount(aa?.index), seqs: whole(recipe.launch.seqs, 1),
    speed: { c1: measured?.c1 ?? amount(proof?.tps), c4: measured?.c4 ?? null, c8: measured?.c8 ?? null, measured: !!measured, exact: measured?.exact ?? true, ttft: measured?.ttft ?? null, at: measured?.at ?? null,
      legacy: !measured && !!proof?.legacy }, // its only speed is from the registry's older acceptance, which did not measure speed the way the lab does now sizeGb: amount(own(catalog.builds, recipe.weights)?.size_gb),
    released: typeof model?.released === 'string' ? model.released : null, loadS: loadSeconds(id),
    think: !!model?.reasoning, tools: /tool-call-parser|enable-auto-tool-choice|--jinja/.test(text) || String(proof?.gates || '').split(' ').includes('tools'), // its arguments say so, or the lab saw it call one kv: /--kv-cache-dtype[= ](?!auto)(\S+)/.exec(text)?.[1] || null,
  };
}

// The family is the id up to its first number; the version is the first number that is not a size.
// qwen3.8-27b is family qwen, version 3.8. welp-35b is family welp with no version.
const familyOf = (model) => model.match(/^\D*/)[0];
const versionOf = (model) => model.match(/\d+(\.\d+)*(?![\d.]*b)/i)?.[0] || '';
const isNewer = (a, b) => a.localeCompare(b, 'en', { numeric: true }) > 0;

// Only the newest version of each family that this machine can run. Your own recipes always stay. The picks are
// chosen among these; the list of models still shows the older ones.
function latestOfEachFamily(list) {
  const newest = new Map();
  for (const { id, local: yours } of list) {
    if (yours) continue;
    const { model } = find(id);
    if (!newest.has(familyOf(model)) || isNewer(versionOf(model), newest.get(familyOf(model)))) newest.set(familyOf(model), versionOf(model));
  }
  return list.filter((r) => r.local || newest.get(familyOf(find(r.id).model)) === versionOf(find(r.id).model));
}

const best = (list, score) => list.reduce((top, r) => (!top || score(r) > score(top) ? r : top), null);

// Three answers per device; each differs from the others whenever the card has enough models.
// A speed from the registry's older acceptance (`legacy`) is not a measurement to rank by: it counts only when no
// model here has a speed that was measured, by the lab, by whoever reported the recipe, or on this machine.
function tiers(list) {
  const measured = list.some((r) => r.tps && !r.speed.legacy), speed = (r) => (measured && r.speed.legacy ? 0 : r.tps || 0);
  const maxTps = Math.max(1, ...list.map(speed));
  const maxSmart = Math.max(1, ...list.map((r) => r.smart || 0));
  const fastest = best(list, (r) => speed(r) + r.ctx / 1e9);
  const smartPool = list.filter((r) => r.name !== fastest?.name && r.smart !== null);
  const smartest = best(smartPool.length ? smartPool : list.filter((r) => r !== fastest), (r) => (r.smart || 0) + r.ctx / 1e9);
  const rest = list.filter((r) => r.name !== fastest?.name && r.name !== smartest?.name);
  const balanced = best(rest.length ? rest : list.filter((r) => r !== fastest && r !== smartest),
    (r) => Math.sqrt((speed(r) / maxTps) * ((r.smart || 0) / maxSmart)));
  return { fastest, balanced, smartest };
}

const norm = (s) => s.toLowerCase().replace(/\((r|tm)\)/g, '').replace(/geforce|nvidia|amd|radeon|intel|graphics|[^a-z0-9]/g, '');

// `shared` is a GPU that uses the machine's RAM: it reports a little less than the card's nominal size, so its card is
// found by name alone among the cards the registry marks as unified memory. A GPU that says what kind it is
// (`backend`: an Intel card) is looked for among the registry's cards of that kind only.
function cardOf(gpuName, vramGb, shared = false, backend = null) {
  const n = norm(gpuName);
  const score = ([id, card]) => Math.max(0, ...[norm(card.name), norm(id), ...(card.match?.names || [])].filter((x) => x && n.includes(x)).map((x) => x.length));
  const off = (entry) => Math.abs(entry[1].vram_gb - vramGb);
  const hits = Object.entries(catalog.cards).filter((entry) => (!backend || entry[1].backend === backend) && score(entry) && (off(entry) <= 1 || (shared && entry[1].match?.unifiedMemory)));
  return hits.sort((a, b) => score(b) - score(a) || off(a) - off(b))[0]?.[0] ?? null;
}

// A card the registry has never tested borrows from the biggest tested NVIDIA card that fits in its memory.
function nearest(vramGb) {
  const size = (c) => (c.picks?.length || 0) + (c.more?.length || 0);
  return Object.entries(catalog.cards).filter(([, c]) => c.backend === 'nvidia' && c.vram_gb && c.vram_gb <= vramGb + 1 && size(c))
    .sort(([, a], [, b]) => b.vram_gb - a.vram_gb || size(b) - size(a))[0]?.[0] ?? null;
}
// An Apple chip runs only recipes made for it: a Metal card whose name is exactly the chip's (an M4 Pro is not an M4),
// with no fallback to an NVIDIA card of similar memory.
function appleCard(gpuName, vramGb) {
  const n = norm(gpuName);
  return Object.entries(catalog.cards).find(([, c]) => c.backend === 'metal' && Math.abs(c.vram_gb - vramGb) <= 1
    && [norm(c.name), ...(c.match?.names || [])].includes(n))?.[0] ?? null;
}
// An Intel card runs only what was tested on it: an engine built for NVIDIA cards does not run there.
export const cardFor = (gpu) => (gpu.unified ? appleCard(gpu.name, gpu.total / 1024) : cardOf(gpu.name, gpu.total / 1024, gpu.shared, gpu.backend) ?? (gpu.backend ? null : nearest(gpu.total / 1024)));

// A recipe's id is written on its container as a label and read back from Docker's listing, one line a container,
// so it is plain text on one line.
const PLAIN_ID = /^[^\x00-\x1f\x7f]{1,200}$/; // eslint-disable-line no-control-regex
// A recipe for this machine's cards, as the app shows it: with `why` when it is one this app will not start. One that
// can't be read is reported and left out, as is one for more cards than the machine has.
const unreadable = new Set();
function listed(id, card, count) {
  try {
    const recipe = find(id);
    if (!PLAIN_ID.test(id) || recipe.card !== card || whole(recipe.launch.cards, 1) > count) return [];
    if (!isLocal(id)) familyOf(recipe.model); // a registry recipe is ranked by its model's name
    const why = blocked(id);
    return [why ? { ...view(id), why } : view(id)];
  } catch (e) {
    if (!unreadable.has(id)) event('warn', 'recipe.unreadable', { id, error: e.message });
    unreadable.add(id);
    return [];
  }
}

// The setups the registry knows for a card that this machine's cards can be part of: one card, several in this
// machine, and several machines of the card working together. Largest first; one the registry does not name but
// has a recipe for is named here.
function setupsOf(card, count, all) {
  const name = own(catalog.cards, card)?.name || card, known = Array.isArray(own(catalog.cards, card)?.setups) ? own(catalog.cards, card).setups : [];
  const key = (s) => `${s.cards}x${s.machines}`, found = new Map();
  for (const s of known) {
    const cards = whole(s?.cards, 1), machines = whole(s?.machines, 1);
    if (cards <= count && typeof s?.label === 'string') found.set(key({ cards, machines }), { cards, machines, label: s.label.slice(0, 80) });
  }
  for (const r of all) {
    if (!found.has(key(r))) found.set(key(r), { cards: r.cards, machines: r.machines, label: r.cards * r.machines === 1 ? name : `${r.cards * r.machines} × ${name}${r.machines === 1 ? ' (one machine)' : ''}` });
  }
  const used = new Set(all.map(key));
  return [...found.values()].filter((s) => used.has(key(s))).sort((a, b) => b.cards * b.machines - a.cards * a.machines || a.machines - b.machines);
}
// The three picks. On a machine with several cards they come from the largest setup in this machine that has a
// model it can start (four cards run a model one card cannot); a pick that setup has no model for is the one-card pick.
function picksOf(list, setups) {
  const whole_ = tiers(latestOfEachFamily(list));
  const many = setups.filter((s) => s.machines === 1 && s.cards > 1).map((s) => list.filter((r) => r.cards === s.cards && r.machines === 1)).find((rs) => rs.length);
  if (!many) return whole_;
  const top = tiers(many), names = new Set(Object.values(top).filter(Boolean).map((r) => r.name)), rest = tiers(latestOfEachFamily(list.filter((r) => !names.has(r.name))));
  return { fastest: top.fastest || rest.fastest, balanced: top.balanced || rest.balanced, smartest: top.smartest || rest.smartest };
}

// The recipe shown first when nothing was chosen or started yet: the registry's recommended one (the first pick) for
// the largest setup in this machine that has a model it can start, or, where that exact recipe is one this app will
// not start, another recipe here for the same model.
function recommendedOf(card, setups, list) {
  const known = Array.isArray(own(catalog.cards, card)?.setups) ? own(catalog.cards, card).setups : [];
  for (const s of setups.filter((x) => x.machines === 1)) {
    const here = list.filter((r) => r.cards === s.cards && r.machines === 1);
    if (!here.length) continue;
    const named = known.find((x) => whole(x?.cards, 1) === s.cards && whole(x?.machines, 1) === 1) || (s.cards === 1 ? own(catalog.cards, card) : null);
    for (const key of [].concat(named?.picks || [], named?.more || []).filter((k) => typeof k === 'string')) {
      const model = own(catalog.recipes, key)?.model;
      const hit = here.find((r) => r.id === key) || (model && here.find((r) => find(r.id).model === model));
      if (hit) return hit.id;
    }
    return null; // the registry names none of what this machine can start here: the picks decide
  }
  return null;
}

// One group per kind of card on the machine: its three picks, everything it can launch (`recipes`), what the
// registry holds for these cards that this app will not start, each with the reason (`blocked`), and the setups
// those belong to (`setups`). Nothing the registry has for the machine's cards is left out without a word.
export function groups(gpus) {
  const byCard = new Map();
  for (const gpu of gpus) {
    const tested = gpu.unified ? cardFor(gpu) : cardOf(gpu.name, gpu.total / 1024, gpu.shared, gpu.backend), key = `${cardFor(gpu)}:${!!tested}`;
    if (!byCard.has(key)) byCard.set(key, { card: cardFor(gpu), tested, members: [] });
    byCard.get(key).members.push(gpu);
  }
  const ids = [...new Set([...Object.keys(catalog.recipes), ...Object.keys(local)])];
  return [...byCard.values()].map(({ card, tested, members }) => {
    const all = ids.flatMap((id) => listed(id, card, members.length)).sort((a, b) => (b.tps || 0) - (a.tps || 0)), list = all.filter((r) => !r.why), setups = setupsOf(card, members.length, all);
    return { card, name: own(catalog.cards, tested)?.name || members[0].name, untested: tested ? null : own(catalog.cards, card)?.name ?? null, gpus: members.map((g) => g.index), tiers: picksOf(list, setups), recommended: recommendedOf(card, setups, list), recipes: list, blocked: all.filter((r) => r.why), setups };
  });
}

// A run's name: its recipe's, or the id when the recipe is gone or can no longer be read.
export const label = (id) => { try { return find(id) ? view(id).name : String(id); } catch { return String(id); } };
export function isLocal(id) { return own(local, id) !== undefined; }
export const raw = (id) => (find(id) ? { id, ...find(id) } : fail(404, 'No such recipe'));

export function save({ id, ...recipe }) {
  if (typeof id !== 'string' || !id.trim() || !PLAIN_ID.test(id)) fail(400, 'Recipe needs an id');
  if (!recipe.launch || typeof recipe.launch !== 'object') fail(400, 'Recipe needs a launch object');
  if (recipe.launch.kind === 'host') fail(400, 'Recipes that run outside Docker can’t be edited here yet');
  if (typeof recipe.launch.image !== 'string' || !recipe.launch.image) fail(400, 'launch.image must be a container image');
  if (!Number.isInteger(recipe.launch.port)) fail(400, 'launch.port must be the port the engine listens on');
  if (typeof recipe.card !== 'string') fail(400, 'Recipe needs a card id');
  for (const w of [].concat(recipe.launch.weights || [])) if (!w?.at || !(w.path || (REPO.test(w.repo || '') && REVISION.test(w.revision || '')))) fail(400, 'Each weight needs "at" and either "path" or a "repo" with a 40-character "revision"');
  const before = own(local, id);
  local[id] = recipe;
  try { blocked(id); view(id); } catch (e) { if (before) local[id] = before; else delete local[id]; fail(400, `That recipe can’t be read: ${e.message}`); }
  writeJson(localFile, local);
  event('info', 'recipe.saved', { id });
  return { id };
}

export function reset(id) {
  if (!isLocal(id)) fail(404, 'That recipe has no local changes');
  delete local[id];
  writeJson(localFile, local);
  event('info', 'recipe.reset', { id });
  return { id };
}

// The registry as the app shows it: when it was last fetched, any error, how many recipes, and which version.
export const registry = () => ({ ...feed, count: Object.keys(catalog.recipes).length, id: (catalog.sha256 || '').slice(0, 7) });

// The model's page on Hugging Face: the repo the registry names. Only a model the registry gives no repo for is looked
// up by name, since anyone can publish a repo with a matching name. A card is kept for a day; a model that has none is
// not asked about again for ten minutes.
// With the card come the recipe's own notes from its source (`setup`) and what it says the host needs. They are the
// recipe's, not the model's, so they are added to each answer and a recipe that has them answers even with no card.
const cards = new Map(); // model → { at, card }, or { at, missing } with why there is none
export async function card(id) {
  const recipe = find(id) || fail(404, 'No such recipe');
  const L = recipe.launch || {}, needs = L.needs && typeof L.needs === 'object' ? L.needs : {};
  const notes = { notes: typeof L.setup === 'string' ? L.setup.slice(0, 8000) : null, needs: { ram: amount(needs.host_ram_gb), disk: amount(needs.disk_gb), nvme: needs.fast_storage === 'nvme' } };
  const said = notes.notes || notes.needs.ram || notes.needs.disk || notes.needs.nvme;
  const hit = cards.get(recipe.model);
  if (hit && Date.now() - hit.at < (hit.card ? 864e5 : 600e3)) return hit.card ? { ...hit.card, ...notes } : said ? notes : fail(404, hit.missing);
  try { return { ...(await fetchCard(recipe)), ...notes }; } catch (e) {
    if (e.status === 404) cards.set(recipe.model, { at: Date.now(), missing: e.message });
    if (e.status === 404 && said) return notes;
    throw e;
  }
}
async function fetchCard(recipe) {
  const model = own(catalog.models, recipe.model) || {};
  const get = (url) => fetch(url, { signal: AbortSignal.timeout(12000) });
  let repo = REPO.test(model.hf || '') ? model.hf : null;
  if (!repo) {
    const name = String(model.name || recipe.model).replace(/\s+/g, '-');
    const found = await get(`${HF}/api/models?search=${encodeURIComponent(name)}&sort=downloads&limit=20`).then((r) => r.json()).catch(() => []);
    repo = (Array.isArray(found) ? found : []).map((m) => String(m?.id || '')).find((hit) => REPO.test(hit) && hit.split('/').pop().toLowerCase().replace(/-it$/, '') === name.toLowerCase()) || fail(404, 'This model has no card on Hugging Face');
  }
  const [meta, readme] = await Promise.all([ // side by side: neither waits for the other
    get(`${HF}/api/models/${repo}`).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    get(`${HF}/${repo}/raw/main/README.md`).catch(() => null),
  ]);
  if (!readme?.ok) fail(404, 'This model has no card on Hugging Face');
  const text = (await bytesUpTo(readme, 4e6).catch(() => fail(404, 'This model’s card is too long to show'))).toString('utf8');
  const card_ = { repo, license: typeof meta?.cardData?.license === 'string' ? meta.cardData.license.slice(0, 60) : null, downloads: amount(meta?.downloads), md: text.replace(/^---\n[\s\S]*?\n---\n/, '').slice(0, 14000) };
  cards.set(recipe.model, { at: Date.now(), card: card_ });
  return card_;
}
