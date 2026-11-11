// What the page knows: the server's last snapshot, the little the page remembers itself, and the questions every screen asks of them.
export const store = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } return v; };
// The key reaches the page three ways: written into it by the server (only for another of your own Tailscale
// machines), in the address it was opened with (#key=…, taken out of the address at once), or typed once. A key that
// came by address or by typing is remembered in this browser.
const inlined = document.querySelector('meta[name=key]').content;
const linked = /[#&]key=([0-9a-f]{16,})/.exec(location.hash || '')?.[1];
if (linked) { store('key', linked); history.replaceState(null, '', `${location.pathname}${location.search}`); }

export const s = {
  key: inlined && inlined !== '__KEY__' ? inlined : linked || store('key') || '',
  snap: null, online: true, needKey: false, version: 0,
  dev: -1,            // which machine is shown: -1 is this one, else an index into snap.devices
  nav: null,          // the screen opened on top of Home, or null
  trail: [],          // where Close goes back to
  sel: null,          // the recipe picked on Home
  expanded: null, modelOpen: null, opened: null, agentsOpen: false,
  full: store('la-full') !== '0',
  note: '', busy: false, command: '', logText: '',
  period: 'days', span: 'all', usage: null, ends: null, peers: null, install: null, draft: null, link: null,
  asking: null, look: null, // the model waiting to be allowed, and its recipe as fetched to show
  form: {}, cards: {},
};

export async function api(path, options = {}) {
  const res = await fetch(`/api/${path}`, { ...options, headers: { authorization: `Bearer ${s.key}`, 'content-type': 'application/json' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}
export const send = (path, method = 'POST', body) => api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
// Calls about models go to the machine being shown; everything else stays on the one serving this page.
export const scoped = (path) => (s.dev === -1 ? path : `devices/${s.dev}/${path}`);

export const D = () => (s.dev === -1 ? s.snap : s.snap.devices[s.dev]?.state);
export const here = () => (s.dev === -1 ? s.snap.name : s.snap.devices[s.dev]?.name || s.snap.name);
// The models of the machine being shown, newest first. Every part of a screen asks for this, so it is worked out
// once for each snapshot.
let listed = { of: null, list: [], others: [], sections: [] };
const newestFirst = (a, b) => (b.released || '').localeCompare(a.released || '');
// The registry's recipes for the machine being shown, by setup: four cards in the machine, one card, several
// machines of the card together. Largest first. In each, what the machine can start comes first, newest first, then
// what the app will not start, each saying why. A machine on an older version names no setups: it has one list.
function sectionsOf(d) {
  const out = [];
  for (const g of d.groups) {
    const rows = (pick) => [...g.recipes.filter(pick).sort(newestFirst), ...(g.blocked || []).filter(pick).sort(newestFirst)];
    if (!g.setups) { out.push({ label: g.name, cards: 1, machines: 1, rows: rows(() => true) }); continue; }
    for (const s of g.setups) out.push({ ...s, rows: rows((r) => r.cards === s.cards && (r.machines || 1) === s.machines) });
  }
  return out.filter((s) => s.rows.length);
}
function lists() {
  const d = D();
  if (listed.of !== d) listed = { of: d, list: d.groups.flatMap((g) => g.recipes).sort(newestFirst), others: d.groups.flatMap((g) => g.blocked || []).sort(newestFirst), sections: sectionsOf(d) };
  return listed;
}
export const all = () => lists().list;
// What the registry holds for this machine's cards that the app will not start. Each says why (`why`).
export const others = () => lists().others;
export const sections = () => lists().sections;
// A model by its id, whether the machine can start it or not.
export const model = (id) => all().find((r) => r.id === id) || others().find((r) => r.id === id) || null;
export const group = () => [...D().groups].sort((a, b) => b.recipes.length - a.recipes.length)[0];
const TIERS = [['fastest', 'Fast'], ['balanced', 'Balanced'], ['smartest', 'Smart']];
export function picks() {
  const g = group(), seen = new Set();
  return TIERS.map(([k, name]) => g?.tiers[k] && { ...g.tiers[k], tier: name }).filter((r) => r && !seen.has(r.id) && seen.add(r.id));
}
// The one model Home is about: one you started, else one found running on the machine, else one that failed.
export function run() {
  const runs = D().runs;
  return runs.find((r) => !r.external && r.phase !== 'failed') || runs.find((r) => r.external) || runs[0] || null;
}
export function chosen() {
  const list = all(), three = picks();
  // What is running, else what you chose, else what was started last, else the registry's recommended model for this machine, else Balanced.
  const id = run()?.recipe ?? [s.sel, D().last, group()?.recommended].find((x) => list.some((y) => y.id === x)) ?? (three.find((x) => x.tier === 'Balanced') || three[0] || list[0])?.id;
  return list.find((x) => x.id === id) || null;
}
// The three picks, plus the chosen model when it is none of them.
export const shown = () => { const three = picks(), c = chosen(); return c && !three.some((r) => r.id === c.id) ? [...three, c] : three; };
export const cardKey = (id) => `${s.dev} ${id}`; // a recipe id can mean a different model on another machine
export const newer = (a, b) => a.localeCompare(b, 'en', { numeric: true }) > 0;
export const agentName = () => s.snap.agents.find((a) => a.id === s.snap.agent && a.installed)?.name;
export const outdated = () => s.snap.agents.filter((a) => a.installed && a.version && a.latest && newer(a.latest, a.version) && a.job?.phase !== 'running');
// Whether the machine has the free GPUs the chosen model needs. When it has not, Home says so and shows the GPUs.
export function hasRoom(c = chosen()) {
  const d = D(), g = c && d.groups.find((x) => x.recipes.some((r) => r.id === c.id));
  return !!g && g.gpus.filter((i) => d.free.includes(i)).length >= c.cards;
}
export const homeCfg = () => s.snap.home || { order: ['hands', 'models', 'stats', 'usage', 'gpus'], on: ['hands', 'models', 'stats'] };
// The blocks Home shows, in order. The GPUs join them while they are the reason nothing can start.
export function HOME() {
  const { order, on } = homeCfg(), list = order.filter((k) => on.includes(k));
  return !list.includes('gpus') && !run() && chosen() && !hasRoom() ? [...list, 'gpus'] : list;
}
// The desktop app's window fits itself to the layout (electron/preload.cjs); a browser's can't be resized from here.
export const shellWindow = window.localAiWindow || null;
const roomy = () => innerWidth >= 640;
// The panel's width and least height, in its own units. The stylesheet is where they are set.
const size = (name) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
export const PANEL = { w: size('--pw') || 312, h: size('--ph') || 432 };
export const canFull = () => roomy() || !!shellWindow; // whether the layout can be switched at all
export const isFull = () => s.full && roomy();

// Which screen the snapshot calls for. The first rule that matches wins.
export function resolve() {
  if (s.needKey) return 'key';
  if (!s.snap) return s.online ? 'boot' : 'cantconnect';
  if (!s.online) return 'cantconnect';
  if (s.dev !== -1 && (!s.snap.devices[s.dev].online || !D())) return 'unreachable';
  if (s.snap.app.phase === 'updating') return 'app-updating';
  const d = D(), r = run();
  if (r) {
    const late = r.phase === 'starting' && r.expected && (Date.now() - r.since) / 1000 > r.expected * 1.5;
    return { weights: 'dl', ready: s.opened === r.id ? 'opened' : 'awake', unresponsive: 'noreply', stopping: 'sleeping', failed: 'failed' }[r.phase] || (late ? 'slow' : 'waking');
  }
  if (!d.docker.ok && d.gpus.length && d.needsDocker !== false) return /not installed/.test(d.docker.error) ? 'needsdocker' : 'dockeroff';
  if (!d.gpus.length) return 'nogpu';
  const c = chosen();
  if (!c) return d.catalog.count ? 'nothing' : 'nocatalog';
  return 'off';
}
