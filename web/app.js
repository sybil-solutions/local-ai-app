// Local AI. One page, two layouts drawn from the same screens: a narrow window is the panel, a wide one is the
// desktop app. This file starts the page: it listens for what you do, follows the server's snapshot, and redraws.
//   state.js     what the page knows, and which screen that calls for
//   screens.js   every screen, built from components/
//   desktop.js   the wide layout
//   view.js      drawing a screen into the page, and fitting the window
//   actions.js   what buttons do and what screens fetch
import { ACTS, go, jump, LIGHT, LOAD, saveHome } from './actions.js';
import { applyBg, loadOwn, onChange } from './art.js';
import { CTX } from './components/models.js';
import { GrowthReadout } from './components/usage.js';
import { NAV } from './desktop.js';
import { ctxOf } from './format.js';
import { api, chosen, hasRoom, homeCfg, isFull, resolve, s, send, shown } from './state.js';
import { desk, fitWindow, layout, panel, put, render } from './view.js';

const $ = (sel, el = document) => el.querySelector(sel);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const say = (e) => { s.note = e.message; render(true); };

// Presses. One listener serves every button: it runs the button's action, then opens the screen it names.
document.addEventListener('click', async (e) => {
  const day = e.target.closest('[data-cell]');
  if (day) { const box = day.closest('.usec'); $('.cal .sel', box)?.classList.remove('sel'); day.classList.add('sel'); put($('[data-readout]', box), decodeURIComponent(day.dataset.cell)); return; }
  const el = e.target.closest('[data-act], [data-go], [data-nav]');
  if (s.agentsOpen && !e.target.closest('.apop, [data-go=chooser]')) { s.agentsOpen = false; if (!el) render(true); }
  if (!el || el.disabled) return;
  const d = el.dataset, light = LIGHT.has(d.act);
  if (s.busy && !light) return;
  let keep = false, stay = false;
  if (d.act) {
    if (!light) s.busy = true;
    s.note = '';
    try { const did = await ACTS[d.act](d, el); keep = did === 'keep'; stay = did === 'stay'; } catch (err) { if (!light) s.busy = false; say(err); return; }
    if (!light) s.busy = false;
  }
  if (stay) { /* the action opened a screen itself */ } else if (d.nav) jump(d.nav); else if (d.go) go(d.go);
  if (!keep) render(true);
});
// Typing. A field keeps what is typed under its data-f name; Edit's slider and arguments go to the draft.
document.addEventListener('input', (e) => {
  const f = e.target.dataset.f;
  if (f === 'ctx') { s.draft.ctx = CTX[+e.target.value]; s.draft.touched.add('ctx'); $('[data-ctxlabel]', e.target.parentElement).textContent = `Context ${ctxOf(s.draft.ctx)}`; } else if (f === 'args') s.draft.args = e.target.value; else if (f) s.form[f] = e.target.value;
});
// A field with data-save is saved when you leave it or choose from it.
document.addEventListener('change', (e) => {
  const { save } = e.target.dataset;
  if (save === 'terminal') send('settings', 'POST', { terminal: e.target.value }).catch(say);
  if (save === 'folder') send('settings', 'POST', { folder: e.target.value.trim() }).then(() => { delete s.form.folder; }, say);
});
// Usage: a day under the pointer shows its numbers, and the growth chart's readout follows the pointer.
document.addEventListener('pointerover', (e) => { const day = e.target.closest('[data-cell]'); if (day && e.pointerType === 'mouse') day.click(); });
document.addEventListener('pointermove', (e) => {
  const chart = e.target.closest?.('.growth');
  if (!chart) return;
  const points = JSON.parse(decodeURIComponent(chart.dataset.points)), box = $('svg', chart).getBoundingClientRect();
  const i = Math.max(0, Math.min(points.length - 1, Math.round(((e.clientX - box.left) / box.width) * (points.length - 1)))), x = (i / (points.length - 1)) * 232;
  $('.gcross', chart).setAttribute('x1', x); $('.gcross', chart).setAttribute('x2', x);
  put($('[data-gread]', chart), GrowthReadout(points[i][0], points[i][1]));
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
for (const type of ['pointerup', 'pointercancel']) document.addEventListener(type, () => { if (!dragging) return; const list = dragging.parentElement; dragging.classList.remove('dragging'); dragging = null; saveOrder(list).catch(say); });
addEventListener('keydown', (e) => {
  const handle = e.target.closest?.('.grip');
  if (handle && /^Arrow(Up|Down)$/.test(e.key)) {
    e.preventDefault();
    const row = handle.closest('.hrow'), list = row.parentElement, k = handle.dataset.key;
    if (e.key === 'ArrowUp' && row.previousElementSibling) list.insertBefore(row, row.previousElementSibling);
    if (e.key === 'ArrowDown' && row.nextElementSibling) list.insertBefore(row.nextElementSibling, row);
    saveOrder(list).then(() => $(`.grip[data-key="${k}"]`, isFull() ? desk : panel)?.focus(), say);
    return;
  }
  // Desktop keys: 1 to 6 for the sections, Esc to go back, and on Home the arrows pick a model and Enter starts it.
  if (!isFull() || !s.snap || e.ctrlKey || e.metaKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  const home = !s.nav && resolve() === 'off';
  if (/^[1-6]$/.test(e.key)) jump(NAV[+e.key - 1][2]);
  else if (e.key === 'Escape') { if (s.agentsOpen) s.agentsOpen = false; else go(s.nav === 'edit' ? 'back' : 'home'); }
  else if (home && /^Arrow(Left|Right)$/.test(e.key)) { const list = shown(), i = list.findIndex((r) => r.id === chosen().id); s.sel = list[(i + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length].id; }
  else if (home && hasRoom() && e.key === 'Enter' && e.target === document.body) Promise.resolve().then(ACTS.start).catch(say);
  else return;
  render(true);
});
addEventListener('resize', layout);
onChange(() => render(true));
// Screens that show something that changes without the snapshot are fetched again while they are open.
setInterval(() => { if (s.nav === 'usage') LOAD.usage().catch(() => {}); if (s.nav === 'machines' || s.nav === 'm-install') LOAD.machines(); }, 12000);

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
fitWindow(!s.full); // the window takes the shape of the layout the page starts in
applyBg(); layout(); follow();
