// The pieces a screen is laid out with: its top bar, headings, rows and tables.
import { attrs, data, html } from '../html.js';
import { canFull, here, s } from '../state.js';
import { IconButton } from './controls.js';
import { Dove, Icon } from './icons.js';

// The app's name with its mark.
export const Wordmark = html`<span class="mark">${Dove}Local AI</span>`;
// Shown before the machine's name while the page shows another machine than the one it is open on. The name itself is blurred.
const Remote = () => s.dev !== -1 && html`<span class="where">Remote</span>`;
// The machine being shown. Pressing it opens Machines.
export const MachineChip = ({ go, nav }) => html`<button class="mark chip"${data({ go, nav })} aria-label="Machine: ${here()}"><i></i>${Remote()}<span class="who">${here()}</span></button>`;
export const LayoutButton = () => canFull() && IconButton({ icon: s.full ? 'shrink' : 'grow', act: 'fs', label: s.full ? 'Exit fullscreen' : 'Fullscreen' });
// The top of a panel screen: Home's (the machine, the layout switch, Settings), a screen's (the name and Close), or bare.
export const HomeBar = () => (s.snap
  ? html`<div class="top">${MachineChip({ go: 'machines' })}<span class="topr chip">${LayoutButton()}${IconButton({ icon: 'menu', go: 'settings', label: 'Settings' })}</span></div>`
  : html`<div class="top">${Wordmark}</div>`);
export const CloseBar = (go = 'back') => html`<div class="top">${Wordmark}${IconButton({ icon: 'close', go, label: 'Close', cls: 'x' })}</div>`;
export const BareBar = html`<div class="top">${Wordmark}</div>`;
// What went wrong, or what to do next, over the screen until dismissed.
export const Notice = () => s.note && html`<button class="notice" data-act="dismiss" title="Dismiss">${s.note}</button>`;

export const Head = (text, style) => html`<div class="head"${attrs({ style })}>${text}</div>`;
export const Label = (text, { group, extra } = {}) => html`<div class="label${group ? ' group' : ''}"${attrs(extra || {})}>${text}</div>`;
// A line of explanation, set left.
export const Note = (text) => html`<div class="line" style="text-align:left">${text}</div>`;
export const Line = (text) => html`<div class="line">${text}</div>`;
export const Spacer = html`<div class="sp"></div>`;
// The part of a screen that scrolls. `home` lays Home's blocks out; `sort` marks a list whose rows can be dragged.
export const Scroll = (children, { home, sort, style } = {}) => html`<div class="scroll${home ? ' home' : ''}"${attrs({ 'data-sort': sort, style })}>${children}</div>`;
export const Box = (text, { mono, style } = {}) => html`<div class="box${mono ? ' mono' : ''}"${attrs({ style })}>${text}</div>`;

// A row that opens a screen.
export const NavRow = (name, go) => html`<button class="item"${data({ go })}>${name}<small>${Icon('right', 14)}</small></button>`;
// A row with a name, a line under it and something on the right. With `act` or `go` the whole row is a button.
export const Row = ({ name, sub, right, act, go, data: values, disabled, quiet, before }) => {
  const body = html`${before ? html`<span class="bgrow">${before}<span><b>${name}</b><small>${sub}</small></span></span>` : html`<span><b>${name}</b><small>${sub}</small></span>`}<small>${right}</small>`;
  return act || go ? html`<button class="item"${data({ act, go, ...values })}${attrs({ disabled })}>${body}</button>` : html`<div class="item${quiet ? ' busy' : ''}">${body}</div>`;
};
// A row with a switch on the right. `grip` adds the handle a row is dragged by.
export const SwitchRow = ({ name, sub, toggle, grip, hidden, key }) => html`<div class="hrow${grip ? '' : ' plain'}${hidden ? ' hidden' : ''}"${data({ key })}>${grip}<span class="hname"><b>${name}</b><small>${sub}</small></span>${toggle}</div>`;
// Names on the left, values on the right. Each row is [name, value].
export const KeyValue = (rows, { small } = {}) => html`<div class="kv${small ? ' small' : ''}">${rows.map(([k, v]) => html`<span class="label">${k}</span><b>${v}</b>`)}</div>`;
export const ProgressBar = (fraction) => html`<div class="bar"><i style="width:${(Math.max(0, Math.min(1, fraction)) * 100).toFixed(1)}%"></i></div>`;
// The app's version at the foot of Settings, with the update when there is one.
export function VersionFoot() {
  const v = s.snap.app;
  const right = v.latest ? html`<button data-go="app-update">Update${/^\d/.test(v.latest) ? ` to ${v.latest}` : ''}</button>` : v.can ? html`<span>Up to date</span>` : '';
  return html`<div class="vfoot"><button class="vname" data-go="app-update">Local AI ${v.version}</button>${right}</div>`;
}
