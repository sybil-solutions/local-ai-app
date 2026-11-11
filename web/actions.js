// What buttons do and what screens fetch. A button carries data-act (an entry in ACTS) and may carry data-go (the
// screen to open after). A change on the server comes back through the snapshot; nothing here redraws machine state.
import { pickBg, setTone } from './art.js';
import { markdown } from './markdown.js';
import { STATE } from './screens.js';
import { all, api, cardKey, chosen, homeCfg, isFull, outdated, picks, run, s, scoped, send, shellWindow, store } from './state.js';
import { fitWindow, layout, render } from './view.js';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const root = document.documentElement;

// What a screen fetches when it opens. An answer is used only if you haven't moved since it was asked for.
let moves = 0;
async function load(path, use) {
  const asked = moves, answer = await api(scoped(path));
  if (asked !== moves) return;
  use(answer);
  render(true);
}
// A model card is the same for everyone looking at that recipe on that machine, so it is fetched once.
async function loadCard(id) {
  const k = cardKey(id);
  if (!id || s.cards[k]) return;
  s.cards[k] = await api(scoped(`card?id=${encodeURIComponent(id)}`)).then((c) => ({ ...c, html: markdown(c.md) }), (e) => ({ error: e.message }));
  render();
}
export const LOAD = {
  usage: () => load('usage', (u) => { s.usage = u; }),
  endpoints: () => { s.ends = null; return load('endpoints', (e) => { s.ends = e; }); },
  // The list comes at once from what the server already knew; when that was an old one, the new one is fetched as soon as it is ready.
  machines: async () => {
    const got = await api('tailscale').catch(() => ({ peers: [], install: null }));
    ({ peers: s.peers, install: s.install } = got);
    render();
    if (got.stale) setTimeout(() => { if (s.nav === 'machines') LOAD.machines(); }, 1700);
  },
  logs: () => { s.logText = 'Loading'; return load(`runs/${run().id}/logs?tail=60`, (out) => { s.logText = out.text.trim() || 'Nothing was printed'; }); },
  'adv-models': () => isFull() && loadCard(s.modelOpen || chosen()?.id),
  'model-page': () => loadCard(s.modelOpen),
  'app-update': () => send('app/check').catch(() => {}),
  approve: () => load(`recipe?id=${encodeURIComponent(s.asking)}`, (recipe) => { s.look = recipe; }),
  edit: () => {
    s.draft = null;
    const view = all().find((r) => r.id === s.modelOpen);
    return load(`recipe?id=${encodeURIComponent(s.modelOpen)}`, (recipe) => {
      const L = recipe.launch, shown = (x) => (!x || /[\s"']/.test(x) ? JSON.stringify(x) : x);
      s.draft = { raw: recipe, name: view.name, engine: view.engine, local: view.local, ctx: L.ctx || 0, cards: L.cards || 1, seqs: L.seqs || 1, kv: view.kv || 'Off', args: (L.args || []).map(shown).join(' '), touched: new Set() };
    });
  },
};
// go('home') closes everything, go('back') closes one screen, anything else opens that screen.
export function go(id) {
  moves++;
  s.agentsOpen = false;
  if (id === 'home') { s.nav = null; s.trail.length = 0; return; }
  if (id === 'chooser' && isFull()) { s.agentsOpen = true; return; }
  if (id === 'back') s.nav = s.trail.pop() ?? null;
  else { if (s.nav !== id && !STATE[s.nav]) s.trail.push(s.nav); s.nav = id; }
  Promise.resolve(LOAD[s.nav]?.()).catch((e) => { s.note = e.message; render(true); }); // a screen you return to loads again
}
// Opens a section from the top bar: nothing to go back to.
export const jump = (id) => { s.trail.length = 0; s.nav = null; go(id); s.trail.length = 0; };

const stopRun = () => { const r = run(); s.opened = null; return r && !r.external ? send(scoped(`runs/${r.id}`), 'DELETE') : null; };
// A model that runs as a program on the machine, not in a container, is shown first: what it runs, and a button to
// allow it. True when that screen was opened in place of starting it.
const mustLook = (id) => { if (!all().find((r) => r.id === id)?.approve) return false; s.asking = id; s.look = null; go('approve'); return true; };
// A GPU can take a few seconds to show as free after a stop.
async function startRun(recipe, approve) {
  for (let tries = 0; ; tries++) {
    try { return await send(scoped('runs'), 'POST', { recipe, approve }); } catch (e) { if (e.status !== 409 || !/free GPU/.test(e.message) || tries >= 6) throw e; await sleep(1500); }
  }
}
// Home's layout is changed here at once and saved behind it, one save after another so the last change is the one kept.
let saving = Promise.resolve();
export const saveHome = (home) => { s.snap.home = home; saving = saving.catch(() => {}).then(() => send('settings', 'POST', { home })); return saving; };
// Arguments are shown one per word; one with spaces or quotes is shown as a JSON string, and read back the same way.
const split = (text) => (text.match(/"(?:[^"\\]|\\.)*"|\S+/g) || []).map((x) => (x.startsWith('"') ? JSON.parse(x) : x));
// Engines name the same setting differently, so an edit is written to whichever of these flags the recipe uses.
const FLAGS = { ctx: ['--max-model-len', '--context-length', '--ctx-size', '-c'], seqs: ['--max-num-seqs', '--max-running-requests', '--parallel', '-np'], cards: ['--tensor-parallel-size', '--tp-size', '--tp'] };

// Actions that only change what the page shows, or save a switch. They never wait for one another, so two switches
// pressed quickly both count. Every other action is one at a time: a second press while it runs is ignored.
export const LIGHT = new Set(['pick', 'expand', 'model', 'toggle', 'tone', 'span', 'period', 'draft', 'dismiss', 'appauto', 'copy']);
// Each gets the button's data-* values and the button. Returning 'keep' leaves the screen as it is (no redraw), and
// 'stay' says the action opened a screen itself, so the button's own data-go is not followed.
export const ACTS = {
  pick: (d) => { s.sel = d.id; },
  expand: (d) => { s.expanded = s.expanded === d.id ? null : d.id; },
  model: (d) => { s.modelOpen = d.id; },
  start: () => (mustLook(chosen().id) ? 'stay' : startRun(chosen().id)),
  // Allowed: whatever is running makes way, and the model starts with the fingerprint of what was shown.
  approve: async () => {
    const r = all().find((x) => x.id === s.asking);
    if (!r) throw new Error('This model is no longer in the list');
    await stopRun();
    s.sel = r.id;
    await startRun(r.id, r.approve);
    go('home');
    return 'stay';
  },
  stop: stopRun,
  retry: async () => { const { recipe } = run(); if (mustLook(recipe)) return 'stay'; await stopRun(); return startRun(recipe); },
  tryfast: async () => { const fast = picks()[0]; if (mustLook(fast.id)) return 'stay'; await stopRun(); s.sel = fast.id; return startRun(fast.id); },
  switch: async (d) => { if (mustLook(d.id)) return 'stay'; await stopRun(); s.sel = d.id; await startRun(d.id); go('home'); return null; },
  open: async (d) => {
    const r = run(), agent = d.agent || s.snap.agent;
    if (agent !== s.snap.agent) await send('settings', 'POST', { agent });
    const out = await send('open', 'POST', { agent, device: s.dev === -1 ? 'self' : s.dev, port: r.id, folder: s.snap.folder });
    s.opened = r.id;
    go('home');
    if (!out.opened) { s.command = out.command; go('runthis'); } else if (out.note) s.note = out.note;
  },
  default: (d) => send('settings', 'POST', { agent: d.agent }),
  agent: (d) => send('agents', 'POST', { id: d.agent }),
  updateall: () => Promise.all(outdated().map((h) => send('agents', 'POST', { id: h.id }))),
  copy: async (d, el) => {
    await navigator.clipboard.writeText(d.copy ?? el.closest('.screen').querySelector('.mono').innerText);
    el.classList.add('copied');
    setTimeout(() => el.classList.remove('copied'), 1200);
    return 'keep';
  },
  use: (d) => { s.dev = +d.dev; s.sel = s.opened = s.usage = s.ends = null; go('home'); },
  uselinked: () => ACTS.use({ dev: Math.max(-1, s.snap.devices.findIndex((x) => x.url === s.link.url)) }),
  // A machine of yours with Local AI is connected; one without gets it installed first, by this computer, over SSH.
  // The install runs on its own, so the page stays usable while it does.
  peer: (d) => {
    const link = s.link = { name: d.name }, url = `http://${d.ip}:${location.port || 18700}`;
    const connect = () => { Object.assign(s.form, { host: url, mkey: '' }); return ACTS.connect({ peer: d.name }); };
    if (d.app) return connect();
    s.nav = 'm-setup';
    send('tailscale/install', 'POST', { ip: d.ip }).then(
      () => (s.nav === 'm-setup' && s.link === link ? connect() : send('devices', 'POST', { url }).then(() => { s.note = `${d.name} is set up and connected`; })),
      (e) => { Object.assign(link, { error: e.message, manual: e.status !== 409 && !/mac/i.test(d.os) }); if (s.nav === 'm-setup' && s.link === link) s.nav = 'm-install'; else s.note = e.message; }, // the command is for Linux
    ).catch((e) => { s.note = e.message; }).finally(() => { LOAD.machines(); render(true); });
    return null;
  },
  // A connected machine that was installed from here is updated the same way: this computer sends it the new files.
  peerupdate: (d) => {
    s.note = `Updating ${d.name}`;
    send('tailscale/install', 'POST', { ip: d.ip, update: true }).then(() => { s.note = `${d.name} is up to date`; }, (e) => { s.note = e.message; }).finally(() => render(true));
  },
  connect: async (d) => {
    const typed = (s.form.host || '').trim().replace(/\/$/, ''), url = /^https?:\/\//.test(typed) ? typed : `http://${typed}${/:\d+$/.test(typed) ? '' : ':18700'}`;
    s.link = { name: d.peer || url.replace(/^https?:\/\//, ''), url };
    s.nav = 'm-connect';
    render(true);
    try {
      await send('devices', 'POST', { url, key: (s.form.mkey || '').trim() });
      for (let tries = 0; !s.snap.devices.some((x) => x.url === url); tries++) { if (tries > 40) throw new Error('It connected, but this page hasn’t heard back. Reload the page'); await sleep(200); }
      s.form.host = s.form.mkey = '';
      if (s.nav === 'm-connect') s.nav = 'm-linked';
    } catch (e) {
      s.link.error = e.message;
      if (s.nav === 'm-connect') s.nav = e.status === 401 ? 'addmachine' : 'm-fail';
      if (e.status === 401) throw e; // it needs its key typed: show the form, with why
    }
  },
  docker: () => send(scoped('docker/start')),
  key: () => { s.key = (s.form.key || '').trim(); store('key', s.key); s.needKey = false; },
  refresh: () => send(scoped('refresh')),
  bg: (d) => pickBg(d.bg),
  tone: () => setTone(root.dataset.tone === 'gray' ? 'color' : 'gray'),
  toggle: (d) => { const h = homeCfg(); return saveHome({ order: h.order, on: h.on.includes(d.k) ? h.on.filter((k) => k !== d.k) : [...h.on, d.k] }); },
  span: (d) => { s.span = d.v; },
  period: (d) => { s.period = d.v; },
  appauto: () => send('settings', 'POST', { autoUpdate: !s.snap.app.auto }),
  appupdate: () => send('app/update'),
  appcheck: () => send('app/check'),
  savetoken: async () => { await send(scoped('settings'), 'POST', { hfToken: s.form.token || '' }); s.form.token = ''; go('back'); },
  removetoken: async () => { await send(scoped('settings'), 'POST', { hfToken: '' }); go('back'); },
  draft: (d) => { s.draft[d.k] = d.k === 'kv' ? d.v : +d.v; s.draft.touched.add(d.k); },
  saveedit: async () => {
    const { raw: original, touched, ctx, seqs, cards, kv } = s.draft, recipe = structuredClone(original), L = recipe.launch, args = split(s.draft.args);
    // Writes v to whichever of these flags the recipe uses, as `--flag v` or `--flag=v`. False when it uses none of them.
    const set = (names, v) => {
      const i = args.findIndex((x) => names.includes(x.split('=')[0]));
      if (i >= 0 && args[i].includes('=')) args[i] = `${args[i].split('=')[0]}=${v}`; else if (i >= 0) args[i + 1] = String(v);
      return i >= 0;
    };
    const elsewhere = (what) => { throw new Error(`This recipe sets ${what} somewhere this screen can’t reach. Change it under Arguments`); };
    if (touched.has('ctx')) { L.ctx = ctx; const inConfig = /max_seq_len:\s*\d+/.test(L.config?.text || ''); if (inConfig) L.config.text = L.config.text.replace(/(max_seq_len:\s*)\d+/, `$1${ctx}`); if (!set(FLAGS.ctx, ctx) && !inConfig) elsewhere('its context'); }
    if (touched.has('seqs')) { L.seqs = seqs; if (!set(FLAGS.seqs, seqs)) elsewhere('requests at once'); }
    if (touched.has('cards')) { L.cards = cards; set(FLAGS.cards, cards); } // the GPUs are handed over by Docker either way
    if (touched.has('kv')) { const i = args.findIndex((x) => x.split('=')[0] === '--kv-cache-dtype'); if (i >= 0) args.splice(i, args[i].includes('=') ? 1 : 2); if (kv !== 'Off') args.push('--kv-cache-dtype', kv); }
    L.args = args;
    await send(scoped('recipes'), 'POST', recipe);
    delete s.cards[cardKey(recipe.id)];
    go('back');
  },
  resetedit: async () => { await send(scoped(`recipes?id=${encodeURIComponent(s.draft.raw.id)}`), 'DELETE'); delete s.cards[cardKey(s.draft.raw.id)]; go('back'); },
  dismiss: () => { s.note = ''; },
  // Switches between the panel and the desktop layout. In the desktop app the window changes shape with it.
  fs: async () => {
    s.full = !s.full;
    store('la-full', s.full ? '1' : '0');
    if (s.full) await fitWindow(false); // the window gets its room back before it fills the screen
    if (s.full) root.requestFullscreen?.().catch(() => {}); else if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    if (!s.full) await fitWindow(true);
    if (shellWindow) setTimeout(layout, 300); // the window has changed size; a window in the background may not say so
  },
};
