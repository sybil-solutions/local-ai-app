// Docker, with one repair built in. Adding a user to the docker group only changes the account database; a service
// that was started before that (and every process it forks) keeps its old groups until a new login. So after the one
// command the app asks for — `sudo usermod -aG docker $USER` — Docker would still say permission denied until a
// re-login. `newgrp` is setuid and may switch to a group the account is listed in, so the same command can be run
// through it instead: no restart, no logout, no second privilege. `id -nG` reads the database, not this process.
import { userInfo } from 'node:os';
import { q } from './shell.js';
import { run } from './util.js';

const GROUP = 'docker';
let membership = { at: 0, yes: false };
async function inGroup() {
  if (Date.now() - membership.at < 15000) return membership.yes;
  const r = await run('id', ['-nG', userInfo().username], { timeout: 5000 });
  membership = { at: Date.now(), yes: r.code === 0 && r.stdout.split(/\s+/).includes(GROUP) };
  return membership.yes;
}

// Runs docker; if the socket refuses this process but the account is in the group, runs it under newgrp instead.
export async function docker(args, opts) {
  const first = await run('docker', args, opts);
  if (!first.code || !/permission denied/i.test(first.stderr) || !(await inGroup())) return first;
  const line = ['docker', ...args.map((a) => q(String(a)))].join(' ');
  const out = await run('/bin/sh', ['-c', `printf '%s\\n' ${q(line)} | newgrp ${GROUP}`], opts);
  if (!out.code) return out;
  // Some systems ship only sg; both are setuid and may take a group the account is listed in.
  const sg = await run('sg', [GROUP, '-c', line], opts);
  return sg.code ? first : sg;
}
