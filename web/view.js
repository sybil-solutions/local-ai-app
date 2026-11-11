// Drawing: which screen is shown, in which layout, and the window that fits it.
import { fitArt } from './art.js';
import { Notice } from './components/layout.js';
import { DeskHome, DeskPage, NavBar } from './desktop.js';
import { html } from './html.js';
import { lit, look, SCREENS } from './screens.js';
import { D, homeCfg, isFull, PANEL, resolve, run, s, shellWindow } from './state.js';

const $ = (sel, el = document) => el.querySelector(sel);
const root = document.documentElement, frame = $('.frame');
export const panel = $('.frame .screen'), desk = $('#fs');

// The one place markup is put into the page. Everything given to it was built with `html`, so it is this app's own.
export const put = (el, markup) => { el.innerHTML = String(markup); };
// A part of the page is rewritten only when its markup changed, and never under someone who is typing in it.
const drawn = new Map();
let drawnId = null;
function swap(el, markup, id, force, scrollers) {
  const text = String(markup), typing = el.contains(document.activeElement) && document.activeElement.matches('input, textarea, select');
  if (text === drawn.get(el) || (typing && !force && id === drawnId)) return;
  const keep = id === drawnId ? [el.scrollTop, ...[...el.querySelectorAll(scrollers)].map((e) => e.scrollTop)] : [];
  put(el, text);
  drawn.set(el, text);
  el.scrollTop = keep[0] || 0;
  el.querySelectorAll(scrollers).forEach((e, i) => { e.scrollTop = keep[i + 1] || 0; });
}

const NEEDS_RUN = new Set(['chooser', 'runthis', 'logs']);
function paint(force) {
  if (s.nav && (!s.snap || !D() || (NEEDS_RUN.has(s.nav) && !run()))) s.nav = null;
  const state = resolve(), id = s.nav || state, wide = isFull();
  root.classList.toggle('wide', wide);
  if (wide) {
    const page = s.nav || (state === 'key' ? 'key' : null);
    desk.classList.toggle('paged', !!page);
    desk.classList.toggle('nopic', !page && !!s.snap && !!D() && !homeCfg().on.includes('hands')); // Home without its Picture block
    swap($('#ui'), html`${NavBar(page)}${!page && DeskHome(state)}${Notice()}`, id, force, '.apop');
    swap($('#page'), page ? DeskPage(page) : '', id, force, '.mlist,.mright');
    fitArt(lit(look(state)));
  } else {
    swap(panel, html`${SCREENS[id]()}${Notice()}`, id, force, '.scroll');
    const picture = $('canvas.art', panel), lower = picture ? picture.offsetTop - 52 : 0; // the picture sits where its block is; 52 is where the first block starts
    panel.style.setProperty('--pr', `${picture ? lit(picture.dataset) * 460 : 0}px`);
    panel.style.setProperty('--py', `${lower}px`);
    panel.classList.toggle('lowpic', lower > 0);
    fitPanel();
  }
  drawnId = id;
}
// A window nobody can see is not redrawn every time the machine's numbers move: it is drawn once, when it is looked
// at again.
let unseen = false;
document.addEventListener('visibilitychange', () => { if (!document.hidden && unseen) render(true); });

// A screen whose data vanished (the model it was about stopped, say) closes instead of leaving the page blank. A
// connected machine whose snapshot can't be drawn at all is left for this computer, with a line saying so.
export function render(force) {
  unseen = !!document.hidden;
  if (unseen) return;
  try { paint(force); } catch (e) {
    if (!s.nav && s.dev === -1) throw e;
    if (!s.nav) { s.note = `${s.snap?.devices[s.dev]?.name || 'That machine'} sent something Local AI can’t show`; s.dev = -1; }
    s.nav = null; s.trail.length = 0;
    paint(true);
  }
}

// The height the panel's screen needs to show all of itself, in panel units: every part at its own height, a
// scrolling part at the height of what is in it.
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
// Asks the window for the panel's shape (the least height, until Home says it needs more) or for its room back.
export function fitWindow(compact) {
  fitted = PANEL.h;
  return shellWindow?.compact(compact, fitted, PANEL.w);
}
// The panel is drawn in its own units and scaled to the window, up to one and a half times.
export function layout() {
  const k = Math.min(innerWidth / PANEL.w, innerHeight / (shellWindow && !s.full ? fitted : PANEL.h), 1.5);
  Object.assign(frame.style, { transform: `scale(${k})`, left: `${(innerWidth - PANEL.w * k) / 2}px` });
  panel.style.height = `${innerHeight / k}px`;
  render(true);
}
