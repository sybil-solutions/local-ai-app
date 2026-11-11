// The desktop layout: a top bar, the picture as the room, Home along the bottom, and every other screen as a page.
import { AgentList, AgentsFoot } from './components/agents.js';
import { Button, QuietButton } from './components/controls.js';
import { DeskPick, offLine, OpenButtons, runLine, StartButton, Stats, StopButton, Widget } from './components/home.js';
import { Dove, Icon } from './components/icons.js';
import { KeyValue, LayoutButton, MachineChip, ProgressBar, VersionFoot } from './components/layout.js';
import { CapNames, Caps, EditForm, facts, meta, ModelCard, OTHERS, UseButton } from './components/models.js';
import { ctxOf, fmt } from './format.js';
import { attrs, data, html } from './html.js';
import { Elsewhere, SCREENS, STATE } from './screens.js';
import { all, chosen, D, here, HOME, model, others, run, s, shown } from './state.js';

// [section, label, the screen it opens]. Keys 1 to 6 follow this order.
export const NAV = [['home', 'Home', 'home'], ['models', 'Models', 'adv-models'], ['agents', 'Agents', 'agent'], ['machines', 'Machines', 'machines'], ['usage', 'Usage', 'usage'], ['settings', 'Settings', 'home-edit']];
// Which section each screen belongs to, for the top bar and for how its page is laid out.
const SECTION = {
  'adv-models': 'models', 'model-page': 'models', edit: 'models', agent: 'agents', usage: 'usage',
  machines: 'machines', addmachine: 'machines', 'm-connect': 'machines', 'm-linked': 'machines', 'm-fail': 'machines', 'm-install': 'machines', 'm-setup': 'machines',
  settings: 'settings', advanced: 'settings', 'home-edit': 'settings', background: 'settings', endpoints: 'settings', registry: 'settings', 'hf-token': 'settings', 'app-update': 'settings',
};
const SETTINGS = [['home-edit', 'Home screen'], ['background', 'Background'], ['endpoints', 'API endpoints'], ['registry', 'Registry'], ['hf-token', 'Hugging Face token']];

// The top bar: the machine, the sections, and the running model with the layout switch.
export function NavBar(page) {
  if (!s.snap) return html`<header class="nav"><span class="mark chip">${Dove}<span>Local AI</span></span></header>`;
  const now = page ? SECTION[page] : 'home', r = D() && (s.dev === -1 || s.snap.devices[s.dev]?.online) && run(); // an offline machine's last snapshot is not live
  const live = r?.phase === 'ready' && html`<button class="nlive" data-nav="home" aria-label="${r.name} is running. Go to Home"><i></i><span class="nm">${r.name}</span><em>${fmt(r.stats?.tps || 0)} tok/s</em></button>`;
  return html`<header class="nav">${MachineChip({ nav: 'machines' })}<nav class="nlinks" aria-label="Sections">${NAV.map(([k, label, to], i) => html`<button${data({ nav: to })} title="${label} (${i + 1})"${attrs({ 'aria-current': now === k && 'page' })}>${label}</button>`)}</nav><div class="nr">${live}${LayoutButton()}</div></header>`;
}

// Home: the widgets you switched on in a row, then a strip with a title, something in the middle, and the buttons.
const Strip = (title, sub, middle, right) => html`<div class="ctitle"><div class="nname">${title}</div><div class="nsub">${sub}</div></div>${middle}<div class="cright">${right}</div>`;
export function DeskHome(id) {
  let strip;
  if (id === 'off') {
    const c = chosen();
    strip = Strip(c.name, offLine(c), html`<div class="cpicks">${HOME().includes('models') && shown().length > 1 && shown().map(DeskPick)}</div>`, html`${QuietButton({ label: 'More models', nav: 'adv-models' })}${StartButton()}`);
  } else if (id === 'awake' || id === 'opened') {
    const r = run(), sub = [runLine(r, id === 'opened'), all().find((x) => x.id === r.recipe)?.engine, r.ctx && ctxOf(r.ctx)].filter(Boolean).join(' · ');
    strip = Strip(r.name, sub, html`<div>${HOME().includes('stats') && Stats(r)}</div>`, html`${s.agentsOpen && html`<div class="apop">${AgentList('open')}</div>`}${OpenButtons()}${StopButton()}`);
  } else {
    const st = STATE[id]();
    strip = Strip(st.word, st.line, html`<div class="cprog">${st.bar && ProgressBar(st.p)}${st.extra}</div>`, st.btns);
  }
  const widgets = s.snap && D() && !s.agentsOpen ? HOME().filter((k) => k === 'usage' || k === 'gpus') : [];
  return html`<div class="cfade"></div><div class="cbot">${widgets.length > 0 && html`<div class="cwid">${widgets.map(Widget)}</div>`}<div class="cin">${strip}</div></div>`;
}

// Models: the whole list on the left, the chosen one open beside it.
function ModelsPage(page) {
  const r = model(s.modelOpen) || chosen();
  if (!r) return html`<div class="pwrap pg"><div class="ptitle">Models</div><div class="psub">None run on ${here()}</div>${Elsewhere()}</div>`;
  const row = (x) => html`<button class="mitem${x.id === r.id ? ' sel' : ''}${x.id === chosen()?.id ? ' cur' : ''}"${data({ act: 'model', id: x.id, go: 'adv-models' })}><span class="at"><b data-tag="${run()?.recipe === x.id ? 'Running' : 'Selected'}">${x.name}</b><small>${x.why || meta(x)}</small></span><span class="ics">${Caps(x)}</span></button>`;
  const right = page === 'edit' ? html`<div class="pg"><div class="screen">${EditForm()}</div></div><button class="pback" data-go="adv-models">Cancel</button>`
    : html`<div><div class="ptitle">${r.name}</div><div class="psub" style="margin-bottom:0">${meta(r)}</div>${r.why && html`<div class="psub why">${r.why}</div>`}</div><div class="mcaps">${CapNames(r)}</div>${KeyValue(facts(r, true))}<div class="macts">${UseButton(r)}${!r.host && Button({ label: 'Edit', act: 'model', go: 'edit', data: { id: r.id } })}</div>${ModelCard(r)}`;
  return html`<div class="msplit"><div class="mleft"><div class="ptitle">Models</div><div class="psub">${all().length} run on this machine, newest first</div><div class="mlist">${all().map(row)}${others().length > 0 && html`<div class="label group">${OTHERS}</div>${others().map(row)}`}</div></div><div class="mright">${right}</div></div>`;
}

// A screen as a page: Models and Settings have layouts of their own, the rest are the panel's screen in a column.
export function DeskPage(page) {
  const body = (id) => html`<div class="screen">${SCREENS[id]()}</div>`;
  if (SECTION[page] === 'models') return ModelsPage(page);
  if (page === 'agent') return html`<div class="pwrap pg"><div class="ptitle">Agents</div><div class="psub">Pick the one Open uses, or install another</div>${AgentList('agent')}<div class="pfield">${AgentsFoot()}</div></div>`;
  if (SECTION[page] === 'settings') {
    const on = page === 'settings' || page === 'advanced' ? 'home-edit' : page;
    return html`<div class="ssplit"><div class="smenu">${SETTINGS.map(([id, label]) => html`<button class="${id === on ? 'on' : ''}"${data({ nav: id })}>${label}</button>`)}${VersionFoot()}</div><div class="pg">${body(on)}</div></div>`;
  }
  const top = NAV.some((n) => n[2] === page) || page === 'key';
  return html`<div class="pwrap pg${page === 'usage' ? ' wide' : ''}">${!top && html`<button class="pback" data-go="back">${Icon('left', 14)}Back</button>`}${body(page)}</div>`;
}
