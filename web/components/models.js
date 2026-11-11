// A model, as a row, as its facts, and as its own page.
import { ctxOf, fmt, monthOf } from '../format.js';
import { data, html } from '../html.js';
import { cardKey, chosen, group, run, s } from '../state.js';
import { Button, Segmented } from './controls.js';
import { Icon } from './icons.js';
import { Head, KeyValue, Label, Note, Scroll } from './layout.js';

// "Sep 2026 · vLLM · 256K"
export const meta = (r) => [r.released && monthOf(r.released), r.engine, ctxOf(r.ctx)].filter(Boolean).join(' · ');

// What a model can do: [icon, name, the value or true]. Shown as small icons in lists and with their names on its page.
const CAPS = [['vision', 'Vision', (r) => r.vision], ['think', 'Thinking', (r) => r.think], ['tools', 'Tool calls', (r) => r.tools], ['kv', 'KV cache', (r) => r.kv], ['gpu', 'GPUs', (r) => r.cards > 1 && r.cards]];
const capsOf = (r) => CAPS.map(([k, name, has]) => [k, name, has(r)]).filter((c) => c[2]);
export const Caps = (r) => capsOf(r).map(([k, name, v]) => {
  const tip = `${name}${v === true ? '' : `: ${v}`}`, mark = html`<span class="ic" role="img" aria-label="${tip}" title="${tip}">${Icon(k, 14)}</span>`;
  return k === 'gpu' ? html`<span class="ics" style="gap:0">${mark}<span class="icn">${v}</span></span>` : mark;
});
export const CapNames = (r) => capsOf(r).map(([k, name, v]) => html`<span class="cap">${Icon(k, 14)}${k === 'gpu' ? `${v} GPUs` : v === true ? name : `${name} ${v}`}</span>`);

// A model's numbers. The desktop page has room for two more rows; the panel names the engine instead.
export const facts = (r, wide) => [
  ['Intelligence', r.smart === null ? '—' : Math.round(r.smart)], ['C1 speed', r.speed.c1 ? `${Math.round(r.speed.c1)} tok/s${r.speed.legacy ? ', from an older test' : ''}` : '—'], ['Context', ctxOf(r.ctx)],
  ...(wide ? [['Requests at once', r.seqs], ['GPUs', r.cards]] : [['Engine', r.engine]]), ['KV cache', r.kv || '—'], ['Download', r.sizeGb ? `${Math.round(r.sizeGb)} GB` : '—'],
];
export const ModelDetail = (r) => html`<div class="mdetail"><div class="ics">${Caps(r)}</div>${KeyValue(facts(r), { small: true })}</div>`;
// Recipes that run outside Docker (MLX on a Mac) can't be edited on the Edit screen, so they get no Edit button.
export const EditButton = (r, style) => !r.host && Button({ label: 'Edit', act: 'model', go: 'edit', data: { id: r.id }, style });

// Home's list of picks in the panel: press one to choose it, the plus for its details.
export const PickRow = (r) => html`<div class="mrow${r.id === chosen().id ? ' on' : ''}"><div class="mhead"><button class="mpick"${data({ act: 'pick', id: r.id })}><span>${r.name}</span><small>${r.tier || ''}</small></button><button class="plus"${data({ act: 'expand', id: r.id })} aria-label="Details">${Icon(s.expanded === r.id ? 'minus' : 'plus', 14)}</button></div>${s.expanded === r.id && html`${ModelDetail(r)}<div class="mdetail" style="padding-top:0">${EditButton(r)}</div>`}</div>`;
// A model in the panel's full list.
export const ListRow = (r) => html`<div class="arow"><button class="ahead"${data({ act: 'model', id: r.id, go: 'model-page' })}><span class="at"><b>${r.name}</b><small>${r.why || meta(r)}</small></span><span class="ics">${Caps(r)}<span class="chev">${Icon('right', 14)}</span></span></button></div>`;

// The model's Hugging Face card, once it has been fetched. Its Markdown was turned into this app's own markup by markdown.js.
// With it come the recipe's own notes from whoever published it, and what it needs of the machine beside the cards.
const needsOf = (n) => [n?.ram && `${Math.ceil(n.ram)} GB of memory`, n?.disk && `${Math.ceil(n.disk)} GB of disk${n.nvme ? ' on an NVMe drive' : ''}`].filter(Boolean).join(' and ');
export function ModelCard(r) {
  const c = s.cards[cardKey(r.id)];
  if (!c || c.error) return html`${Label('Model card', { group: true })}${Note(c ? c.error : 'Loading')}`;
  const needs = needsOf(c.needs), recipe = (needs || c.notes) && html`${Label('From the recipe', { group: true })}${needs && Note(`Needs ${needs} beside the GPUs`)}${c.notes && html`<div class="mdcard notes">${c.notes}</div>`}`;
  if (!c.repo) return recipe;
  return html`${recipe}${Label('Model card', { group: true })}<div class="cardsrc"><a href="https://huggingface.co/${c.repo}" target="_blank" rel="noopener">${c.repo}</a>${c.license ? ` · ${c.license}` : ''}${c.downloads != null ? ` · ${fmt(c.downloads)} downloads` : ''}</div><div class="mdcard">${c.html}</div>`;
}
// The main button on a model's page: start it, pick it for Home, or swap it for the one running. Nothing for the one running.
export function UseButton(r) {
  if (r.why) return Button({ label: 'Can’t be started here', disabled: true });
  const live = run();
  if (live) return live.recipe !== r.id && Button({ label: live.external ? 'Run' : 'Switch to this model', act: 'switch', kind: 'go', data: { id: r.id } });
  return r.id === chosen()?.id ? Button({ label: r.ready ? 'Run' : 'Download', act: 'start', go: 'home', kind: 'go' }) : Button({ label: 'Use', act: 'pick', go: 'home', kind: 'go', data: { id: r.id } });
}

// The context lengths the Edit slider steps through.
export const CTX = [8192, 16384, 32768, 65536, 131072, 204800, 262144, 524288, 1048576];
const Choice = (k, list) => Segmented({ choices: list.map((v) => [v, v]), on: s.draft[k], act: 'draft', data: { k } });
// Edit: the few settings every engine has, and the recipe's arguments as text.
export function EditForm() {
  const d = s.draft;
  if (!d) return Note('Loading');
  return html`${Head(d.name)}${Note(d.engine)}${Scroll(html`
    <div class="label" data-ctxlabel>Context ${ctxOf(d.ctx)}</div><input type="range" data-f="ctx" min="0" max="${CTX.length - 1}" value="${CTX.findIndex((c) => c >= d.ctx)}" aria-label="Context">
    ${Label('GPUs')}${Choice('cards', [1, 2, 4, 8].filter((n) => n <= Math.max(d.cards, group()?.gpus.length || 1)))}
    ${Label('Requests at once')}${Choice('seqs', [1, 2, 4, 8])}${d.engine === 'vLLM' && html`${Label('KV cache')}${Choice('kv', ['Off', 'fp8'])}`}
    ${Label('Arguments')}<textarea class="box" data-f="args" rows="6" spellcheck="false" aria-label="Arguments">${d.args}</textarea>`, { home: true, style: 'gap:8px' })}${Button({ label: 'Save', act: 'saveedit', kind: 'go' })}${d.local && Button({ label: 'Reset', act: 'resetedit' })}`;
}
