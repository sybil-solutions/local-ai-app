// Every screen, as a function that returns its markup. The panel shows one at a time; the desktop layout shows the
// same ones as pages. A screen only arranges components (web/components/): it reads the state and decides what goes where.
import { AgentList, AgentsFoot } from './components/agents.js';
import { Button, CopyField, Field, LinkButton, ScreenTabs, TextLink, Toggle } from './components/controls.js';
import { HomeBlocks, OpenButtons, StartButton, Status, StopButton } from './components/home.js';
import { Grip } from './components/icons.js';
import { BareBar, Box, CloseBar, Head, HomeBar, KeyValue, Label, Line, NavRow, Note, ProgressBar, Row, Scroll, Spacer, SwitchRow, VersionFoot } from './components/layout.js';
import { EditButton, EditForm, ListRow, meta, ModelCard, ModelDetail, UseButton } from './components/models.js';
import { UsageBody } from './components/usage.js';
import { ago, count, mins } from './format.js';
import { data, html } from './html.js';
import { all, D, here, homeCfg, model, newer, picks, run, s, sections } from './state.js';

// Another machine that can run models, offered when this one can't.
export function Elsewhere() {
  const other = s.dev !== -1 && s.snap.groups.some((g) => g.recipes.length) ? { i: -1, name: s.snap.name } : s.snap.devices.find((x) => x.i !== s.dev && x.online && x.state?.groups.some((g) => g.recipes.length));
  return other ? html`${Button({ label: `Use ${other.name}`, act: 'use', kind: 'go', data: { dev: other.i } })}${Button({ label: 'Add machine', go: 'addmachine' })}` : Button({ label: 'Add machine', go: 'addmachine', kind: 'go' });
}

// Screens that are one picture, one word, one line and a few buttons: { pose, p, bar, word, line, extra, btns }.
// Both layouts draw them from this.
const Cancel = () => Button({ label: 'Cancel', act: 'stop', kind: 'neg' });
const Back = () => Button({ label: 'Back', go: 'machines' });
export const STATE = {
  boot: () => ({ pose: 'apart', word: 'Local AI', line: 'Looking for your GPU' }),
  cantconnect: () => ({ pose: 'broken', word: 'Can’t connect', line: 'Trying again' }),
  unreachable: () => ({ pose: 'broken', word: 'Can’t reach it', line: `${here()} · ${s.snap.devices[s.dev].error || 'Offline'}`, btns: Button({ label: 'This computer', act: 'use', kind: 'go', data: { dev: -1 } }) }),
  'app-updating': () => ({ pose: 'reach', p: 0.5, bar: true, word: 'Updating', line: `Local AI ${/^\d/.test(s.snap.app.latest || '') ? s.snap.app.latest : ''}`, extra: Line('Models keep running') }),
  waking: () => ({ pose: 'reach', p: run().view.p, bar: true, word: run().name, line: `Starting · ${run().view.line}`, btns: Cancel() }),
  slow: () => ({ pose: 'reach', p: run().view.p, bar: true, word: 'Taking longer', line: `Usually ${mins(run().expected)} min, now ${mins((Date.now() - run().since) / 1000)}`, btns: Cancel() }),
  dl: () => ({ pose: 'reach', p: run().progress || 0, bar: true, word: 'Downloading', line: run().detail || 'Getting the model', btns: Cancel() }),
  sleeping: () => ({ pose: 'reach', p: 0.2, word: 'Stopping', line: 'Freeing the GPU' }),
  failed: () => {
    const r = run(), f = r.view, fast = picks()[0];
    const first = f.word === 'Ran out of room' && fast && fast.id !== r.recipe ? Button({ label: 'Try Fast', act: 'tryfast', kind: 'go' })
      : f.word === 'Locked model' ? Button({ label: 'Add token', go: 'hf-token', kind: 'go' }) : Button({ label: 'Try again', act: 'retry', kind: 'go' });
    return { pose: 'broken', word: f.word, line: f.line, extra: TextLink({ label: 'Engine output', go: 'logs' }), btns: html`${first}${Button({ label: 'Back', act: 'stop' })}` };
  },
  // A model started outside Local AI can't be restarted or stopped from here, so it gets no buttons.
  noreply: () => ({ pose: 'broken', word: 'No reply', line: run().view.line, btns: !run().external && html`${Button({ label: 'Restart', act: 'retry', kind: 'go' })}${Button({ label: 'Stop', act: 'stop', kind: 'neg' })}` }),
  needsdocker: () => ({ pose: 'apart', word: 'Needs Docker', line: 'One free install', btns: LinkButton({ label: 'Install Docker', href: 'https://docs.docker.com/engine/install/', kind: 'go' }) }),
  dockeroff: () => ({ pose: 'apart', word: 'Docker is off', line: 'Turn it on to start models', btns: Button({ label: 'Turn on', act: 'docker', kind: 'go' }) }),
  nogpu: () => ({ pose: 'apart', word: 'No GPU here', line: 'This computer can’t run models', btns: Elsewhere() }),
  nothing: () => ({ pose: 'apart', word: 'Nothing fits', line: `No tested models for ${D().groups[0]?.name || 'this GPU'}`, btns: Elsewhere() }),
  nocatalog: () => ({ pose: 'apart', word: 'No models yet', line: D().catalog.error ? 'Can’t reach the model list' : 'Getting the model list', btns: Button({ label: 'Try again', act: 'refresh', kind: 'go' }) }),
  'm-connect': () => ({ pose: 'reach', p: 0.5, word: 'Connecting', line: s.link.name, btns: Button({ label: 'Cancel', go: 'machines', kind: 'neg' }) }),
  'm-linked': () => ({ pose: 'touch', p: 1, word: 'Connected', line: s.link.name, btns: html`${Button({ label: 'Use this machine', act: 'uselinked', kind: 'go' })}${Back()}` }),
  'm-fail': () => ({ pose: 'broken', word: 'Can’t reach it', line: s.link.error, btns: html`${Button({ label: 'Try again', go: 'addmachine', kind: 'go' })}${Back()}` }),
  'm-setup': () => ({ pose: 'reach', p: 0.5, word: 'Setting up', line: `Installing Local AI on ${s.link.name}`, extra: Line('This can take a minute'), btns: Back() }),
  // Reached only when this computer could not install it there itself: why, and the command that does it by hand.
  'm-install': () => {
    const byHand = s.link.manual !== false;
    return { pose: 'apart', word: 'Not set up', line: s.link.error || `Run this on ${s.link.name}, then come back`,
      extra: byHand && Box(s.install || 'Install Local AI there first', { mono: true, style: 'margin-top:8px' }),
      btns: html`${byHand && s.install && Button({ label: 'Copy', act: 'copy', kind: 'go', data: { copy: s.install } })}${Back()}` };
  },
};
const Plain = (id) => { const st = STATE[id](); return html`${HomeBar()}${Status(st)}${st.bar && ProgressBar(st.p)}${st.extra}${Spacer}${st.btns}`; };
// How lit the picture is: fully while a model works, part way while one starts, dark otherwise.
export const look = (id) => (id === 'awake' || id === 'opened' ? { pose: 'work', p: 1 } : STATE[id] ? STATE[id]() : { pose: 'apart', p: 0 });
export const lit = ({ pose, p }) => (pose === 'work' || pose === 'touch' ? 1 : pose === 'reach' ? +p || 0 : 0);

const BACKGROUNDS = [['clouds', 'Clouds', 'Sky'], ['fresco', 'The Creation of Adam', 'Michelangelo'], ['own', 'Your own picture', 'Choose a file'], ['none', 'None', 'Plain dark']];
const BLOCK_NAMES = { hands: ['Picture', 'Behind the model’s name, lit while it runs'], models: ['Model picks', 'Fast, balanced and smart'], stats: ['Live stats', 'Speed and tokens, live'], usage: ['Usage', 'Tokens served, by day'], gpus: ['GPUs', 'Memory on each GPU'] };
const SettingsTabs = (on) => ScreenTabs([['settings', 'General'], ['advanced', 'Advanced']], on);
const yes = (apis, k) => (apis ? (apis.includes(k) ? 'Yes' : 'No') : '—');
const typed = (name, label, placeholder, type) => Field({ name, label, placeholder, type, value: s.form[name] || '' });

// A machine you are connected to. One that can't update itself (it was installed from here) gets its update from here.
function DeviceRow(m) {
  const use = data({ act: 'use', dev: m.i }), body = html`<span><b>${m.name}</b><small>${m.sub}</small></span>`;
  if (!m.stale) return html`<button class="item"${use}>${body}<small>${m.i === s.dev ? 'In use' : ''}</small></button>`;
  return html`<div class="item vrow"><button class="vpick"${use}>${body}</button><button class="inst vact"${data({ act: 'peerupdate', ip: m.ip, name: m.name })}>Update</button></div>`;
}

export const SCREENS = {
  off: () => html`${HomeBar()}${Scroll(HomeBlocks('off'), { home: true })}${StartButton()}`,
  awake: () => html`${HomeBar()}${Scroll(HomeBlocks('run'), { home: true })}${OpenButtons()}${StopButton()}`,
  opened: () => html`${HomeBar()}${Scroll(HomeBlocks('opened'), { home: true })}${OpenButtons()}${StopButton()}`,
  chooser: () => html`${CloseBar()}${Head('Open with')}${Scroll(AgentList('open'))}`,
  runthis: () => html`${CloseBar()}${Head('Run this')}${Box(s.command, { mono: true })}${Spacer}${Button({ label: 'Copy', act: 'copy', kind: 'go' })}`,
  key: () => html`${BareBar}${Head('Enter the key', 'margin-top:24px')}${Note('It’s under Settings › API endpoints in the Local AI app on that machine, or in its file ~/.local-ai/config.json')}${typed('key', 'Key', 'Key')}${Spacer}${Button({ label: 'Connect', act: 'key', kind: 'go' })}`,
  settings: () => html`${CloseBar('home')}${SettingsTabs('settings')}${NavRow('Home screen', 'home-edit')}${NavRow('Background', 'background')}${NavRow('Agents and folder', 'agent')}${NavRow('Machines', 'machines')}${NavRow('Usage', 'usage')}${Spacer}${VersionFoot()}`,
  advanced: () => html`${CloseBar('home')}${SettingsTabs('advanced')}${NavRow('Models', 'adv-models')}${NavRow('API endpoints', 'endpoints')}${NavRow('Registry', 'registry')}${NavRow('Hugging Face token', 'hf-token')}${Spacer}${VersionFoot()}`,
  'home-edit': () => {
    const { order, on } = homeCfg();
    const row = (k) => SwitchRow({ key: k, name: BLOCK_NAMES[k][0], sub: BLOCK_NAMES[k][1], hidden: !on.includes(k),
      grip: html`<button class="grip"${data({ key: k })} aria-label="Move ${BLOCK_NAMES[k][0]}. Use the arrow keys" title="Drag to reorder">${Grip}</button>`,
      toggle: Toggle({ on: on.includes(k), act: 'toggle', data: { k }, label: `Show ${BLOCK_NAMES[k][0]}` }) });
    return html`${CloseBar()}${Head('Home screen')}${Note('Switch on what Home shows. Drag to change the order.')}${Scroll(order.map(row), { sort: true })}`;
  },
  background: () => {
    const { bg, tone } = document.documentElement.dataset;
    const row = ([k, name, hint]) => Row({ act: 'bg', data: { bg: k }, before: html`<i class="bgthumb bg-${k}"></i>`, name, sub: k === 'own' && s.snap.picture ? 'Choose another' : hint, right: k === bg ? 'In use' : '' });
    const mono = bg !== 'none' && SwitchRow({ name: 'Black and white', sub: tone === 'gray' ? 'Stays grey while a model runs' : 'Lights up in colour while a model runs', toggle: Toggle({ on: tone === 'gray', act: 'tone', label: 'Black and white' }) });
    return html`${CloseBar()}${Head('Background')}${Scroll(html`${BACKGROUNDS.map(row)}${mono}`)}`;
  },
  agent: () => html`${CloseBar()}${Head('Agents')}${Note('Open uses the default. Tap one to make it the default.')}${Scroll(AgentList('agent'))}${AgentsFoot()}`,
  machines: () => {
    const gpus = (d) => (d?.gpus.length ? `${d.gpus.length}× ${(d.groups[0]?.name || 'GPU').replace(/^(NVIDIA|GeForce) /g, '')}` : 'No GPU');
    const mine = [{ i: -1, name: s.snap.name, sub: gpus(s.snap) }, ...s.snap.devices.map((d) => ({ i: d.i, name: d.name, ip: new URL(d.url).hostname, sub: d.online ? gpus(d.state) : d.error || 'Offline',
      stale: !!(d.online && d.state?.app && !d.state.app.can && newer(s.snap.app.version, d.state.app.version)) }))];
    const os = (p) => p.os.replace(/^[a-z]/, (c) => c.toUpperCase());
    const others = (s.peers || []).filter((p) => !p.linked).map((p) => (p.online
      ? Row({ act: 'peer', data: { ip: p.ip, name: p.name, os: p.os, app: p.app ? 1 : '' }, name: p.name, sub: os(p), right: p.app ? 'Connect' : 'Set up' })
      : Row({ quiet: true, name: p.name, sub: os(p), right: `Seen ${ago(p.seen)}` })));
    return html`${CloseBar()}${Head('Machines')}${Scroll(html`${Label('Connected', { group: true })}${mine.map(DeviceRow)}${Label('On your Tailscale', { group: true })}${s.peers === null ? Note('Looking') : others.length ? others : Note('No other machines')}`)}${Button({ label: 'Add machine', go: 'addmachine' })}`;
  },
  addmachine: () => html`${CloseBar()}${Head('Add machine')}${typed('host', 'Address', 'http://100.90.62.80:18700')}${typed('mkey', 'Key', 'Not needed on your Tailscale')}${Spacer}${Button({ label: 'Add machine', act: 'connect', kind: 'go' })}`,
  usage: () => html`${CloseBar()}${Head('Usage')}${Scroll(UsageBody())}`,
  'adv-models': () => html`${CloseBar()}${Head('Models')}${Label(`${all().length} this machine can start, largest setup first`)}${Scroll(sections().map((sec) => html`${Label(sec.label, { group: true })}${sec.rows.map(ListRow)}`))}`,
  'model-page': () => {
    const r = model(s.modelOpen);
    if (!r) return html`${CloseBar()}${Note('This model is no longer in the list')}`;
    // A recipe that can't be edited has one button, at full width; the rest have Edit beside it.
    const main = UseButton(r) || Button({ label: 'Running', disabled: true }), edit = EditButton(r, 'width:auto;flex:1');
    return html`${CloseBar()}${Scroll(html`${Head(r.name)}${Note(meta(r))}${r.why && Note(r.why)}${ModelDetail(r)}${ModelCard(r)}`)}${edit ? html`<div class="two">${main}${edit}</div>` : main}`;
  },
  // Before a model that runs as a program on the machine is started for the first time, or after it changed.
  approve: () => {
    const r = all().find((x) => x.id === s.asking), L = s.look?.id === s.asking && s.look.launch, list = (v) => [].concat(v || []);
    if (!r) return html`${CloseBar()}${Note('This model is no longer in the list')}`;
    const pre = { mono: true, pre: true };
    return html`${CloseBar()}${Head(`Run ${r.name}?`)}${Note(`It runs as a program on ${here()}, not in a container, so it can do what you can. Here is what it runs. You are asked again only if this changes.`)}${Scroll(!L ? Note('Loading') : html`
      ${Label('Command')}${Box(list(L.command).join(' '), pre)}
      ${list(L.pip).length > 0 && html`${Label('Installs from PyPI')}${Box(list(L.pip).join('\n'), pre)}`}
      ${list(L.weights).length > 0 && html`${Label('Downloads from Hugging Face')}${Box(list(L.weights).map((w) => `${w.repo} @ ${String(w.revision).slice(0, 7)}`).join('\n'), pre)}`}
      ${L.config && html`${Label(`Its script, ${L.config.at}`)}${Box(L.config.text, { mono: true, pre: true, clip: true })}`}`)}${Button({ label: 'Allow and run', act: 'approve', kind: 'go', disabled: !L })}${Button({ label: 'Cancel', go: 'back' })}`;
  },
  edit: () => html`${CloseBar()}${EditForm()}`,
  endpoints: () => {
    if (!s.ends) return html`${CloseBar()}${Head('API endpoints')}${Note('Loading')}`;
    const runs = s.ends.runs.map((r) => html`${Label(`${r.name}, on this computer`)}${CopyField(r.local)}${r.tailnet && html`${Label('On your Tailscale')}${CopyField(r.tailnet)}`}${KeyValue([['OpenAI chat', yes(r.apis, 'chat')], ['OpenAI Responses', yes(r.apis, 'responses')], ['Anthropic messages', yes(r.apis, 'messages')]])}`);
    const sources = s.ends.sources.map((x) => html`<div class="src"><span><b>${x.device}</b><small>${x.known ? x.ip : 'Not on your Tailscale'}</small></span><span><b>${count(x.requests)}</b><small>${ago(x.last)}</small></span></div>`);
    return html`${CloseBar()}${Head('API endpoints')}${Scroll(html`${runs.length ? runs : Note('Start a model to get its address. Any API key works.')}${Label('Key, to add this machine from another')}${CopyField(s.ends.key, `••••••${s.ends.key.slice(-4)}`)}${Label('Where requests come from today', { group: true })}${sources.length ? sources : Note('None seen yet')}`)}`;
  },
  logs: () => html`${CloseBar()}${Head('Engine output')}${Note('The last lines before it stopped')}${Box(s.logText, { mono: true, style: 'flex:1;overflow:auto;white-space:pre-wrap' })}${Button({ label: 'Copy', act: 'copy', kind: 'go' })}`,
  registry: () => {
    const c = D().catalog;
    return html`${CloseBar()}${Head('Registry')}${KeyValue([['Source', 'local-ai-registry'], ['Version', c.id || '—'], ['Recipes', c.count], ['Checked', c.at ? ago(c.at) : '—']])}${c.error && Note('Couldn’t reach it. Using the saved list.')}${Spacer}${Button({ label: 'Check for updates', act: 'refresh', kind: 'go' })}`;
  },
  'hf-token': () => html`${CloseBar()}${Head('Hugging Face token')}${Note('Some models are locked until you accept their terms on Hugging Face. A read token lets Local AI download them.')}${typed('token', 'Token', D().hfToken ? `Saved, ends in ${D().hfToken}` : 'hf_…', 'password')}${TextLink({ label: 'Make a token on Hugging Face', href: 'https://huggingface.co/settings/tokens', style: 'margin:2px 0 0;text-align:left' })}${Spacer}${Button({ label: 'Save', act: 'savetoken', kind: 'go' })}${D().hfToken && Button({ label: 'Remove token', act: 'removetoken', kind: 'neg' })}`,
  'app-update': () => {
    const v = s.snap.app, named = /^\d/.test(v.latest || '');
    const about = v.latest ? `You have ${v.version}` : v.can ? 'You have the newest version' : 'This copy wasn’t installed from its repo, so it can’t update itself';
    const auto = SwitchRow({ name: 'Update automatically', sub: 'Models keep running while it restarts', toggle: Toggle({ on: v.auto, act: 'appauto', label: 'Update automatically' }) });
    return html`${CloseBar()}${Head(`Local AI ${named ? v.latest : v.version}`)}${Note(about)}${v.notes.length > 0 && html`${Label('What’s new', { group: true })}<ul class="notes">${v.notes.map((n) => html`<li>${n}</li>`)}</ul>`}${v.phase === 'failed' && Note(`The last update failed: ${v.error}`)}${Spacer}${v.can && html`${auto}${v.latest ? Button({ label: 'Update and restart', act: 'appupdate', kind: 'go' }) : Button({ label: 'Check for updates', act: 'appcheck' })}`}`;
  },
};
for (const id of Object.keys(STATE)) SCREENS[id] = () => Plain(id);
