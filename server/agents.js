import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { at, event, fail, HOME, run, writeJson } from './util.js';

const openai = (url, model) => ({ env: { OPENAI_BASE_URL: `${url}/v1`, OPENAI_API_BASE: `${url}/v1`, OPENAI_API_KEY: 'local', OPENAI_MODEL: model }, args: [] });
const piDir = at('agents', 'pi');
const pi = (t) => ({ env: { PI_CODING_AGENT_DIR: piDir, OMP_CODING_AGENT_DIR: piDir }, args: ['--provider', t.key, '--model', t.model] });

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
      '-c', 'model_providers.local.env_key=LOCAL_AI_KEY', '-c', 'model_provider=local', '-c', `model=${t.model}`, '-c', `model_context_window=${t.ctx}`],
  }) },
  opencode: { name: 'OpenCode', needs: 'chat', npm: 'opencode-ai', self: 'opencode upgrade', build: (t) => ({
    env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: `local-ai/${t.model}`, small_model: `local-ai/${t.model}`,
      provider: { 'local-ai': { npm: '@ai-sdk/openai-compatible', name: 'Local AI', options: { baseURL: `${t.url}/v1`, apiKey: 'local' },
        models: { [t.model]: { name: t.model, limit: { context: t.ctx, output: 8192 } } } } } }) },
    args: ['--model', `local-ai/${t.model}`],
  }) },
  hermes: { name: 'Hermes', needs: 'chat', self: 'hermes update', build: (t) => openai(t.url, t.model) },
  copilot: { name: 'GitHub Copilot', needs: 'chat', npm: '@github/copilot', build: (t) => ({ env: { COPILOT_PROVIDER_BASE_URL: `${t.url}/v1`, COPILOT_PROVIDER_API_KEY: 'local' }, args: ['--model', t.model] }) },
};

const WIN = process.platform === 'win32';
const shell = process.env.SHELL || 'sh';
let cached = { at: 0, found: new Set() };

async function installed() {
  if (Date.now() - cached.at < 30000) return cached.found;
  const names = Object.keys(HARNESSES);
  const r = WIN ? await run('where', names) : await run(shell, ['-lc', names.map((n) => `command -v ${n}`).join(';')], { timeout: 8000 });
  const found = new Set(names.filter((n) => new RegExp(`(^|[/\\\\])${n}(\\.\\w+)?\\s*$`, 'm').test(r.stdout)));
  cached = { at: Date.now(), found };
  return found;
}

// The version each agent reports, and the newest one npm has. Both are slow to ask for, so they are kept a while.
const versions = { at: 0, of: {} }, latest = { at: 0, of: {} }, jobs = {};
let notify = () => {};
export const onChange = (fn) => { notify = fn; };
const inShell = (command, timeout) => (WIN ? run('cmd', ['/c', command], { timeout }) : run(shell, ['-lc', command], { timeout }));
async function refreshVersions(found) {
  const before = JSON.stringify([versions.of, latest.of]);
  if (Date.now() - versions.at > 900e3 || [...found].some((n) => !(n in versions.of))) {
    versions.at = Date.now();
    versions.of = Object.fromEntries(await Promise.all([...found].map(async (n) => [n, /\d+\.\d+\.\d+[\w.-]*/.exec((await inShell(`${n} --version`, 15000)).stdout)?.[0] || null])));
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
  return Object.entries(HARNESSES).map(([id, h]) => ({ id, name: h.name, needs: h.needs, installed: found.has(id), version: versions.of[id] || null, latest: latest.of[id] || null, canInstall: !!h.npm, job: jobs[id] || null }));
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

let lastModels = '';
// One provider per running model, so Pi and any T3 thread pointed at this folder see them all.
export function syncPi(targets) {
  const providers = Object.fromEntries(targets.map((t) => [t.key, {
    baseUrl: `${t.url}/v1`, apiKey: 'local', api: 'openai-completions',
    models: [{ id: t.model, name: `${t.name} · ${t.device}`, reasoning: true, contextWindow: t.ctx || 32768, maxTokens: 32768, input: t.vision ? ['text', 'image'] : ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsDeveloperRole: false } }],
  }]));
  const text = JSON.stringify({ providers });
  if (text === lastModels) return;
  mkdirSync(piDir, { recursive: true, mode: 0o700 });
  writeJson(`${piDir}/models.json`, { providers });
  lastModels = text;
}

const q = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

const terminals = [['xdg-terminal-exec'], ['kitty'], ['alacritty', '-e'], ['foot'], ['ghostty', '-e'], ['wezterm', 'start', '--'], ['gnome-terminal', '--'], ['konsole', '-e'], ['x-terminal-emulator', '-e']];

async function terminalFor(script) {
  if (WIN) return ['cmd', ['/c', 'start', '', 'cmd', '/k', script]];
  if (process.platform === 'darwin') return ['open', ['-a', 'Terminal', script]];
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return null;
  if (process.env.TERMINAL) return [process.env.TERMINAL, ['-e', script]];
  for (const [bin, ...args] of terminals) if (!(await run('sh', ['-c', `command -v ${bin}`])).code) return [bin, [...args, script]];
  return null;
}

const launched = (cmd, args) => new Promise((done) => {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.once('error', () => done(false));
  child.once('spawn', () => { child.unref(); done(true); });
});

// Always returns the command, so a machine without a terminal or display still gets something to paste.
export async function open(agent, target, folder) {
  const harness = HARNESSES[agent] || fail(400, 'Unknown agent');
  if (!(await installed()).has(agent)) fail(409, `${harness.name} is not installed`);
  if (target.apis && !target.apis.includes(harness.needs)) fail(409, `This engine has no ${harness.needs} API, which ${harness.name} needs`);
  if (!existsSync(folder)) fail(400, `Folder ${folder} does not exist`);
  const { env, args } = harness.build(target);
  mkdirSync(at('agents'), { recursive: true, mode: 0o700 });
  const script = at('agents', `open-${agent}${WIN ? '.cmd' : '.command'}`);
  let command;
  if (WIN) {
    command = [`cd /d "${folder}"`, ...Object.entries(env).map(([k, v]) => `set "${k}=${v}"`), [agent, ...args].map((a) => `"${String(a).replace(/"/g, '""')}"`).join(' ')].join(' & ');
    writeFileSync(script, `@echo off\r\n${command}\r\n`);
  } else {
    command = `cd ${q(folder)} && env ${Object.entries(env).map(([k, v]) => `${k}=${q(v)}`).join(' ')} ${[agent, ...args].map(q).join(' ')}`;
    writeFileSync(script, `#!${shell} -l\n${command}\n`);
    chmodSync(script, 0o700);
  }
  const term = await terminalFor(script);
  const opened = term ? await launched(...term) : false;
  event(opened ? 'info' : 'warn', 'harness.open', { agent, model: target.model, opened, home: HOME });
  return { opened, command };
}
