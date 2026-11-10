// Every screen, as a function that returns its HTML. The panel shows one at a time; the desktop layout shows the same ones as pages.
import { agentName, all, cardKey, chosen, D, group, here, HOME, homeCfg, newer, outdated, picks, run, s, shown } from './state.js';
import { a, ago, art, b, bar, caps, close, ctxOf, esc, facts, fmt, grip, icon, item, kv, left, menu, meta, mins, running, status, toggle, vfoot } from './ui.js';
import { miniUsage, usageBody } from './usage.js';

// Home: the blocks you chose, in your order.
export const offLine = (c) => (!c.ready ? `${c.sizeGb ? `${Math.round(c.sizeGb)} GB` : 'Model'} to download`
  : group()?.untested ? `Made for ${esc(group().untested)} · untested here` : c.loadS ? `Starts in about ${mins(c.loadS)} min` : 'Ready to start');
const detail = (r) => `<div class="mdetail"><div class="ics">${caps(r)}</div><div class="kv small">${kv(facts(r))}</div></div>`;
// Recipes that run outside Docker (MLX on a Mac) can't be edited on the Edit screen, so they get no Edit button.
const editBtn = (r, extra = '') => (r.host ? '' : a('Edit', 'model', '', `data-id="${esc(r.id)}" data-go="edit" ${extra}`));
const modelRow = (r) => `<div class="mrow${r.id === chosen().id ? ' on' : ''}"><div class="mhead">`
  + `<button class="mpick" data-act="pick" data-id="${esc(r.id)}"><span>${esc(r.name)}</span><small>${r.tier || ''}</small></button>`
  + `<button class="plus" data-act="expand" data-id="${esc(r.id)}" aria-label="Details">${icon(s.expanded === r.id ? 'minus' : 'plus', 14)}</button></div>`
  + `${s.expanded === r.id ? `${detail(r)}<div class="mdetail" style="padding-top:0">${editBtn(r)}</div>` : ''}</div>`;
const gpuRows = () => `<div class="wbtn"><span class="wtitle">GPUs</span>${D().gpus.map((g) => `<div class="gpu"><span>GPU ${g.index}</span><i><u style="width:${Math.min(100, ((g.used || 0) / g.total) * 100).toFixed(0)}%"></u></i><span>${Math.round((g.used || 0) / 1024)} of ${Math.round(g.total / 1024)} GB</span></div>`).join('')}</div>`;
export const runLine = (r, isOpen) => (isOpen ? `${agentName() || 'Agent'} is open` : r.external ? 'Running · started outside Local AI' : 'Running');
export const BLOCKS = {
  hands: (ph) => (ph === 'off' ? `${art('apart')}<div class="line">${offLine(chosen())}</div>` : status('work', run().name, ph === 'opened' ? `Running · ${runLine(run(), true)}` : runLine(run()), 1)),
  models: (ph) => (ph === 'off' ? `<div>${shown().map(modelRow).join('')}<button class="quiet" style="margin-top:4px" data-go="adv-models">More models</button></div>` : ''),
  stats: (ph) => (ph === 'off' ? '' : running(run())),
  usage: miniUsage,
  gpus: gpuRows,
};
const home = (ph) => `<div class="scroll home">${HOME().map((k) => BLOCKS[k](ph)).join('')}</div>`;
export const startBtn = () => a(chosen().ready ? 'Run' : 'Download', 'start', 'go');
export const openBtns = () => `<div class="two">${agentName() ? a(`Open ${esc(agentName())}`, 'open', 'go') : b('Choose an agent', 'chooser', 'go')}${b(icon('down'), 'chooser', '', 'aria-label="Choose an agent"')}</div>`;
export const stopBtn = () => (run().external ? '' : a('Stop', 'stop', 'neg'));

// Agents: in the chooser a tap opens one; on their own page each shows its version and its one action.
function agentRow(h, mode) {
  const failed = h.job?.phase === 'failed', act = `data-act="agent" data-agent="${h.id}"`;
  if (h.job?.phase === 'running') return `<div class="item vrow busy"><span><b>${h.name}</b><small>${h.job.kind === 'update' ? 'Updating…' : 'Installing…'}</small></span><i class="instbar"></i></div>`;
  if (!h.installed && !h.canInstall) return `<div class="item vrow busy"><span><b>${h.name}</b><small>Not installed</small></span></div>`;
  if (!h.installed) return `<button class="item vrow" ${act} title="${esc(h.job?.error || '')}"><span><b>${h.name}</b><small>${failed ? 'Couldn’t install' : `Not installed${h.latest ? ` · ${h.latest}` : ''}`}</small></span><span class="inst">${failed ? 'Try again' : 'Install'}</span></button>`;
  const isDefault = h.id === s.snap.agent;
  if (mode === 'open') {
    const wrong = run()?.apis && !run().apis.includes(h.needs);
    return `<button class="item" data-act="open" data-agent="${h.id}" ${wrong ? 'disabled' : ''}>${h.name}<small>${wrong ? 'Not for this model' : isDefault ? 'Default' : ''}</small></button>`;
  }
  const label = failed ? 'Try again' : h.version && h.latest && newer(h.latest, h.version) ? `Update to ${h.latest}` : h.latest ? '' : 'Update';
  const right = label ? `<button class="inst vact" ${act} title="${esc(h.job?.error || '')}">${label}</button>` : '<small>Up to date</small>';
  return `<div class="item vrow"><button class="vpick" data-act="default" data-agent="${h.id}"><span><b>${h.name}</b><small>${h.version || 'Installed'}${isDefault ? ' · Default' : ''}${failed ? ' · Couldn’t update' : ''}</small></span></button>${right}</div>`;
}
export const agentList = (mode) => s.snap.agents.map((h) => agentRow(h, mode)).join('');
export const agentsFoot = () => `${outdated().length ? a(`Update all (${outdated().length})`, 'updateall') : ''}<div class="label">Folder</div>`
  + `<input class="field" data-f="folder" data-save="folder" spellcheck="false" aria-label="Folder" value="${esc(s.form.folder ?? s.snap.folder)}">`;

// A model card is someone else's Markdown, so every tag in it is dropped and only our own are written.
export function markdown(text) {
  // One pass over the escaped text: what a rule writes is never read again by another rule, so a card can't smuggle markup through one into the next.
  const RULES = /!\[([^\]]*)\]\((https:\/\/[^)\s]+)\)|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*/g;
  const inline = (t) => esc(t).replace(RULES, (_, alt, src, text, href, code, bold) => (src ? `<img alt="${alt}" src="${src}" loading="lazy">`
    : href ? `<a href="${href}" target="_blank" rel="noopener">${text}</a>` : code ? `<code>${code}</code>` : `<b>${bold}</b>`));
  const out = [];
  let list = null, code = null, table = false, para = [];
  const flush = () => { if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`); if (list) out.push(`</${list}>`); if (table) out.push('</table>'); para = []; list = null; table = false; };
  for (const raw of text.replace(/<!--[\s\S]*?-->/g, '').replace(/<\/?[a-zA-Z][^>]*>/g, '').split('\n')) {
    const line = raw.trim(), head = /^(#{1,4})\s+(.*)/.exec(line), li = /^(?:[-*]|(\d+\.))\s+(.*)/.exec(line);
    if (code !== null) { if (line.startsWith('```')) { out.push(`<pre>${esc(code)}</pre>`); code = null; } else code += `${raw}\n`; continue; }
    if (line.startsWith('```')) { flush(); code = ''; } else if (!line) flush();
    else if (head) { flush(); out.push(`<h${head[1].length + 1}>${inline(head[2])}</h${head[1].length + 1}>`); }
    else if (li) { const kind = li[1] ? 'ol' : 'ul'; if (list !== kind) { flush(); out.push(`<${kind}>`); list = kind; } out.push(`<li>${inline(li[2])}</li>`); }
    else if (line.startsWith('|')) {
      if (/^\|[\s:|-]+\|?$/.test(line)) continue;
      const tag = table ? 'td' : 'th';
      if (!table) { flush(); out.push('<table>'); table = true; }
      out.push(`<tr>${line.replace(/^\||\|$/g, '').split('|').map((c) => `<${tag}>${inline(c.trim())}</${tag}>`).join('')}</tr>`);
    } else para.push(line);
  }
  flush();
  return out.join('');
}
export const cardHtml = (r) => {
  const c = s.cards[cardKey(r.id)];
  if (!c || c.error) return `<div class="label group">Model card</div>${left(c ? esc(c.error) : 'Loading')}`;
  const source = `<a href="https://huggingface.co/${esc(c.repo)}" target="_blank" rel="noopener">${esc(c.repo)}</a>${c.license ? ` · ${esc(c.license)}` : ''}${c.downloads != null ? ` · ${fmt(c.downloads)} downloads` : ''}`;
  return `<div class="label group">Model card</div><div class="cardsrc">${source}</div><div class="mdcard">${c.html}</div>`;
};
// The main button on a model's page: start it, pick it for Home, or swap it for the one running.
export function useBtn(r) {
  const live = run(), id = `data-id="${esc(r.id)}"`;
  if (live) return live.recipe === r.id ? '' : a(live.external ? 'Run' : 'Switch to this model', 'switch', 'go', id);
  return r.id === chosen()?.id ? a(r.ready ? 'Run' : 'Download', 'start', 'go', 'data-go="home"') : a('Use', 'pick', 'go', `${id} data-go="home"`);
}

export const CTX = [8192, 16384, 32768, 65536, 131072, 204800, 262144, 524288, 1048576];
const seg = (k, list) => `<div class="seg">${list.map((v) => `<button class="${v === s.draft[k] ? 'on' : ''}" data-act="draft" data-k="${k}" data-v="${v}">${v}</button>`).join('')}</div>`;
export function editBody() {
  const d = s.draft;
  if (!d) return left('Loading');
  return `<div class="head">${esc(d.name)}</div>${left(esc(d.engine))}<div class="scroll home" style="gap:8px">`
    + `<div class="label" data-ctxlabel>Context ${ctxOf(d.ctx)}</div><input type="range" data-f="ctx" min="0" max="${CTX.length - 1}" value="${CTX.findIndex((c) => c >= d.ctx)}" aria-label="Context">`
    + `<div class="label">GPUs</div>${seg('cards', [1, 2, 4, 8].filter((n) => n <= Math.max(d.cards, group()?.gpus.length || 1)))}`
    + `<div class="label">Requests at once</div>${seg('seqs', [1, 2, 4, 8])}${d.engine === 'vLLM' ? `<div class="label">KV cache</div>${seg('kv', ['Off', 'fp8'])}` : ''}`
    + `<div class="label">Arguments</div><textarea class="box" data-f="args" rows="6" spellcheck="false" aria-label="Arguments">${esc(d.args)}</textarea></div>`
    + `${a('Save', 'saveedit', 'go')}${d.local ? a('Reset', 'resetedit') : ''}`;
}

const BGS = [['fresco', 'The Creation of Adam', 'Michelangelo'], ['own', 'Your own picture', 'Choose a file'], ['none', 'None', 'Plain dark']];
const BLOCK_NAMES = { hands: ['Picture', 'The painting and its light'], models: ['Model picks', 'Fast, balanced and smart'], stats: ['Live stats', 'Speed and tokens, live'], usage: ['Usage', 'Tokens served, by day'], gpus: ['GPUs', 'Memory on each GPU'] };
const addr = (text, show) => `<button class="addr" data-act="copy" data-copy="${esc(text)}"><span>${esc(show ?? text)}</span><small>Copy</small></button>`;
const yes = (apis, k) => (apis ? (apis.includes(k) ? 'Yes' : 'No') : '—');
const field = (name, label, placeholder, type = 'text') => `<div class="label">${label}</div><input class="field" type="${type}" data-f="${name}" spellcheck="false" autocomplete="off" aria-label="${label}" placeholder="${placeholder}" value="${esc(s.form[name] || '')}">`;
// Another machine that can run models, when this one can't.
export function elsewhere() {
  const other = s.dev !== -1 && s.snap.groups.some((g) => g.recipes.length) ? { i: -1, name: s.snap.name } : s.snap.devices.find((x) => x.i !== s.dev && x.online && x.state?.groups.some((g) => g.recipes.length));
  return other ? `${a(`Use ${esc(other.name)}`, 'use', 'go', `data-dev="${other.i}"`)}${b('Add machine', 'addmachine')}` : b('Add machine', 'addmachine', 'go');
}

// Screens that are one picture, one word, one line and a few buttons: { pose, p, bar, word, line, extra, btns }. Both layouts draw them from this.
export const STATE = {
  boot: () => ({ pose: 'apart', word: 'Local AI', line: 'Looking for your GPU' }),
  cantconnect: () => ({ pose: 'broken', word: 'Can’t connect', line: 'Trying again' }),
  unreachable: () => ({ pose: 'broken', word: 'Can’t reach it', line: `${here()} · ${s.snap.devices[s.dev].error || 'Offline'}`, btns: a('This computer', 'use', 'go', 'data-dev="-1"') }),
  'app-updating': () => ({ pose: 'reach', p: 0.5, bar: true, word: 'Updating', line: `Local AI ${/^\d/.test(s.snap.app.latest || '') ? s.snap.app.latest : ''}`, extra: '<div class="line">Models keep running</div>' }),
  waking: () => ({ pose: 'reach', p: run().view.p, bar: true, word: run().name, line: `Starting · ${run().view.line}`, btns: a('Cancel', 'stop', 'neg') }),
  slow: () => ({ pose: 'reach', p: run().view.p, bar: true, word: 'Taking longer', line: `Usually ${mins(run().expected)} min, now ${mins((Date.now() - run().since) / 1000)}`, btns: a('Cancel', 'stop', 'neg') }),
  dl: () => ({ pose: 'reach', p: run().progress || 0, bar: true, word: 'Downloading', line: run().detail || 'Getting the model', btns: a('Cancel', 'stop', 'neg') }),
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
  nothing: () => ({ pose: 'apart', word: 'Nothing fits', line: `No tested models for ${D().groups[0]?.name || 'this GPU'}`, btns: elsewhere() }),
  nocatalog: () => ({ pose: 'apart', word: 'No models yet', line: D().catalog.error ? 'Can’t reach the model list' : 'Getting the model list', btns: a('Try again', 'refresh', 'go') }),
  busy: () => ({ pose: 'apart', word: 'GPUs in use', line: 'Another program is using them', extra: `<div class="busyrows">${gpuRows()}</div>`, btns: b('More models', 'adv-models') }),
  'm-connect': () => ({ pose: 'reach', p: 0.5, word: 'Connecting', line: s.link.name, btns: b('Cancel', 'machines', 'neg') }),
  'm-linked': () => ({ pose: 'touch', p: 1, word: 'Connected', line: s.link.name, btns: `${a('Use this machine', 'uselinked', 'go')}${b('Back', 'machines')}` }),
  'm-fail': () => ({ pose: 'broken', word: 'Can’t reach it', line: s.link.error, btns: `${b('Try again', 'addmachine', 'go')}${b('Back', 'machines')}` }),
  'm-install': () => ({
    pose: 'apart', word: 'Not set up', line: `Run this on ${s.link.name}, then come back`,
    extra: `<div class="box mono" style="margin-top:8px">${esc(s.install || 'Install Local AI there first')}</div>`,
    btns: `${s.install ? a('Copy', 'copy', 'go', `data-copy="${esc(s.install)}"`) : ''}${b('Back', 'machines')}`,
  }),
};
const plain = (id) => { const st = STATE[id](); return `${menu()}${status(st.pose, st.word, st.line, st.p)}${st.bar ? bar(st.p * 100) : ''}${st.extra || ''}<div class="sp"></div>${st.btns || ''}`; };
// How lit the painting is: fully while a model works, part way while one starts, dark otherwise.
export const look = (id) => (id === 'awake' || id === 'opened' ? { pose: 'work', p: 1 } : STATE[id] ? STATE[id]() : { pose: 'apart', p: 0 });
export const lit = ({ pose, p }) => (pose === 'work' || pose === 'touch' ? 1 : pose === 'reach' ? +p || 0 : 0);

const tabs = (on) => `<div class="tabs two"><button class="${on === 'settings' ? 'on' : ''}" data-go="settings">General</button><button class="${on === 'advanced' ? 'on' : ''}" data-go="advanced">Advanced</button></div>`;
export const SCREENS = {
  off: () => `${menu()}${home('off')}${startBtn()}`,
  awake: () => `${menu()}${home('run')}${openBtns()}${stopBtn()}`,
  opened: () => `${menu()}${home('opened')}${openBtns()}${stopBtn()}`,
  chooser: () => `${close()}<div class="head">Open with</div><div class="scroll">${agentList('open')}</div>`,
  runthis: () => `${close()}<div class="head">Run this</div><div class="box mono">${esc(s.command)}</div><div class="sp"></div>${a('Copy', 'copy', 'go')}`,
  key: () => `<div class="top"><span class="mark">Local AI</span></div><div class="head" style="margin-top:24px">Enter the key</div>${left('It’s under Settings › Advanced › API endpoints on the machine running Local AI')}${field('key', 'Key', 'Key')}<div class="sp"></div>${a('Connect', 'key', 'go')}`,
  settings: () => `${close('home')}${tabs('settings')}${item('Home screen', 'home-edit')}${item('Background', 'background')}${item('Agents and folder', 'agent')}${item('Machines', 'machines')}${item('Usage', 'usage')}<div class="sp"></div>${vfoot()}`,
  advanced: () => `${close('home')}${tabs('advanced')}${item('Models', 'adv-models')}${item('API endpoints', 'endpoints')}${item('Registry', 'registry')}${item('Hugging Face token', 'hf-token')}<div class="sp"></div>${vfoot()}`,
  'home-edit': () => {
    const { order, on } = homeCfg();
    const row = (k) => `<div class="hrow${on.includes(k) ? '' : ' hidden'}" data-key="${k}"><button class="grip" data-key="${k}" aria-label="Move ${BLOCK_NAMES[k][0]}. Use the arrow keys" title="Drag to reorder">${grip}</button>`
      + `<span class="hname"><b>${BLOCK_NAMES[k][0]}</b><small>${BLOCK_NAMES[k][1]}</small></span>${toggle(on.includes(k), `data-act="toggle" data-k="${k}"`, `Show ${BLOCK_NAMES[k][0]}`)}</div>`;
    return `${close()}<div class="head">Home screen</div>${left('Switch on what Home shows. Drag to change the order.')}<div class="scroll" data-sort>${order.map(row).join('')}</div>`;
  },
  background: () => {
    const row = ([k, name, hint]) => `<button class="item" data-act="bg" data-bg="${k}"><span class="bgrow"><i class="bgthumb bg-${k}"></i><span><b>${name}</b><small>${k === 'own' && s.snap.picture ? 'Choose another' : hint}</small></span></span>`
      + `<small>${k === document.documentElement.dataset.bg ? 'In use' : ''}</small></button>`;
    const { bg, tone } = document.documentElement.dataset;
    const mono = bg === 'none' ? '' : `<div class="hrow plain"><span class="hname"><b>Black and white</b><small>${tone === 'gray' ? 'Stays grey while a model runs' : 'Lights up in colour while a model runs'}</small></span>${toggle(tone === 'gray', 'data-act="tone"', 'Black and white')}</div>`;
    return `${close()}<div class="head">Background</div><div class="scroll">${BGS.map(row).join('')}${mono}</div>`;
  },
  agent: () => `${close()}<div class="head">Agents</div>${left('Open uses the default. Tap one to make it the default.')}<div class="scroll">${agentList('agent')}</div>${agentsFoot()}`,
  machines: () => {
    const gpus = (d) => (d?.gpus.length ? `${d.gpus.length}× ${(d.groups[0]?.name || 'GPU').replace(/^(NVIDIA|GeForce) /g, '')}` : 'No GPU');
    const mine = [{ i: -1, name: s.snap.name, sub: gpus(s.snap) }, ...s.snap.devices.map((d) => ({ i: d.i, name: d.name, sub: d.online ? gpus(d.state) : d.error || 'Offline' }))];
    const who = (p) => `<span><b>${esc(p.name)}</b><small>${esc(p.os.replace(/^[a-z]/, (c) => c.toUpperCase()))}</small></span>`;
    const others = (s.peers || []).filter((p) => !p.linked).map((p) => (p.online
      ? `<button class="item" data-act="peer" data-ip="${p.ip}" data-name="${esc(p.name)}" data-app="${p.app ? 1 : ''}">${who(p)}<small>${p.app ? 'Connect' : 'Not set up'}</small></button>`
      : `<div class="item busy">${who(p)}<small>Seen ${ago(p.seen)}</small></div>`)).join('');
    return `${close()}<div class="head">Machines</div><div class="scroll"><div class="label group">Connected</div>`
      + mine.map((m) => `<button class="item" data-act="use" data-dev="${m.i}"><span><b>${esc(m.name)}</b><small>${esc(m.sub)}</small></span><small>${m.i === s.dev ? 'In use' : ''}</small></button>`).join('')
      + `<div class="label group">On your Tailscale</div>${s.peers === null ? left('Looking') : others || left('No other machines')}</div>${b('Add machine', 'addmachine')}`;
  },
  addmachine: () => `${close()}<div class="head">Add machine</div>${field('host', 'Address', 'http://100.90.62.80:18700')}${field('mkey', 'Key', 'Not needed on your Tailscale')}<div class="sp"></div>${a('Add machine', 'connect', 'go')}`,
  usage: () => `${close()}<div class="head">Usage</div><div class="scroll">${usageBody()}</div>`,
  'adv-models': () => `${close()}<div class="head">Models</div><div class="label">Runs on this machine, newest first</div><div class="scroll">`
    + `${all().map((r) => `<div class="arow"><button class="ahead" data-act="model" data-id="${esc(r.id)}" data-go="model-page"><span class="at"><b>${esc(r.name)}</b><small>${meta(r)}</small></span><span class="ics">${caps(r)}<span class="chev">${icon('right', 14)}</span></span></button></div>`).join('')}</div>`,
  'model-page': () => {
    const r = all().find((x) => x.id === s.modelOpen);
    if (!r) return `${close()}${left('This model is no longer in the list')}`;
    return `${close()}<div class="scroll"><div class="head">${esc(r.name)}</div>${left(meta(r))}${detail(r)}${cardHtml(r)}</div><div class="two">${useBtn(r) || '<button class="btn" disabled>Running</button>'}${editBtn(r, 'style="width:auto;flex:1"')}</div>`;
  },
  edit: () => `${close()}${editBody()}`,
  endpoints: () => {
    if (!s.ends) return `${close()}<div class="head">API endpoints</div>${left('Loading')}`;
    const runs = s.ends.runs.map((r) => `<div class="label">${esc(r.name)}, on this computer</div>${addr(r.local)}${r.tailnet ? `<div class="label">On your Tailscale</div>${addr(r.tailnet)}` : ''}`
      + `<div class="kv">${kv([['OpenAI chat', yes(r.apis, 'chat')], ['OpenAI Responses', yes(r.apis, 'responses')], ['Anthropic messages', yes(r.apis, 'messages')]])}</div>`).join('');
    const rows = s.ends.sources.map((x) => `<div class="src"><span><b>${esc(x.device)}</b><small>${x.known ? esc(x.ip) : 'Not on your Tailscale'}</small></span><span><b>${x.requests.toLocaleString('en-US')}</b><small>${ago(x.last)}</small></span></div>`).join('');
    return `${close()}<div class="head">API endpoints</div><div class="scroll">${runs || left('Start a model to get its address. Any API key works.')}`
      + `<div class="label">Key, to add this machine from another</div>${addr(s.ends.key, `••••••${s.ends.key.slice(-4)}`)}<div class="label group">Where requests come from today</div>${rows || left('None seen yet')}</div>`;
  },
  logs: () => `${close()}<div class="head">Engine output</div>${left('The last lines before it stopped')}<div class="box mono" style="flex:1;overflow:auto">${esc(s.logText).split('\n').join('<br>')}</div>${a('Copy', 'copy', 'go')}`,
  registry: () => {
    const c = D().catalog;
    return `${close()}<div class="head">Registry</div><div class="kv">${kv([['Source', 'local-ai-registry'], ['Version', esc(c.id || '—')], ['Recipes', c.count], ['Checked', c.at ? ago(c.at) : '—']])}</div>`
      + `${c.error ? left('Couldn’t reach it. Using the saved list.') : ''}<div class="sp"></div>${a('Check for updates', 'refresh', 'go')}`;
  },
  'hf-token': () => `${close()}<div class="head">Hugging Face token</div>${left('Some models are locked until you accept their terms on Hugging Face. A read token lets Local AI download them.')}`
    + `${field('token', 'Token', D().hfToken ? `Saved, ends in ${esc(D().hfToken)}` : 'hf_…', 'password')}<a class="link" style="margin:2px 0 0;text-align:left" href="https://huggingface.co/settings/tokens" target="_blank" rel="noopener">Make a token on Hugging Face</a>`
    + `<div class="sp"></div>${a('Save', 'savetoken', 'go')}${D().hfToken ? a('Remove token', 'removetoken', 'neg') : ''}`,
  'app-update': () => {
    const v = s.snap.app, named = /^\d/.test(v.latest || '');
    const about = v.latest ? `You have ${esc(v.version)}` : v.can ? 'You have the newest version' : 'This copy wasn’t installed from its repo, so it can’t update itself';
    const auto = `<div class="hrow plain"><span class="hname"><b>Update automatically</b><small>Models keep running while it restarts</small></span>${toggle(v.auto, 'data-act="appauto"', 'Update automatically')}</div>`;
    return `${close()}<div class="head">Local AI ${esc(named ? v.latest : v.version)}</div>${left(about)}${v.notes.length ? `<div class="label group">What’s new</div><ul class="notes">${v.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}`
      + `${v.phase === 'failed' ? left(`The last update failed: ${esc(v.error)}`) : ''}<div class="sp"></div>${v.can ? `${auto}${v.latest ? a('Update and restart', 'appupdate', 'go') : a('Check for updates', 'appcheck')}` : ''}`;
  },
};
for (const id of Object.keys(STATE)) SCREENS[id] = () => plain(id);
