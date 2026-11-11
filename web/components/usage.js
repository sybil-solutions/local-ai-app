// Usage: one period at a time, how it grew, which models served it, and a calendar of activity.
import { count, fmt, mins } from '../format.js';
import { html } from '../html.js';
import { D, s } from '../state.js';
import { Segmented } from './controls.js';
import { Label, Note } from './layout.js';

const LEVELS = ['#232220', '#45433f', '#6f6c66', '#9c9891', '#c8c4bc', '#f2efe9'];
const day = (iso) => new Date(`${iso}T00:00:00Z`);
const say = (d, o) => d.toLocaleDateString('en-US', { timeZone: 'UTC', ...o });
const plus = (d, n) => new Date(d.getTime() + n * 864e5);
const tokensOf = (x) => Object.values(x.models).reduce((n, v) => n + v, 0);
const shade = (level) => `background:${LEVELS[level]}`;

// Usage is very uneven, so shades are quantiles of the active periods rather than a straight scale.
function levels(values) {
  const on = values.filter(Boolean).sort((x, y) => x - y);
  const cuts = [0.25, 0.5, 0.75, 0.9].map((q) => on[Math.floor(q * on.length)]);
  return (v) => (v ? 1 + cuts.filter((c) => v >= c).length : 0);
}

// The Home widget: the last twelve weeks, from the snapshot. Pressing it opens Usage.
export function MiniUsage() {
  const known = new Map(D().usage.days.map((x) => [x.d, x.v])), level = levels([...known.values()]);
  const cells = Array.from({ length: 84 }, (_, i) => known.get(new Date(Date.now() - (83 - i) * 864e5).toISOString().slice(0, 10)) || 0);
  return html`<button class="wbtn" data-go="usage"><span class="wtitle">Usage<span>${fmt(D().usage.all)} served</span></span><span class="minical">${cells.map((v) => html`<i style="${shade(level(v))}"></i>`)}</span></button>`;
}

// The chosen period as { tokens, wrote, requests, sub, points: [{ label, v }], by: Map(model -> tokens) }.
function period() {
  const u = s.usage, now = new Date(), by = new Map(), add = (name, v) => by.set(name, (by.get(name) || 0) + v);
  if (s.span === 'run') {
    const r = u.runs[0];
    if (!r) return { tokens: 0, wrote: 0, requests: 0, sub: 'No model is running', points: [], by };
    const since = r.since || r.series[0]?.[0] || Date.now();
    add(r.name, r.tokens);
    const points = r.series.map(([t, v]) => ({ label: `${Math.max(0, Math.round((t - since) / 60000))} min`, v }));
    return { tokens: r.tokens, wrote: r.out, requests: r.req, sub: `${r.name} · running for ${mins((Date.now() - since) / 1000)} min`, points, by };
  }
  if (s.span === 'today') {
    let tokens = 0, wrote = 0, requests = 0;
    const points = [];
    for (let t = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(); t <= now.getTime(); t += 3600e3) {
      for (const [name, r] of Object.entries(u.hours[new Date(t).toISOString().slice(0, 13)] || {})) { tokens += r.in + r.out; wrote += r.out; requests += r.req; add(name, r.in + r.out); }
      points.push({ label: new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), v: tokens });
    }
    return { tokens, wrote, requests, sub: now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }), points, by };
  }
  const list = s.span === 'month' ? u.days.filter((x) => x.d.startsWith(now.toISOString().slice(0, 7))) : u.days;
  let tokens = 0;
  const points = list.map((x) => { for (const [name, v] of Object.entries(x.models)) add(name, v); return { label: say(day(x.d), { month: 'short', day: 'numeric' }), v: (tokens += tokensOf(x)) }; });
  const sub = s.span === 'month' ? now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : list.length ? `Since ${say(day(list[0].d), { month: 'short', day: 'numeric' })}` : 'Nothing served yet';
  return { tokens, wrote: list.reduce((n, x) => n + x.out, 0), requests: list.reduce((n, x) => n + x.req, 0), sub, points, by };
}

// What the chart says about one point. app.js writes it again as the pointer moves.
export const GrowthReadout = (label, tokens) => html`<b>${label}</b><span>${fmt(tokens)} tokens so far</span>`;
function Growth(points) {
  if (points.length < 2) return Note('Not enough yet to draw');
  const W = 232, H = 84, top = points.at(-1).v || 1, n = points.length - 1;
  const line = points.map((p, i) => `${((i / n) * W).toFixed(1)},${(H - 2 - (p.v / top) * (H - 6)).toFixed(1)}`).join(' ');
  return html`<div class="growth" data-points="${encodeURIComponent(JSON.stringify(points.map((p) => [p.label, p.v])))}"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Tokens served over time, rising to ${fmt(top)}"><line class="gbase" x1="0" y1="${H - 1}" x2="${W}" y2="${H - 1}"/><polygon class="garea" points="0,${H - 1} ${line} ${W},${H - 1}"/><polyline class="gline" points="${line}"/><line class="gcross" x1="${W}" y1="0" x2="${W}" y2="${H}"/></svg><div class="gaxis"><span>${points[0].label}</span><span>${points.at(-1).label}</span></div><div class="readout" data-gread>${GrowthReadout(points.at(-1).label, top)}</div></div>`;
}

// Days, weeks or months as a list of { d, label, tokens, requests }. A missing day is a real zero, not a gap.
function periods() {
  const known = new Map(s.usage.days.map((x) => [x.d, { tokens: tokensOf(x), requests: x.req }]));
  const last = day(new Date().toISOString().slice(0, 10)), oldest = s.usage.days[0] && day(s.usage.days[0].d);
  const days = [];
  for (let d = oldest && oldest < plus(last, -83) ? oldest : plus(last, -83); d <= last; d = plus(d, 1)) days.push({ d, ...(known.get(d.toISOString().slice(0, 10)) || { tokens: 0, requests: 0 }) });
  if (s.period === 'days') return days.map((x) => ({ ...x, label: say(x.d, { month: 'short', day: 'numeric' }) }));
  const groups = new Map();
  for (const x of days) {
    const k = s.period === 'weeks' ? plus(x.d, -((x.d.getUTCDay() + 6) % 7)).getTime() : Date.UTC(x.d.getUTCFullYear(), x.d.getUTCMonth(), 1);
    const g = groups.get(k) || { d: new Date(k), tokens: 0, requests: 0 };
    g.tokens += x.tokens; g.requests += x.requests;
    groups.set(k, g);
  }
  return [...groups.values()].map((g) => ({ ...g, label: s.period === 'weeks' ? `Week of ${say(g.d, { month: 'short', day: 'numeric' })}` : say(g.d, { month: 'long' }) }));
}

// One period's line under the calendar. A cell carries its own, already as markup, for app.js to show when it is pressed.
const Readout = (x) => html`<b>${x.label}</b><span>${fmt(x.tokens)} tokens · ${count(x.requests)} requests</span>`;
function Calendar() {
  const list = periods(), level = levels(list.map((x) => x.tokens)), last = list.length - 1;
  const Cell = (x, i, inner = '', style = '') => html`<button data-cell="${encodeURIComponent(String(Readout(x)))}" aria-label="${x.label}: ${fmt(x.tokens)} tokens" class="${i === last ? 'sel' : ''}" style="${shade(level(x.tokens))}${style}">${inner}</button>`;
  let grid;
  if (s.period === 'days') {
    const lead = (list[0].d.getUTCDay() + 6) % 7, seen = new Set();
    const months = list.filter((x) => !seen.has(x.d.getUTCMonth()) && seen.add(x.d.getUTCMonth())).filter((_, i, m) => m.length < 5 || i % 2 === 0);
    grid = html`<div class="cal-months">${months.map((x) => html`<span>${say(x.d, { month: 'short' })}</span>`)}</div><div class="cal days" style="--cols:${Math.ceil((lead + list.length) / 7)}">${Array.from({ length: lead }, () => html`<i></i>`)}${list.map((x, i) => Cell(x, i))}</div>`;
  } else if (s.period === 'weeks') grid = html`<div class="cal weeks">${list.map((x, i) => Cell(x, i))}</div>`;
  else grid = html`<div class="cal months">${list.map((x, i) => Cell(x, i, html`${say(x.d, { month: 'short' })}<b>${fmt(x.tokens)}</b>`, `;color:${level(x.tokens) >= 3 ? '#12120f' : 'inherit'}`))}</div>`;
  return html`${grid}<div class="readout" data-readout>${Readout(list[last])}</div>`;
}

export function UsageBody() {
  if (!s.usage) return Note('Loading');
  const u = period(), total = [...u.by.values()].reduce((n, v) => n + v, 0) || 1;
  const models = [...u.by].sort((x, y) => y[1] - x[1]).map(([name, v]) => html`<div class="umodel"><span>${name}</span><b>${fmt(v)}</b><span>${Math.round((v / total) * 100)}%</span><i><u style="width:${((v / total) * 100).toFixed(1)}%"></u></i></div>`);
  return html`<div class="ugrid"><section class="usec">${Segmented({ choices: [['run', 'This run'], ['today', 'Today'], ['month', 'Month'], ['all', 'All time']], on: s.span, act: 'span', kind: 'useg' })}<div class="hero"><b>${fmt(u.tokens)}</b><span>tokens · ${u.sub}</span></div><div class="umeta"><span><b>${fmt(u.wrote)}</b> generated</span><span><b>${count(u.requests)}</b> requests</span></div>${Label('Growth')}${Growth(u.points)}${Label('By model')}<div class="umodels">${models.length ? models : Note('Nothing yet')}</div></section><section class="usec">${Label('Activity')}${Segmented({ choices: [['days', 'Days'], ['weeks', 'Weeks'], ['months', 'Months']], on: s.period, act: 'period', kind: 'tabs' })}${Calendar()}<div class="legend"><span>Less</span>${LEVELS.map((c) => html`<i style="background:${c}"></i>`)}<span>More</span></div></section></div>`;
}
