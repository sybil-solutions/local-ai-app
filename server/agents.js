// Coding agents: which are installed, installing and updating them, and opening one on a running model.
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDsh, openT3 } from './apps.js';
import { piArgs, WINDOW } from './pi.js';
import { inShell, launched, q, shell, terminalPath, WIN } from './shell.js';
import { terminalFor } from './terminals.js';
import { at, event, fail, HOME, once, own, run } from './util.js';

export { syncPi } from './pi.js';
export { setTerminal, terminalChoice } from './terminals.js';

const openai = (url, model) => ({ env: { OPENAI_BASE_URL: `${url}/v1`, OPENAI_API_BASE: `${url}/v1`, OPENAI_API_KEY: 'local', OPENAI_MODEL: model }, args: [] });

const HARNESSES = {
  pi: { name: 'Pi', needs: 'chat', npm: '@earendil-works/pi-coding-agent', build: piArgs },
  omp: { name: 'Oh My Pi', needs: 'chat', npm: '@oh-my-pi/pi-coding-agent', build: piArgs },
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
  // Desktop apps, not terminal programs. Each is opened its own way (`open`, further down) and updates itself.
  t3: { name: 'T3 Code', needs: 'chat', paths: [join(homedir(), '.t3', 'bin', 't3')], open: (...args) => openT3(binOf('t3'), ...args) },
  dsh: { name: 'DeepSeek Harness', needs: 'chat', bare: true, paths: ['/Applications/DeepSeek Harness.app', join(homedir(), 'Applications', 'DeepSeek Harness.app')], open: (...args) => openDsh(binOf('dsh'), ...args) },
};

let cached = { at: 0, found: new Set() };

const installed = once(async () => {
  if (Date.now() - cached.at < 120000) return cached.found; // agents come and go rarely, and looking starts a shell
  const names = Object.keys(HARNESSES);
  const r = WIN ? await run('where', names) : await inShell(names.map((n) => `command -v ${n}`).join(';'), 8000);
  const found = new Set(names.filter((n) => new RegExp(`(^|[/\\\\])${n}(\\.\\w+)?\\s*$`, 'm').test(r.stdout) || HARNESSES[n].paths?.some((p) => existsSync(p))));
  cached = { at: Date.now(), found };
  return found;
});
// The command that starts an agent: its name when the shell finds it, else the fixed place it was found at.
const binOf = (id) => HARNESSES[id].paths?.find((p) => existsSync(p)) || id;

// The version each agent reports, and the newest one npm has. Both are slow to ask for, so they are kept a while.
const versions = { at: 0, of: {} }, latest = { at: 0, of: {} }, jobs = {};
let notify = () => {};
export const onChange = (fn) => { notify = fn; };
const refreshVersions = once(async (found) => {
  const before = JSON.stringify([versions.of, latest.of]);
  if (Date.now() - versions.at > 900e3 || [...found].some((n) => !(n in versions.of))) {
    versions.at = Date.now();
    // `bare` marks one found as an app bundle, which has no --version to ask.
    versions.of = Object.fromEntries(await Promise.all([...found].map(async (n) => [n, HARNESSES[n].bare ? null : /\d+\.\d+\.\d+(?:[\w.-]*\w)?/.exec((await inShell(`${q(binOf(n))} --version`, 15000)).stdout)?.[0] || null])));
  }
  if (Date.now() - latest.at > 6 * 3600e3) {
    latest.at = Date.now();
    await Promise.all(Object.entries(HARNESSES).filter(([, h]) => h.npm).map(async ([id, h]) => {
      try { latest.of[id] = (await (await fetch(`https://registry.npmjs.org/${h.npm}/latest`, { signal: AbortSignal.timeout(8000) })).json()).version || null; } catch { /* offline: keep what we knew */ }
    }));
  }
  return before !== JSON.stringify([versions.of, latest.of]);
});

export const list = async () => {
  const found = await installed();
  refreshVersions(found).then((changed) => changed && notify(), () => {});
  return Object.entries(HARNESSES).map(([id, h]) => ({ id, name: h.name, needs: h.needs, installed: found.has(id), version: versions.of[id] || null, latest: latest.of[id] || null, canInstall: !!h.npm, canUpdate: !!(h.npm || h.self), app: !!h.open, job: jobs[id] || null }));
};

// Installs a missing agent, or updates one with its own updater when it has one.
export async function change(id) {
  const h = own(HARNESSES, id) || fail(400, 'Unknown agent');
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

// Always returns the command, so a machine without a terminal or display still gets something to paste.
export async function open(agent, target, folder, targets = [target]) {
  const harness = own(HARNESSES, agent) || fail(400, 'Unknown agent');
  if (!(await installed()).has(agent)) fail(409, `${harness.name} is not installed`);
  if (target.apis && !target.apis.includes(harness.needs)) fail(409, `This engine has no ${harness.needs} API, which ${harness.name} needs`);
  if (!existsSync(folder)) fail(400, `Folder ${folder} does not exist`);
  if (harness.open) return harness.open(target, folder, targets);
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
    // Started with the PATH a terminal of yours has, where the shell said it; else by a login shell.
    const path = await terminalPath();
    writeFileSync(script, path ? `#!/bin/sh\nexport PATH=${q(path)}\n${command}\n` : `#!${shell} -l\n${command}\n`);
    chmodSync(script, 0o700);
  }
  const term = await terminalFor(script);
  const opened = term ? await launched(...term) : false;
  event(opened ? 'info' : 'warn', 'harness.open', { agent, model: target.model, opened, home: HOME });
  return { opened, command };
}
