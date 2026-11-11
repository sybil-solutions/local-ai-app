// The terminal an agent opens in.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { WIN } from './shell.js';
import { config, fail, once, run, saveConfig } from './util.js';

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
// LOCAL_AI_TERMINAL=none opens none: Open then always gives the command to paste (a machine nobody sits at).
const terminals = once(async () => {
  if (process.env.LOCAL_AI_TERMINAL === 'none') return [];
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
});
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

// The command that opens a script in the chosen terminal, or null when there is none to open it in.
export async function terminalFor(script) {
  if (WIN) return ['cmd', ['/c', 'start', '', 'cmd', '/k', script]];
  const list = await terminals(), pick = list.find((t) => t.id === config.terminal) || list[0];
  return pick ? pick.start(script) : null;
}
