// Local AI. One page, two layouts drawn from the same screens: a narrow window is the panel, a wide one is the desktop app.
// This file draws the current screen, loads what a screen needs when it opens, and does what buttons ask.
import { applyBg, fitArt, loadOwn, onChange, pickBg, setTone } from './art.js';
import { homeHtml, NAV, navBar, pageHtml } from './desktop.js';
import { CTX, lit, look, markdown, SCREENS, STATE } from './screens.js';
import { all, api, cardKey, chosen, D, hasRoom, homeCfg, isFull, PANEL, outdated, picks, resolve, run, s, scoped, send, shellWindow, shown, store } from './state.js';
import { ctxOf, fmt, notice } from './ui.js';

const $ = (sel, el = document) => el.querySelector(sel);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const root = document.documentElement, frame = $('.frame'), panel = $('.frame .screen'), desk = $('#fs');

// Drawing. A screen is redrawn only when its HTML changed, and never under someone who is typing.
const NEEDS_RUN = new Set(['chooser', 'runthis', 'logs']);
const drawn = new Map();
let drawnId = null;
function swap(el, html, id, force, scrollers) {
  const typing = el.contains(document.activeElement) && document.activeElement.matches('input, textarea, select');
  if (html === drawn.get(el) || (typing && !force && id === drawnId)) return;
  const keep = id === drawnId ? [el.scrollTop, ...[...el.querySelectorAll(scrollers)].map((e) => e.scrollTop)] : [];
  el.innerHTML = html;
  drawn.set(el, html);
  el.scrollTop = keep[0] || 0;
  el.querySelectorAll(scrollers).forEach((e, i) => { e.scrollTop = keep[i + 1] || 0; });
}
function render(force) {
  try { paint(force); } catch (e) { if (!s.nav) throw e; go('home'); paint(true); } // a screen whose data vanished closes
}
function paint(force) {
  if (s.nav && (!s.snap || !D() || (NEEDS_RUN.has(s.nav) && !run()))) s.nav = null;
  const state = resolve(), id = s.nav || state, wide = isFull(), glow = lit(look(state));
  root.classList.toggle('wide', wide);
  if (wide) {
    const page = s.nav || (state === 'key' ? 'key' : null);
    desk.classList.toggle('paged', !!page);
    swap($('#ui'), `${navBar(page)}${page ? '' : homeHtml(state)}${notice()}`, id, force, '.apop');
    swap($('#page'), page ? pageHtml(page) : '', id, force, '.mlist,.mright');
    fitArt(glow);
  } else {
    swap(panel, SCREENS[id]() + notice(), id, force, '.scroll');
    const picture = $('canvas.art', panel);
    panel.style.setProperty('--pr', `${picture ? lit(picture.dataset) * 460 : 0}px`);
    const lower = picture ? picture.offsetTop - 52 : 0; // the picture sits where its block is; 52 is where the first block starts
    panel.style.setProperty('--py', `${lower}px`);
    panel.classList.toggle('lowpic', lower > 0);
    fitPanel();
  }
  drawnId = id;
}
// The height the panel's screen needs to show all of itself, in panel units: every part at its own height, a scrolling
// part at the height of what is in it.
function natural() {
  const style = getComputedStyle(panel), parts = [...panel.children].filter((el) => getComputedStyle(el).position !== 'absolute');
  const tall = (el) => (el.classList.contains('sp') ? 0 : !el.classList.contains('scroll') ? el.offsetHeight
    : el.lastElementChild ? el.lastElementChild.offsetTop + el.lastElementChild.offsetHeight - el.firstElementChild.offsetTop : 0);
  return Math.ceil(parts.reduce((n, el) => n + tall(el), 0) + (parseFloat(style.rowGap) || 0) * (parts.length - 1) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom));
}
// In the desktop app the panel's window follows Home: it grows when Home shows more and shrinks back when it shows
// less, so nothing is cut off. Other screens keep the height Home had, so the window does not jump as you move about.
let fitted = PANEL.h;
function fitPanel() {
  if (!shellWindow || s.full || s.nav || !panel.firstElementChild) return;
  const want = Math.max(PANEL.h, natural());
  if (Math.abs(want - fitted) < 2) return;
  fitted = want;
  shellWindow.compact(true, want, PANEL.w);
}
// The panel is drawn in its own units and scaled to the window, up to one and a half times.
function layout() {
  const k = Math.min(innerWidth / PANEL.w, innerHeight / (shellWindow && !s.full ? fitted : PANEL.h), 1.5);
  Object.assign(frame.style, { transform: `scale(${k})`, left: `${(innerWidth - PANEL.w * k) / 2}px` });
  panel.style.height = `${innerHeight / k}px`;
  render(true);
}

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
const LOAD = {
  usage: () => load('usage', (u) => { s.usage = u; }),
  endpoints: () => { s.ends = null; return load('endpoints', (e) => { s.ends = e; }); },
  machines: async () => { ({ peers: s.peers, install: s.install } = await api('tailscale').catch(() => ({ peers: [], install: null }))); render(); },
  logs: () => { s.logText = 'Loading'; return load(`runs/${run().id}/logs?tail=60`, (out) => { s.logText = out.text.trim() || 'Nothing was printed'; }); },
  'adv-models': () => isFull() && loadCard(s.modelOpen || chosen()?.id),
  'model-page': () => loadCard(s.modelOpen),
  'app-update': () => send('app/check').catch(() => {}),
  edit: () => {
    s.draft = null;
    const view = all().find((r) => r.id === s.modelOpen);
    return load(`recipe?id=${encodeURIComponent(s.modelOpen)}`, (raw) => {
      const L = raw.launch, shown = (x) => (!x || /[\s"']/.test(x) ? JSON.stringify(x) : x);
      s.draft = { raw, name: view.name, engine: view.engine, local: view.local, ctx: L.ctx || 0, cards: L.cards || 1, seqs: L.seqs || 1, kv: view.kv || 'Off', args: (L.args || []).map(shown).join(' '), touched: new Set() };
    });
  },
};
// go('home') closes everything, go('back') closes one screen, anything else opens that screen.
function go(id) {
  moves++;
  s.agentsOpen = false;
  if (id === 'home') { s.nav = null; s.trail.length = 0; return; }
  if (id === 'chooser' && isFull()) { s.agentsOpen = true; return; }
  if (id === 'back') s.nav = s.trail.pop() ?? null;
  else { if (s.nav !== id && !STATE[s.nav]) s.trail.push(s.nav); s.nav = id; }
  Promise.resolve(LOAD[s.nav]?.()).catch((e) => { s.note = e.message; render(true); }); // a screen you return to loads again
}
const jump = (id) => { s.trail.length = 0; s.nav = null; go(id); s.trail.length = 0; };
setInterval(() => { if (s.nav === 'usage') LOAD.usage().catch(() => {}); if (s.nav === 'machines' || s.nav === 'm-install') LOAD.machines(); }, 12000);

// What buttons do. Each gets the button's data-* values; a server change comes back through the snapshot.
const stopRun = () => { const r = run(); s.opened = null; return r && !r.external ? send(scoped(`runs/${r.id}`), 'DELETE') : null; };
// A GPU can take a few seconds to show as free after a stop.
async function startRun(recipe) {
  for (let tries = 0; ; tries++) {
    try { return await send(scoped('runs'), 'POST', { recipe }); } catch (e) { if (e.status !== 409 || !/free GPU/.test(e.message) || tries >= 6) throw e; await sleep(1500); }
  }
}
const saveHome = (home) => { s.snap.home = home; return send('settings', 'POST', { home }); };
// Arguments are shown one per word; one with spaces or quotes is shown as a JSON string, and read back the same way.
const split = (text) => (text.match(/"(?:[^"\\]|\\.)*"|\S+/g) || []).map((x) => (x.startsWith('"') ? JSON.parse(x) : x));
// Engines name the same setting differently, so an edit is written to whichever of these flags the recipe uses.
const FLAGS = { ctx: ['--max-model-len', '--context-length', '--ctx-size', '-c'], seqs: ['--max-num-seqs', '--max-running-requests', '--parallel', '-np'], cards: ['--tensor-parallel-size', '--tp-size', '--tp'] };
const ACTS = {
  pick: (d) => { s.sel = d.id; },
  expand: (d) => { s.expanded = s.expanded === d.id ? null : d.id; },
  model: (d) => { s.modelOpen = d.id; },
  start: () => startRun(chosen().id),
  stop: stopRun,
  retry: async () => { const { recipe } = run(); await stopRun(); await startRun(recipe); },
  tryfast: async () => { const fast = picks()[0]; await stopRun(); s.sel = fast.id; await startRun(fast.id); },
  switch: async (d) => { await stopRun(); s.sel = d.id; await startRun(d.id); go('home'); },
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
    await navigator.clipboard.writeText(d.copy ?? $('.mono', el.closest('.screen')).innerText);
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
      (e) => { Object.assign(link, { error: e.message, manual: !/mac/i.test(d.os) }); if (s.nav === 'm-setup' && s.link === link) s.nav = 'm-install'; else s.note = e.message; }, // the command is for Linux
    ).catch((e) => { s.note = e.message; }).finally(() => { LOAD.machines(); render(true); });
    return null;
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
    const { raw, touched, ctx, seqs, cards, kv } = s.draft, recipe = structuredClone(raw), L = recipe.launch, args = split(s.draft.args);
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
  fs: async () => {
    s.full = !s.full;
    store('la-full', s.full ? '1' : '0');
    if (s.full) await shellWindow?.compact(false); // the window gets its room back before it fills the screen
    if (s.full) root.requestFullscreen?.().catch(() => {}); else if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    if (!s.full) { fitted = PANEL.h; await shellWindow?.compact(true, fitted, PANEL.w); }
    if (shellWindow) setTimeout(layout, 300); // the window has changed size; a window in the background may not say so
  },
};

document.addEventListener('click', async (e) => {
  const day = e.target.closest('[data-cell]');
  if (day) { const box = day.closest('.usec'); $('.cal .sel', box)?.classList.remove('sel'); day.classList.add('sel'); $('[data-readout]', box).innerHTML = decodeURIComponent(day.dataset.cell); return; }
  const el = e.target.closest('[data-act], [data-go], [data-nav]');
  if (s.agentsOpen && !e.target.closest('.apop, [data-go=chooser]')) { s.agentsOpen = false; if (!el) render(true); }
  if (!el || el.disabled || s.busy) return;
  const d = el.dataset;
  let keep = false;
  if (d.act) {
    s.busy = true; s.note = '';
    try { keep = (await ACTS[d.act](d, el)) === 'keep'; } catch (err) { s.note = err.message; s.busy = false; render(true); return; }
    s.busy = false;
  }
  if (d.nav) jump(d.nav); else if (d.go) go(d.go);
  if (!keep) render(true);
});
document.addEventListener('input', (e) => {
  const f = e.target.dataset.f;
  if (f === 'ctx') { s.draft.ctx = CTX[+e.target.value]; s.draft.touched.add('ctx'); $('[data-ctxlabel]', e.target.parentElement).textContent = `Context ${ctxOf(s.draft.ctx)}`; } else if (f === 'args') s.draft.args = e.target.value; else if (f) s.form[f] = e.target.value;
});
document.addEventListener('change', (e) => {
  if (e.target.dataset.save === 'terminal') send('settings', 'POST', { terminal: e.target.value }).catch((err) => { s.note = err.message; render(true); });
  if (e.target.dataset.save === 'folder') send('settings', 'POST', { folder: e.target.value.trim() }).then(() => { delete s.form.folder; }, (err) => { s.note = err.message; render(true); });
});
document.addEventListener('pointerover', (e) => { const day = e.target.closest('[data-cell]'); if (day && e.pointerType === 'mouse') day.click(); });
// The growth chart's readout follows the pointer.
document.addEventListener('pointermove', (e) => {
  const chart = e.target.closest?.('.growth');
  if (!chart) return;
  const points = JSON.parse(decodeURIComponent(chart.dataset.points)), box = $('svg', chart).getBoundingClientRect();
  const i = Math.max(0, Math.min(points.length - 1, Math.round(((e.clientX - box.left) / box.width) * (points.length - 1)))), x = (i / (points.length - 1)) * 232;
  $('.gcross', chart).setAttribute('x1', x); $('.gcross', chart).setAttribute('x2', x);
  $('[data-gread]', chart).innerHTML = `<b>${points[i][0]}</b><span>${fmt(points[i][1])} tokens so far</span>`;
});
// Home screen order: drag a row by its handle, or focus the handle and use the arrow keys.
let dragging = null;
const saveOrder = (list) => saveHome({ order: [...list.querySelectorAll('.hrow')].map((r) => r.dataset.key), on: homeCfg().on }).then(() => render(true));
document.addEventListener('pointerdown', (e) => { const handle = e.target.closest('.grip'); if (!handle) return; e.preventDefault(); dragging = handle.closest('.hrow'); dragging.classList.add('dragging'); });
document.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const over = [...dragging.parentElement.querySelectorAll('.hrow')].find((r) => { const box = r.getBoundingClientRect(); return r !== dragging && e.clientY > box.top && e.clientY < box.bottom; });
  if (over) { const box = over.getBoundingClientRect(); dragging.parentElement.insertBefore(dragging, e.clientY < box.top + box.height / 2 ? over : over.nextSibling); }
});
for (const type of ['pointerup', 'pointercancel']) document.addEventListener(type, () => { if (!dragging) return; const list = dragging.parentElement; dragging.classList.remove('dragging'); dragging = null; saveOrder(list); });
addEventListener('keydown', (e) => {
  const handle = e.target.closest?.('.grip');
  if (handle && /^Arrow(Up|Down)$/.test(e.key)) {
    e.preventDefault();
    const row = handle.closest('.hrow'), list = row.parentElement, k = handle.dataset.key;
    if (e.key === 'ArrowUp' && row.previousElementSibling) list.insertBefore(row, row.previousElementSibling);
    if (e.key === 'ArrowDown' && row.nextElementSibling) list.insertBefore(row.nextElementSibling, row);
    saveOrder(list).then(() => $(`.grip[data-key="${k}"]`, isFull() ? desk : panel)?.focus());
    return;
  }
  // Desktop keys: 1 to 6 for the sections, Esc to go back, and on Home the arrows pick a model and Enter starts it.
  if (!isFull() || !s.snap || e.ctrlKey || e.metaKey || e.altKey || /INPUT|TEXTAREA/.test(e.target.tagName)) return;
  const home = !s.nav && resolve() === 'off' && hasRoom();
  if (/^[1-6]$/.test(e.key)) jump(NAV[+e.key - 1][2]);
  else if (e.key === 'Escape') { if (s.agentsOpen) s.agentsOpen = false; else go(s.nav === 'edit' ? 'back' : 'home'); }
  else if (home && /^Arrow(Left|Right)$/.test(e.key)) { const list = shown(), i = list.findIndex((r) => r.id === chosen().id); s.sel = list[(i + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length].id; }
  else if (home && e.key === 'Enter' && e.target === document.body) ACTS.start().catch((err) => { s.note = err.message; render(true); });
  else return;
  render(true);
});
addEventListener('resize', layout);
onChange(() => render(true));

// The snapshot is long-polled: each answer is a full picture of the machine, and the page redraws from it.
async function follow() {
  for (;;) {
    let lost = false;
    try {
      const next = await api(`state?v=${s.version}`);
      if (!next.v) { await sleep(500); continue; } // the server has not drawn its first snapshot yet
      if (s.snap && next.app.started !== s.snap.app.started) location.reload(); // the server restarted, so this page's code may be old
      Object.assign(s, { version: next.v, snap: next, online: true, needKey: false });
      if (s.dev !== -1 && !next.devices[s.dev]) s.dev = -1;
    } catch (e) {
      lost = true;
      if (e.status === 401) s.needKey = true; else s.online = false;
    }
    try { if (s.snap) { applyBg(); loadOwn(); } render(); } catch (e) { console.error(e); } // a screen that can't draw must not stop the polling
    if (lost) await sleep(1500);
  }
}
if (!s.full) shellWindow?.compact(true, fitted, PANEL.w); // a window that was left showing the panel opens fitted to it
applyBg(); layout(); follow();
