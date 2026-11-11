// The machine's GPUs and their memory: NVIDIA cards from nvidia-smi, or the one chip of an Apple silicon Mac.
import { readFileSync } from 'node:fs';
import { run } from './util.js';

// LOCAL_AI_GPU=nvidia looks for NVIDIA cards even on a Mac (the smoke test uses it to exercise the Docker path).
const APPLE = process.platform === 'darwin' && process.arch === 'arm64' && process.env.LOCAL_AI_GPU !== 'nvidia';

// Apple silicon has no nvidia-smi: the chip is one GPU whose memory is the unified RAM. `unified` marks it, so it is
// free whenever no run holds it (the OS always uses some of that memory) and runs on it need no Docker.
let chip = null;
async function readApple() {
  if (!chip) {
    const [brand, mem] = await Promise.all([run('sysctl', ['-n', 'machdep.cpu.brand_string'], { timeout: 4000 }), run('sysctl', ['-n', 'hw.memsize'], { timeout: 4000 })]);
    const name = brand.stdout.trim();
    if (brand.code || mem.code || !/^Apple M\d/.test(name)) return [];
    chip = { name, total: Math.round(+mem.stdout.trim() / 1048576) };
  }
  const vm = await run('vm_stat', [], { timeout: 4000 });
  const page = +(/page size of (\d+)/.exec(vm.stdout)?.[1] || 16384);
  const pages = (key) => +(new RegExp(`${key}:\\s+(\\d+)`).exec(vm.stdout)?.[1] || 0);
  const used = vm.code ? null : Math.round(((pages('Pages active') + pages('Pages wired down') + pages('Pages occupied by compressor')) * page) / 1048576);
  return [{ index: 0, name: chip.name, total: chip.total, used, util: null, power: null, temp: null, unified: true }];
}

// The machine's RAM in MiB, from /proc/meminfo, as { total, used }.
function systemMemory() {
  try {
    const text = readFileSync('/proc/meminfo', 'utf8'), kb = (key) => +(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text)?.[1] || 0);
    return { total: Math.round(kb('MemTotal') / 1024), used: Math.round((kb('MemTotal') - kb('MemAvailable')) / 1024) };
  } catch { return null; }
}

// Each GPU as { index, name, total, used, util, power, temp } with memory in MiB. No GPUs is an empty list.
export async function readGpus() {
  if (APPLE) return readApple();
  const q = 'index,name,memory.total,memory.used,utilization.gpu,power.draw,temperature.gpu';
  const r = await run('nvidia-smi', [`--query-gpu=${q}`, '--format=csv,noheader,nounits'], { timeout: 8000 });
  if (r.code) return [];
  const num = (s) => (Number.isFinite(+s) ? +s : null);
  return r.stdout.trim().split('\n').filter(Boolean).map((line) => {
    const [index, name, total, used, util, power, temp] = line.split(', ');
    // A GPU that shares the system's memory (DGX Spark) reports none of its own: its memory is the machine's RAM.
    const own = num(total), ram = own ? null : systemMemory();
    return { index: +index, name, total: own ?? ram?.total ?? 0, used: own ? num(used) : ram?.used ?? null, util: num(util), power: num(power), temp: num(temp), ...(own ? {} : { shared: true }) };
  });
}
