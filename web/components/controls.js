// Things you press or type into.
import { attrs, data, html } from '../html.js';
import { Icon } from './icons.js';

// A button. It does something (`act` names an entry in ACTS), opens a screen (`go`) or jumps to a section (`nav`);
// `data` rides along as data-* values for the action. kind is '', 'go' (the main action) or 'neg' (stop, cancel).
export const Button = ({ label, act, go, nav, kind = '', data: values, disabled, title, aria, style }) => html`<button class="btn ${kind}"${data({ act, go, nav, ...values })}${attrs({ disabled, title, 'aria-label': aria, style })}>${label}</button>`;
// The main button with a small one beside it for the other choices.
export const Split = (main, side) => html`<div class="two">${main}${side}</div>`;
// A link that looks like a button, for a page outside the app.
export const LinkButton = ({ label, href, kind = '' }) => html`<a class="btn ${kind}" href="${href}" target="_blank" rel="noopener">${label}</a>`;
export const QuietButton = ({ label, go, nav, style }) => html`<button class="quiet"${data({ go, nav })}${attrs({ style })}>${label}</button>`;
export const TextLink = ({ label, go, href, style }) => (href
  ? html`<a class="link" href="${href}" target="_blank" rel="noopener"${attrs({ style })}>${label}</a>`
  : html`<button class="link"${data({ go })}>${label}</button>`);
// An on-off switch. `label` is what a screen reader says it switches.
export const Toggle = ({ on, act, data: values, label }) => html`<button class="switch${on ? ' on' : ''}" role="switch" aria-checked="${on ? 'true' : 'false'}" aria-label="${label}"${data({ act, ...values })}></button>`;
// A labelled text field. `name` is where what is typed is kept (s.form[name]); `save` saves it when you leave the field.
export const Field = ({ name, label, value = '', placeholder, type = 'text', save }) => html`<div class="label">${label}</div><input class="field"${attrs({ type, placeholder })}${data({ f: name, save })} spellcheck="false" autocomplete="off" aria-label="${label}" value="${value}">`;
export const Select = ({ label, save, value, options }) => html`<div class="label">${label}</div><select class="field"${data({ save })} aria-label="${label}">${options.map((o) => html`<option value="${o.id}"${attrs({ selected: o.id === value })}>${o.name}</option>`)}</select>`;
// A few choices in a row, one of them on. Each choice is [value, label].
export const Segmented = ({ choices, on, act, data: values, kind = 'seg' }) => html`<div class="${kind}">${choices.map(([v, label]) => html`<button class="${v === on ? 'on' : ''}"${data({ act, v, ...values })}>${label}</button>`)}</div>`;
// Tabs that open screens. Each tab is [screen, label].
export const ScreenTabs = (tabs, on) => html`<div class="tabs two">${tabs.map(([go, label]) => html`<button class="${go === on ? 'on' : ''}"${data({ go })}>${label}</button>`)}</div>`;
// Text that is copied when you press it. `show` is what is displayed when that differs (a key shown as dots).
export const CopyField = (text, show = text) => html`<button class="addr"${data({ act: 'copy', copy: text })}><span>${show}</span><small>Copy</small></button>`;
export const IconButton = ({ icon, size, go, act, label, cls }) => html`<button${attrs({ class: cls })}${data({ go, act })} aria-label="${label}" title="${label}">${Icon(icon, size)}</button>`;
