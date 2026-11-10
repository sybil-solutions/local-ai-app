// Local AI. One page, two layouts drawn from the same screens: a narrow window is the panel, a wide one is the desktop app.
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const fmt = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : n >= 1000 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n || 0)));
const ctxOf = (n) => (n >= 1048576 ? `${Math.round(n / 1048576)}M` : n ? `${Math.round(n / 1024)}K` : '—');
const mins = (seconds) => Math.max(1, Math.round(seconds / 60));
const ago = (when) => { const m = Math.round((Date.now() - new Date(when)) / 60000); return m < 1 ? 'Now' : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
const newer = (a, b) => a.localeCompare(b, 'en', { numeric: true }) > 0;
const store = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } return v; };
const root = document.documentElement, frame = $('.frame'), screen = $('.frame .screen'), fs = $('#fs'), art = $('#art'), picker = $('#picker');

let key = $('meta[name=key]').content;
if (!key || key === '__KEY__') key = store('key') || '';
async function api(path, options = {}) {
  const res = await fetch(`/api/${path}`, { ...options, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}
const send = (path, method = 'POST', body) => api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

// What the server last said, and the little the page remembers on its own.
let snap = null, online = true, needKey = false, version = 0, dev = -1;
let nav = null, sel = null, expanded = null, modelOpen = null, opened = null, command = '', note = '', busy = false, agentsOpen = false;
let period = 'days', uspan = 'all', usage = null, ends = null, peers = null, logText = '', draft = null, link = null, installCmd = null, full = store('la-full') !== '0';
const trail = [], form = {}, cards = {};
const scoped = (path) => (dev === -1 ? path : `devices/${dev}/${path}`);
const D = () => (dev === -1 ? snap : snap.devices[dev]?.state);
const here = () => (dev === -1 ? snap.name : snap.devices[dev]?.name || snap.name);
const TIERS = [['fastest', 'Fast'], ['balanced', 'Balanced'], ['smartest', 'Smart']];
const all = () => D().groups.flatMap((g) => g.recipes).sort((a, b) => (b.released || '').localeCompare(a.released || ''));
const group = () => [...D().groups].sort((a, b) => b.recipes.length - a.recipes.length)[0];
function picks() {
  const g = group(), seen = new Set();
  return TIERS.map(([k, name]) => g?.tiers[k] && { ...g.tiers[k], tier: name }).filter((r) => r && !seen.has(r.id) && seen.add(r.id));
}
const run = () => D().runs.find((r) => r.phase !== 'failed') || D().runs[0] || null;
function chosen() {
  const list = all(), three = picks(), r = run();
  const id = r?.recipe ?? [sel, D().last].find((x) => list.some((y) => y.id === x)) ?? (three.find((x) => x.tier === 'Balanced') || three[0] || list[0])?.id;
  return list.find((x) => x.id === id) || null;
}
const shown3 = () => { const three = picks(), c = chosen(); return c && !three.some((r) => r.id === c.id) ? [...three, c] : three; };
const agentName = () => snap.harnesses.find((h) => h.id === snap.harness && h.installed)?.name;
const outdated = () => snap.harnesses.filter((h) => h.installed && h.version && h.latest && newer(h.latest, h.version) && h.job?.phase !== 'running');
const homeCfg = () => snap.home || { order: ['hands', 'models', 'stats', 'usage', 'gpus'], on: ['hands', 'models', 'stats'] };
const HOME = () => homeCfg().order.filter((k) => homeCfg().on.includes(k));
const gpuLine = (d) => (d?.gpus.length ? `${d.gpus.length}× ${(d.groups[0]?.name || 'GPU').replace(/^(NVIDIA|GeForce) /g, '')}` : 'No GPU');
const canFull = () => innerWidth >= 640, isFull = () => full && canFull();

// Small pieces every screen is built from.
const svg = (d, size = 16, extra = 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"') => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" ${extra} aria-hidden="true">${d}</svg>`;
const menuIcon = svg('<path d="M4 7h16M4 12h16M4 17h16"/>'), closeIcon = svg('<path d="M6 6l12 12M18 6L6 18"/>');
const gripIcon = svg('<circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/>', 14, 'fill="currentColor"');
const I = {
  vision: ['<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>', 'Vision'],
  think: ['<path d="M9 18h6M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/>', 'Thinking'],
  tools: ['<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>', 'Tool calls'],
  kv: ['<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>', 'KV cache'],
  gpu: ['<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M15 2v2M9 2v2M15 20v2M9 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/>', 'GPUs'],
};
const icon = (k, extra = '') => `<span class="ic" role="img" aria-label="${I[k][1]}${extra}" title="${I[k][1]}${extra}">${svg(I[k][0], 14)}</span>`;
const caps = (r) => [r.vision && icon('vision'), r.think && icon('think'), r.tools && icon('tools'), r.kv && icon('kv', `: ${esc(r.kv)}`), r.cards > 1 && `<span class="ics" style="gap:0">${icon('gpu', `: ${r.cards}`)}<span class="icn">${r.cards}</span></span>`].filter(Boolean).join('');
const b = (label, go, cls = '', extra = '') => `<button class="btn ${cls}" data-go="${go}" ${extra}>${label}</button>`;
const a = (label, act, cls = '', extra = '') => `<button class="btn ${cls}" data-act="${act}" ${extra}>${label}</button>`;
const bar = (pct) => `<div class="bar"><i style="width:${Math.max(0, Math.min(100, pct)).toFixed(1)}%"></i></div>`;
const sw = (on, attrs, label) => `<button class="switch${on ? ' on' : ''}" role="switch" aria-checked="${on}" aria-label="${label}" ${attrs}></button>`;
const left = (text) => `<div class="line" style="text-align:left">${text}</div>`;
const item = (name, go, note = '›') => `<button class="item" data-go="${go}">${name}<small>${note}</small></button>`;
const art_ = (pose, p = 0) => `<canvas class="art" data-pose="${pose}" data-p="${p}" aria-hidden="true"></canvas>`;
const status = (pose, word, line = '', p = 0) => `${art_(pose, p)}<div class="word">${esc(word)}</div><div class="line">${esc(line)}</div>`;
const fsBtn = () => (canFull() ? `<button data-act="fs" aria-label="${full ? 'Exit fullscreen' : 'Fullscreen'}" title="${full ? 'Exit fullscreen' : 'Fullscreen'}">${svg(full ? '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>' : '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>')}</button>` : '');
const menu = () => (snap ? `<div class="top"><button class="mark chip" data-go="machines" aria-label="Machine: ${esc(here())}"><i></i>${esc(here())}</button><span class="topr chip">${fsBtn()}<button data-go="settings" aria-label="Settings" title="Settings">${menuIcon}</button></span></div>` : '<div class="top"><span class="mark">Local AI</span></div>');
const close = (go = 'back') => `<div class="top"><span class="mark">Local AI</span><button class="x" data-go="${go}" aria-label="Close">${closeIcon}</button></div>`;
const cell = (label, value, live) => `<div class="stat${live ? ' live' : ''}"><b>${fmt(value)}</b><span class="label">${label}</span></div>`;
const running = (r) => `<div class="stats twoup">${cell('Decode tok/s', r.stats?.tps || 0, true)}${cell('Prefill tok/s', r.stats?.pps || 0)}${cell('Session tokens', r.stats?.used || 0)}<button class="linkstat" data-go="usage">${cell('Lifetime tokens', D().usage.all)}</button></div>`;
const meta = (r) => [r.released && new Date(`${r.released}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', year: 'numeric' }), r.engine, ctxOf(r.ctx)].filter(Boolean).join(' · ');
const detail = (r, icons = true) => `<div class="mdetail">${icons ? `<div class="ics">${caps(r)}</div>` : ''}<div class="kv small"><span class="label">Intelligence</span><b>${r.smart === null ? '—' : Math.round(r.smart)}</b><span class="label">C1 speed</span><b>${r.speed.c1 ? `${Math.round(r.speed.c1)}/s` : '—'}</b><span class="label">Context</span><b>${ctxOf(r.ctx)}</b><span class="label">Engine</span><b>${esc(r.engine)}</b><span class="label">KV cache</span><b>${esc(r.kv || '—')}</b><span class="label">Download</span><b>${r.sizeGb ? `${Math.round(r.sizeGb)} GB` : '—'}</b></div></div>`;
const notice = () => (note ? `<button class="notice" data-act="dismiss" title="Dismiss">${esc(note)}</button>` : '');
const vfoot = () => { const v = snap.app; return `<div class="vfoot"><button class="vname" data-go="app-update">Local AI ${esc(v.version)}</button>${v.latest ? `<button data-go="app-update">Update${/^\d/.test(v.latest) ? ` to ${esc(v.latest)}` : ''}</button>` : v.can ? '<span>Up to date</span>' : ''}</div>`; };

// Home: the blocks you chose, in your order.
const offLine = (c) => (!c.ready ? `${c.sizeGb ? `${Math.round(c.sizeGb)} GB` : 'Model'} to download` : group()?.untested ? `Made for ${esc(group().untested)} · untested here` : c.loadS ? `Starts in about ${mins(c.loadS)} min` : 'Ready to start');
const modelRow = (r) => `<div class="mrow${r.id === chosen().id ? ' on' : ''}"><div class="mhead"><button class="mpick" data-act="pick" data-id="${esc(r.id)}">${esc(r.name)}<small>${r.tier || ''}</small></button><button class="plus" data-act="exp" data-id="${esc(r.id)}" aria-label="Details">${expanded === r.id ? '−' : '+'}</button></div>${expanded === r.id ? `${detail(r)}<div class="mdetail" style="padding-top:0">${a('Edit', 'msel', '', `data-id="${esc(r.id)}" data-go="edit"`)}</div>` : ''}</div>`;
const LEVELS = ['#232220', '#45433f', '#6f6c66', '#9c9891', '#c8c4bc', '#f2efe9'];
function levels(values) {
  const on = values.filter(Boolean).sort((x, y) => x - y);
  const cuts = [0.25, 0.5, 0.75, 0.9].map((q) => on[Math.floor(q * on.length)]);
  return (v) => (v ? 1 + cuts.filter((c) => v >= c).length : 0);
}
function miniUsage() {
  const known = new Map(D().usage.days.map((x) => [x.d, x.v])), level = levels([...known.values()]);
  const cells = Array.from({ length: 84 }, (_, i) => known.get(new Date(Date.now() - (83 - i) * 864e5).toISOString().slice(0, 10)) || 0);
  return `<button class="wbtn" data-go="usage"><span class="wtitle">Usage<span>${fmt(D().usage.all)} served</span></span><span class="minical">${cells.map((v) => `<i style="background:${LEVELS[level(v)]}"></i>`).join('')}</span></button>`;
}
const gpuRows = () => `<div class="wbtn"><span class="wtitle">GPUs</span>${D().gpus.map((g) => `<div class="gpu"><span>GPU ${g.index}</span><i><u style="width:${Math.min(100, ((g.used || 0) / g.total) * 100).toFixed(0)}%"></u></i><span>${Math.round((g.used || 0) / 1024)} of ${Math.round(g.total / 1024)} GB</span></div>`).join('')}</div>`;
const WBODY = {
  hands: (ph) => (ph === 'off' ? `${art_('apart')}<div class="line">${offLine(chosen())}</div>` : status('work', run().name, ph === 'opened' ? `Running · ${agentName() || 'Agent'} is open` : 'Running', 1)),
  models: (ph) => (ph === 'off' ? `<div>${shown3().map(modelRow).join('')}<button class="quiet" style="margin-top:4px" data-go="adv-models">More models</button></div>` : ''),
  stats: (ph) => (ph === 'off' ? '' : running(run())),
  usage: miniUsage,
  gpus: gpuRows,
};
const home = (ph) => `<div class="scroll home">${HOME().map((k) => WBODY[k](ph)).join('')}</div>`;
const openBtns = () => `<div class="two">${agentName() ? a(`Open ${esc(agentName())}`, 'open', 'go') : b('Choose an agent', 'chooser', 'go')}${b('⌄', 'chooser', '', 'aria-label="Choose an agent"')}</div>`;

// Agents, in the chooser (tap to open) and on their own page (versions and updates).
function agentRow(h, mode) {
  const working = h.job?.phase === 'running', failed = h.job?.phase === 'failed';
  if (working) return `<div class="item vrow busy"><span><b>${h.name}</b><small>${h.job.kind === 'update' ? 'Updating…' : 'Installing…'}</small></span><i class="instbar"></i></div>`;
  if (!h.installed) return h.canInstall ? `<button class="item vrow" data-act="agent" data-agent="${h.id}" title="${esc(h.job?.error || '')}"><span><b>${h.name}</b><small>${failed ? 'Couldn’t install' : `Not installed${h.latest ? ` · ${h.latest}` : ''}`}</small></span><span class="inst">${failed ? 'Try again' : 'Install'}</span></button>` : `<div class="item vrow busy"><span><b>${h.name}</b><small>Not installed</small></span></div>`;
  const isDefault = h.id === snap.harness;
  if (mode === 'open') { const r = run(), off = r?.apis && !r.apis.includes(h.needs); return `<button class="item" data-act="open" data-agent="${h.id}" ${off ? 'disabled' : ''}>${h.name}<small>${off ? 'Won’t work with this model' : isDefault ? 'Default' : ''}</small></button>`; }
  const update = h.version && h.latest && newer(h.latest, h.version);
  const right = failed ? `<button class="inst vact" data-act="agent" data-agent="${h.id}" title="${esc(h.job.error)}">Try again</button>` : update ? `<button class="inst vact" data-act="agent" data-agent="${h.id}">Update to ${h.latest}</button>` : h.latest ? '<small>Up to date</small>' : `<button class="inst vact" data-act="agent" data-agent="${h.id}">Update</button>`;
  return `<div class="item vrow"><button class="vpick" data-act="default" data-agent="${h.id}"><span><b>${h.name}</b><small>${h.version || 'Installed'}${isDefault ? ' · Default' : ''}${failed ? ' · Couldn’t update' : ''}</small></span></button>${right}</div>`;
}
const agentList = (mode) => snap.harnesses.map((h) => agentRow(h, mode)).join('');
const agentsFoot = () => `${outdated().length ? a(`Update all (${outdated().length})`, 'updateall') : ''}<div class="label">Folder</div><input class="field" data-f="folder" data-save="folder" spellcheck="false" aria-label="Folder" value="${esc(form.folder ?? snap.folder)}">`;

// Usage: one period at a time, how it grew, which models served it, and the calendar.
const day = (iso) => new Date(`${iso}T00:00:00Z`);
const say = (d, o) => d.toLocaleDateString('en-US', { timeZone: 'UTC', ...o });
const plus = (d, n) => new Date(d.getTime() + n * 864e5);
const tokensOf = (x) => Object.values(x.models).reduce((n, v) => n + v, 0);
function usageData() {
  const now = new Date(), by = new Map(), add = (name, v) => by.set(name, (by.get(name) || 0) + v);
  if (uspan === 'run') {
    const r = usage.runs[0];
    if (!r) return { tokens: 0, wrote: 0, requests: 0, sub: 'No model is running', points: [], by };
    const since = r.since || r.series[0]?.[0] || Date.now();
    add(r.name, r.tokens);
    return { tokens: r.tokens, wrote: r.out, requests: r.req, sub: `${esc(r.name)} · running for ${mins((Date.now() - since) / 1000)} min`, points: r.series.map(([t, v]) => ({ label: `${Math.max(0, Math.round((t - since) / 60000))} min`, v })), by };
  }
  if (uspan === 'today') {
    let tokens = 0, wrote = 0, requests = 0;
    const points = [];
    for (let t = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(); t <= now.getTime(); t += 3600e3) {
      for (const [name, r] of Object.entries(usage.hours[new Date(t).toISOString().slice(0, 13)] || {})) { tokens += r.in + r.out; wrote += r.out; requests += r.req; add(name, r.in + r.out); }
      points.push({ label: new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), v: tokens });
    }
    return { tokens, wrote, requests, sub: now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }), points, by };
  }
  const list = uspan === 'month' ? usage.days.filter((x) => x.d.startsWith(now.toISOString().slice(0, 7))) : usage.days;
  let tokens = 0;
  const points = list.map((x) => { for (const [name, v] of Object.entries(x.models)) add(name, v); return { label: say(day(x.d), { month: 'short', day: 'numeric' }), v: (tokens += tokensOf(x)) }; });
  const sub = uspan === 'month' ? now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : list.length ? `Since ${say(day(list[0].d), { month: 'short', day: 'numeric' })}` : 'Nothing served yet';
  return { tokens, wrote: list.reduce((n, x) => n + x.out, 0), requests: list.reduce((n, x) => n + x.req, 0), sub, points, by };
}
function growth(points) {
  if (points.length < 2) return left('Not enough yet to draw');
  const W = 232, H = 84, top = points.at(-1).v || 1, n = points.length - 1;
  const line = points.map((p, i) => `${((i / n) * W).toFixed(1)},${(H - 2 - (p.v / top) * (H - 6)).toFixed(1)}`).join(' ');
  return `<div class="growth" data-points="${encodeURIComponent(JSON.stringify(points.map((p) => [p.label, p.v])))}"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Tokens served over time, rising to ${fmt(top)}"><line class="gbase" x1="0" y1="${H - 1}" x2="${W}" y2="${H - 1}"/><polygon class="garea" points="0,${H - 1} ${line} ${W},${H - 1}"/><polyline class="gline" points="${line}"/><line class="gcross" x1="${W}" y1="0" x2="${W}" y2="${H}"/></svg><div class="gaxis"><span>${points[0].label}</span><span>${points.at(-1).label}</span></div><div class="readout" data-gread><b>${points.at(-1).label}</b><span>${fmt(top)} tokens so far</span></div></div>`;
}
// Every period is a list of { label, tokens, requests }; a missing day is a real zero, not a gap.
function periods() {
  const known = new Map(usage.days.map((x) => [x.d, { tokens: tokensOf(x), requests: x.req }]));
  const last = day(new Date().toISOString().slice(0, 10)), first = usage.days.length && day(usage.days[0].d) < plus(last, -83) ? day(usage.days[0].d) : plus(last, -83);
  const days = [];
  for (let d = first; d <= last; d = plus(d, 1)) days.push({ d, ...(known.get(d.toISOString().slice(0, 10)) || { tokens: 0, requests: 0 }) });
  if (period === 'days') return days.map((x) => ({ ...x, label: say(x.d, { month: 'short', day: 'numeric' }) }));
  const groups = new Map();
  for (const x of days) {
    const k = period === 'weeks' ? plus(x.d, -((x.d.getUTCDay() + 6) % 7)).getTime() : Date.UTC(x.d.getUTCFullYear(), x.d.getUTCMonth(), 1);
    const g = groups.get(k) || { d: new Date(k), tokens: 0, requests: 0 };
    g.tokens += x.tokens; g.requests += x.requests;
    groups.set(k, g);
  }
  return [...groups.values()].map((g) => ({ ...g, label: period === 'weeks' ? `Week of ${say(g.d, { month: 'short', day: 'numeric' })}` : say(g.d, { month: 'long' }) }));
}
const readout = (x) => `<b>${x.label}</b><span>${fmt(x.tokens)} tokens · ${x.requests.toLocaleString('en-US')} requests</span>`;
function calendar() {
  const list = periods(), level = levels(list.map((x) => x.tokens)), last = list.length - 1;
  const data = (x, i) => `data-cell="${encodeURIComponent(readout(x))}" aria-label="${x.label}: ${fmt(x.tokens)} tokens" class="${i === last ? 'sel' : ''}"`;
  let grid;
  if (period === 'days') {
    const lead = (list[0].d.getUTCDay() + 6) % 7, seen = new Set();
    const marks = list.filter((x) => !seen.has(x.d.getUTCMonth()) && seen.add(x.d.getUTCMonth())).filter((_, i, m) => m.length < 5 || i % 2 === 0).map((x) => `<span>${say(x.d, { month: 'short' })}</span>`).join('');
    grid = `<div class="cal-months">${marks}</div><div class="cal days" style="--cols:${Math.ceil((lead + list.length) / 7)}">${'<i></i>'.repeat(lead)}${list.map((x, i) => `<button ${data(x, i)} style="background:${LEVELS[level(x.tokens)]}"></button>`).join('')}</div>`;
  } else if (period === 'weeks') grid = `<div class="cal weeks">${list.map((x, i) => `<button ${data(x, i)} style="background:${LEVELS[level(x.tokens)]}"></button>`).join('')}</div>`;
  else grid = `<div class="cal months">${list.map((x, i) => { const l = level(x.tokens); return `<button ${data(x, i)} style="background:${LEVELS[l]};color:${l >= 3 ? '#12120f' : 'inherit'}">${say(x.d, { month: 'short' })}<b>${fmt(x.tokens)}</b></button>`; }).join('')}</div>`;
  return `${grid}<div class="readout" data-readout>${readout(list[last])}</div>`;
}
function usageBody() {
  if (!usage) return left('Loading');
  const u = usageData(), total = [...u.by.values()].reduce((n, v) => n + v, 0) || 1;
  const models = [...u.by].sort((x, y) => y[1] - x[1]).map(([name, v]) => `<div class="umodel"><span>${esc(name)}</span><b>${fmt(v)}</b><span>${Math.round((v / total) * 100)}%</span><i><u style="width:${((v / total) * 100).toFixed(1)}%"></u></i></div>`).join('');
  const seg = (list, on, act) => list.map(([k, label]) => `<button class="${k === on ? 'on' : ''}" data-act="${act}" data-v="${k}">${label}</button>`).join('');
  return `<div class="ugrid"><section class="usec"><div class="useg">${seg([['run', 'This run'], ['today', 'Today'], ['month', 'Month'], ['all', 'All time']], uspan, 'uspan')}</div><div class="hero"><b>${fmt(u.tokens)}</b><span>tokens · ${u.sub}</span></div><div class="umeta"><span><b>${fmt(u.wrote)}</b> generated</span><span><b>${u.requests.toLocaleString('en-US')}</b> requests</span></div><div class="label">Growth</div>${growth(u.points)}<div class="label">By model</div><div class="umodels">${models || left('Nothing yet')}</div></section><section class="usec"><div class="label">Activity</div><div class="tabs">${seg([['days', 'Days'], ['weeks', 'Weeks'], ['months', 'Months']], period, 'period')}</div>${calendar()}<div class="legend"><span>Less</span>${LEVELS.map((c) => `<i style="background:${c}"></i>`).join('')}<span>More</span></div></section></div>`;
}

// A model card is someone else's Markdown, so every tag in it is dropped and only our own are written.
function markdown(text) {
  const inline = (s) => esc(s).replace(/!\[([^\]]*)\]\((https:\/\/[^)\s]+)\)/g, '<img alt="$1" src="$2" loading="lazy">').replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  const out = [];
  let list = null, code = null, table = false, para = [];
  const flush = () => { if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`); if (list) out.push(`</${list}>`); if (table) out.push('</table>'); para = []; list = null; table = false; };
  for (const raw of text.replace(/<!--[\s\S]*?-->/g, '').replace(/<\/?[a-zA-Z][^>]*>/g, '').split('\n')) {
    const line = raw.trim(), head = /^(#{1,4})\s+(.*)/.exec(line), li = /^(?:[-*]|(\d+\.))\s+(.*)/.exec(line);
    if (code !== null) { if (line.startsWith('```')) { out.push(`<pre>${esc(code)}</pre>`); code = null; } else code += `${raw}\n`; continue; }
    if (line.startsWith('```')) { flush(); code = ''; } else if (!line) flush();
    else if (head) { flush(); out.push(`<h${head[1].length + 1}>${inline(head[2])}</h${head[1].length + 1}>`); }
    else if (li) { const kind = li[1] ? 'ol' : 'ul'; if (list !== kind) { flush(); out.push(`<${kind}>`); list = kind; } out.push(`<li>${inline(li[2])}</li>`); }
    else if (line.startsWith('|')) { if (/^\|[\s:|-]+\|?$/.test(line)) continue; const tag = table ? 'td' : 'th'; if (!table) { flush(); out.push('<table>'); table = true; } out.push(`<tr>${line.replace(/^\||\|$/g, '').split('|').map((c) => `<${tag}>${inline(c.trim())}</${tag}>`).join('')}</tr>`); }
    else para.push(line);
  }
  flush();
  return out.join('');
}
const cardHtml = (r) => { const c = cards[r.id]; return `<div class="label group">Model card</div>${!c ? left('Loading') : c.error ? left(esc(c.error)) : `<div class="cardsrc"><a href="https://huggingface.co/${esc(c.repo)}" target="_blank" rel="noopener">${esc(c.repo)}</a>${c.license ? ` · ${esc(c.license)}` : ''}${c.downloads != null ? ` · ${fmt(c.downloads)} downloads` : ''}</div><div class="mdcard">${c.html}</div>`}`; };
const useBtn = (r) => { const live = run(); return live ? (live.recipe === r.id ? '' : a('Switch to this model', 'switch', 'go', `data-id="${esc(r.id)}"`)) : r.id === chosen()?.id ? a(`${r.ready ? 'Start' : 'Download'} ${esc(r.name)}`, 'start', 'go', 'data-go="home"') : a('Use', 'pick', 'go', `data-id="${esc(r.id)}" data-go="home"`); };
const CTX = [8192, 16384, 32768, 65536, 131072, 204800, 262144, 524288, 1048576];
const FLAGS = { ctx: ['--max-model-len', '--context-length', '--ctx-size', '-c'], seqs: ['--max-num-seqs', '--max-running-requests', '--parallel', '-np'], cards: ['--tensor-parallel-size', '--tp-size', '--tp'] };
const seg = (k, list) => `<div class="seg">${list.map((v) => `<button class="${v === draft[k] ? 'on' : ''}" data-act="draft" data-k="${k}" data-v="${v}">${v}</button>`).join('')}</div>`;
const editBody = () => (!draft ? left('Loading') : `<div class="head">${esc(draft.name)}</div>${left(esc(draft.engine))}<div class="scroll home" style="gap:8px"><div class="label" data-ctxlabel>Context ${ctxOf(draft.ctx)}</div><input type="range" data-f="ctx" min="0" max="${CTX.length - 1}" value="${CTX.findIndex((c) => c >= draft.ctx)}" aria-label="Context"><div class="label">GPUs</div>${seg('cards', [1, 2, 4, 8].filter((n) => n <= Math.max(draft.cards, group()?.gpus.length || 1)))}<div class="label">Requests at once</div>${seg('seqs', [1, 2, 4, 8])}${draft.engine === 'vLLM' ? `<div class="label">KV cache</div>${seg('kv', ['Off', 'fp8'])}` : ''}<div class="label">Arguments</div><textarea class="box" data-f="args" rows="6" spellcheck="false" aria-label="Arguments">${esc(draft.args)}</textarea></div>${a('Save', 'saveedit', 'go')}${draft.local ? a('Reset', 'resetedit') : ''}`);
const BGS = [['gray', 'The Creation of Adam', 'Grayscale'], ['color', 'The Creation of Adam', 'In colour'], ['own', 'Your own picture', 'Choose a file'], ['none', 'None', 'Plain dark']];
const WMETA = { hands: ['Picture', 'The painting and what’s happening'], models: ['Model picks', 'Fast, balanced and smart'], stats: ['Live stats', 'Speed and tokens while running'], usage: ['Usage', 'Tokens served, by day'], gpus: ['GPUs', 'Memory on each GPU'] };
const addr = (text, shown) => `<button class="addr" data-act="copy" data-copy="${esc(text)}"><span>${esc(shown ?? text)}</span><small>Copy</small></button>`;
const yes = (apis, k) => (apis ? (apis.includes(k) ? 'Yes' : 'No') : '—');

// Screens that are one picture, one word, one line and a few buttons. Both layouts draw them from this.
const elsewhere = () => {
  const other = dev !== -1 && snap.groups.some((g) => g.recipes.length) ? { i: -1, name: snap.name } : snap.devices.find((x) => x.i !== dev && x.online && x.state?.groups.some((g) => g.recipes.length));
  return other ? `${a(`Use ${esc(other.name)}`, 'use', 'go', `data-dev="${other.i}"`)}${b('Add machine', 'addmachine')}` : b('Add machine', 'addmachine', 'go');
};
const STATE = {
  boot: () => ({ pose: 'apart', word: 'Local AI', line: 'Looking for your GPU' }),
  cantconnect: () => ({ pose: 'broken', word: 'Can’t connect', line: 'Trying again' }),
  unreachable: () => ({ pose: 'broken', word: 'Can’t reach it', line: `${here()} · ${snap.devices[dev].error || 'Offline'}`, btns: a('This computer', 'use', 'go', 'data-dev="-1"') }),
  'app-updating': () => ({ pose: 'reach', p: 0.5, bar: true, word: 'Updating', line: `Local AI ${/^\d/.test(snap.app.latest || '') ? snap.app.latest : ''}`, extra: '<div class="line">Models keep running</div>' }),
  waking: () => { const r = run(); return { pose: 'reach', p: r.view.p, bar: true, word: r.name, line: `Starting · ${r.view.line}`, btns: a('Cancel', 'stop', 'neg') }; },
  slow: () => { const r = run(); return { pose: 'reach', p: r.view.p, bar: true, word: 'Taking longer', line: `Usually ${mins(r.expected)} min, now ${mins((Date.now() - r.since) / 1000)}`, btns: a('Cancel', 'stop', 'neg') }; },
  dl: () => { const r = run(); return { pose: 'reach', p: r.progress || 0, bar: true, word: 'Downloading', line: r.detail || 'Getting the model', btns: a('Cancel', 'stop', 'neg') }; },
  sleeping: () => ({ pose: 'reach', p: 0.2, word: 'Stopping', line: 'Freeing the GPU' }),
  failed: () => {
    const r = run(), f = r.view, fast = picks()[0];
    const first = f.word === 'Ran out of room' && fast && fast.id !== r.recipe ? a('Try Fast', 'tryfast', 'go') : f.word === 'Locked model' ? b('Add token', 'hf-token', 'go') : a('Try again', 'retry', 'go');
    return { pose: 'broken', word: f.word, line: f.line, extra: '<button class="link" data-go="logs">Engine output</button>', btns: `${first}${a('Back', 'stop')}` };
  },
  noreply: () => ({ pose: 'broken', word: 'No reply', line: run().view.line, btns: `${a('Restart', 'retry', 'go')}${a('Stop', 'stop', 'neg')}` }),
  needsdocker: () => ({ pose: 'apart', word: 'Needs Docker', line: 'One free install', btns: '<a class="btn go" href="https://docs.docker.com/engine/install/" target="_blank" rel="noopener">Install Docker</a>' }),
  dockeroff: () => ({ pose: 'apart', word: 'Docker is off', line: 'Turn it on to start models', btns: a('Turn on', 'docker', 'go') }),
  nogpu: () => ({ pose: 'apart', word: 'No GPU here', line: 'This computer can’t run models', btns: elsewhere() }),
  nothing: () => ({ pose: 'apart', word: 'Nothing fits', line: `No tested models for ${esc(D().groups[0]?.name || 'this GPU')}`, btns: elsewhere() }),
  nocatalog: () => ({ pose: 'apart', word: 'No models yet', line: D().catalog.error ? 'Can’t reach the model list' : 'Getting the model list', btns: a('Try again', 'refresh', 'go') }),
  busy: () => ({ pose: 'apart', word: 'GPU in use', line: 'Another program has it', btns: '<button class="btn" disabled>Start</button>' }),
  'm-connect': () => ({ pose: 'reach', p: 0.5, word: 'Connecting', line: link.name, btns: b('Cancel', 'machines', 'neg') }),
  'm-linked': () => ({ pose: 'touch', p: 1, word: 'Connected', line: link.name, btns: `${a('Use this machine', 'uselinked', 'go')}${b('Back', 'machines')}` }),
  'm-fail': () => ({ pose: 'broken', word: 'Can’t reach it', line: link.error, btns: `${b('Try again', 'addmachine', 'go')}${b('Back', 'machines')}` }),
  'm-install': () => ({ pose: 'apart', word: 'Not set up', line: `Run this on ${link.name}, then come back`, extra: `<div class="box mono" style="margin-top:8px">${esc(installCmd || 'Install Local AI there first')}</div>`, btns: `${installCmd ? a('Copy', 'copy', 'go', `data-copy="${esc(installCmd)}"`) : ''}${b('Back', 'machines')}` }),
};
const plain = (id) => { const s = STATE[id](); return `${menu()}${status(s.pose, s.word, s.line, s.p)}${s.bar ? bar(s.p * 100) : ''}${s.extra || ''}<div class="sp"></div>${s.btns || ''}`; };

const SCREENS = {
  off: () => `${menu()}${home('off')}${a(`${chosen().ready ? 'Start' : 'Download'} ${esc(chosen().name)}`, 'start', 'go')}`,
  awake: () => `${menu()}${home('run')}${openBtns()}${a('Stop', 'stop', 'neg')}`,
  opened: () => `${menu()}${home('opened')}${openBtns()}${a('Stop', 'stop', 'neg')}`,
  chooser: () => `${close()}<div class="head">Open with</div><div class="scroll">${agentList('open')}</div>`,
  runthis: () => `${close()}<div class="head">Run this</div><div class="box mono">${esc(command)}</div><div class="sp"></div>${a('Copy', 'copy', 'go')}`,
  key: () => `<div class="top"><span class="mark">Local AI</span></div><div class="head" style="margin-top:24px">Enter the key</div>${left('It’s under Settings › Advanced › API endpoints on the machine running Local AI')}<input class="field" data-f="key" autocomplete="off" spellcheck="false" aria-label="Key" placeholder="Key" value="${esc(form.key || '')}"><div class="sp"></div>${a('Connect', 'key', 'go')}`,
  settings: () => `${close('home')}<div class="tabs two"><button class="on" data-go="settings">General</button><button data-go="advanced">Advanced</button></div>${item('Home screen', 'home-edit')}${item('Background', 'background')}${item('Agents and folder', 'agent')}${item('Machines', 'machines')}${item('Usage', 'usage')}<div class="sp"></div>${vfoot()}`,
  advanced: () => `${close('home')}<div class="tabs two"><button data-go="settings">General</button><button class="on" data-go="advanced">Advanced</button></div>${item('Models', 'adv-models')}${item('API endpoints', 'endpoints')}${item('Registry', 'registry')}${item('Hugging Face token', 'hf-token')}<div class="sp"></div>${vfoot()}`,
  'home-edit': () => `${close()}<div class="head">Home screen</div>${left('Switch on what Home shows. Drag to change the order.')}<div class="scroll" data-sort>${homeCfg().order.map((k) => `<div class="hrow${homeCfg().on.includes(k) ? '' : ' hidden'}" data-key="${k}"><button class="grip" data-key="${k}" aria-label="Move ${WMETA[k][0]}. Use the arrow keys" title="Drag to reorder">${gripIcon}</button><span class="hname"><b>${WMETA[k][0]}</b><small>${WMETA[k][1]}</small></span>${sw(homeCfg().on.includes(k), `data-act="toggle" data-k="${k}"`, `Show ${WMETA[k][0]}`)}</div>`).join('')}</div>`,
  background: () => `${close()}<div class="head">Background</div><div class="scroll">${BGS.map(([k, name, hint]) => `<button class="item" data-act="bg" data-bg="${k}"><span class="bgrow"><i class="bgthumb bg-${k}"></i><span><b>${name}</b><small>${k === 'own' && snap.picture ? 'Choose another' : hint}</small></span></span><small>${k === root.dataset.bg ? 'In use' : ''}</small></button>`).join('')}</div>`,
  agent: () => `${close()}<div class="head">Agents</div>${left('Open uses the default. Tap one to make it the default.')}<div class="scroll">${agentList('agent')}</div>${agentsFoot()}`,
  machines: () => {
    const mine = [{ i: -1, name: snap.name, sub: gpuLine(snap) }, ...snap.devices.map((d) => ({ i: d.i, name: d.name, sub: d.online ? gpuLine(d.state) : d.error || 'Offline' }))];
    const others = (peers || []).filter((p) => !p.linked).map((p) => (p.online ? `<button class="item" data-act="peer" data-ip="${p.ip}" data-name="${esc(p.name)}" data-app="${p.app ? 1 : ''}"><span><b>${esc(p.name)}</b><small>${esc(p.os)}</small></span><small>${p.app ? 'Connect' : 'Not set up'}</small></button>` : `<div class="item busy"><span><b>${esc(p.name)}</b><small>${esc(p.os)}</small></span><small>Seen ${ago(p.seen)}</small></div>`)).join('');
    return `${close()}<div class="head">Machines</div><div class="scroll"><div class="label group">Connected</div>${mine.map((m) => `<button class="item" data-act="use" data-dev="${m.i}"><span><b>${esc(m.name)}</b><small>${esc(m.sub)}</small></span><small>${m.i === dev ? 'In use' : ''}</small></button>`).join('')}<div class="label group">On your Tailscale</div>${peers === null ? left('Looking') : others || left('No other machines')}</div>${b('Add machine', 'addmachine')}`;
  },
  addmachine: () => `${close()}<div class="head">Add machine</div><div class="label">Address</div><input class="field" data-f="host" spellcheck="false" autocomplete="off" aria-label="Address" placeholder="http://100.64.0.10:18700" value="${esc(form.host || '')}"><div class="label">Key</div><input class="field" data-f="mkey" spellcheck="false" autocomplete="off" aria-label="Key" placeholder="From API endpoints on that machine" value="${esc(form.mkey || '')}"><div class="sp"></div>${a('Add machine', 'connect', 'go')}`,
  usage: () => `${close()}<div class="head">Usage</div><div class="scroll">${usageBody()}</div>`,
  'adv-models': () => `${close()}<div class="head">Models</div><div class="label">Runs on this machine, newest first</div><div class="scroll">${all().map((r) => `<div class="arow"><button class="ahead" data-act="msel" data-id="${esc(r.id)}" data-go="model-page"><span class="at"><b>${esc(r.name)}</b><small>${meta(r)}</small></span><span class="ics">${caps(r)}<span class="chev">›</span></span></button></div>`).join('')}</div>`,
  'model-page': () => { const r = all().find((x) => x.id === modelOpen) || chosen(); return `${close()}<div class="scroll"><div class="head">${esc(r.name)}</div>${left(meta(r))}${detail(r)}${cardHtml(r)}</div><div class="two">${useBtn(r) || '<button class="btn" disabled>Running</button>'}${a('Edit', 'msel', '', `data-id="${esc(r.id)}" data-go="edit" style="width:auto;flex:1"`)}</div>`; },
  edit: () => `${close()}${editBody()}`,
  endpoints: () => {
    if (!ends) return `${close()}<div class="head">API endpoints</div>${left('Loading')}`;
    const runs = ends.runs.map((r) => `<div class="label">${esc(r.name)}, on this computer</div>${addr(r.local)}${r.tailnet ? `<div class="label">On your Tailscale</div>${addr(r.tailnet)}` : ''}<div class="kv"><span class="label">OpenAI chat</span><b>${yes(r.apis, 'chat')}</b><span class="label">OpenAI Responses</span><b>${yes(r.apis, 'responses')}</b><span class="label">Anthropic messages</span><b>${yes(r.apis, 'messages')}</b></div>`).join('');
    const rows = ends.sources.map((s) => `<div class="src"><span><b>${esc(s.device)}</b><small>${s.known ? esc(s.ip) : 'Not on your Tailscale'}</small></span><span><b>${s.requests.toLocaleString('en-US')}</b><small>${ago(s.last)}</small></span></div>`).join('');
    return `${close()}<div class="head">API endpoints</div><div class="scroll">${runs || left('Start a model to get its address. Any API key works.')}<div class="label">Key, to add this machine from another</div>${addr(ends.key, `••••••${ends.key.slice(-4)}`)}<div class="label group">Where requests come from today</div>${rows || left('None seen yet')}</div>`;
  },
  logs: () => `${close()}<div class="head">Engine output</div>${left('The last lines before it stopped')}<div class="box mono" style="flex:1;overflow:auto">${esc(logText).split('\n').join('<br>')}</div>${a('Copy', 'copy', 'go')}`,
  registry: () => { const c = D().catalog; return `${close()}<div class="head">Registry</div><div class="kv"><span class="label">Source</span><b>local-ai-registry</b><span class="label">Version</span><b>${esc(c.id || '—')}</b><span class="label">Recipes</span><b>${c.count}</b><span class="label">Checked</span><b>${c.at ? ago(c.at) : '—'}</b></div>${c.error ? left('Couldn’t reach it. Using the saved list.') : ''}<div class="sp"></div>${a('Check for updates', 'refresh', 'go')}`; },
  'hf-token': () => `${close()}<div class="head">Hugging Face token</div>${left('Some models are locked until you accept their terms on Hugging Face. A read token lets Local AI download them.')}<div class="label">Token</div><input class="field" type="password" data-f="token" autocomplete="off" aria-label="Token" placeholder="${snap.hfToken ? `Saved, ends in ${esc(snap.hfToken)}` : 'hf_…'}" value="${esc(form.token || '')}"><a class="link" style="margin:2px 0 0;text-align:left" href="https://huggingface.co/settings/tokens" target="_blank" rel="noopener">Make a token on Hugging Face</a><div class="sp"></div>${a('Save', 'savetoken', 'go')}${snap.hfToken ? a('Remove token', 'removetoken', 'neg') : ''}`,
  'app-update': () => {
    const v = snap.app, named = /^\d/.test(v.latest || '');
    return `${close()}<div class="head">Local AI ${esc(named ? v.latest : v.version)}</div>${left(v.latest ? `You have ${esc(v.version)}` : v.can ? 'You have the newest version' : 'This copy wasn’t installed from its repo, so it can’t update itself')}${v.notes.length ? `<div class="label group">What’s new</div><ul class="notes">${v.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}${v.phase === 'failed' ? left(`The last update failed: ${esc(v.error)}`) : ''}<div class="sp"></div>${v.can ? `<div class="hrow plain"><span class="hname"><b>Update automatically</b><small>Models keep running while it restarts</small></span>${sw(v.auto, 'data-act="appauto"', 'Update automatically')}</div>${v.latest ? a('Update and restart', 'appupdate', 'go') : a('Check for updates', 'appcheck')}` : ''}`;
  },
};
for (const id of Object.keys(STATE)) SCREENS[id] = () => plain(id);

// Which screen the server's state calls for. The first rule that matches wins.
function resolve() {
  if (needKey) return 'key';
  if (!snap) return online ? 'boot' : 'cantconnect';
  if (!online) return 'cantconnect';
  if (dev !== -1 && (!snap.devices[dev].online || !D())) return 'unreachable';
  if (snap.app.phase === 'updating') return 'app-updating';
  const d = D(), r = run();
  if (r) return { weights: 'dl', ready: opened === r.id ? 'opened' : 'awake', unresponsive: 'noreply', stopping: 'sleeping', failed: 'failed' }[r.phase] || (r.phase === 'starting' && r.expected && (Date.now() - r.since) / 1000 > r.expected * 1.5 ? 'slow' : 'waking');
  if (!d.docker.ok && d.gpus.length) return /not installed/.test(d.docker.error) ? 'needsdocker' : 'dockeroff';
  if (!d.gpus.length) return 'nogpu';
  const c = chosen();
  if (!c) return d.catalog.count ? 'nothing' : 'nocatalog';
  const g = d.groups.find((x) => x.recipes.some((y) => y.id === c.id));
  return g.gpus.filter((i) => d.free.includes(i)).length < c.cards ? 'busy' : 'off';
}
const look = (id) => (id === 'awake' || id === 'opened' ? { pose: 'work', p: 1 } : STATE[id] ? STATE[id]() : { pose: 'apart', p: 0 });
const lit = ({ pose, p }) => (pose === 'work' || pose === 'touch' ? 1 : pose === 'reach' ? +p || 0 : 0);

// Desktop: a top bar, the painting as the room, and pages for everything else.
const NAV = [['home', 'Home', 'home'], ['models', 'Models', 'adv-models'], ['agents', 'Agents', 'agent'], ['machines', 'Machines', 'machines'], ['usage', 'Usage', 'usage'], ['settings', 'Settings', 'home-edit']];
const SECTION = { 'adv-models': 'models', 'model-page': 'models', edit: 'models', agent: 'agents', machines: 'machines', addmachine: 'machines', 'm-connect': 'machines', 'm-linked': 'machines', 'm-fail': 'machines', 'm-install': 'machines', usage: 'usage', settings: 'settings', advanced: 'settings', 'home-edit': 'settings', background: 'settings', endpoints: 'settings', registry: 'settings', 'hf-token': 'settings', 'app-update': 'settings' };
const SETTINGS = [['home-edit', 'Home screen'], ['background', 'Background'], ['endpoints', 'API endpoints'], ['registry', 'Registry'], ['hf-token', 'Hugging Face token']];
function navBar(page) {
  if (!snap) return '<header class="nav"><span class="mark chip"><i></i><span>Local AI</span></span></header>';
  const now = page ? SECTION[page] : 'home', r = D() && run();
  const links = NAV.map(([k, label, to], i) => `<button data-nav="${to}" title="${label} (${i + 1})"${now === k ? ' aria-current="page"' : ''}>${label}</button>`).join('');
  const live = r?.phase === 'ready' ? `<button class="nlive" data-nav="home" aria-label="${esc(r.name)} is running. Go to Home"><i></i><span class="nm">${esc(r.name)}</span><em>${fmt(r.stats?.tps || 0)} tok/s</em></button>` : '';
  return `<header class="nav"><button class="mark chip" data-nav="machines" aria-label="Machine: ${esc(here())}"><i></i><span>${esc(here())}</span></button><nav class="nlinks" aria-label="Sections">${links}</nav><div class="nr">${live}${fsBtn()}</div></header>`;
}
function homeHtml(id) {
  let inner;
  if (id === 'off') {
    const c = chosen();
    const pick = (r) => `<button class="cpick${r.id === c.id ? ' on' : ''}" data-act="pick" data-id="${esc(r.id)}">${esc(r.name)}<small>${[r.tier, r.speed.c1 && `${Math.round(r.speed.c1)}/s`].filter(Boolean).join(' · ')}</small></button>`;
    inner = `<div class="ctitle"><div class="nname">${esc(c.name)}</div><div class="nsub">${offLine(c)}</div></div><div class="cpicks">${HOME().includes('models') ? shown3().map(pick).join('') : ''}</div><div class="cright"><button class="quiet" data-nav="adv-models">More models</button>${a(`${c.ready ? 'Start' : 'Download'} ${esc(c.name)}`, 'start', 'go')}</div>`;
  } else if (id === 'awake' || id === 'opened') {
    const r = run(), c = all().find((x) => x.id === r.recipe);
    inner = `<div class="ctitle"><div class="nname">${esc(r.name)}</div><div class="nsub">${[id === 'opened' ? `${esc(agentName() || 'Agent')} is open` : 'Running', c?.engine, ctxOf(r.ctx)].filter(Boolean).join(' · ')}</div></div><div>${HOME().includes('stats') ? running(r) : ''}</div><div class="cright">${agentsOpen ? `<div class="apop">${agentList('open')}</div>` : ''}${openBtns()}${a('Stop', 'stop', 'neg')}</div>`;
  } else {
    const s = STATE[id]();
    inner = `<div class="ctitle"><div class="nname">${esc(s.word)}</div><div class="nsub">${esc(s.line)}</div></div><div class="cprog">${s.bar ? bar(s.p * 100) : ''}${s.extra || ''}</div><div class="cright">${s.btns || ''}</div>`;
  }
  const extras = snap && D() && !agentsOpen ? HOME().filter((k) => k === 'usage' || k === 'gpus') : [];
  return `<div class="cfade"></div>${extras.length ? `<div class="cwid">${extras.map((k) => `<div class="widget">${WBODY[k]()}</div>`).join('')}</div>` : ''}<div class="cin">${inner}</div>`;
}
const frameBody = (id) => `<div class="screen">${SCREENS[id]()}</div>`;
function modelsPage(page) {
  const r = all().find((x) => x.id === modelOpen) || chosen(), live = run();
  if (!r) return `<div class="pwrap pg"><div class="ptitle">Models</div><div class="psub">None run on ${esc(here())}</div>${elsewhere()}</div>`;
  const list = all().map((x) => `<button class="mitem${x.id === r.id ? ' sel' : ''}${x.id === chosen()?.id ? ' cur' : ''}" data-act="msel" data-id="${esc(x.id)}" data-go="adv-models"><span class="at"><b data-tag="${live ? 'Running' : 'Selected'}">${esc(x.name)}</b><small>${meta(x)}</small></span><span class="ics">${caps(x)}</span></button>`).join('');
  const kv = [['Intelligence', r.smart === null ? '—' : Math.round(r.smart)], ['C1 speed', r.speed.c1 ? `${Math.round(r.speed.c1)} tok/s` : '—'], ['Context', ctxOf(r.ctx)], ['Requests at once', r.seqs], ['GPUs', r.cards], ['KV cache', esc(r.kv || '—')], ['Download', r.sizeGb ? `${Math.round(r.sizeGb)} GB` : '—']];
  const capLabels = [r.vision && ['vision', 'Vision'], r.think && ['think', 'Thinking'], r.tools && ['tools', 'Tool calls'], r.kv && ['kv', `KV cache ${esc(r.kv)}`], r.cards > 1 && ['gpu', `${r.cards} GPUs`]].filter(Boolean).map(([k, t]) => `<span class="cap">${icon(k)}${t}</span>`).join('');
  const right = page === 'edit' ? `<div class="pg"><div class="screen">${editBody()}</div></div><button class="pback" data-go="adv-models">Cancel</button>`
    : `<div><div class="ptitle">${esc(r.name)}</div><div class="psub" style="margin-bottom:0">${meta(r)}</div></div><div class="mcaps">${capLabels}</div><div class="kv">${kv.map(([k, v]) => `<span class="label">${k}</span><b>${v}</b>`).join('')}</div><div class="macts">${useBtn(r)}${a('Edit', 'msel', '', `data-id="${esc(r.id)}" data-go="edit"`)}</div>${cardHtml(r)}`;
  return `<div class="msplit"><div class="mleft"><div class="ptitle">Models</div><div class="psub">${all().length} run on this machine, newest first</div><div class="mlist">${list}</div></div><div class="mright">${right}</div></div>`;
}
function pageHtml(page) {
  if (SECTION[page] === 'models') return modelsPage(page);
  if (page === 'agent') return `<div class="pwrap pg"><div class="ptitle">Agents</div><div class="psub">Pick the one Open uses, or install another</div>${agentList('agent')}<div class="pfield">${agentsFoot()}</div></div>`;
  if (SECTION[page] === 'settings') { const on = page === 'settings' || page === 'advanced' ? 'home-edit' : page; return `<div class="ssplit"><div class="smenu">${SETTINGS.map(([id, label]) => `<button class="${id === on ? 'on' : ''}" data-nav="${id}">${label}</button>`).join('')}${vfoot()}</div><div class="pg">${frameBody(on)}</div></div>`; }
  const top = NAV.some((n) => n[2] === page) || page === 'key';
  return `<div class="pwrap pg${page === 'usage' ? ' wide' : ''}">${top ? '' : '<button class="pback" data-go="back">‹ Back</button>'}${frameBody(page)}</div>`;
}

// The painting. One choice lights both layouts: dark when off, lit from the fingertips as a model starts.
const FRESCO = { x: 982, y: 566, w: 2000, h: 1015 }, PHONE = { x: 130, y: 116, top: 368 }, TARGET = [0.5, 0.36];
let GAP = FRESCO, own = null, glow = 0;
function applyBg() {
  const choice = snap?.background || store('la-bg') || 'gray', mine = choice === 'own' && own, src = mine ? own.url : '/fresco.webp';
  GAP = mine ? own : FRESCO;
  root.dataset.bg = choice === 'own' && !own ? 'gray' : choice;
  store('la-bg', choice);
  for (const img of art.querySelectorAll('img')) if (img.getAttribute('src') !== src) img.src = src;
  const k = mine ? Math.max(260 / GAP.w, PHONE.top / GAP.h) : 0.56;
  root.style.setProperty('--pimg', `url("${src}")`);
  root.style.setProperty('--psz', `${GAP.w * k}px ${GAP.h * k}px`);
  root.style.setProperty('--ppos', `${PHONE.x - GAP.x * k}px ${PHONE.y - GAP.y * k}px`);
}
async function loadOwn() {
  if (!snap.picture || own?.at === snap.picture) return;
  const at = snap.picture, res = await fetch('/api/background', { headers: { authorization: `Bearer ${key}` } });
  if (!res.ok) return;
  const url = URL.createObjectURL(await res.blob()), img = new Image();
  img.onload = () => { own = { at, url, x: img.width / 2, y: img.height / 2, w: img.width, h: img.height }; root.style.setProperty('--own', `url("${url}")`); applyBg(); render(true); };
  img.src = url;
}
function pickBg(k) {
  if (k === 'own' && (!own || root.dataset.bg === 'own')) { picker.click(); return null; }
  snap.background = k; applyBg();
  return send('settings', 'POST', { background: k });
}
picker.onchange = () => {
  const file = picker.files[0], img = new Image();
  picker.value = '';
  if (!file) return;
  img.onload = () => {
    const k = Math.min(1, 2400 / Math.max(img.width, img.height)), c = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * k), height: Math.round(img.height * k) });
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(img.src);
    send('settings', 'POST', { picture: c.toDataURL('image/jpeg', 0.86) }).catch((e) => { note = e.message; render(true); });
  };
  img.src = URL.createObjectURL(file);
};
function fitArt() {
  const W = art.clientWidth, H = art.clientHeight, [tx, ty] = TARGET;
  if (!W || !H) return;
  const s = Math.max((W * tx) / GAP.x, (W * (1 - tx)) / (GAP.w - GAP.x), (H * ty) / GAP.y, (H * (1 - ty)) / (GAP.h - GAP.y));
  for (const img of art.querySelectorAll('img')) Object.assign(img.style, { width: `${GAP.w * s}px`, left: `${W * tx - GAP.x * s}px`, top: `${H * ty - GAP.y * s}px` });
  art.style.setProperty('--gx', `${W * tx}px`); art.style.setProperty('--gy', `${H * ty}px`);
  art.style.setProperty('--r', `${glow * Math.hypot(W, H) * 1.15}px`);
}
// With no picture chosen, the panel draws the two cut-out hands instead.
const adam = Object.assign(new Image(), { src: '/adam.webp' }), god = Object.assign(new Image(), { src: '/god.webp' });
function drawHands(c, t) {
  const CW = 260, CH = 128, { pose } = c.dataset, p = +c.dataset.p, g = c.getContext('2d');
  if (c.width !== CW * 2) { c.width = CW * 2; c.height = CH * 2; }
  g.setTransform(2, 0, 0, 2, 0, 0); g.clearRect(0, 0, CW, CH);
  const sep = pose === 'apart' ? 1 : pose === 'reach' ? 1 - p : pose === 'broken' ? 1.3 : 0, h = 190, w = (h * 776) / 500, life = Math.max(0, Math.min(1, 1 - sep)), y = (CH - h) / 2 + (pose === 'broken' ? 12 : 0);
  g.filter = `saturate(${life}) brightness(${pose === 'broken' ? 0.3 : 0.5 + 0.5 * life})`;
  if (adam.complete) g.drawImage(adam, CW / 2 - w - sep * 46, y, w, h);
  if (god.complete) g.drawImage(god, CW / 2 + sep * 46, y, w, h);
  g.filter = 'none'; g.strokeStyle = '#f2efe9';
  if (pose === 'work') for (let j = 0; j < 2; j++) { const ph = (t * 0.0009 + j / 2) % 1; g.globalAlpha = (1 - ph) * 0.7; g.beginPath(); g.arc(CW / 2, CH / 2, 8 + ph * 70, 0, 6.2832); g.stroke(); }
  g.globalAlpha = 1;
}
(function loop(t) { if (root.dataset.bg === 'none') document.querySelectorAll('canvas.art').forEach((c) => drawHands(c, t)); requestAnimationFrame(loop); })(0);

// Drawing. A screen is redrawn only when its HTML changed, and never under someone who is typing.
const NEEDS_RUN = new Set(['chooser', 'runthis', 'logs']);
const shown = { panel: '', ui: '', page: '', id: null };
function swap(el, html, id, force, scrollers) {
  const typing = el.contains(document.activeElement) && document.activeElement.matches('input, textarea');
  if (html === shown[el.id || 'panel'] || (typing && !force && id === shown.id)) return;
  const keep = id === shown.id ? [el.scrollTop, ...[...el.querySelectorAll(scrollers)].map((e) => e.scrollTop)] : [];
  el.innerHTML = html;
  shown[el.id || 'panel'] = html;
  el.scrollTop = keep[0] || 0;
  el.querySelectorAll(scrollers).forEach((e, i) => { e.scrollTop = keep[i + 1] || 0; });
}
function render(force) {
  if (nav && (!snap || !D() || (NEEDS_RUN.has(nav) && !run()))) nav = null;
  const state = resolve(), id = nav || state, wide = isFull();
  root.classList.toggle('wide', wide);
  glow = lit(look(state));
  if (wide) {
    const page = nav || (state === 'key' ? 'key' : null), working = look(state).pose === 'work';
    fs.className = `${working ? 'live' : ''}${page ? ' paged' : ''}`;
    art.classList.toggle('work', working && !page);
    art.style.setProperty('--beat', `${Math.round(1 / (0.0006 + ((snap && D() && run()?.stats?.tps) || 0) / 200000))}ms`);
    swap($('#ui'), `${navBar(page)}${page ? '' : homeHtml(state)}${notice()}`, id, force, '.apop');
    swap($('#page'), page ? pageHtml(page) : '', id, force, '.mlist,.mright');
    fitArt();
  } else {
    swap(screen, SCREENS[id]() + notice(), id, force, '.scroll');
    frame.id = `f-${id}`;
    const c = $('canvas.art', screen);
    screen.style.setProperty('--pr', `${c ? lit(c.dataset) * 460 : 0}px`);
  }
  shown.id = id;
}
function layout() {
  const s = Math.min(innerWidth / 260, innerHeight / 480, 1.5);
  Object.assign(frame.style, { transform: `scale(${s})`, left: `${(innerWidth - 260 * s) / 2}px` });
  screen.style.height = `${innerHeight / s}px`;
  render(true);
}

// Things a screen fetches when it opens.
const split = (text) => (text.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((x) => (/^(["']).*\1$/.test(x) ? x.slice(1, -1) : x));
async function loadCard(id) {
  if (!id || cards[id]) return;
  cards[id] = await api(scoped(`card?id=${encodeURIComponent(id)}`)).then((c) => ({ ...c, html: markdown(c.md) }), (e) => ({ error: e.message }));
  render();
}
const LOAD = {
  usage: async () => { usage = await api(scoped('usage')); render(); },
  endpoints: async () => { ends = null; ends = await api(scoped('endpoints')); render(); },
  machines: async () => { ({ peers, install: installCmd } = await api('tailscale').catch(() => ({ peers: [], install: null }))); render(); },
  logs: async () => { logText = 'Loading'; logText = (await api(scoped(`runs/${run().id}/logs?tail=60`))).text.trim() || 'Nothing was printed'; render(); },
  'adv-models': () => isFull() && loadCard(modelOpen || chosen()?.id),
  'model-page': () => loadCard(modelOpen),
  'app-update': () => send('app/check').catch(() => {}),
  edit: async () => {
    draft = null;
    const view = all().find((r) => r.id === modelOpen), raw = await api(scoped(`recipe?id=${encodeURIComponent(modelOpen)}`));
    draft = { raw, name: view.name, engine: view.engine, local: view.local, ctx: raw.launch.ctx || 0, cards: raw.launch.cards || 1, seqs: raw.launch.seqs || 1, kv: view.kv || 'Off', args: (raw.launch.args || []).map((x) => (/\s/.test(x) ? `'${x}'` : x)).join(' '), touched: new Set() };
    render(true);
  },
};
function go(id) {
  agentsOpen = false;
  if (id === 'home') { nav = null; trail.length = 0; return; }
  if (id === 'back') { nav = trail.pop() ?? null; return; }
  if (id === 'chooser' && isFull()) { agentsOpen = true; return; }
  if (nav !== id && !STATE[nav]) trail.push(nav);
  nav = id;
  Promise.resolve(LOAD[id]?.()).catch((e) => { note = e.message; render(true); });
}
setInterval(() => { if (nav === 'usage' || nav === 'machines' || nav === 'm-install') LOAD[nav === 'usage' ? 'usage' : 'machines']().catch(() => {}); }, 12000);

// What buttons do.
const stopRun = () => { const r = run(); opened = null; return r ? send(scoped(`runs/${r.id}`), 'DELETE') : null; };
// A GPU can take a few seconds to show as free after a stop.
async function startRun(recipe) {
  for (let tries = 0; ; tries++) {
    try { return await send(scoped('runs'), 'POST', { recipe }); } catch (e) { if (e.status !== 409 || !/free GPU/.test(e.message) || tries >= 6) throw e; await sleep(1500); }
  }
}
const saveHome = (h) => { snap.home = h; return send('settings', 'POST', { home: h }); };
const ACTS = {
  pick: (d) => { sel = d.id; },
  exp: (d) => { expanded = expanded === d.id ? null : d.id; },
  msel: (d) => { modelOpen = d.id; },
  start: () => startRun(chosen().id),
  stop: stopRun,
  retry: async () => { const { recipe } = run(); await stopRun(); await startRun(recipe); },
  tryfast: async () => { const fast = picks()[0]; await stopRun(); sel = fast.id; await startRun(fast.id); },
  switch: async (d) => { await stopRun(); sel = d.id; await startRun(d.id); go('home'); },
  open: async (d) => {
    const r = run(), id = d.agent || snap.harness;
    if (id !== snap.harness) await send('settings', 'POST', { harness: id });
    const out = await send('open', 'POST', { harness: id, device: dev === -1 ? 'self' : dev, port: r.id, folder: snap.folder });
    opened = r.id; agentsOpen = false;
    go('home');
    if (!out.opened) { command = out.command; go('runthis'); }
  },
  default: (d) => send('settings', 'POST', { harness: d.agent }),
  agent: (d) => send('agents', 'POST', { id: d.agent }),
  updateall: () => Promise.all(outdated().map((h) => send('agents', 'POST', { id: h.id }))),
  copy: async (d, el) => {
    const text = d.copy ?? $('.mono', el.closest('.screen')).innerText;
    await navigator.clipboard.writeText(text);
    el.classList.add('copied'); setTimeout(() => el.classList.remove('copied'), 1200);
    return 'keep';
  },
  use: (d) => { dev = +d.dev; sel = null; opened = null; go('home'); },
  uselinked: () => { const i = snap.devices.findIndex((x) => x.url === link.url); if (i >= 0) dev = i; sel = null; go('home'); },
  peer: (d) => { link = { name: d.name }; if (!d.app) return go('m-install'); form.host = `http://${d.ip}:${location.port || 18700}`; form.mkey = ''; return ACTS.connect({ peer: d.name }); },
  connect: async (d) => {
    const typed = (form.host || '').trim().replace(/\/$/, ''), url = /^https?:\/\//.test(typed) ? typed : `http://${typed}${/:\d+$/.test(typed) ? '' : ':18700'}`;
    link = { name: d.peer || url.replace(/^https?:\/\//, ''), url };
    nav = 'm-connect'; render(true);
    try { await send('devices', 'POST', { url, key: (form.mkey || '').trim() }); form.host = form.mkey = ''; if (nav === 'm-connect') nav = 'm-linked'; } catch (e) { link.error = e.message; if (nav === 'm-connect') nav = e.status === 401 ? 'addmachine' : 'm-fail'; if (e.status === 401) throw e; }
  },
  docker: () => send(scoped('docker/start')),
  key: () => { key = (form.key || '').trim(); store('key', key); needKey = false; },
  refresh: () => send(scoped('refresh')),
  bg: (d) => pickBg(d.bg),
  toggle: (d) => { const h = homeCfg(); return saveHome({ order: h.order, on: h.on.includes(d.k) ? h.on.filter((k) => k !== d.k) : [...h.on, d.k] }); },
  uspan: (d) => { uspan = d.v; },
  period: (d) => { period = d.v; },
  appauto: () => send('settings', 'POST', { autoUpdate: !snap.app.auto }),
  appupdate: () => send('app/update'),
  appcheck: () => send('app/check'),
  savetoken: async () => { await send(scoped('settings'), 'POST', { hfToken: form.token || '' }); form.token = ''; go('back'); },
  removetoken: async () => { await send(scoped('settings'), 'POST', { hfToken: '' }); go('back'); },
  draft: (d) => { draft[d.k] = d.k === 'kv' ? d.v : +d.v; draft.touched.add(d.k); },
  saveedit: async () => {
    const recipe = structuredClone(draft.raw), L = recipe.launch, args = split(draft.args), has = (k) => draft.touched.has(k);
    const set = (names, v) => { const i = args.findIndex((x) => names.includes(x)); if (i >= 0) args[i + 1] = String(v); };
    if (has('ctx')) { L.ctx = draft.ctx; set(FLAGS.ctx, draft.ctx); if (L.config?.text) L.config.text = L.config.text.replace(/(max_seq_len:\s*)\d+/, `$1${draft.ctx}`); }
    if (has('seqs')) { L.seqs = draft.seqs; set(FLAGS.seqs, draft.seqs); }
    if (has('cards')) { L.cards = draft.cards; set(FLAGS.cards, draft.cards); }
    if (has('kv')) { const i = args.indexOf('--kv-cache-dtype'); if (i >= 0) args.splice(i, 2); if (draft.kv !== 'Off') args.push('--kv-cache-dtype', draft.kv); }
    L.args = args;
    await send(scoped('recipes'), 'POST', recipe);
    go('back');
  },
  resetedit: async () => { await send(scoped(`recipes?id=${encodeURIComponent(draft.raw.id)}`), 'DELETE'); go('back'); },
  dismiss: () => { note = ''; },
  fs: () => {
    full = !full; store('la-full', full ? '1' : '0');
    if (full) root.requestFullscreen?.().catch(() => {}); else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  },
};
document.addEventListener('click', async (e) => {
  const cellEl = e.target.closest('[data-cell]');
  if (cellEl) { const box = cellEl.closest('.usec'); $('.cal .sel', box)?.classList.remove('sel'); cellEl.classList.add('sel'); $('[data-readout]', box).innerHTML = decodeURIComponent(cellEl.dataset.cell); return; }
  const el = e.target.closest('[data-act], [data-go], [data-nav]');
  if (agentsOpen && !e.target.closest('.apop, [data-go=chooser]')) { agentsOpen = false; if (!el) render(true); }
  if (!el || el.disabled || busy) return;
  const d = el.dataset;
  let keep = false;
  if (d.act) {
    busy = true; note = '';
    try { keep = (await ACTS[d.act](d, el)) === 'keep'; } catch (err) { note = err.message; busy = false; render(true); return; }
    busy = false;
  }
  if (d.nav) { trail.length = 0; nav = null; go(d.nav); trail.length = 0; } else if (d.go) go(d.go);
  if (!keep) render(true);
});
document.addEventListener('input', (e) => {
  const f = e.target.dataset.f;
  if (f === 'ctx') { draft.ctx = CTX[+e.target.value]; draft.touched.add('ctx'); $('[data-ctxlabel]', e.target.parentElement).textContent = `Context ${ctxOf(draft.ctx)}`; } else if (f === 'args') draft.args = e.target.value; else if (f) form[f] = e.target.value;
});
document.addEventListener('change', (e) => { if (e.target.dataset.save === 'folder') send('settings', 'POST', { folder: e.target.value.trim() }).then(() => { delete form.folder; }, (err) => { note = err.message; render(true); }); });
document.addEventListener('pointerover', (e) => { const c = e.target.closest('[data-cell]'); if (c && e.pointerType === 'mouse') c.click(); });
document.addEventListener('pointermove', (e) => {
  const g = e.target.closest?.('.growth');
  if (!g) return;
  const pts = JSON.parse(decodeURIComponent(g.dataset.points)), box = $('svg', g).getBoundingClientRect();
  const i = Math.max(0, Math.min(pts.length - 1, Math.round(((e.clientX - box.left) / box.width) * (pts.length - 1)))), x = (i / (pts.length - 1)) * 232;
  $('.gcross', g).setAttribute('x1', x); $('.gcross', g).setAttribute('x2', x);
  $('[data-gread]', g).innerHTML = `<b>${pts[i][0]}</b><span>${fmt(pts[i][1])} tokens so far</span>`;
});
// Home screen order: drag the handle, or focus it and use the arrow keys.
let dragRow = null;
const saveOrder = (list) => saveHome({ order: [...list.querySelectorAll('.hrow')].map((r) => r.dataset.key), on: homeCfg().on }).then(() => render(true));
document.addEventListener('pointerdown', (e) => { const g = e.target.closest('.grip'); if (!g) return; e.preventDefault(); dragRow = g.closest('.hrow'); dragRow.classList.add('dragging'); });
document.addEventListener('pointermove', (e) => {
  if (!dragRow) return;
  const over = [...dragRow.parentElement.querySelectorAll('.hrow')].find((r) => { const box = r.getBoundingClientRect(); return r !== dragRow && e.clientY > box.top && e.clientY < box.bottom; });
  if (over) { const box = over.getBoundingClientRect(); dragRow.parentElement.insertBefore(dragRow, e.clientY < box.top + box.height / 2 ? over : over.nextSibling); }
});
for (const type of ['pointerup', 'pointercancel']) document.addEventListener(type, () => { if (!dragRow) return; const list = dragRow.parentElement; dragRow.classList.remove('dragging'); dragRow = null; saveOrder(list); });
addEventListener('keydown', (e) => {
  const g = e.target.closest?.('.grip');
  if (g && /^Arrow(Up|Down)$/.test(e.key)) {
    e.preventDefault();
    const row = g.closest('.hrow'), list = row.parentElement, k = g.dataset.key;
    if (e.key === 'ArrowUp' && row.previousElementSibling) list.insertBefore(row, row.previousElementSibling);
    if (e.key === 'ArrowDown' && row.nextElementSibling) list.insertBefore(row.nextElementSibling, row);
    saveOrder(list).then(() => $(`.grip[data-key="${k}"]`, isFull() ? fs : screen)?.focus());
    return;
  }
  if (!isFull() || !snap || e.ctrlKey || e.metaKey || e.altKey || /INPUT|TEXTAREA/.test(e.target.tagName)) return;
  const state = resolve();
  if (/^[1-6]$/.test(e.key)) { trail.length = 0; nav = null; go(NAV[+e.key - 1][2]); trail.length = 0; } else if (e.key === 'Escape') { if (agentsOpen) agentsOpen = false; else go(nav === 'edit' ? 'back' : 'home'); } else if (!nav && state === 'off' && /^Arrow(Left|Right)$/.test(e.key)) { const list = shown3(), i = list.findIndex((r) => r.id === chosen().id); sel = list[(i + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length].id; } else if (!nav && state === 'off' && e.key === 'Enter' && e.target === document.body) ACTS.start().catch((err) => { note = err.message; render(true); });
  else return;
  render(true);
});
addEventListener('resize', layout);

async function follow() {
  for (;;) {
    try {
      const s = await api(`state?v=${version}`);
      if (snap && s.app.started !== snap.app.started) location.reload();
      version = s.v; snap = s; online = true; needKey = false;
      if (dev !== -1 && !snap.devices[dev]) dev = -1;
      applyBg(); loadOwn(); render();
    } catch (e) {
      if (e.status === 401) needKey = true; else online = false;
      render();
      await sleep(1500);
    }
  }
}
applyBg(); layout(); follow();
