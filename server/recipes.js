import { loadSeconds, speedOf } from './speed.js';
import { at, event, fail, readJson, writeJson } from './util.js';

const FEED = process.env.LOCAL_AI_REGISTRY || 'https://raw.githubusercontent.com/sybil-solutions/local-ai-registry/main/dist/catalog.json';
const ALLOWED_FLAGS = new Set(['--ipc', '--network', '--net', '--gpus', '--shm-size', '--ulimit', '--workdir', '-w']);
const REPO = /^[\w.-]+\/[\w.-]+$/;
const REVISION = /^[0-9a-f]{40}$/;
const ENGINES = { vllm: 'vLLM', sglang: 'SGLang', tabbyapi: 'TabbyAPI', 'llama.cpp': 'llama.cpp' };
const catalogFile = at('catalog.json');
const localFile = at('recipes.json');

let catalog = readJson(catalogFile, { cards: {}, recipes: {}, models: {}, builds: {} });
const local = readJson(localFile, {});
const feed = { at: null, error: null };

export async function refresh() {
  try {
    const res = await fetch(FEED, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`registry answered ${res.status}`);
    const next = await res.json();
    if (!next.cards || !next.recipes) throw new Error('registry returned an unknown format');
    catalog = next;
    writeJson(catalogFile, next);
    Object.assign(feed, { at: new Date().toISOString(), error: null });
    event('info', 'registry.updated', { recipes: Object.keys(next.recipes).length });
  } catch (e) {
    feed.error = e.message;
    event('warn', 'registry.unreachable', { error: e.message, cached: Object.keys(catalog.recipes).length });
  }
}

export const find = (id) => local[id] || catalog.recipes[id];
export const flagsOf = (launch) => (launch.flags || []).flatMap((flag) => {
  const text = flag.trim();
  const eq = /^(-[\w-]+)=(.*)$/.exec(text);
  return eq ? [eq[1], eq[2]] : text.split(/\s+(.*)/s).filter(Boolean);
});

// Your own recipes are trusted; public ones must be pinned and need nothing beyond one docker run.
export function blocked(id) {
  const recipe = find(id);
  const launch = recipe.launch;
  if (!launch.image) return 'Has no container image';
  if (local[id]) return null;
  if (launch.kind === 'host') return 'Runs outside Docker';
  if (launch.build) return 'Image must be built from source';
  if (launch.setup || launch.prepare || launch.resources) return 'Needs manual setup';
  if ((launch.machines || 1) > 1) return 'Needs several machines';
  if (!launch.image.includes('@sha256:')) return 'Image is not pinned';
  const flag = flagsOf(launch).find((f) => f.startsWith('-') && !ALLOWED_FLAGS.has(f));
  if (flag) return `Uses ${flag}`;
  if ([].concat(launch.weights || []).some((w) => w.path || !REPO.test(w.repo || '') || !REVISION.test(w.revision || '') || !/^\/[\w./-]+$/.test(w.at || '') || w.at.includes('..'))) return 'Weights are not pinned';
  if (/(--host[ =]|host:\s*)127\.0\.0\.1/.test(`${(launch.args || []).join(' ')} ${launch.config?.text || ''}`)) return 'Only listens on loopback';
  return recipe.proof?.[0]?.failed ? 'Failed its last test' : null;
}

function score(model) {
  const aa = catalog.models[model]?.aa;
  return (aa?.of ? catalog.models[aa.of]?.aa : aa) || null;
}

function view(id) {
  const recipe = find(id);
  const model = catalog.models[recipe.model];
  const proof = recipe.proof?.find((p) => !p.failed);
  const measured = speedOf(id);
  const aa = score(recipe.model);
  const text = `${(recipe.launch.args || []).join(' ')} ${recipe.launch.config?.text || ''}`;
  return {
    id, local: !!local[id], name: recipe.name || model?.name || recipe.model, card: recipe.card,
    cards: recipe.launch.cards || 1, engine: ENGINES[String(recipe.engine || '').split(/[-@]/)[0]] || 'Custom', ctx: recipe.launch.ctx || 0,
    vision: !!recipe.launch.vision, tps: measured?.c1 ?? proof?.tps ?? null, smart: aa?.index ?? null, seqs: recipe.launch.seqs || 1,
    speed: { c1: measured?.c1 ?? proof?.tps ?? null, c4: measured?.c4 ?? null, c8: measured?.c8 ?? null, measured: !!measured, exact: measured?.exact ?? true, ttft: measured?.ttft ?? null, at: measured?.at ?? null }, sizeGb: catalog.builds[recipe.weights]?.size_gb ?? null,
    released: model?.released || null, loadS: loadSeconds(id),
    think: !!model?.reasoning, tools: /tool-call-parser|enable-auto-tool-choice|--jinja/.test(text), kv: /--kv-cache-dtype[= ](?!auto)(\S+)/.exec(text)?.[1] || null,
  };
}

// The family is the id up to its first number; the version is the first number that is not a size.
// qwen3.8-27b is family qwen, version 3.8. welp-35b is family welp with no version.
const familyOf = (model) => model.match(/^\D*/)[0];
const versionOf = (model) => model.match(/\d+(\.\d+)*(?![\d.]*b)/i)?.[0] || '';
const isNewer = (a, b) => a.localeCompare(b, 'en', { numeric: true }) > 0;

// Keeps only the newest version of each family that this machine can run. Your own recipes always stay.
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
function tiers(list) {
  const maxTps = Math.max(1, ...list.map((r) => r.tps || 0));
  const maxSmart = Math.max(1, ...list.map((r) => r.smart || 0));
  const fastest = best(list, (r) => (r.tps || 0) + r.ctx / 1e9);
  const smartPool = list.filter((r) => r.name !== fastest?.name && r.smart !== null);
  const smartest = best(smartPool.length ? smartPool : list.filter((r) => r !== fastest), (r) => (r.smart || 0) + r.ctx / 1e9);
  const rest = list.filter((r) => r.name !== fastest?.name && r.name !== smartest?.name);
  const balanced = best(rest.length ? rest : list.filter((r) => r !== fastest && r !== smartest),
    (r) => Math.sqrt(((r.tps || 0) / maxTps) * ((r.smart || 0) / maxSmart)));
  return { fastest, balanced, smartest };
}

const norm = (s) => s.toLowerCase().replace(/\((r|tm)\)/g, '').replace(/geforce|nvidia|amd|radeon|intel|graphics|[^a-z0-9]/g, '');

function cardOf(gpuName, vramGb) {
  const n = norm(gpuName);
  const score = ([id, card]) => Math.max(0, ...[norm(card.name), norm(id), ...(card.match?.names || [])].filter((x) => x && n.includes(x)).map((x) => x.length));
  const off = (entry) => Math.abs(entry[1].vram_gb - vramGb);
  const hits = Object.entries(catalog.cards).filter((entry) => score(entry) && off(entry) <= 1);
  return hits.sort((a, b) => score(b) - score(a) || off(a) - off(b))[0]?.[0] ?? null;
}

// A card the registry has never tested borrows from the biggest tested NVIDIA card that fits in its memory.
function nearest(vramGb) {
  const size = (c) => (c.picks?.length || 0) + (c.more?.length || 0);
  return Object.entries(catalog.cards).filter(([, c]) => c.backend === 'nvidia' && c.vram_gb && c.vram_gb <= vramGb + 1 && size(c))
    .sort(([, a], [, b]) => b.vram_gb - a.vram_gb || size(b) - size(a))[0]?.[0] ?? null;
}
export const cardFor = (gpu) => cardOf(gpu.name, gpu.total / 1024) ?? nearest(gpu.total / 1024);

// One group per kind of card on the machine: its three picks plus everything else it can launch.
export function groups(gpus) {
  const byCard = new Map();
  for (const gpu of gpus) {
    const tested = cardOf(gpu.name, gpu.total / 1024), key = `${cardFor(gpu)}:${!!tested}`;
    if (!byCard.has(key)) byCard.set(key, { card: cardFor(gpu), tested, members: [] });
    byCard.get(key).members.push(gpu);
  }
  const ids = [...new Set([...Object.keys(catalog.recipes), ...Object.keys(local)])];
  return [...byCard.values()].map(({ card, tested, members }) => {
    const own = ids.filter((id) => find(id).card === card && (find(id).launch.cards || 1) <= members.length);
    const list = latestOfEachFamily(own.filter((id) => !blocked(id)).map(view)).sort((a, b) => (b.tps || 0) - (a.tps || 0));
    return { card, name: catalog.cards[tested]?.name || members[0].name, supported: !!card, untested: tested ? null : catalog.cards[card]?.name ?? null, gpus: members.map((g) => g.index), tiers: tiers(list), recipes: list, hidden: own.filter(blocked).length };
  });
}

export const label = (id) => (find(id) ? view(id).name : id);
export const isLocal = (id) => !!local[id];
export const raw = (id) => (find(id) ? { id, ...find(id) } : fail(404, 'No such recipe'));

export function save({ id, ...recipe }) {
  if (typeof id !== 'string' || !id.trim()) fail(400, 'Recipe needs an id');
  if (!recipe.launch || typeof recipe.launch !== 'object') fail(400, 'Recipe needs a launch object');
  if (typeof recipe.launch.image !== 'string' || !recipe.launch.image) fail(400, 'launch.image must be a container image');
  if (!Number.isInteger(recipe.launch.port)) fail(400, 'launch.port must be the port the engine listens on');
  if (typeof recipe.card !== 'string') fail(400, 'Recipe needs a card id');
  for (const w of [].concat(recipe.launch.weights || [])) if (!w?.at || !(w.path || (REPO.test(w.repo || '') && REVISION.test(w.revision || '')))) fail(400, 'Each weight needs "at" and either "path" or a "repo" with a 40-character "revision"');
  local[id] = recipe;
  writeJson(localFile, local);
  event('info', 'recipe.saved', { id });
  return { id };
}

export function reset(id) {
  if (!local[id]) fail(404, 'That recipe has no local changes');
  delete local[id];
  writeJson(localFile, local);
  event('info', 'recipe.reset', { id });
  return { id };
}

// The registry as the app shows it: when it was last fetched, any error, how many recipes, and which version.
export const registry = () => ({ ...feed, count: Object.keys(catalog.recipes).length, id: (catalog.sha256 || '').slice(0, 7) });

// The model's page on Hugging Face: the repo the registry names, else the best match for its name.
const cards = new Map();
export async function card(id) {
  const recipe = find(id) || fail(404, 'No such recipe');
  const model = catalog.models[recipe.model] || {};
  const hit = cards.get(recipe.model);
  if (hit && Date.now() - hit.at < 864e5) return hit.card;
  const get = (url) => fetch(url, { signal: AbortSignal.timeout(12000) });
  const name = (model.name || recipe.model).replace(/\s+/g, '-');
  const found = await get(`https://huggingface.co/api/models?search=${encodeURIComponent(name)}&sort=downloads&limit=20`).then((r) => r.json()).catch(() => []);
  const base = Array.isArray(found) ? found.find((m) => m.id.split('/')[1].toLowerCase().replace(/-it$/, '') === name.toLowerCase()) : null;
  const repo = base?.id || model.hf || fail(404, 'This model has no card on Hugging Face');
  const meta = await get(`https://huggingface.co/api/models/${repo}`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  const readme = await get(`https://huggingface.co/${repo}/raw/main/README.md`).catch(() => null);
  if (!readme?.ok) fail(404, 'This model has no card on Hugging Face');
  const card_ = { repo, license: meta.cardData?.license || null, downloads: meta.downloads ?? null, md: (await readme.text()).replace(/^---\n[\s\S]*?\n---\n/, '').slice(0, 14000) };
  cards.set(recipe.model, { at: Date.now(), card: card_ });
  return card_;
}
