// Omarchy's own Agents panel, when this machine runs Omarchy. Two files of Omarchy's are written, each the place
// Omarchy gives for exactly this, and nothing else of Omarchy's is touched:
//   - ~/.local/state/omarchy/agents/usage/local-ai.json: the panel draws a section for every record in that folder,
//     whoever wrote it. This one says which models Local AI is running, as the section's plan line. It carries no
//     token counts: Omarchy counts self-hosted work itself, from each agent's own sessions (see below), and the
//     same tokens must not be counted twice. With nothing running the record is removed, and the section with it.
//   - ~/.config/omarchy/agents/local.json: the provider ids Omarchy counts as self-hosted. Pi, Oh My Pi and OpenCode
//     record a session's provider by the id it was opened under, so the ids Local AI opens them under are added
//     here, when an agent is opened. Ids already there, and anything else in the file, are kept.
// On a machine without Omarchy's folders nothing is written.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { event } from './util.js';

const STATE = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), CONFIG = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
const RECORD = join(STATE, 'omarchy', 'agents', 'usage', 'local-ai.json'), LOCALS = join(CONFIG, 'omarchy', 'agents', 'local.json');
const put = (file, value) => { const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, `${JSON.stringify(value)}\n`); renameSync(tmp, file); };

// The record for the models running now: { name, phase } each. `at` is when, so a test can fix it.
export function recordFor(runs, at = new Date()) {
  const ready = runs.filter((r) => r.phase === 'ready'), starting = runs.filter((r) => !['ready', 'failed', 'stopping'].includes(r.phase));
  const plan = ready.length ? ready.map((r) => r.name).join(', ') : starting.length ? `Starting ${starting[0].name}` : '';
  if (!plan) return null;
  return { schemaVersion: 1, id: 'local-ai', name: 'Local AI', updatedAt: at.toISOString(), ready: true, tierLabel: plan.slice(0, 80), usageStatusText: '', authHelpText: '',
    hasLocalStats: false, hasPromptStats: false, limits: [], limitsFetchedAt: 0, limitsStale: false,
    todayPrompts: 0, todaySessions: 0, todayTotalTokens: 0, todayTokensByModel: {}, recentDays: [], totalPrompts: 0, totalSessions: 0, activeDays: 0, activeDates: [], modelUsage: {} };
}

let shown = null; // the plan line last written, so the file is touched only when it changes
export function showRuns(runs) {
  try {
    if (!existsSync(dirname(RECORD))) return;
    const record = recordFor(runs), plan = record?.tierLabel || '';
    if (plan === shown) return;
    if (record) put(RECORD, record); else rmSync(RECORD, { force: true });
    shown = plan;
  } catch (e) { event('warn', 'omarchy.record', { error: e.message }); }
}

// Adds provider ids to the ones Omarchy counts as self-hosted.
export function countAsLocal(ids) {
  try {
    if (!existsSync(join(CONFIG, 'omarchy'))) return;
    let file = {};
    try { file = JSON.parse(readFileSync(LOCALS, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') return; } // a file that can't be read is the person's own, and is left alone
    if (!file || typeof file !== 'object' || Array.isArray(file)) return;
    const have = Array.isArray(file.providers) ? file.providers : [], lower = new Set(have.map((p) => String(p).toLowerCase())), add = [...new Set(ids)].filter((id) => !lower.has(String(id).toLowerCase()));
    if (!add.length) return;
    mkdirSync(dirname(LOCALS), { recursive: true });
    put(LOCALS, { ...file, providers: [...have, ...add] });
  } catch (e) { event('warn', 'omarchy.locals', { error: e.message }); }
}
