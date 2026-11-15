// Renders every screen of the page, in both layouts, for every state the server can report, without a browser.
// Two things are checked:
//   1. Every screen draws. A screen that throws for some state is a blank window for someone.
//   2. Nothing the page is told becomes markup. Every piece of text in the fixture carries an HTML payload; if any of
//      it reaches the output unescaped, a model name, a machine name or an error from another machine could run
//      script in the page that holds the key.
// Usage: node tests/screens.mjs            exit code 0 when every check passed
//        node tests/screens.mjs --dump f   also writes every screen's HTML to f (to compare two versions of web/)
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.TZ = 'UTC';
const WEB = process.env.WEB_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const RealDate = Date;
// The page asks the time in many places; a fixed clock makes two runs print the same thing.
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };

// The little of a browser the page's modules touch when they are loaded and when a screen is drawn.
const dataset = { bg: 'clouds', tone: 'color' };
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.innerWidth = 1280;
globalThis.innerHeight = 820;
globalThis.location = { port: '18700', hash: '', pathname: '/', search: '' };
globalThis.history = { replaceState() {} };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
globalThis.document = { querySelector: () => ({ content: 'fixture-key' }), documentElement: { dataset, style: { setProperty() {} }, classList: { toggle() {} } } };

const load = (file) => import(pathToFileURL(join(WEB, file)).href);
const { s } = await load('state.js');
const { SCREENS, STATE } = await load('screens.js');
const { NavBar, DeskHome, DeskPage } = await load('desktop.js');
const { resolve } = await load('state.js');
const { markdown } = await load('markdown.js');

// ---- fixture -------------------------------------------------------------------------------------------------------
const PAYLOAD = '\'"><img src=x onerror=alert(1)><b>&';
let poison = false;
const t = (text) => (poison ? `${text}${PAYLOAD}` : text); // free text: names, messages, anything a person or a machine wrote

const recipe = (id, name, extra = {}) => ({ id: t(id), name: t(name), local: false, host: false, card: 'card', cards: 1, engine: t('vLLM'), ctx: 262144, seqs: 8, vision: true, think: true, tools: true, kv: t('fp8'),
  tps: 120, smart: 41.5, sizeGb: 19.2, released: '2026-09-01', loadS: 95, ready: true, speed: { c1: 120.4, c4: 310, c8: 520, measured: true, exact: true, ttft: 0.21, at: '2026-11-09T10:00:00.000Z' }, ...extra });
const RECIPES = () => [recipe('r/fast', 'Fast Model 3.5'), recipe('r/balanced', 'Balanced Model'), recipe('r/smart', 'Smart Model 27B', { cards: 2, kv: null, ready: false }),
  recipe('r/host', 'Host Model MLX', { host: true, engine: t('MLX'), sizeGb: null, smart: null, speed: { c1: null, c4: null, c8: null, measured: false, exact: true, ttft: null, at: null }, vision: false, tools: false, loadS: null }),
  recipe('r/mine', 'My Own Recipe', { local: true, released: null })];
const run = (phase, extra = {}) => ({ id: 18701, host: false, recipe: t('r/fast'), name: t('Fast Model 3.5'), url: t('http://127.0.0.1:18701'), gpus: [0], since: NOW - 120e3, readyAt: NOW - 60e3, expected: 95,
  phase, detail: t('2.1 GB of 19.2 GB'), progress: 0.4, error: null, failure: null, view: { line: t('About 1 min'), p: 0.6 }, ctx: 262144, vision: true, served: t('fast-model'), apis: ['chat', 'responses'],
  stats: { tps: 88.4, pps: 9400, ppsEst: false, used: 123456, active: 1 }, external: false, reachable: true, ...extra });
const gpu = (index, used = 1024) => ({ index, name: t('NVIDIA RTX PRO 6000'), total: 97887, used, util: 12, power: 80, temp: 40 });
const machine = (extra = {}) => {
  const list = RECIPES();
  return { name: t('this-mac.local'), docker: { ok: true, error: null }, needsDocker: true, gpus: [gpu(0), gpu(1)], free: [0, 1],
    groups: [{ card: 'card', name: t('RTX PRO 6000'), untested: null, gpus: [0, 1], tiers: { fastest: list[0], balanced: list[1], smartest: list[2] }, recipes: list }], runs: [],
    usage: { all: 362000000, days: Array.from({ length: 40 }, (_, i) => ({ d: new RealDate(NOW - i * 864e5).toISOString().slice(0, 10), v: (i * 7919) % 900000 })) },
    catalog: { at: '2026-11-10T11:00:00.000Z', error: null, count: 5, id: t('abc1234') }, last: null, ...extra };
};
const agents = () => [
  { id: 'pi', name: t('Pi'), needs: 'chat', installed: true, version: '1.5.2', latest: '1.5.2', canInstall: true, canUpdate: true, app: false, job: null },
  { id: 'omp', name: t('Oh My Pi'), needs: 'chat', installed: true, version: '18.16.0', latest: '18.18.6', canInstall: true, canUpdate: true, app: false, job: null },
  { id: 'claude', name: t('Claude Code'), needs: 'messages', installed: true, version: '2.1.3', latest: '2.1.9', canInstall: true, canUpdate: true, app: false, job: { kind: 'update', phase: 'running' } },
  { id: 'codex', name: t('Codex'), needs: 'responses', installed: true, version: null, latest: null, canInstall: true, canUpdate: true, app: false, job: { kind: 'update', phase: 'failed', error: t('npm stopped') } },
  { id: 'opencode', name: t('OpenCode'), needs: 'chat', installed: false, version: null, latest: '1.19.5', canInstall: true, canUpdate: true, app: false, job: { kind: 'install', phase: 'failed', error: t('no network') } },
  { id: 'hermes', name: t('Hermes'), needs: 'chat', installed: false, version: null, latest: null, canInstall: false, canUpdate: true, app: false, job: null },
  { id: 'copilot', name: t('GitHub Copilot'), needs: 'chat', installed: false, version: null, latest: '1.0.108', canInstall: true, canUpdate: true, app: false, job: { kind: 'install', phase: 'running' } },
  { id: 't3', name: t('T3 Code'), needs: 'chat', installed: true, version: '0.1.8', latest: null, canInstall: false, canUpdate: false, app: true, job: null },
];
const snapshot = (extra = {}, app = {}) => ({ v: 7, ...machine(), devices: [
  { i: 0, name: t('big-box'), url: 'http://100.90.0.1:18700', online: true, error: null, state: { ...machine({ name: t('big-box'), gpus: [0, 1, 2, 3].map((i) => gpu(i, 92000)), free: [], runs: [run('ready', { external: true, recipe: null, id: 8000 })] }), devices: [], app: { version: '0.4.0', can: true } } },
  { i: 1, name: t('sleepy'), url: 'http://100.90.0.2:18700', online: false, error: t('Not responding'), state: null },
], agents: agents(), agent: 'pi', folder: t('/Users/someone/code'), terminals: [{ id: 'ghostty', name: t('Ghostty') }, { id: 'terminal', name: t('Terminal') }], terminal: 'ghostty',
home: null, background: 'clouds', tone: null, picture: null, hfToken: null,
app: { version: t('0.5.0'), started: NOW - 3600e3, latest: null, notes: [], phase: 'idle', error: null, can: true, auto: false, ...app }, ...extra });

const USAGE = () => ({ days: Array.from({ length: 30 }, (_, i) => ({ d: new RealDate(NOW - (29 - i) * 864e5).toISOString().slice(0, 10), out: 1000 * i, req: 3 * i, models: { [t('fast-model')]: 5000 * i, [t('other')]: 900 * i } })),
  hours: { [new RealDate(NOW).toISOString().slice(0, 13)]: { [t('fast-model')]: { in: 900, out: 300, req: 4 } } },
  runs: [{ id: 18701, name: t('Fast Model 3.5'), since: NOW - 600e3, tokens: 4200, out: 1200, req: 9, series: [[NOW - 600e3, 0], [NOW - 300e3, 2100], [NOW, 4200]] }] });
const ENDS = () => ({ runs: [{ id: 18701, name: t('Fast Model 3.5'), local: t('http://127.0.0.1:18701/v1'), tailnet: t('http://this-mac.tail.ts.net:18701/v1'), apis: ['chat'] }, { id: 18702, name: t('No APIs yet'), local: t('http://127.0.0.1:18702/v1'), tailnet: null, apis: null }],
  key: t('0123456789abcdef0123456789abcdef0123456789abcdef'), sources: [{ ip: t('100.90.0.9'), requests: 12345, last: new RealDate(NOW - 120e3).toISOString(), device: t('laptop'), known: true }, { ip: t('10.0.0.4'), requests: 2, last: new RealDate(NOW - 86400e3).toISOString(), device: t('10.0.0.4'), known: false }] });
const PEERS = () => [{ name: t('spark-one'), dns: 'spark-one.tail.ts.net', ip: t('100.90.0.5'), os: t('linux'), online: true, seen: '2026-11-10T11:59:00Z', app: false, linked: false },
  { name: t('has-app'), dns: '', ip: '100.90.0.6', os: t('linux'), online: true, seen: '2026-11-10T11:59:00Z', app: true, linked: false },
  { name: t('mac-mini'), dns: '', ip: '100.90.0.7', os: t('macOS'), online: false, seen: '2026-10-31T11:59:00Z', app: false, linked: false },
  { name: t('already'), dns: '', ip: '100.90.0.1', os: 'linux', online: true, seen: '2026-11-10T11:59:00Z', app: true, linked: true }];
const CARD_MD = () => `# ${t('Model Card')}\n\nSome **bold** text, \`code\`, a [link](https://example.com/a?b=1&c=2) and ![${t('logo')}](https://example.com/logo.png).\n\n- one\n- two\n\n1. first\n\n| a | b |\n|---|---|\n| 1 | ${t('2')} |\n\n\`\`\`\nprint("${t('hi')}")\n\`\`\`\n<script>alert(1)</script>\n`;

// Everything the page remembers itself, back to how it starts.
function reset(extra = {}) {
  Object.assign(s, { snap: null, online: true, needKey: false, version: 0, dev: -1, nav: null, trail: [], sel: null, expanded: null, modelOpen: null, opened: null, agentsOpen: false, full: true,
    note: '', busy: false, command: '', logText: '', period: 'days', span: 'all', usage: null, ends: null, peers: null, install: null, draft: null, link: null, asking: null, look: null, form: {}, cards: {} }, extra);
}

// ---- the states -----------------------------------------------------------------------------------------------------
// Each is [name, how to set the page up]. Home is drawn for each; the screens opened on top are drawn in `PAGES`.
const withRun = (phase, extra) => () => reset({ snap: snapshot({ runs: [run(phase, extra)] }) });
const HOMES = [
  ['boot', () => reset()],
  ['cantconnect', () => reset({ online: false })],
  ['cantconnect-after', () => reset({ snap: snapshot(), online: false })],
  ['key', () => reset({ needKey: true })],
  ['off', () => reset({ snap: snapshot() })],
  ['off-expanded', () => reset({ snap: snapshot(), expanded: t('r/fast'), sel: t('r/smart') })],
  ['off-no-room', () => reset({ snap: snapshot({ free: [] }) })],
  ['off-untested', () => { const snap = snapshot(); snap.groups[0].untested = t('RTX 5090'); reset({ snap }); }],
  ['off-one-recipe', () => { const snap = snapshot(); snap.groups[0].recipes = snap.groups[0].recipes.slice(0, 1); snap.groups[0].tiers = { fastest: snap.groups[0].recipes[0], balanced: null, smartest: null }; reset({ snap }); }],
  ['off-all-blocks', () => reset({ snap: snapshot({ home: { order: ['usage', 'gpus', 'hands', 'models', 'stats'], on: ['usage', 'gpus', 'hands', 'models', 'stats'] } }) })],
  ['off-no-blocks', () => reset({ snap: snapshot({ home: { order: ['usage', 'gpus', 'hands', 'models', 'stats'], on: [] } }) })],
  ['queued', withRun('queued')], ['dl', withRun('weights')], ['image', withRun('image')], ['waking', withRun('starting')],
  ['slow', withRun('starting', { since: NOW - 900e3 })], ['testing', withRun('testing')],
  ['awake', withRun('ready')],
  ['awake-est', withRun('ready', { stats: { tps: 0, pps: 1200, ppsEst: true, used: 0, active: 0 } })],
  ['awake-no-stats', withRun('ready', { stats: null, apis: null })],
  ['awake-all-blocks', () => reset({ snap: snapshot({ runs: [run('ready')], home: { order: ['usage', 'gpus', 'hands', 'models', 'stats'], on: ['usage', 'gpus', 'hands', 'models', 'stats'] } }) })],
  ['awake-no-blocks', () => reset({ snap: snapshot({ runs: [run('ready')], home: { order: ['usage', 'gpus', 'hands', 'models', 'stats'], on: [] } }) })],
  ['awake-agents-open', () => reset({ snap: snapshot({ runs: [run('ready')] }), agentsOpen: true })],
  ['awake-no-agent', () => { const snap = snapshot({ runs: [run('ready')] }); snap.agents.forEach((a) => { a.installed = false; }); reset({ snap }); }],
  ['opened', () => reset({ snap: snapshot({ runs: [run('ready')] }), opened: 18701 })],
  ['external', withRun('ready', { external: true, recipe: null })],
  ['external-noreply', withRun('unresponsive', { external: true, recipe: null, view: { line: t('Last heard 3 min ago'), p: 0.6 } })],
  ['noreply', withRun('unresponsive', { view: { line: t('Last heard 3 min ago'), p: 0.6 } })],
  ['sleeping', withRun('stopping')],
  ['failed-room', withRun('failed', { error: t('CUDA out of memory'), view: { word: 'Ran out of room', line: t('Too big for the free GPU memory'), p: -1 } })],
  ['failed-locked', withRun('failed', { error: t('401'), view: { word: 'Locked model', line: t('Needs a Hugging Face token'), p: -1 } })],
  ['failed-other', withRun('failed', { error: t('boom'), view: { word: t('Did not start'), line: t('boom'), p: -1 } })],
  ['dockeroff', () => reset({ snap: snapshot({ docker: { ok: false, error: t('Docker is not reachable: Cannot connect to the Docker daemon') } }) })],
  ['dockerdenied', () => reset({ snap: snapshot({ docker: { ok: false, error: t('Docker is not reachable: permission denied while trying to connect') } }) })],
  ['needsdocker', () => reset({ snap: snapshot({ docker: { ok: false, error: 'Docker is not installed' } }) })],
  ['nogpu', () => reset({ snap: snapshot({ gpus: [], free: [], groups: [] }) })],
  ['nogpu-no-other', () => reset({ snap: snapshot({ gpus: [], free: [], groups: [], devices: [] }) })],
  ['nothing', () => { const snap = snapshot(); snap.groups[0].recipes = []; snap.groups[0].tiers = { fastest: null, balanced: null, smartest: null }; reset({ snap }); }],
  ['nocatalog', () => { const snap = snapshot({ catalog: { at: null, error: null, count: 0, id: '' } }); snap.groups[0].recipes = []; snap.groups[0].tiers = {}; reset({ snap }); }],
  ['nocatalog-error', () => { const snap = snapshot({ catalog: { at: null, error: t('registry answered 503'), count: 0, id: '' } }); snap.groups[0].recipes = []; snap.groups[0].tiers = {}; reset({ snap }); }],
  ['app-updating', () => reset({ snap: snapshot({}, { phase: 'updating', latest: t('0.6.0') }) })],
  ['app-updating-build', () => reset({ snap: snapshot({}, { phase: 'updating', latest: t('a newer build') }) })],
  ['shared-gpu', () => reset({ snap: snapshot({ gpus: [{ index: 0, name: t('NVIDIA GB10'), total: 0, used: null, util: null, power: null, temp: null, shared: true }], home: { order: ['hands', 'gpus'], on: ['hands', 'gpus'] } }) })],
  ['remote', () => reset({ snap: snapshot(), dev: 0 })],
  ['remote-offline', () => reset({ snap: snapshot(), dev: 1 })],
  ['note', () => reset({ snap: snapshot(), note: t('Something went wrong') })],
];
// Screens opened on top of Home: [screen, how to set up beyond a plain snapshot]. Several variants of one screen are fine.
const base = (extra = {}, snapExtra = {}, app = {}) => () => reset({ snap: snapshot({ runs: [run('ready')], ...snapExtra }, app), ...extra });
const PAGES = [
  ['chooser', base()], ['chooser', base({}, { runs: [run('ready', { apis: null })] })],
  ['runthis', base({ command: t('cd /x && env A=1 pi --model m') })],
  ['key', () => reset({ needKey: true, form: { key: t('typed') } })],
  ['settings', base()], ['settings', base({}, {}, { latest: t('0.6.0') })], ['settings', base({}, {}, { latest: t('a newer build'), can: true })], ['settings', base({}, {}, { can: false })],
  ['advanced', base()],
  ['home-edit', base()], ['home-edit', base({}, { home: { order: ['usage', 'hands', 'models', 'stats', 'gpus'], on: ['usage'] } })],
  ['background', base()], ['background', () => { dataset.bg = 'none'; base({}, { picture: 1 })(); }], ['background', () => { dataset.bg = 'own'; dataset.tone = 'gray'; base({}, { picture: 1, background: 'own' })(); }],
  ['agent', base()], ['agent', base({ form: { folder: t('/typed/folder') } }, { terminals: [] })],
  ['machines', base()], ['machines', base({ peers: PEERS(), install: t('curl -fsSL http://100.90.0.9:18700/install | bash') })], ['machines', base({ peers: [], dev: 0 })],
  ['addmachine', base({ form: { host: t('http://100.90.0.3:18700'), mkey: t('k') }, link: { name: t('x'), error: t('That key is wrong') } })],
  ['usage', base()], ...['run', 'today', 'month', 'all'].flatMap((span) => ['days', 'weeks', 'months'].map((period) => ['usage', base({ usage: USAGE(), span, period })])),
  ['usage', base({ usage: { days: [], hours: {}, runs: [] }, span: 'run' })], ['usage', base({ usage: { days: [], hours: {}, runs: [] }, span: 'all' })],
  ['adv-models', base()], ['adv-models', base({ modelOpen: t('r/host') })], ['adv-models', base({ dev: 0 })],
  ['model-page', base({ modelOpen: t('r/smart') })], ['model-page', base({ modelOpen: t('r/host') })], ['model-page', base({ modelOpen: t('gone') })], ['model-page', base({ modelOpen: t('r/fast') })],
  ['model-page', () => { base({ modelOpen: t('r/balanced') })(); s.cards[`-1 ${t('r/balanced')}`] = { error: t('This model has no card on Hugging Face') }; }],
  ['model-page', () => { base({ modelOpen: t('r/balanced') })(); s.cards[`-1 ${t('r/balanced')}`] = { repo: t('org/model'), license: t('apache-2.0'), downloads: 123456, md: CARD_MD(), html: markdown(CARD_MD()) }; }],
  ['model-page', () => { base({ modelOpen: t('r/mine') }, { runs: [] })(); }],
  ['approve', base({ asking: t('r/host') })], ['approve', base({ asking: t('gone') })],
  ['approve', base({ asking: t('r/host'), look: { id: t('r/host'), launch: { kind: 'host', command: ['python3', t('serve.py'), '--port', '8080'], pip: [t('mlx-lm==0.30.0')], weights: [{ repo: t('org/model'), revision: t('0123456789abcdef'), at: 'model' }], config: { at: t('serve.py'), text: t('print("hello")\n') } } } })],
  ['edit', base({ modelOpen: t('r/fast') })],
  ['edit', () => { base({ modelOpen: t('r/fast') })(); s.draft = { raw: { id: t('r/fast'), launch: {} }, name: t('Fast Model 3.5'), engine: 'vLLM', local: true, ctx: 131072, cards: 2, seqs: 4, kv: 'fp8', args: t('--max-model-len 131072 "a b"'), touched: new Set() }; }],
  ['edit', () => { base({ modelOpen: t('r/fast') })(); s.draft = { raw: { id: t('r/fast'), launch: {} }, name: t('Fast Model 3.5'), engine: t('SGLang'), local: false, ctx: 0, cards: 1, seqs: 1, kv: 'Off', args: '', touched: new Set() }; }],
  ['endpoints', base()], ['endpoints', base({ ends: ENDS() })], ['endpoints', base({ ends: { runs: [], key: t('0123456789abcdef'), sources: [] } })],
  ['logs', base({ logText: t('line one\nline two <b>') })],
  ['registry', base()], ['registry', base({}, { catalog: { at: null, error: t('offline'), count: 0, id: '' } })],
  ['hf-token', base()], ['hf-token', base({ form: { token: t('hf_x') } }, { hfToken: t('abcd') })],
  ['app-update', base()], ['app-update', base({}, {}, { latest: t('0.6.0'), notes: [t('First note'), t('Second note')], auto: true })], ['app-update', base({}, {}, { latest: t('a newer build'), phase: 'failed', error: t('could not pull') })], ['app-update', base({}, {}, { can: false })],
  ['m-connect', base({ link: { name: t('spark-one'), url: 'http://100.90.0.5:18700' } })], ['m-linked', base({ link: { name: t('spark-one'), url: 'http://100.90.0.5:18700' } })],
  ['m-fail', base({ link: { name: t('spark-one'), error: t('Could not reach it: ECONNREFUSED') } })], ['m-setup', base({ link: { name: t('spark-one') } })],
  ['m-install', base({ link: { name: t('spark-one') }, install: t('curl -fsSL http://100.90.0.9:18700/install | bash') })], ['m-install', base({ link: { name: t('spark-one') } })],
  ['m-install', base({ link: { name: t('mac-mini'), error: t('Open the Local AI app on mac-mini'), manual: false }, install: t('curl x | bash') })],
];

// ---- drawing --------------------------------------------------------------------------------------------------------
const failures = [], out = {};
const check = (name, ok, detail = '') => { if (!ok) { failures.push(name); console.log(`FAIL ${name}${detail ? ` (${detail})` : ''}`); } };
function draw(key, fn) {
  try { out[key] = String(fn()); } catch (e) { out[key] = null; check(`draws ${key}`, false, e.message); return; }
  // The payload's own markup must never appear: only its escaped form may.
  if (poison) for (const bad of ['<img src=x', '\'"><', '<b>&']) check(`keeps text as text in ${key}`, !out[key].includes(bad), `found ${JSON.stringify(bad)}`);
}
function drawAll(tag) {
  const seen = new Map();
  for (const [name, setup] of HOMES) {
    dataset.bg = 'clouds'; dataset.tone = 'color';
    setup();
    const state = resolve();
    for (const full of [false, true]) {
      s.full = full;
      const key = `${tag}/home/${name}/${full ? 'desktop' : 'panel'}`;
      if (full) draw(key, () => `${NavBar(state === 'key' ? 'key' : null)}${state === 'key' ? DeskPage('key') : DeskHome(state)}`);
      else draw(key, () => SCREENS[state]());
    }
  }
  for (const [id, setup] of PAGES) {
    dataset.bg = 'clouds'; dataset.tone = 'color';
    setup();
    const n = (seen.get(id) || 0) + 1;
    seen.set(id, n);
    s.nav = id;
    for (const full of [false, true]) {
      s.full = full;
      draw(`${tag}/page/${id}#${n}/${full ? 'desktop' : 'panel'}`, () => (full ? `${NavBar(id)}${DeskPage(id)}` : SCREENS[id]()));
    }
  }
  return seen;
}

poison = false;
const seen = drawAll('plain');
// Every screen there is must have been drawn at least once, or a new screen could ship without ever being looked at.
const drawnStates = new Set(HOMES.map(([name, setup]) => { setup(); return resolve(); }));
for (const id of Object.keys(SCREENS)) check(`the fixture covers the ${id} screen`, seen.has(id) || drawnStates.has(id) || !!STATE[id]);
for (const id of Object.keys(STATE)) check(`the fixture covers the ${id} state`, seen.has(id) || drawnStates.has(id));
poison = true;
drawAll('poisoned');

// A model card is other people's Markdown. Whatever it holds, only the page's own few tags may come out.
const ALLOWED = /<\/?(p|b|code|pre|ul|ol|li|table|tr|th|td|h[2-5]|a|img)(\s[^<>]*)?>/g;
const HOSTILE = ['<script>alert(1)</script>', '[x](javascript:alert(1))', '![x](javascript:alert(1))', '[x](https://a.b/"onmouseover="alert(1))', '![a"onerror="alert(1)](https://a.b/c.png)',
  '**<img src=x onerror=alert(1)>**', '`<svg onload=alert(1)>`', '[<b>x</b>](https://a.b)', '<a href="javascript:alert(1)">x</a>', '<!-- --><iframe src=//evil>', '# <h1 onclick=alert(1)>',
  '| <td onclick=x> | b |\n|---|---|\n| 1 | 2 |', '```\n</pre><script>alert(1)</script>\n```', '[a](https://a.b) [b](data:text/html,<script>alert(1)</script>)', '<<script>script>alert(1)<</script>/script>',
  '![x](https://a.b/c.png" onerror="alert(1))', '[x]( https://a.b )', '\u0000<script>', '&lt;script&gt;alert(1)&lt;/script&gt;', '[x](https://a.b/?q=<script>)'];
for (const [i, text] of HOSTILE.entries()) {
  let html;
  try { html = String(markdown(text)); } catch (e) { check(`the model card renderer survives hostile text ${i}`, false, e.message); continue; }
  const rest = html.replace(ALLOWED, '');
  check(`a model card can't add its own tags (${i})`, !/[<>]/.test(rest), JSON.stringify(html).slice(0, 160));
  check(`a model card can't add script or handlers (${i})`, !/<script|javascript:|data:text|\son\w+\s*=/i.test(html.replace(/&[a-z#0-9]+;/gi, '')) || !/<[^>]*(javascript:|\son\w+\s*=)/i.test(html), JSON.stringify(html).slice(0, 160));
  for (const m of html.matchAll(/<(a|img)\s([^<>]*)>/g)) check(`a model card's links and pictures only point at http(s) (${i})`, /^(href|alt="[^"]*" src)="https?:\/\/[^"\s]+"/.test(m[2].replace(/^alt="[^"]*" /, 'alt="" ')) || /^href="https?:\/\/[^"]+" target="_blank" rel="noopener"$/.test(m[2]), m[0].slice(0, 120));
}

const dump = process.argv.indexOf('--dump');
if (dump > 0) writeFileSync(process.argv[dump + 1], JSON.stringify(out, null, 1));
console.log(failures.length ? `\n${failures.length} check(s) failed, ${Object.keys(out).length} screens drawn` : `all checks passed: ${Object.keys(out).length} screens drawn`);
process.exit(failures.length ? 1 : 0);
