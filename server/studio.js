// Local Studio, when it runs on this machine: its controller (port 8080) starts and stops one model at a time and
// keeps track of it. A model it started is found here like any other (discovery.js), and is stopped by asking the
// controller, never by stopping its container behind its back, which would leave it holding a model that is gone.
// The controller answers only with its key, which is in its own data folder (data/api-settings.json, beside where
// it runs). Local AI reads it there, as the same user, and uses it only to talk to that controller on this machine.
import { readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { listening } from './discovery.js';
import { run, sleep } from './util.js';

const PORT = +(process.env.LOCAL_STUDIO_PORT || 8080);
let found = { at: 0, ctl: null };

// The controller on this machine: { url, key }, or null. Linux only: there the folder a program runs in can be read.
async function controller() {
  if (Date.now() - found.at < 60000) return found.ctl;
  found = { at: Date.now(), ctl: null };
  if (process.platform !== 'linux') return null;
  for (const { where, port, who } of listening((await run('ss', ['-ltnpH'], { timeout: 5000 })).stdout)) {
    if (port !== PORT || !/^\d+$/.test(who || '')) continue;
    let key;
    try { key = JSON.parse(readFileSync(join(readlinkSync(`/proc/${who}/cwd`), 'data', 'api-settings.json'), 'utf8')).apiKey; } catch { continue; }
    const host = /^(0\.0\.0\.0|\*|\[::\]|::)$/.test(where) ? '127.0.0.1' : where;
    const url = `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
    const ok = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
    if (typeof key === 'string' && key && ok) return (found.ctl = { url, key });
  }
  return null;
}

const ask = async (ctl, path, { method = 'GET', timeout = 5000 } = {}) => {
  const res = await fetch(`${ctl.url}${path}`, { method, headers: { authorization: `Bearer ${ctl.key}` }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`Local Studio answered ${res.status}`);
  return res.json().catch(() => ({}));
};

// Whether the model Local Studio is running is this one (by the name it is served as).
export async function owns(served) {
  try { const ctl = await controller(), s = ctl && await ask(ctl, '/status'); return !!(s?.running && s.process?.served_model_name === served); } catch { return false; }
}

// Asks Local Studio to stop its model, and waits until it says it has (its GPUs are free then), two minutes at most.
export async function stop(served) {
  const ctl = await controller();
  if (!ctl) throw new Error('Local Studio’s controller is not answering');
  await ask(ctl, '/evict', { method: 'POST', timeout: 180000 });
  for (let i = 0; i < 60; i++) {
    const s = await ask(ctl, '/status').catch(() => null);
    if (s && (!s.running || s.process?.served_model_name !== served)) return;
    await sleep(2000);
  }
  throw new Error('Local Studio did not stop it within two minutes');
}
