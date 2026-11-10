import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { at, config, event, fail, HOME, run, saveConfig, writeJson } from './util.js';

const openai = (url, model) => ({ env: { OPENAI_BASE_URL: `${url}/v1`, OPENAI_API_BASE: `${url}/v1`, OPENAI_API_KEY: 'local', OPENAI_MODEL: model }, args: [] });
// Pi and Oh My Pi keep their own config folder, so they stay signed in. The running models reach them through an
// extension the app writes (see syncPi): it registers one provider per model for that run only.
const piExt = at('agents', 'local-ai.js'), piModels = at('agents', 'models.json');
const pi = (t) => ({ env: {}, args: ['-e', piExt, '--model', `${t.key}/${t.model}`] });
// A model whose context length is unknown is given this one.
const WINDOW = 32768;

const HARNESSES = {
  pi: { name: 'Pi', needs: 'chat', npm: '@earendil-works/pi-coding-agent', build: pi },
  omp: { name: 'Oh My Pi', needs: 'chat', npm: '@oh-my-pi/pi-coding-agent', build: pi },
  claude: { name: 'Claude Code', needs: 'messages', npm: '@anthropic-ai/claude-code', self: 'claude update', build: (t) => ({
    env: { ANTHROPIC_BASE_URL: t.url, ANTHROPIC_AUTH_TOKEN: 'local', ANTHROPIC_MODEL: t.model, ANTHROPIC_DEFAULT_SONNET_MODEL: t.model, ANTHROPIC_DEFAULT_OPUS_MODEL: t.model, ANTHROPIC_DEFAULT_HAIKU_MODEL: t.model },
    args: ['--model', t.model],
  }) },
  codex: { name: 'Codex', needs: 'responses', npm: '@openai/codex', build: (t) => ({
    env: { LOCAL_AI_KEY: 'local' },
    args: ['-c', 'model_providers.local.name=Local AI', '-c', `model_providers.local.base_url=${t.url}/v1`, '-c', 'model_providers.local.wire_api=responses',
      '-c', 'model_providers.local.env_key=LOCAL_AI_KEY', '-c', 'model_provider=local', '-c', `model=${t.model}`, '-c', `model_context_window=${t.ctx || WINDOW}`],
  }) },
  opencode: { name: 'OpenCode', needs: 'chat', npm: 'opencode-ai', self: 'opencode upgrade', build: (t) => ({
    env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: `local-ai/${t.model}`, small_model: `local-ai/${t.model}`,
      provider: { 'local-ai': { npm: '@ai-sdk/openai-compatible', name: 'Local AI', options: { baseURL: `${t.url}/v1`, apiKey: 'local' },
        models: { [t.model]: { name: t.model, limit: { context: t.ctx || WINDOW, output: t.ctx || WINDOW } } } } } }) },
    args: ['--model', `local-ai/${t.model}`],
  }) },
  hermes: { name: 'Hermes', needs: 'chat', self: 'hermes update', build: (t) => openai(t.url, t.model) },
  copilot: { name: 'GitHub Copilot', needs: 'chat', npm: '@github/copilot', build: (t) => ({ env: { COPILOT_PROVIDER_BASE_URL: `${t.url}/v1`, COPILOT_PROVIDER_API_KEY: 'local' }, args: ['--model', t.model] }) },
  // A desktop app, not a terminal program: Open shows the folder in T3 Code, where the model is listed under Pi.
  t3: { name: 'T3 Code', needs: 'chat', app: true, paths: [join(homedir(), '.t3', 'bin', 't3')] },
};

const WIN = process.platform === 'win32';
const shell = process.env.SHELL || 'sh';
let cached = { at: 0, found: new Set() };

async function installed() {
  if (Date.now() - cached.at < 30000) return cached.found;
  const names = Object.keys(HARNESSES);
  const r = WIN ? await run('where', names) : await run(shell, ['-lc', names.map((n) => `command -v ${n}`).join(';')], { timeout: 8000 });
  const found = new Set(names.filter((n) => new RegExp(`(^|[/\\\\])${n}(\\.\\w+)?\\s*$`, 'm').test(r.stdout) || HARNESSES[n].paths?.some((p) => existsSync(p))));
  cached = { at: Date.now(), found };
  return found;
}
// The command that starts an agent: its name when the shell finds it, else the fixed place it was found at.
const binOf = (id) => HARNESSES[id].paths?.find((p) => existsSync(p)) || id;

// The version each agent reports, and the newest one npm has. Both are slow to ask for, so they are kept a while.
const versions = { at: 0, of: {} }, latest = { at: 0, of: {} }, jobs = {};
let notify = () => {};
export const onChange = (fn) => { notify = fn; };
const inShell = (command, timeout) => (WIN ? run('cmd', ['/c', command], { timeout }) : run(shell, ['-lc', command], { timeout }));
async function refreshVersions(found) {
  const before = JSON.stringify([versions.of, latest.of]);
  if (Date.now() - versions.at > 900e3 || [...found].some((n) => !(n in versions.of))) {
    versions.at = Date.now();
    versions.of = Object.fromEntries(await Promise.all([...found].map(async (n) => [n, /\d+\.\d+\.\d+(?:[\w.-]*\w)?/.exec((await inShell(`${q(binOf(n))} --version`, 15000)).stdout)?.[0] || null])));
  }
  if (Date.now() - latest.at > 6 * 3600e3) {
    latest.at = Date.now();
    await Promise.all(Object.entries(HARNESSES).filter(([, h]) => h.npm).map(async ([id, h]) => {
      try { latest.of[id] = (await (await fetch(`https://registry.npmjs.org/${h.npm}/latest`, { signal: AbortSignal.timeout(8000) })).json()).version || null; } catch { /* offline: keep what we knew */ }
    }));
  }
  return before !== JSON.stringify([versions.of, latest.of]);
}

export const list = async () => {
  const found = await installed();
  refreshVersions(found).then((changed) => changed && notify(), () => {});
  return Object.entries(HARNESSES).map(([id, h]) => ({ id, name: h.name, needs: h.needs, installed: found.has(id), version: versions.of[id] || null, latest: latest.of[id] || null, canInstall: !!h.npm, canUpdate: !!(h.npm || h.self), app: !!h.app, job: jobs[id] || null }));
};

// Installs a missing agent, or updates one with its own updater when it has one.
export async function change(id) {
  const h = HARNESSES[id] || fail(400, 'Unknown agent');
  const has = (await installed()).has(id);
  const command = has && h.self ? h.self : h.npm ? `npm install -g ${h.npm}@latest` : fail(409, `${h.name} comes with its own installer`);
  if (jobs[id]?.phase === 'running') return { ok: true };
  jobs[id] = { kind: has ? 'update' : 'install', phase: 'running' };
  event('info', 'agent.change', { id, command });
  inShell(command, 900e3).then((r) => {
    jobs[id] = r.code ? { kind: jobs[id].kind, phase: 'failed', error: (r.stderr.trim().split('\n').pop() || 'It did not finish').slice(0, 160) } : null;
    if (r.code) event('warn', 'agent.failed', { id, error: jobs[id].error });
    cached.at = 0; versions.at = 0;
    notify();
  });
  return { ok: true };
}

// Every running model as a Pi provider. Pi sends at most maxTokens per answer and needs a number, so it gets the
// whole context; Oh My Pi leaves the limit out.
const providersFor = (targets) => Object.fromEntries(targets.map((t) => [t.key, {
  baseUrl: `${t.url}/v1`, apiKey: 'local', api: 'openai-completions',
  models: [{ id: t.model, name: `${t.name} · ${t.device}`, reasoning: true, contextWindow: t.ctx || WINDOW, maxTokens: t.ctx || WINDOW, omitMaxOutputTokens: true,
    input: t.vision ? ['text', 'image'] : ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsDeveloperRole: false } }],
}]));
// The extension reads the model list each time Pi starts, so it is always what is running now. A missing or broken
// list registers nothing, so Pi still starts.
const EXTENSION = `// Written by Local AI. Registers each model Local AI is running as a provider. Safe to delete.
import { readFileSync } from 'node:fs';
export default function (pi) {
  let providers = {};
  try { ({ providers } = JSON.parse(readFileSync(${JSON.stringify(piModels)}, 'utf8'))); } catch { /* Local AI is not running anything */ }
  for (const [id, provider] of Object.entries(providers || {})) pi.registerProvider(id, provider);
}
`;
const writeExtension = (file) => { if (!existsSync(file) || readFileSync(file, 'utf8') !== EXTENSION) writeFileSync(file, EXTENSION, { mode: 0o600 }); };

// T3 Code starts Pi itself, with Pi's own config folder. Pi loads every extension in that folder's extensions/, so the
// same extension is placed there the first time T3 Code is opened from here. Nothing else of Pi's is touched.
const piHome = () => process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
const piShared = () => join(piHome(), 'extensions', 'local-ai.js');

let lastModels = null;
// Keeps the extension's model list equal to what is running.
export function syncPi(targets) {
  const text = JSON.stringify({ providers: providersFor(targets) });
  if (text === lastModels) return;
  mkdirSync(at('agents'), { recursive: true, mode: 0o700 });
  writeJson(piModels, JSON.parse(text));
  writeExtension(piExt);
  if (existsSync(piShared())) writeExtension(piShared()); // keeps a copy placed earlier current with this version
  lastModels = text;
}

const q = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

// Terminals that can be handed a script to run. On a Mac each is an app; elsewhere a command. The order is the
// preference when none was chosen: one you installed yourself comes before the one the system ships.
// Warp is left out: it has no way to be started on a script.
const viaOpen = (app, ...before) => (script) => ['open', ['-na', app, '--args', ...before, script]];
const MAC_TERMINALS = [
  { id: 'ghostty', name: 'Ghostty', app: 'Ghostty', start: viaOpen('Ghostty', '-e') },
  { id: 'iterm', name: 'iTerm', app: 'iTerm', start: (script) => ['open', ['-a', 'iTerm', script]] },
  { id: 'kitty', name: 'kitty', app: 'kitty', start: viaOpen('kitty') },
  { id: 'wezterm', name: 'WezTerm', app: 'WezTerm', start: viaOpen('WezTerm', 'start', '--') },
  { id: 'alacritty', name: 'Alacritty', app: 'Alacritty', start: viaOpen('Alacritty', '-e') },
  { id: 'terminal', name: 'Terminal', app: 'Terminal', start: (script) => ['open', ['-a', 'Terminal', script]] },
];
const LINUX_TERMINALS = [['xdg-terminal-exec'], ['kitty'], ['alacritty', '-e'], ['foot'], ['ghostty', '-e'], ['wezterm', 'start', '--'], ['gnome-terminal', '--'], ['konsole', '-e'], ['x-terminal-emulator', '-e']]
  .map(([bin, ...args]) => ({ id: bin, name: bin, bin, start: (script) => [bin, [...args, script]] }));
const APP_DIRS = ['/Applications', join(homedir(), 'Applications'), '/System/Applications/Utilities', '/Applications/Utilities'];

// The terminals installed here, in order of preference. Looked for again every 30 s.
let terms = { at: 0, list: [] };
async function terminals() {
  if (Date.now() - terms.at < 30000) return terms.list;
  let list = [];
  if (process.platform === 'darwin') list = MAC_TERMINALS.filter((t) => APP_DIRS.some((dir) => existsSync(join(dir, `${t.app}.app`))));
  else if (!WIN && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) {
    const found = (await run('sh', ['-c', LINUX_TERMINALS.map((t) => `command -v ${t.bin}`).join(';')], { timeout: 8000 })).stdout;
    list = LINUX_TERMINALS.filter((t) => new RegExp(`(^|/)${t.bin}\\s*$`, 'm').test(found));
    if (process.env.TERMINAL) list.unshift({ id: 'env', name: process.env.TERMINAL, start: (script) => [process.env.TERMINAL, ['-e', script]] });
  }
  terms = { at: Date.now(), list };
  return list;
}
// What the app shows: the terminals to choose from and the one Open uses (the chosen one while it is still installed).
export async function terminalChoice() {
  const list = await terminals(), now = list.find((t) => t.id === config.terminal) || list[0];
  return { terminals: list.map(({ id, name }) => ({ id, name })), terminal: now?.id || null };
}
export async function setTerminal(id) {
  if (!(await terminals()).some((t) => t.id === id)) fail(400, 'That terminal is not installed here');
  config.terminal = id;
  saveConfig();
}

async function terminalFor(script) {
  if (WIN) return ['cmd', ['/c', 'start', '', 'cmd', '/k', script]];
  const list = await terminals(), pick = list.find((t) => t.id === config.terminal) || list[0];
  return pick ? pick.start(script) : null;
}

const launched = (cmd, args) => new Promise((done) => {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.once('error', () => done(false));
  child.once('spawn', () => { child.unref(); done(true); });
});

// T3 Code: Pi inside it is given the extension, then the folder is opened in the desktop app.
async function openT3(target, folder) {
  mkdirSync(join(piHome(), 'extensions'), { recursive: true, mode: 0o700 });
  writeExtension(piShared());
  const bin = binOf('t3'), out = await run(bin, ['app', folder], { timeout: 30000 });
  if (out.code) fail(502, `T3 Code did not open: ${(out.stderr.trim() || out.stdout.trim()).split('\n').pop().slice(0, 200) || 'is it running?'}`);
  event('info', 'harness.open', { agent: 't3', model: target.model, opened: true });
  return { opened: true, command: `${q(bin)} app ${q(folder)}`, pick: `Pi › ${target.name} · ${target.device}` };
}

// Always returns the command, so a machine without a terminal or display still gets something to paste.
export async function open(agent, target, folder) {
  const harness = HARNESSES[agent] || fail(400, 'Unknown agent');
  if (!(await installed()).has(agent)) fail(409, `${harness.name} is not installed`);
  if (target.apis && !target.apis.includes(harness.needs)) fail(409, `This engine has no ${harness.needs} API, which ${harness.name} needs`);
  if (!existsSync(folder)) fail(400, `Folder ${folder} does not exist`);
  if (harness.app) return openT3(target, folder);
  const { env, args } = harness.build(target), bin = binOf(agent);
  mkdirSync(at('agents'), { recursive: true, mode: 0o700 });
  const script = at('agents', `open-${agent}${WIN ? '.cmd' : '.command'}`);
  const vars = Object.entries(env);
  let command;
  if (WIN) {
    command = [`cd /d "${folder}"`, ...vars.map(([k, v]) => `set "${k}=${v}"`), [bin, ...args].map((a) => `"${String(a).replace(/"/g, '""')}"`).join(' ')].join(' & ');
    writeFileSync(script, `@echo off\r\n${command}\r\n`);
  } else {
    command = `cd ${q(folder)} && ${vars.length ? `env ${vars.map(([k, v]) => `${k}=${q(v)}`).join(' ')} ` : ''}${[bin, ...args].map(q).join(' ')}`;
    writeFileSync(script, `#!${shell} -l\n${command}\n`);
    chmodSync(script, 0o700);
  }
  const term = await terminalFor(script);
  const opened = term ? await launched(...term) : false;
  event(opened ? 'info' : 'warn', 'harness.open', { agent, model: target.model, opened, home: HOME });
  return { opened, command };
}
