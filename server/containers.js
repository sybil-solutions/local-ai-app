// Runs that are Docker containers: starting one from a recipe, listing what Docker has, taking in what is already
// running after a restart, stopping and removing. Docker is the record: a run is a container labelled local-ai=1.
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { dockerArgs } from './docker.js';
import { health } from './health.js';
import { isLocal, label } from './recipes.js';
import { removed, runs, setFailed, share, status, update } from './runs.js';
import { at, ENGINE_HOST, event, fail, HOST, run } from './util.js';
import * as weights from './weights.js';

const docker = (args, opts) => run('docker', args, opts);

// Pulls the recipe's image if it is not here, then starts its container.
export async function launchContainer(r, recipe, signal) {
  update(r, { phase: 'image', detail: 'Checking engine image', progress: null });
    if ((await docker(['image', 'inspect', recipe.launch.image], { signal })).code) {
      update(r, { detail: 'Pulling engine image' });
      const pulled = await docker(['pull', recipe.launch.image], { timeout: 4 * 3600e3, signal });
      if (pulled.code) throw new Error(pulled.stderr.trim().slice(-400) || 'Could not pull the engine image');
    }
    const name = `local-ai-${r.id}`, L = recipe.launch;
    update(r, { phase: 'starting', detail: 'Loading model', container: name, since: Date.now() });
    r.reachable = !!share.ip || !/^127\./.test(HOST); // whether the port is published where another machine can call it
    const configFile = L.config ? at('runs', String(r.id), basename(L.config.at)) : null;
    if (configFile) { mkdirSync(dirname(configFile), { recursive: true }); writeFileSync(configFile, L.config.text); }
    const started = await docker(dockerArgs({ run: r, launch: L, name, bind: [HOST, ...(share.ip ? [share.ip] : [])], mounts: weights.mounts(L), configFile, trusted: isLocal(r.recipe) }), { timeout: 120000, signal });
    if (started.code) {
      await docker(['rm', '-f', name]);
      r.container = null;
      throw new Error(started.stderr.trim().slice(-400) || 'docker run failed');
    }
    update(r, { busy: false, touched: Date.now() });
    event('info', 'run.container', { id: r.id, recipe: r.recipe, gpus: r.gpus });
}

// Stops a run's container and removes it. One that had already failed is only removed.
export async function stopContainer(r, alreadyFailed) {
  if (!alreadyFailed) await docker(['stop', '-t', '15', r.container], { timeout: 40000 });
  const gone = await docker(['rm', '-f', r.container], { timeout: 20000 });
  if (gone.code && !/No such container/i.test(gone.stderr)) {
    setFailed(r, `Could not remove the container: ${gone.stderr.trim().slice(-300)}`);
    fail(500, r.error);
  }
  removed.set(r.container, Date.now());
}

export const containerLogs = async (r, lines) => { const out = await docker(['logs', '--tail', String(lines), r.container], { timeout: 10000 }); return `${out.stdout}${out.stderr}`; };

// Each label is asked for by name, as a column of its own. Docker's list of all labels is joined with commas, and a
// label an image brings along could hold a comma and a name of ours after it.
const LABELS = ['port', 'recipe', 'reach', 'gpus', 'since'];

async function inspectAll() {
  const ps = await docker(['ps', '-a', '--filter', 'label=local-ai=1', '--format', ['{{.Names}}', '{{.State}}', '{{.Status}}', ...LABELS.map((k) => `{{.Label "local-ai.${k}"}}`)].join('\t')], { timeout: 10000 });
  if (ps.code) {
    update(status.docker, { ok: false, error: ps.code === 127 ? 'Docker is not installed' : `Docker is not reachable: ${ps.stderr.trim().slice(0, 200)}` });
    return null;
  }
  update(status.docker, { ok: true, error: null });
  return ps.stdout.trim().split('\n').filter(Boolean).map((line) => {
    const [name, state, text, ...values] = line.split('\t');
    return { name, state, text, labels: Object.fromEntries(LABELS.map((k, i) => [`local-ai.${k}`, values[i] || ''])) };
  }).filter((c) => Number.isInteger(+c.labels['local-ai.port']) && +c.labels['local-ai.port'] > 0);
}

async function reconcile(c, listedAt) {
  if (removed.get(c.name) >= listedAt) return;
  const id = +c.labels['local-ai.port'];
  let r = runs.get(id);
  if (!r) {
    r = { id, recipe: c.labels['local-ai.recipe'], name: label(c.labels['local-ai.recipe']), url: `http://${ENGINE_HOST}:${id}`, reachable: c.labels['local-ai.reach'] ? c.labels['local-ai.reach'] === '1' : !/^127\./.test(HOST), gpus: (c.labels['local-ai.gpus'] || '').split('+').filter(Boolean).map(Number), phase: 'starting', detail: 'Loading model', progress: null, error: null, since: +c.labels['local-ai.since'] || Date.now(), busy: false, container: c.name, apis: null, stats: null, misses: 0, seen: true };
    runs.set(id, r);
    event('info', 'run.adopted', { id, recipe: r.recipe });
  }
  if (r.busy || r.phase === 'stopping') return;
  if (c.state !== 'running') {
    if (r.phase !== 'failed') {
      const logs = await docker(['logs', '--tail', '120', c.name], { timeout: 8000 });
      setFailed(r, `Engine stopped: ${c.text}`, `${logs.stdout}${logs.stderr}`);
    }
    return;
  }
  await health(r);
}

// One look at Docker: runs whose container is gone are dropped, containers found are taken in or checked.
export async function sweepContainers(listedAt) {
  const containers = await inspectAll();
  if (!containers) return;
  const names = new Set(containers.map((c) => c.name));
  for (const r of runs.values()) {
    if (r.container && !r.busy && r.phase !== 'stopping' && !names.has(r.container) && !(r.touched >= listedAt)) {
      runs.delete(r.id);
      event('warn', 'run.vanished', { id: r.id, recipe: r.recipe });
    }
  }
  await Promise.all(containers.map((c) => reconcile(c, listedAt)));
  for (const [name, at_] of removed) if (at_ < listedAt) removed.delete(name);
}
