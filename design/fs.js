
// Fullscreen layer over the frozen panel: the painting, a top bar, and real desktop pages.
const STAGE = new Set(['off', 'waking', 'awake', 'opened', 'sleeping', 'nothing', 'nogpu']);
const NONE = new Set(['nothing', 'nogpu']);
const gpuOf = (n) => (n === 'pop-os' ? '4× RTX PRO 6000' : 'Connected');
const LIVE = new Set(['awake', 'opened']);
const FRESCO = { x: 982, y: 566, w: 2000, h: 1015 };
const PHONE = { x: 130, y: 116, top: 368 };
let GAP = FRESCO, ownGap = null;
const TARGET = [0.5, 0.36];
const NAV = [['home', 'Home'], ['models', 'Models', 'adv-models'], ['agents', 'Agents', 'agent'], ['machines', 'Machines', 'machines'], ['usage', 'Usage', 'usage'], ['settings', 'Settings', 'home-edit']];
const SECTION = { background: 'settings', 'model-page': 'models', 'app-update': 'settings', 'app-updating': 'settings', 'app-fail': 'settings', 'adv-models': 'models', edit: 'models', allmodels: 'models', agent: 'agents', machines: 'machines', addmachine: 'machines', 'm-connect': 'machines', 'm-install': 'machines', 'm-installing': 'machines', 'm-linked': 'machines', unreachable: 'machines', usage: 'usage', settings: 'settings', advanced: 'settings', 'home-edit': 'settings', endpoints: 'settings', registry: 'settings', 'hf-token': 'settings' };
const SETTINGS = [['home-edit', 'Home screen'], ['background', 'Background'],['endpoints', 'API endpoints'], ['registry', 'Registry'], ['hf-token', 'Hugging Face token']];
let stage = 'off', page = null, advance = 0, realFull = false, agentsOpen = false, modelEditing = false, shownPage = null;
let selected = null;
const PAINT = 'data:image/webp;base64,__ART__';
const blobUrl = (data) => URL.createObjectURL(new Blob([Uint8Array.from(atob(data.split(',')[1]), (c) => c.charCodeAt(0))], { type: data.slice(5, data.indexOf(';')) }));
const paintUrl = blobUrl(PAINT);
let ownUrl = null;
const fs = Object.assign(document.createElement('div'), { id: 'fs', innerHTML: `<div id="art" aria-hidden="true"><img class="mono" alt="" src="${paintUrl}"><img class="color" alt="" src="${paintUrl}"><i class="glow"></i><i class="spark"></i></div><div id="ui"></div><div id="page"></div>` });
const picker = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*', hidden: true });
document.body.append(fs, picker);
const $ = (s) => fs.querySelector(s);
const root = document.documentElement;
root.style.setProperty('--paint', `url("${paintUrl}")`);
// One choice drives both the desktop painting and the phone screens.
function applyBg() {
  const own = bg === 'own' && ownGap, src = own ? ownUrl : paintUrl, g = own ? ownGap : FRESCO;
  GAP = g; root.dataset.bg = own || bg !== 'own' ? bg : 'gray';
  $('#art').querySelectorAll('img').forEach((i) => { if (i.src !== src) i.src = src; });
  const k = own ? Math.max(260 / g.w, PHONE.top / g.h) : 0.56;
  root.style.setProperty('--pimg', `url("${src}")`);
  root.style.setProperty('--psz', `${g.w * k}px ${g.h * k}px`);
  root.style.setProperty('--ppos', `${PHONE.x - g.x * k}px ${PHONE.y - g.y * k}px`);
}
function loadOwn(data, then) {
  const img = new Image();
  img.onload = () => { if (ownUrl) URL.revokeObjectURL(ownUrl); ownUrl = blobUrl(data); ownGap = { x: img.width / 2, y: img.height / 2, w: img.width, h: img.height }; root.style.setProperty('--own', `url("${ownUrl}")`); then(); };
  img.src = data;
}
function pickBg(k) {
  if (k === 'own' && (!ownGap || bg === 'own')) { picker.click(); return; }
  bg = k; store('la-bg', k); applyBg(); render();
}
picker.onchange = () => {
  const f = picker.files[0]; picker.value = '';
  if (!f) return;
  const img = new Image();
  img.onload = () => {
    const k = Math.min(1, 2400 / Math.max(img.width, img.height)), c = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * k), height: Math.round(img.height * k) });
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(img.src);
    ownPic = c.toDataURL('image/jpeg', 0.86); store('la-bg-own', ownPic);
    loadOwn(ownPic, () => { bg = 'own'; store('la-bg', 'own'); applyBg(); render(); fitArt(); });
  };
  img.src = URL.createObjectURL(f);
};
applyBg();
if (ownPic) loadOwn(ownPic, () => { applyBg(); fitArt(); });
const isFull = () => full && canFull();
const on = () => LIVE.has(stage);
const rec = () => (tier === 'custom' ? editing : recOf[tier]);
const extras = () => HOME.filter((k) => k === 'usage' || k === 'gpus');
const fill = () => '<div class="bar"><i class="fill"></i></div>';
const startBtn = () => b(tier === 'custom' ? 'Start' : `Start ${m().m}`, 'waking', 'go');
const stopBtn = () => b('Stop', 'sleeping', 'neg');
const openBtns = () => `<div class="two">${b(`Open ${agent}`, 'opened', 'go')}${b('⌄', 'chooser', '', 'aria-label="Choose an agent"')}</div>`;
const progressWord = () => (stage === 'waking' ? `Starting ${m().m}` : 'Stopping');
const subline = () => `${stage === 'opened' ? `${agent} is open` : 'Running'} · ${rec().engine} · ${rec().ctx}`;
const tiersShown = () => (tier === 'custom' ? [...TIERS, 'custom'] : TIERS);
const sectionOf = () => (page ? SECTION[page] || null : 'home');

function navBar() {
  const now = sectionOf();
  const links = NAV.map(([k, label], i) => `<button data-nav="${k}" title="${label} (${i + 1})"${now === k ? ' aria-current="page"' : ''}>${label}</button>`).join('');
  const live = on() ? `<button class="nlive" data-nav="home" aria-label="${m().m} is running. Go to Home"><i></i><span class="nm">${m().m}</span><em><span data-now="${m().now}">${fmt(m().now)}</span> tok/s</em></button>` : '';
  return `<header class="nav"><button class="mark chip" data-nav="machines" aria-label="Machine: ${here}"><i></i><span>${here}</span></button><nav class="nlinks" aria-label="Sections">${links}</nav><div class="nr">${live}${fsBtn()}</div></header>`;
}
function homeHtml() {
  const pick = (k) => `<button class="cpick${k === tier ? ' on' : ''}" data-go="off" data-tier="${k}">${T[k].m}<small>${T[k].n}${T[k].speeds[0] ? ` · ${T[k].speeds[0][1]}/s` : ''}</small></button>`;
  const o = others(), [word, line] = noneSay(stage);
  const inner = NONE.has(stage) ? `<div class="ctitle"><div class="nname">${word}</div><div class="nsub">${line}</div></div><div class="cpicks">${o.map((n, i) => `<button class="cpick${i ? '' : ' on'}" data-go="off" data-use="${n}">${n}<small>${gpuOf(n)}</small></button>`).join('')}</div><div class="cright">${o.length ? `<button class="quiet" data-go="addmachine">Add machine</button>${b(`Use ${o[0]}`, 'off', 'go', `data-use="${o[0]}"`)}` : useElsewhere()}</div>`
    : stage === 'off' ? `<div class="ctitle"><div class="nname">${m().m}</div><div class="nsub">${untested ? `Made for ${untested} · untested on this GPU` : 'Starts in about 2 min'}</div></div><div class="cpicks">${HOME.includes('models') ? tiersShown().map(pick).join('') : ''}</div><div class="cright"><button class="quiet" data-nav="models">More models</button>${startBtn()}</div>`
    : on() ? `<div class="ctitle"><div class="nname">${m().m}</div><div class="nsub">${subline()}</div></div><div>${HOME.includes('stats') ? running(m().now, m().pre, 18240, LIFETIME) : ''}</div><div class="cright">${agentsOpen ? `<div class="apop">${agentList('opened')}</div>` : ''}${openBtns()}${stopBtn()}</div>`
    : `<div class="ctitle"><div class="nname">${progressWord()}</div></div><div class="cprog">${fill()}</div><div class="cright">${stage === 'waking' ? b('Cancel', 'off', 'neg') : ''}</div>`;
  const widgets = extras().length ? `<div class="cwid">${extras().map((k) => `<div class="widget">${WBODY[k]()}</div>`).join('')}</div>` : '';
  return `<div class="cfade"></div>${widgets}<div class="cin">${inner}</div>`;
}
const capLabels = (r) => [r.vision && [icon('vision'), 'Vision'], r.think && [icon('think'), 'Thinking'], r.tools && [icon('tools'), 'Tool calls'], r.kv && [icon('kv'), `KV cache ${r.kv}`], r.cards > 1 && [icon('gpu'), `${r.cards} GPUs`]].filter(Boolean).map(([i, t]) => `<span class="cap">${i}${t}</span>`).join('');
function modelsPage() {
  if (NONE.has(stage)) return `<div class="pwrap pg"><div class="ptitle">Models</div><div class="psub">None run on ${here}</div>${useElsewhere(others()[0])}</div>`;
  const i = selected ?? Math.max(0, RECIPES.indexOf(rec())), r = RECIPES[i], isCurrent = r === rec();
  const list = RECIPES.map((x, n) => `<button class="mitem${n === i ? ' sel' : ''}${x === rec() ? ' cur' : ''}" data-msel="${n}"><span class="at"><b data-tag="${on() ? 'Running' : 'Selected'}">${x.name}</b><small>${x.date} · ${x.engine} · ${x.ctx}</small></span><span class="ics">${caps(x)}</span></button>`).join('');
  const useBtn = on() ? (isCurrent ? '' : b('Switch to this model', 'waking', 'go', `data-all="${i}"`)) : isCurrent ? b(`Start ${r.name}`, 'waking', 'go') : b('Use this model', 'off', 'go', `data-all="${i}"`);
  const right = modelEditing ? `<div class="pg">${frameBody('edit')}</div><button class="pback" data-medit="0">Cancel</button>`
    : `<div><div class="ptitle">${r.name}</div><div class="psub" style="margin-bottom:0">${r.date} · ${r.engine}</div></div><div class="mcaps">${capLabels(r)}</div><div class="kv"><span class="label">Intelligence</span><b>${r.ai ?? '—'}</b><span class="label">C1 speed</span><b>${r.c1 ? `${r.c1} tok/s` : '—'}</b><span class="label">Context</span><b>${r.ctx}</b><span class="label">Requests at once</span><b>${r.seqs || 1}</b><span class="label">GPUs</span><b>${r.cards || 1}</b><span class="label">KV cache</span><b>${r.kv || '—'}</b><span class="label">Download</span><b>${r.gb}</b></div><div class="macts">${useBtn}<button class="btn" data-medit="1">Edit</button></div>${cardHtml(r)}`;
  return `<div class="msplit"><div class="mleft"><div class="ptitle">Models</div><div class="psub">${RECIPES.length} run on this machine, newest first</div><div class="mlist">${list}</div></div><div class="mright">${right}</div></div>`;
}
const frameBody = (id) => `<div class="screen">${F.find((f) => f[0] === id)[4]()}</div>`;
const backTo = (html) => { const t = html.match(/data-go="([\w-]+)" aria-label="Close"/)?.[1]; if (t === 'back') return '<button class="pback" data-go="back">‹ Back</button>'; if (!t || t === 'off' || t === 'settings' || t === 'advanced' || NAV.some((n) => n[2] === t && t !== 'machines' && t !== 'adv-models')) return ''; const name = NAV.find((n) => n[2] === t)?.[1] || F.find((f) => f[0] === t)[1]; return `<button class="pback" data-go="${t}">‹ ${name}</button>`; };
function pageHtml() {
  if (SECTION[page] === 'models') return modelsPage();
  if (page === 'agent') return `<div class="pwrap pg"><div class="ptitle">Agents</div><div class="psub">Pick the one Open uses, or install another</div>${agentList('agent')}<div class="pfield"><div class="label">Folder</div><div class="field">~/code</div></div></div>`;
  if (SECTION[page] === 'settings') { const cur_ = page === 'settings' || page === 'advanced' ? 'home-edit' : page; return `<div class="ssplit"><div class="smenu">${SETTINGS.map(([id, label]) => `<button class="${id === cur_ ? 'on' : ''}" data-go="${id}">${label}</button>`).join('')}${vfoot()}</div><div class="pg">${frameBody(cur_)}</div></div>`; }
  const body = frameBody(page), back = backTo(body);
  return `<div class="pwrap pg${page === 'usage' ? ' wide' : ''}">${back}${body}</div>`;
}
function fitArt() {
  const a = $('#art'), W = a.clientWidth, H = a.clientHeight, [tx, ty] = TARGET;
  if (!W || !H) return;
  const s = Math.max(W * tx / GAP.x, W * (1 - tx) / (GAP.w - GAP.x), H * ty / GAP.y, H * (1 - ty) / (GAP.h - GAP.y));
  a.querySelectorAll('img').forEach((i) => { i.style.width = `${GAP.w * s}px`; i.style.left = `${W * tx - GAP.x * s}px`; i.style.top = `${H * ty - GAP.y * s}px`; });
  a.style.setProperty('--gx', `${W * tx}px`); a.style.setProperty('--gy', `${H * ty}px`);
  a.style.setProperty('--r', (stage === 'waking' || on()) ? `${Math.hypot(W, H) * 1.15}px` : '0px');
}
function fsRender() {
  document.documentElement.classList.toggle('wide', isFull());
  if (!isFull()) return;
  fs.className = `${on() ? 'live' : ''}${page ? ' paged' : ''}`;
  const a = $('#art');
  a.classList.toggle('rising', stage === 'waking');
  a.classList.toggle('work', on() && !page);
  a.style.setProperty('--beat', `${Math.round(1 / (0.0006 + m().now / 200000))}ms`);
  $('#ui').innerHTML = `${navBar()}${page ? '' : homeHtml()}`;
  const p = $('#page'), scrollers = page === shownPage ? [...p.querySelectorAll('.mlist,.mright')].map((e) => e.scrollTop) : [], top = page === shownPage ? p.scrollTop : 0;
  p.innerHTML = page ? pageHtml() : '';
  p.querySelectorAll('.mlist,.mright').forEach((e, i) => { e.scrollTop = scrollers[i] || 0; });
  p.scrollTop = top; shownPage = page;
  p.querySelectorAll('canvas.art').forEach((c) => draw(c, 1400));
  fitArt();
}
const settle = (next) => { stage = next; if (!page) mark(stage); fsRender(); schedule(); };
const schedule = () => {
  clearTimeout(advance);
  if (stage === 'waking') advance = setTimeout(() => settle('awake'), 3200);
  if (stage === 'sleeping') advance = setTimeout(() => settle('off'), 1600);
};
const frozenRender = render, frozenGo = go;
render = () => { frozenRender(); fsRender(); };
go = (id, remember = true) => {
  if (!isFull()) { if (STAGE.has(id)) stage = id; return frozenGo(id, remember); }
  if (id === 'chooser') { agentsOpen = !agentsOpen; fsRender(); return; }
  if (!pos.has(id)) return;
  if (remember && id !== cur) trail.push(cur);
  agentsOpen = false;
  if (id === 'model-page') { selected = advOpen; page = 'adv-models'; mark('model-page'); fsRender(); return; }
  if (id === 'edit') { modelEditing = true; selected = RECIPES.indexOf(editing); page = 'adv-models'; mark('adv-models'); fsRender(); return; }
  modelEditing = false;
  if (STAGE.has(id)) { if (id === 'off' && page && on()) page = null; else { stage = id; page = null; } } else page = id;
  if (id === 'waking' || id === 'off') selected = null;
  mark(page || stage); fsRender(); schedule();
};
const goNav = (k) => { const entry = NAV.find((n) => n[0] === k); go(entry[2] || stage, true); };
function setFull(next) {
  if (next === full) return;
  full = next;
  if (next) {
    if (cur === 'chooser') page = 'agent'; else if (STAGE.has(cur)) { stage = cur; page = null; } else page = cur;
    document.documentElement.requestFullscreen?.().catch(() => {});
    render(); schedule();
    return;
  }
  clearTimeout(advance);
  const back = page || stage;
  page = null; agentsOpen = false; modelEditing = false;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  render(); frozenGo(back, false);
}
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-fs]')) { setFull(!full); return; }
  if (agentsOpen && isFull() && !e.composedPath().some((n) => n.matches?.('.apop, [data-go=chooser]'))) { agentsOpen = false; fsRender(); }
});
document.addEventListener('fullscreenchange', () => { if (realFull && !document.fullscreenElement && full) setFull(false); realFull = !!document.fullscreenElement; });
fs.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-nav]');
  if (nav) { e.stopImmediatePropagation(); goNav(nav.dataset.nav); return; }
  const sel = e.target.closest('[data-msel]');
  if (sel) { e.stopImmediatePropagation(); selected = +sel.dataset.msel; modelEditing = false; fsRender(); return; }
  if (modelEditing && e.target.closest('.mright [data-go=model-page]')) { e.stopImmediatePropagation(); modelEditing = false; fsRender(); return; }
  const med = e.target.closest('[data-medit]');
  if (med) { e.stopImmediatePropagation(); modelEditing = med.dataset.medit === '1'; if (modelEditing) editing = RECIPES[selected ?? Math.max(0, RECIPES.indexOf(rec()))]; render(); return; }
});
fs.addEventListener('click', onTap);
// Home screen order: drag the handle, or focus it and use the arrow keys.
function saveOrder(list) { ORDER = [...list.querySelectorAll('.hrow')].map((r) => r.dataset.key); HOME = ORDER.filter((k) => HOME.includes(k)); render(); }
let dragRow = null;
document.addEventListener('pointerdown', (e) => {
  const g = e.target.closest('.grip'); if (!g) return;
  e.preventDefault(); e.stopPropagation(); dragRow = g.closest('.hrow'); dragRow.classList.add('dragging'); g.setPointerCapture?.(e.pointerId);
}, true);
document.addEventListener('pointermove', (e) => {
  if (!dragRow) return;
  const list = dragRow.parentElement, rows = [...list.querySelectorAll('.hrow')];
  const over = rows.find((r) => { const b = r.getBoundingClientRect(); return r !== dragRow && e.clientY > b.top && e.clientY < b.bottom; });
  if (over) { const b = over.getBoundingClientRect(); list.insertBefore(dragRow, e.clientY < b.top + b.height / 2 ? over : over.nextSibling); }
});
const endDrag = () => { if (!dragRow) return; const list = dragRow.parentElement; dragRow.classList.remove('dragging'); dragRow = null; saveOrder(list); };
document.addEventListener('pointerup', endDrag); document.addEventListener('pointercancel', endDrag);
document.addEventListener('keydown', (e) => {
  const g = e.target.closest?.('.grip'); if (!g || !/^Arrow(Up|Down)$/.test(e.key)) return;
  e.preventDefault(); e.stopPropagation();
  const row = g.closest('.hrow'), list = row.parentElement, key = g.dataset.key;
  if (e.key === 'ArrowUp' && row.previousElementSibling) list.insertBefore(row, row.previousElementSibling);
  if (e.key === 'ArrowDown' && row.nextElementSibling) list.insertBefore(row.nextElementSibling, row);
  saveOrder(list);
  document.querySelector(`${isFull() ? '#page' : '.frame.cur'} .grip[data-key="${key}"]`)?.focus();
}, true);
// Growth chart: the readout follows the pointer.
document.addEventListener('pointermove', (e) => {
  const gr = e.target.closest?.('.growth'); if (!gr) return;
  const pts = JSON.parse(decodeURIComponent(gr.dataset.points)), svg = gr.querySelector('svg'), box = svg.getBoundingClientRect();
  const i = Math.max(0, Math.min(pts.length - 1, Math.round((e.clientX - box.left) / box.width * (pts.length - 1)))), x = (i / Math.max(1, pts.length - 1)) * 232;
  const c = gr.querySelector('.gcross'); c.setAttribute('x1', x); c.setAttribute('x2', x);
  gr.querySelector('[data-gread]').innerHTML = `<b>${pts[i][0]}</b><span>${fmt(pts[i][1])} tokens so far</span>`;
});
fs.addEventListener('pointerover', (e) => { const c = e.target.closest('[data-cell]'); if (c && e.pointerType === 'mouse') showCell(c); });
addEventListener('keydown', (e) => {
  if (!isFull() || e.ctrlKey || e.metaKey || e.altKey || /INPUT|TEXTAREA/.test(e.target.tagName)) return;
  if (/^[1-6]$/.test(e.key)) { goNav(NAV[+e.key - 1][0]); return; }
  if (e.key === 'Escape') { if (agentsOpen) { agentsOpen = false; fsRender(); } else if (modelEditing) { modelEditing = false; fsRender(); } else if (page) goNav('home'); return; }
  if (page || stage !== 'off' || (e.target !== document.body && e.target.tagName !== 'HTML')) return;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { const list = tiersShown(), i = list.indexOf(tier); tier = list[(i + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length]; render(); }
  if (e.key === 'Enter') go('waking');
});
let wasFull = canFull();
addEventListener('resize', () => { if (canFull() !== wasFull) { wasFull = canFull(); render(); } else if (isFull()) fitArt(); });
fsRender();
// Preview only: ?demo=nothing, ?demo=nogpu or ?demo=untested opens this page as a laptop whose GPU has no recipe of its own.
const DEMO = new URLSearchParams(location.search).get('demo');
if (NONE.has(DEMO) || DEMO === 'untested') { here = 'gpu-sandbox'; linked.add(here); }
if (NONE.has(DEMO)) { gpuHere = 'GT 1030'; render(); go(DEMO, false); }
if (DEMO === 'untested') { untested = 'RTX 3090'; Object.assign(T.fast, { m: 'Gemma 4 12B', gb: '8 GB', speeds: [] }); Object.assign(T.balanced, { m: 'Qwen3.8-27B', gb: '17 GB', speeds: [] }); Object.assign(T.smart, { m: 'Flash-Next', gb: '22 GB', speeds: [] }); render(); }
