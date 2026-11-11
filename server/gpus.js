// The machine's GPUs and their memory: NVIDIA cards from nvidia-smi, or the one chip of an Apple silicon Mac.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { run } from './util.js';

// LOCAL_AI_GPU=nvidia looks for NVIDIA cards even on a Mac (the tests use it to exercise the Docker path).
const APPLE = process.platform === 'darwin' && process.arch === 'arm64' && process.env.LOCAL_AI_GPU !== 'nvidia';

// Apple silicon has no nvidia-smi: the chip is one GPU whose memory is the unified RAM. `unified` marks it, so it is
// free whenever no run holds it (the OS always uses some of that memory) and runs on it need no Docker. How much of
// the memory is in use is read every six seconds: it moves slowly, and each reading starts a program.
let chip = null, memory = { at: 0, used: null };
async function readApple() {
  if (!chip) {
    const [brand, mem] = await Promise.all([run('sysctl', ['-n', 'machdep.cpu.brand_string'], { timeout: 4000 }), run('sysctl', ['-n', 'hw.memsize'], { timeout: 4000 })]);
    const name = brand.stdout.trim();
    if (brand.code || mem.code || !/^Apple M\d/.test(name)) return [];
    chip = { name, total: Math.round(+mem.stdout.trim() / 1048576) };
  }
  if (Date.now() - memory.at >= 6000) {
    const vm = await run('vm_stat', [], { timeout: 4000 });
    const page = +(/page size of (\d+)/.exec(vm.stdout)?.[1] || 16384);
    const pages = (key) => +(new RegExp(`${key}:\\s+(\\d+)`).exec(vm.stdout)?.[1] || 0);
    memory = { at: Date.now(), used: vm.code ? null : Math.round(((pages('Pages active') + pages('Pages wired down') + pages('Pages occupied by compressor')) * page) / 1048576) };
  }
  return [{ index: 0, name: chip.name, total: chip.total, used: memory.used, util: null, power: null, temp: null, unified: true }];
}

// The machine's RAM in MiB, from /proc/meminfo, as { total, used }.
function systemMemory() {
  try {
    const text = readFileSync('/proc/meminfo', 'utf8'), kb = (key) => +(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text)?.[1] || 0);
    return { total: Math.round(kb('MemTotal') / 1024), used: Math.round((kb('MemTotal') - kb('MemAvailable')) / 1024) };
  } catch { return null; }
}

// One line of nvidia-smi's answer as a GPU: { index, name, total, used, util, power, temp }, memory in MiB.
const QUERY = ['--query-gpu=index,name,memory.total,memory.used,utilization.gpu,power.draw,temperature.gpu', '--format=csv,noheader,nounits'];
const num = (s) => (Number.isFinite(+s) ? +s : null);
function card(line) {
  const [index, name, total, used, util, power, temp] = line.split(', ');
  if (!name || !Number.isInteger(+index)) return null;
  // A GPU that shares the system's memory (DGX Spark) reports none of its own: its memory is the machine's RAM.
  const own = num(total), ram = own ? null : systemMemory();
  return { index: +index, name, total: own ?? ram?.total ?? 0, used: own ? num(used) : ram?.used ?? null, util: num(util), power: num(power), temp: num(temp), ...(own ? {} : { shared: true }) };
}

// nvidia-smi is left running and prints every card's numbers every two seconds. Started afresh for each reading it
// costs a tenth of a second of CPU every time, which is most of what this app would use; left running it costs next
// to nothing. `live` is that program and the last line each card printed.
let live = null;
function watch() {
  const child = spawn('nvidia-smi', [...QUERY, '-l', '2'], { stdio: ['ignore', 'pipe', 'ignore'] }), rows = new Map(), mine = { child, rows, since: Date.now() };
  let tail = '';
  child.stdout.on('data', (text) => {
    const lines = (tail + text).split('\n');
    tail = lines.pop();
    for (const line of lines) { const gpu = card(line.trim()); if (gpu) rows.set(gpu.index, { gpu, at: Date.now() }); }
  });
  const over = () => { if (live === mine) live = null; };
  child.on('error', over);
  child.on('exit', over);
  live = mine;
}
process.on('exit', () => live?.child.kill());

// Each GPU as { index, name, total, used, util, power, temp } with memory in MiB. No GPUs is an empty list.
export async function readGpus() {
  if (APPLE) return readApple();
  const fresh = live ? [...live.rows.values()].filter((row) => Date.now() - row.at < 7000) : [];
  if (fresh.length) return fresh.map((row) => row.gpu).sort((a, b) => a.index - b.index);
  if (live && Date.now() - live.since > 10000) { live.child.kill(); live = null; } // it stopped printing: start over
  // The first reading, and every reading until the running one has printed, is asked for on its own.
  const once = await run('nvidia-smi', QUERY, { timeout: 8000 });
  const gpus = once.code ? [] : once.stdout.trim().split('\n').map((line) => card(line.trim())).filter(Boolean);
  if (gpus.length && !live) watch();
  return gpus;
}
