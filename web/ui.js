// The small pieces every screen is built from. Each returns a string of HTML.
import { canFull, D, here, s } from './state.js';

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmt = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : n >= 1000 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n || 0)));
export const ctxOf = (n) => (n >= 1048576 ? `${Math.round(n / 1048576)}M` : n ? `${Math.round(n / 1024)}K` : '—');
export const mins = (seconds) => Math.max(1, Math.round(seconds / 60));
export const ago = (when) => { const m = Math.round((Date.now() - new Date(when)) / 60000); return m < 1 ? 'Now' : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };

const LINE = 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
const svg = (d, size = 16, paint = LINE) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" ${paint} aria-hidden="true">${d}</svg>`;
const ICONS = {
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  right: '<path d="M9 6l6 6-6 6"/>',
  left: '<path d="M15 6l-6 6 6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  grow: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  shrink: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  vision: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  think: '<path d="M9 18h6M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/>',
  tools: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  kv: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
  gpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M15 2v2M9 2v2M15 20v2M9 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/>',
};
export const icon = (name, size) => svg(ICONS[name], size);
export const grip = svg('<circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/>', 14, 'fill="currentColor"');

// What a model can do, as small icons (list rows) or as icons with their names (the model's own page).
const CAPS = [['vision', 'Vision', (r) => r.vision], ['think', 'Thinking', (r) => r.think], ['tools', 'Tool calls', (r) => r.tools], ['kv', 'KV cache', (r) => r.kv], ['gpu', 'GPUs', (r) => r.cards > 1 && r.cards]];
const capsOf = (r) => CAPS.map(([k, name, has]) => [k, name, has(r)]).filter((c) => c[2]);
export const caps = (r) => capsOf(r).map(([k, name, v]) => {
  const tip = `${name}${v === true ? '' : `: ${esc(v)}`}`, ic = `<span class="ic" role="img" aria-label="${tip}" title="${tip}">${icon(k, 14)}</span>`;
  return k === 'gpu' ? `<span class="ics" style="gap:0">${ic}<span class="icn">${v}</span></span>` : ic;
}).join('');
export const capNames = (r) => capsOf(r).map(([k, name, v]) => `<span class="cap">${icon(k, 14)}${k === 'gpu' ? `${v} GPUs` : v === true ? name : `${name} ${esc(v)}`}</span>`).join('');

// b() goes to another screen; a() does something. Both may carry extra data-* attributes.
export const b = (label, go, cls = '', extra = '') => `<button class="btn ${cls}" data-go="${go}" ${extra}>${label}</button>`;
export const a = (label, act, cls = '', extra = '') => `<button class="btn ${cls}" data-act="${act}" ${extra}>${label}</button>`;
export const bar = (pct) => `<div class="bar"><i style="width:${Math.max(0, Math.min(100, pct)).toFixed(1)}%"></i></div>`;
export const toggle = (on, attrs, label) => `<button class="switch${on ? ' on' : ''}" role="switch" aria-checked="${on}" aria-label="${label}" ${attrs}></button>`;
export const left = (text) => `<div class="line" style="text-align:left">${text}</div>`;
export const item = (name, go) => `<button class="item" data-go="${go}">${name}<small>${icon('right', 14)}</small></button>`;
export const kv = (rows) => rows.map(([k, v]) => `<span class="label">${k}</span><b>${v}</b>`).join('');
const stat = (label, value, live) => `<div class="stat${live ? ' live' : ''}"><b>${fmt(value)}</b><span class="label">${label}</span></div>`;

// The picture and the words under it. pose is apart, reach (p of the way), touch, work or broken.
export const art = (pose, p = 0) => `<canvas class="art" data-pose="${pose}" data-p="${p}" aria-hidden="true"></canvas>`;
export const status = (pose, word, line = '', p = 0) => `${art(pose, p)}<div class="word">${esc(word)}</div><div class="line">${esc(line)}</div>`;

export const fsBtn = () => (canFull() ? `<button data-act="fs" aria-label="${s.full ? 'Exit fullscreen' : 'Fullscreen'}" title="${s.full ? 'Exit fullscreen' : 'Fullscreen'}">${icon(s.full ? 'shrink' : 'grow')}</button>` : '');
const bare = '<div class="top"><span class="mark">Local AI</span></div>';
export const menu = () => (s.snap
  ? `<div class="top"><button class="mark chip" data-go="machines" aria-label="Machine: ${esc(here())}"><i></i><span class="who">${esc(here())}</span></button><span class="topr chip">${fsBtn()}<button data-go="settings" aria-label="Settings" title="Settings">${icon('menu')}</button></span></div>`
  : bare);
export const close = (go = 'back') => `<div class="top"><span class="mark">Local AI</span><button class="x" data-go="${go}" aria-label="Close">${icon('close')}</button></div>`;
export const notice = () => (s.note ? `<button class="notice" data-act="dismiss" title="Dismiss">${esc(s.note)}</button>` : '');

export const running = (r) => `<div class="stats">${stat('Decode tok/s', r.stats?.tps || 0, true)}${stat('Prefill tok/s', r.stats?.pps || 0)}${stat('Session tokens', r.stats?.used || 0)}<button class="linkstat" data-go="usage">${stat('Lifetime tokens', D().usage.all)}</button></div>`;
export const meta = (r) => [r.released && new Date(`${r.released}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', year: 'numeric' }), r.engine, ctxOf(r.ctx)].filter(Boolean).join(' · ');
// A model's numbers. The desktop page has room for two more rows; the panel names the engine instead.
export const facts = (r, wide) => [
  ['Intelligence', r.smart === null ? '—' : Math.round(r.smart)], ['C1 speed', r.speed.c1 ? `${Math.round(r.speed.c1)} tok/s` : '—'], ['Context', ctxOf(r.ctx)],
  ...(wide ? [['Requests at once', r.seqs], ['GPUs', r.cards]] : [['Engine', esc(r.engine)]]), ['KV cache', esc(r.kv || '—')], ['Download', r.sizeGb ? `${Math.round(r.sizeGb)} GB` : '—'],
];
export const vfoot = () => {
  const v = s.snap.app;
  const right = v.latest ? `<button data-go="app-update">Update${/^\d/.test(v.latest) ? ` to ${esc(v.latest)}` : ''}</button>` : v.can ? '<span>Up to date</span>' : '';
  return `<div class="vfoot"><button class="vname" data-go="app-update">Local AI ${esc(v.version)}</button>${right}</div>`;
};
