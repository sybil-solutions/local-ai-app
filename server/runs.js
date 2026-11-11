// The runs: every model this machine is running or starting, the GPUs, and Docker's state. The other engine files
// (containers, hosts, discovery, health) all read and change runs through here, and say so with update().
import { event } from './util.js';

export const runs = new Map();
// Containers this app removed, by name and when, so a listing made before the removal does not bring one back.
export const removed = new Map();
export const status = { gpus: [], docker: { ok: false, error: 'Checking Docker' } };

let notify = () => {};
export const onChange = (fn) => { notify = fn; };
// Something the app shows has changed: a new snapshot is due.
export const changed = () => notify();
// This machine's tailnet address once the app also answers there, and the names it answers to. Engines are
// published on the same address, so your other machines can call them.
export const share = { ip: null, names: [] };
export const shareOn = (ip, names = []) => Object.assign(share, { ip, names });
export const update = (r, fields) => { Object.assign(r, fields); changed(); };
const FAILURES = [
  [/out of memory|OutOfMemory|CUBLAS|failed to allocate|Not enough GPU memory/i, 'Ran out of room', 'Too big for the free GPU memory'],
  [/nvidia-container|runtime.*nvidia|libnvidia/i, 'GPU not reaching Docker', 'Install the NVIDIA container toolkit'],
  [/driver.*(old|version|mismatch)|Failed to initialize NVML/i, 'Driver problem', 'Update your NVIDIA driver'],
  [/Engine stopped/, 'Stopped', 'It quit on its own'],
  [/within 2 hours/, 'Never woke up', 'Gave up after 2 hours'],
  [/gated|\b40[13]\b/, 'Locked model', 'Needs a Hugging Face token'],
  [/GB free in/, 'Not enough space', null],
  [/checksum/, 'Download damaged', 'One file came through wrong'],
  [/manifest|pull access|Could not pull/i, 'No engine', 'Could not get the engine'],
  [/fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN/i, 'No connection', 'Check your network and try again'],
];
function classify(text) {
  const hit = FAILURES.find(([re]) => re.test(text));
  return hit ? { word: hit[1], line: hit[2] ?? text.trim().split('\n').pop().slice(0, 90) } : { word: 'Did not start', line: text.trim().split('\n').pop().slice(0, 90) };
}

export function setFailed(r, error, logs = '') {
  update(r, { phase: 'failed', error, failure: classify(`${logs}\n${error}`), detail: null, progress: null, busy: false });
  event('error', 'run.failed', { id: r.id, recipe: r.recipe, error });
}

const claimed = () => new Set([...runs.values()].filter((r) => r.phase !== 'failed').flatMap((r) => r.gpus));
export const freeGpus = () => {
  const taken = claimed();
  return status.gpus.filter((g) => !taken.has(g.index) && (g.unified || g.shared || (g.used ?? 0) < 2048)); // shared memory is always partly in use by the system
};
