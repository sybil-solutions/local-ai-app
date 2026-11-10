// The desktop layout: a top bar, the painting as the room, Home along the bottom, and every other screen as a page.
import { all, chosen, D, here, HOME, run, s, shown } from './state.js';
import { agentList, agentsFoot, BLOCKS, cardHtml, editBody, elsewhere, offLine, openBtns, runLine, SCREENS, startBtn, STATE, stopBtn, useBtn } from './screens.js';
import { bar, capNames, caps, ctxOf, esc, facts, fmt, fsBtn, icon, kv, meta, running, vfoot } from './ui.js';

// [section, label, the screen it opens]. Keys 1 to 6 follow this order.
export const NAV = [['home', 'Home', 'home'], ['models', 'Models', 'adv-models'], ['agents', 'Agents', 'agent'], ['machines', 'Machines', 'machines'], ['usage', 'Usage', 'usage'], ['settings', 'Settings', 'home-edit']];
const SECTION = {
  'adv-models': 'models', 'model-page': 'models', edit: 'models', agent: 'agents', usage: 'usage',
  machines: 'machines', addmachine: 'machines', 'm-connect': 'machines', 'm-linked': 'machines', 'm-fail': 'machines', 'm-install': 'machines',
  settings: 'settings', advanced: 'settings', 'home-edit': 'settings', background: 'settings', endpoints: 'settings', registry: 'settings', 'hf-token': 'settings', 'app-update': 'settings',
};
const SETTINGS = [['home-edit', 'Home screen'], ['background', 'Background'], ['endpoints', 'API endpoints'], ['registry', 'Registry'], ['hf-token', 'Hugging Face token']];

export function navBar(page) {
  if (!s.snap) return '<header class="nav"><span class="mark chip"><i></i><span>Local AI</span></span></header>';
  const now = page ? SECTION[page] : 'home', r = D() && run();
  const links = NAV.map(([k, label, to], i) => `<button data-nav="${to}" title="${label} (${i + 1})"${now === k ? ' aria-current="page"' : ''}>${label}</button>`).join('');
  const live = r?.phase === 'ready' ? `<button class="nlive" data-nav="home" aria-label="${esc(r.name)} is running. Go to Home"><i></i><span class="nm">${esc(r.name)}</span><em>${fmt(r.stats?.tps || 0)} tok/s</em></button>` : '';
  return `<header class="nav"><button class="mark chip" data-nav="machines" aria-label="Machine: ${esc(here())}"><i></i><span class="who">${esc(here())}</span></button><nav class="nlinks" aria-label="Sections">${links}</nav><div class="nr">${live}${fsBtn()}</div></header>`;
}

// Home: a title, something in the middle, and the buttons on the right.
export function homeHtml(id) {
  const strip = (title, sub, middle, right) => `<div class="ctitle"><div class="nname">${title}</div><div class="nsub">${sub}</div></div>${middle}<div class="cright">${right}</div>`;
  let inner;
  if (id === 'off') {
    const c = chosen();
    const pick = (r) => `<button class="cpick${r.id === c.id ? ' on' : ''}" data-act="pick" data-id="${esc(r.id)}"><span>${esc(r.name)}</span><small>${[r.tier, r.speed.c1 && `${Math.round(r.speed.c1)}/s`].filter(Boolean).join(' · ')}</small></button>`;
    inner = strip(esc(c.name), offLine(c), `<div class="cpicks">${HOME().includes('models') ? shown().map(pick).join('') : ''}</div>`, `<button class="quiet" data-nav="adv-models">More models</button>${startBtn()}`);
  } else if (id === 'awake' || id === 'opened') {
    const r = run(), sub = [esc(runLine(r, id === 'opened')), all().find((x) => x.id === r.recipe)?.engine, r.ctx && ctxOf(r.ctx)].filter(Boolean).join(' · ');
    inner = strip(esc(r.name), sub, `<div>${HOME().includes('stats') ? running(r) : ''}</div>`, `${s.agentsOpen ? `<div class="apop">${agentList('open')}</div>` : ''}${openBtns()}${stopBtn()}`);
  } else {
    const st = STATE[id]();
    inner = strip(esc(st.word), esc(st.line), `<div class="cprog">${st.bar ? bar(st.p * 100) : ''}${st.extra || ''}</div>`, st.btns || '');
  }
  const extras = s.snap && D() && !s.agentsOpen ? HOME().filter((k) => k === 'usage' || k === 'gpus') : [];
  return `<div class="cfade"></div>${extras.length ? `<div class="cwid">${extras.map((k) => `<div class="widget">${BLOCKS[k]()}</div>`).join('')}</div>` : ''}<div class="cin">${inner}</div>`;
}

// Models: the whole list on the left, the chosen one open beside it.
function modelsPage(page) {
  const r = all().find((x) => x.id === s.modelOpen) || chosen();
  if (!r) return `<div class="pwrap pg"><div class="ptitle">Models</div><div class="psub">None run on ${esc(here())}</div>${elsewhere()}</div>`;
  const row = (x) => `<button class="mitem${x.id === r.id ? ' sel' : ''}${x.id === chosen()?.id ? ' cur' : ''}" data-act="model" data-id="${esc(x.id)}" data-go="adv-models">`
    + `<span class="at"><b data-tag="${run() ? 'Running' : 'Selected'}">${esc(x.name)}</b><small>${meta(x)}</small></span><span class="ics">${caps(x)}</span></button>`;
  const right = page === 'edit' ? `<div class="pg"><div class="screen">${editBody()}</div></div><button class="pback" data-go="adv-models">Cancel</button>`
    : `<div><div class="ptitle">${esc(r.name)}</div><div class="psub" style="margin-bottom:0">${meta(r)}</div></div><div class="mcaps">${capNames(r)}</div><div class="kv">${kv(facts(r, true))}</div>`
      + `<div class="macts">${useBtn(r)}<button class="btn" data-act="model" data-id="${esc(r.id)}" data-go="edit">Edit</button></div>${cardHtml(r)}`;
  return `<div class="msplit"><div class="mleft"><div class="ptitle">Models</div><div class="psub">${all().length} run on this machine, newest first</div><div class="mlist">${all().map(row).join('')}</div></div><div class="mright">${right}</div></div>`;
}

export function pageHtml(page) {
  const body = (id) => `<div class="screen">${SCREENS[id]()}</div>`;
  if (SECTION[page] === 'models') return modelsPage(page);
  if (page === 'agent') return `<div class="pwrap pg"><div class="ptitle">Agents</div><div class="psub">Pick the one Open uses, or install another</div>${agentList('agent')}<div class="pfield">${agentsFoot()}</div></div>`;
  if (SECTION[page] === 'settings') {
    const on = page === 'settings' || page === 'advanced' ? 'home-edit' : page;
    return `<div class="ssplit"><div class="smenu">${SETTINGS.map(([id, label]) => `<button class="${id === on ? 'on' : ''}" data-nav="${id}">${label}</button>`).join('')}${vfoot()}</div><div class="pg">${body(on)}</div></div>`;
  }
  const top = NAV.some((n) => n[2] === page) || page === 'key';
  return `<div class="pwrap pg${page === 'usage' ? ' wide' : ''}">${top ? '' : `<button class="pback" data-go="back">${icon('left', 14)}Back</button>`}${body(page)}</div>`;
}
