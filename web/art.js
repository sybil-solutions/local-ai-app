// The picture behind everything. One choice serves both layouts: dark when off, lit while a model runs, and part way
// while one starts. The whole picture is lit at once; nothing grows or shrinks.
import { PANEL as SIZE, s, send, store } from './state.js';

const root = document.documentElement, frame = document.querySelector('#art'), picker = document.querySelector('#picker');
// The point of each picture that is kept in view (the gap between the fingers; the heart of the cloud), where that
// point sits in the panel, and where it sits on the desktop. The fresco is shown in the panel at a scale chosen for the hands.
const PICS = { clouds: { url: '/clouds.webp', x: 1100, y: 760, w: 2000, h: 1611 }, fresco: { url: '/fresco.webp', x: 982, y: 566, w: 2000, h: 1015, k: 0.56 } };
const FIRST = 'clouds', PANEL = { y: 116, top: 368 }, DESK = [0.5, 0.36]; // the point kept in view sits in the middle of the panel, 116 down
let own = null, redraw = () => {};
export const onChange = (fn) => { redraw = fn; };
const picture = () => (root.dataset.bg === 'own' ? own : PICS[root.dataset.bg] || PICS[FIRST]);

// The picture (clouds, fresco, own or none) and its tone (gray or color) are two settings. The sky and your own
// picture start in colour, the fresco in grey. Older versions saved one value,
// 'gray' or 'color', meaning the fresco in that tone; an own picture was always in colour.
const LEGACY = { gray: ['fresco', 'gray'], color: ['fresco', 'color'] };
let applied = null; // what the picture was last set from: a snapshot that changes none of it sets nothing again
export function applyBg() {
  const from = `${s.snap?.background} ${s.snap?.tone} ${own?.url} ${SIZE.w}`;
  if (from === applied) return;
  applied = from;
  const saved = s.snap?.background || store('la-bg') || FIRST;
  const [choice, tone] = LEGACY[saved] || [saved, saved === 'fresco' ? 'gray' : 'color'];
  root.dataset.bg = choice === 'own' && !own ? FIRST : choice;
  root.dataset.tone = s.snap?.tone || store('la-tone') || tone;
  store('la-bg', choice);
  store('la-tone', root.dataset.tone);
  // Large enough to cover the panel's width on both sides of the point kept in view, however wide the panel is.
  const pic = picture(), k = Math.max(pic.k || Math.max(SIZE.w / pic.w, PANEL.top / pic.h), SIZE.w / 2 / pic.x, SIZE.w / 2 / (pic.w - pic.x));
  for (const img of frame.querySelectorAll('img')) if (img.getAttribute('src') !== pic.url) img.src = pic.url;
  root.style.setProperty('--pimg', `url("${pic.url}")`);
  root.style.setProperty('--psz', `${pic.w * k}px ${pic.h * k}px`);
  root.style.setProperty('--ppos', `${SIZE.w / 2 - pic.x * k}px ${PANEL.y - pic.y * k}px`);
  drawArt();
}

// Your own picture lives on the server; its centre is the point kept in view.
let asked = null; // the picture last asked for, so one that is loading or can't be had is not asked for again
export async function loadOwn() {
  const at = s.snap.picture;
  if (!at || own?.at === at || asked === at) return;
  asked = at;
  const res = await fetch('/api/background', { headers: { authorization: `Bearer ${s.key}` } });
  if (!res.ok) return;
  const url = URL.createObjectURL(await res.blob()), img = new Image();
  img.onload = () => { own = { at, url, x: img.width / 2, y: img.height / 2, w: img.width, h: img.height }; root.style.setProperty('--own', `url("${url}")`); applyBg(); redraw(); };
  img.src = url;
}

export function pickBg(k) {
  if (k === 'own' && (!own || root.dataset.bg === 'own')) { picker.click(); return null; }
  s.snap.background = k;
  applyBg();
  return send('settings', 'POST', { background: k });
}
export function setTone(tone) {
  s.snap.tone = tone;
  applyBg();
  return send('settings', 'POST', { tone });
}
picker.onchange = () => {
  const file = picker.files[0], img = new Image();
  picker.value = '';
  if (!file) return;
  img.onload = () => {
    const k = Math.min(1, 2400 / Math.max(img.width, img.height)), c = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * k), height: Math.round(img.height * k) });
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(img.src);
    send('settings', 'POST', { picture: c.toDataURL('image/jpeg', 0.86) }).catch((e) => { s.note = e.message; redraw(); });
  };
  img.src = URL.createObjectURL(file);
};

// Desktop: cover the window with the picture so the point kept in view lands on DESK, and light it `glow` of the way
// (0 dark, 1 lit).
export function fitArt(glow) {
  const W = frame.clientWidth, H = frame.clientHeight, [tx, ty] = DESK, pic = picture();
  if (!W || !H) return;
  const k = Math.max((W * tx) / pic.x, (W * (1 - tx)) / (pic.w - pic.x), (H * ty) / pic.y, (H * (1 - ty)) / (pic.h - pic.y));
  for (const img of frame.querySelectorAll('img')) Object.assign(img.style, { width: `${pic.w * k}px`, left: `${W * tx - pic.x * k}px`, top: `${H * ty - pic.y * k}px` });
  frame.style.setProperty('--lit', glow);
}

// With no picture chosen, the panel draws the two cut-out hands instead. They are drawn when a screen is drawn, when
// the choice changes and when the hands themselves arrive. Nothing runs in between: a page that is only being looked
// at does no work.
let hands = null;
function drawHands(c) {
  const CW = SIZE.w, CH = 128, { pose } = c.dataset, g = c.getContext('2d'), [adam, god] = hands;
  if (c.width !== Math.round(CW * 2)) { c.width = Math.round(CW * 2); c.height = CH * 2; }
  g.setTransform(2, 0, 0, 2, 0, 0);
  g.clearRect(0, 0, CW, CH);
  const apart = pose === 'apart' ? 1 : pose === 'reach' ? 1 - c.dataset.p : pose === 'broken' ? 1.3 : 0, h = 190, w = (h * 776) / 500, life = Math.max(0, Math.min(1, 1 - apart)), y = (CH - h) / 2 + (pose === 'broken' ? 12 : 0);
  g.filter = `saturate(${life}) brightness(${pose === 'broken' ? 0.3 : 0.5 + 0.5 * life})`;
  if (adam.complete) g.drawImage(adam, CW / 2 - w - apart * 46, y, w, h);
  if (god.complete) g.drawImage(god, CW / 2 + apart * 46, y, w, h);
  g.filter = 'none';
}
export function drawArt() {
  if (root.dataset.bg !== 'none') return;
  hands ||= ['/adam.webp', '/god.webp'].map((src) => Object.assign(new Image(), { onload: drawArt, src })); // fetched only once they are wanted
  document.querySelectorAll('canvas.art').forEach(drawHands);
}
