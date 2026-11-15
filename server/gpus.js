// The machine's GPUs and their memory: NVIDIA cards from nvidia-smi, Intel Arc cards from lspci (Linux), or the one
// chip of an Apple silicon Mac.
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
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

async function readNvidia() {
  const fresh = live ? [...live.rows.values()].filter((row) => Date.now() - row.at < 7000) : [];
  if (fresh.length) return fresh.map((row) => row.gpu).sort((a, b) => a.index - b.index);
  if (live && Date.now() - live.since > 10000) { live.child.kill(); live = null; } // it stopped printing: start over
  // The first reading, and every reading until the running one has printed, is asked for on its own.
  const once = await run('nvidia-smi', QUERY, { timeout: 8000 });
  const gpus = once.code ? [] : once.stdout.trim().split('\n').map((line) => card(line.trim())).filter(Boolean);
  if (gpus.length && !live) watch();
  return gpus;
}

// Intel Arc cards, on Linux. lspci names them (`[Arc Pro B70]`) and says how large their memory is; the card's render
// node, which is what an engine's container is given, is found under /dev/dri/by-path by the card's PCI address.
// A card whose own memory is at least 4 GB is a card of its own (a B70 shows its 32 GB). One that shows less is part
// of the processor and uses the machine's RAM (`shared`, as a DGX Spark does). The driver does not say how much of a
// card's memory is in use, so `used` is unknown for a card of its own; whether another container holds the card is
// found from Docker (containers.js). What lspci says is kept for a minute: cards do not come and go.
// LOCAL_AI_DRI is the folder the render nodes are in. The tests point it at a folder of their own, so they see the
// cards they made and never the machine's.
const DRI = process.env.LOCAL_AI_DRI || '/dev/dri';
const BYTES = { K: 2 ** 10, M: 2 ** 20, G: 2 ** 30, T: 2 ** 40 };
// What `lspci -D -v -d 8086:` printed, as the Arc cards in it: { address, name, memory } with memory in MiB.
export function arcCards(text) {
  return text.split(/\n(?=\S)/).map((block) => {
    const [, address, kind, name] = /^(\S+) ([^:]+): Intel Corporation .*\[(Arc [^\]]+)\]/.exec(block) || [];
    if (!name || !/VGA|Display/.test(kind)) return null;
    const sizes = [...block.matchAll(/Memory at .*\[size=(\d+)([KMGT])\]/g)].map(([, n, unit]) => (+n * BYTES[unit]) / BYTES.M);
    return { address, name: `Intel ${name}`, memory: Math.max(0, ...sizes) };
  }).filter(Boolean).sort((a, b) => a.address.localeCompare(b.address));
}
let listed = { at: 0, cards: [] };
const celsius = (address) => { // the package temperature, where the driver gives one
  try {
    const dir = `/sys/bus/pci/devices/${address}/hwmon`, mon = join(dir, readdirSync(dir)[0]);
    const label = readdirSync(mon).find((f) => /^temp\d+_label$/.test(f) && readFileSync(join(mon, f), 'utf8').trim() === 'pkg');
    return label ? Math.round(+readFileSync(join(mon, label.replace('_label', '_input')), 'utf8') / 1000) : null;
  } catch { return null; }
};
async function readIntel(first) {
  if (Date.now() - listed.at > 60000) {
    const out = await run('lspci', ['-D', '-v', '-d', '8086:'], { timeout: 8000 });
    listed = { at: Date.now(), cards: out.code ? [] : arcCards(out.stdout) };
  }
  const gpus = [];
  for (const c of listed.cards) {
    const link = `pci-${c.address}-render`;
    let node;
    try { node = realpathSync(join(DRI, 'by-path', link)); } catch { continue; } // no render node: its driver is not loaded
    const own = c.memory >= 4096, ram = own ? null : systemMemory();
    gpus.push({ index: first + gpus.length, name: c.name, total: own ? c.memory : ram?.total ?? 0, used: own ? null : ram?.used ?? null, util: null, power: null, temp: celsius(c.address),
      backend: 'intel-xpu', node, link, ...(own ? {} : { shared: true }) });
  }
  return gpus;
}
// The render node's name (renderD128), which is how a container that was given the card names it.
export const nodeName = (gpu) => basename(gpu.node);

// Each GPU as { index, name, total, used, util, power, temp } with memory in MiB. No GPUs is an empty list. An Intel
// card also has `backend`, its render `node` and the name of the `link` to it under /dev/dri/by-path.
export async function readGpus() {
  if (APPLE) return readApple();
  const nvidia = await readNvidia();
  return process.platform === 'linux' || process.env.LOCAL_AI_DRI ? [...nvidia, ...(await readIntel(nvidia.length))] : nvidia;
}
