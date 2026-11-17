// Home: the model's name and state over the picture, and the blocks you switch on under Settings › Home screen.
import { fmt, gb, mins } from '../format.js';
import { data, html } from '../html.js';
import { agentName, chosen, D, group, hasRoom, HOME, homeCfg, run, shown } from '../state.js';
import { Button, QuietButton, Split } from './controls.js';
import { Icon } from './icons.js';
import { Line } from './layout.js';
import { PickRow } from './models.js';
import { MiniUsage } from './usage.js';

// The picture's place in a panel screen. app.js paints the picture behind it; pose and p say how lit it is:
// apart (dark), reach (p of the way), touch and work (fully lit), broken (dark).
const Art = (pose, p = 0) => html`<canvas class="art" data-pose="${pose}" data-p="${p}" aria-hidden="true"></canvas>`;
// The picture with a word and a line under it.
export const Status = ({ pose, word, line = '', p = 0 }) => html`${Art(pose, p)}<div class="word">${word}</div><div class="line">${line}</div>`;

// The line under the chosen model when nothing runs: why it can't start, what starting it costs, or that it is ready.
export const offLine = (c) => (!hasRoom(c) ? 'The GPUs are in use by another program' : !c.ready ? `${c.sizeGb ? `${Math.round(c.sizeGb)} GB` : 'Model'} to download`
  : group()?.untested ? `Made for ${group().untested} · untested here` : c.loadS ? `Starts in about ${mins(c.loadS)} min` : 'Ready to start');
export const runLine = (r, isOpen) => (isOpen ? `${agentName() || 'Agent'} is open` : r.byStudio ? 'Running · started by Local Studio' : r.external ? 'Running · started outside Local AI' : 'Running');

const Stat = (label, value, live) => html`<div class="stat${live ? ' live' : ''}"><b>${fmt(value)}</b><span class="label">${label}</span></div>`;
// The running model's numbers. Lifetime tokens opens Usage.
export const Stats = (r) => html`<div class="stats">${Stat('Decode tok/s', r.stats?.tps || 0, true)}${Stat(r.stats?.ppsEst ? 'Prefill tok/s (est.)' : 'Prefill tok/s', r.stats?.pps || 0)}${Stat('Session tokens', r.stats?.used || 0)}<button class="linkstat" data-go="usage">${Stat('Lifetime tokens', D().usage.all)}</button></div>`;
// Memory in use on each GPU. A GPU that reports no memory of its own shows a dash.
const GpuBars = () => html`<div class="wbtn"><span class="wtitle">GPUs</span>${D().gpus.map((g) => html`<div class="gpu"><span>GPU ${g.index}</span><i><u style="width:${g.total ? Math.min(100, ((g.busy && g.used == null ? g.total : g.used || 0) / g.total) * 100).toFixed(0) : 0}%"></u></i><span>${!g.total ? '—' : g.used == null ? `${gb(g.total)} GB${g.busy ? ', in use' : ''}` : `${gb(g.used)} of ${gb(g.total)} GB`}</span></div>`)}</div>`;

export const StartButton = () => Button({ label: chosen().ready ? 'Run' : 'Download', act: 'start', kind: 'go', disabled: !hasRoom() });
export const OpenButtons = () => Split(agentName() ? Button({ label: `Open ${agentName()}`, act: 'open', kind: 'go' }) : Button({ label: 'Choose an agent', go: 'chooser', kind: 'go' }), Button({ label: Icon('down'), go: 'chooser', aria: 'Choose an agent' }));
// A model Local Studio started is stopped by asking Local Studio; any other that Local AI did not start is left alone.
export const StopButton = () => (!run().external || run().byStudio) && Button({ label: 'Stop', act: 'stop', kind: 'neg' });

// The panel's Home. `phase` is off (nothing runs), run or opened. The model's name and state are always there, at the
// Picture block's place in your order; the picture itself only when that block is on. Without the picks, the name of
// the chosen model stands in for them.
const Title = (phase) => {
  const picture = homeCfg().on.includes('hands');
  if (phase === 'off') return html`${picture && Art('apart')}${!HOME().includes('models') && html`<div class="word">${chosen().name}</div>`}${Line(offLine(chosen()))}`;
  return html`${picture && Art('work', 1)}<div class="word">${run().name}</div>${Line(phase === 'opened' ? `Running · ${runLine(run(), true)}` : runLine(run()))}`;
};
const BLOCKS = {
  hands: Title,
  models: (phase) => phase === 'off' && html`<div>${shown().map(PickRow)}${QuietButton({ label: 'More models', go: 'adv-models', style: 'margin-top:4px' })}</div>`,
  stats: (phase) => phase !== 'off' && Stats(run()),
  usage: MiniUsage,
  gpus: GpuBars,
};
export const HomeBlocks = (phase) => { const on = HOME(); return homeCfg().order.map((k) => (k === 'hands' || on.includes(k)) && BLOCKS[k](phase)); };
// A block on its own, for the desktop layout's widgets.
export const Widget = (k) => html`<div class="widget">${BLOCKS[k]()}</div>`;
// One of the desktop's picks along the bottom of Home.
export const DeskPick = (r) => html`<button class="cpick${r.id === chosen().id ? ' on' : ''}"${data({ act: 'pick', id: r.id })}><span>${r.name}</span><small>${[r.tier, r.speed.c1 && !r.speed.legacy && `${Math.round(r.speed.c1)}/s`].filter(Boolean).join(' · ')}</small></button>`;
