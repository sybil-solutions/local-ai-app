// The picture behind everything. One choice lights both layouts: dark when off, lit outward from one point as a model starts.
import { PANEL as SIZE, s, send, store } from './state.js';

const root = document.documentElement, frame = document.querySelector('#art'), picker = document.querySelector('#picker');
// Where the light starts in each picture (the gap between the fingers; the dove), where that point sits
// in the panel, and where it sits on the desktop. The fresco is shown in the panel at a scale chosen for the hands.
const PICS = { clouds: { url: '/clouds.webp', x: 1100, y: 760, w: 2000, h: 1611 }, fresco: { url: '/fresco.webp', x: 982, y: 566, w: 2000, h: 1015, k: 0.56 } };
const FIRST = 'clouds', PANEL = { x: SIZE.w / 2, y: 116, top: 368 }, DESK = [0.5, 0.36], HIGHEST = 0.2; // DESK: where the heart sits, as parts of the window; HIGHEST: as far up as it moves
let own = null, redraw = () => {};
export const onChange = (fn) => { redraw = fn; };
const picture = () => (root.dataset.bg === 'own' ? own : PICS[root.dataset.bg] || PICS[FIRST]);

// The picture (clouds, fresco, own or none) and its tone (gray or color) are two settings. The sky and your own
// picture start in colour, the fresco in grey. Older versions saved one value,
// 'gray' or 'color', meaning the fresco in that tone; an own picture was always in colour.
const LEGACY = { gray: ['fresco', 'gray'], color: ['fresco', 'color'] };
export function applyBg() {
  const saved = s.snap?.background || store('la-bg') || FIRST;
  const [choice, tone] = LEGACY[saved] || [saved, saved === 'fresco' ? 'gray' : 'color'];
  root.dataset.bg = choice === 'own' && !own ? FIRST : choice;
  root.dataset.tone = s.snap?.tone || store('la-tone') || tone;
  store('la-bg', choice);
  store('la-tone', root.dataset.tone);
  const pic = picture(), k = pic.k || Math.max(SIZE.w / pic.w, PANEL.top / pic.h);
  for (const img of frame.querySelectorAll('img')) if (img.getAttribute('src') !== pic.url) img.src = pic.url;
  root.style.setProperty('--pimg', `url("${pic.url}")`);
  root.style.setProperty('--psz', `${pic.w * k}px ${pic.h * k}px`);
  root.style.setProperty('--ppos', `${PANEL.x - pic.x * k}px ${PANEL.y - pic.y * k}px`);
}

// Your own picture lives on the server; its centre plays the part of the fingertips.
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

// Desktop: cover the window with the picture so its heart (the dove, the fingertips) lands on DESK, and light it out
// to `glow` of the way. `room` is the part of the window Home leaves free ({ top, bottom }, in pixels): when Home
// shows more (the usage and GPU widgets) the heart moves up to the middle of what is left, so nothing sits on it.
export function fitArt(glow, room) {
  const W = frame.clientWidth, H = frame.clientHeight, [tx, lowest] = DESK, pic = picture();
  if (!W || !H) return;
  const ty = room ? Math.max(HIGHEST, Math.min(lowest, (room.top + room.bottom) / 2 / H)) : lowest;
  const k = Math.max((W * tx) / pic.x, (W * (1 - tx)) / (pic.w - pic.x), (H * ty) / pic.y, (H * (1 - ty)) / (pic.h - pic.y));
  for (const img of frame.querySelectorAll('img')) Object.assign(img.style, { width: `${pic.w * k}px`, left: `${W * tx - pic.x * k}px`, top: `${H * ty - pic.y * k}px` });
  frame.style.setProperty('--gx', `${W * tx}px`);
  frame.style.setProperty('--gy', `${H * ty}px`);
  frame.style.setProperty('--r', `${glow * Math.hypot(W, H) * 1.15}px`);
}

// With no picture chosen, the panel draws the two cut-out hands instead.
const adam = Object.assign(new Image(), { src: '/adam.webp' }), god = Object.assign(new Image(), { src: '/god.webp' });
function drawHands(c, t) {
  const CW = SIZE.w, CH = 128, { pose } = c.dataset, g = c.getContext('2d');
  if (c.width !== CW * 2) { c.width = CW * 2; c.height = CH * 2; }
  g.setTransform(2, 0, 0, 2, 0, 0);
  g.clearRect(0, 0, CW, CH);
  const apart = pose === 'apart' ? 1 : pose === 'reach' ? 1 - c.dataset.p : pose === 'broken' ? 1.3 : 0, h = 190, w = (h * 776) / 500, life = Math.max(0, Math.min(1, 1 - apart)), y = (CH - h) / 2 + (pose === 'broken' ? 12 : 0);
  g.filter = `saturate(${life}) brightness(${pose === 'broken' ? 0.3 : 0.5 + 0.5 * life})`;
  if (adam.complete) g.drawImage(adam, CW / 2 - w - apart * 46, y, w, h);
  if (god.complete) g.drawImage(god, CW / 2 + apart * 46, y, w, h);
  g.filter = 'none';
}
(function loop(t) {
  if (root.dataset.bg === 'none') document.querySelectorAll('canvas.art').forEach((c) => drawHands(c, t));
  requestAnimationFrame(loop);
})(0);
