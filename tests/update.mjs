// Updating an installed copy from a release, end to end. A copy at 0.0.1 is installed in a folder of its own and
// started; a stand-in of the releases repository offers 0.0.2, signed with a key made for this test. Checked:
//   - a list that is not signed with the release key, and one that offers no newer version, are not taken;
//   - a download that does not match the signed list is not kept;
//   - a signed, newer release is offered, downloaded, and installed by its own installer, started as an update of
//     this copy (on Linux, with every program the installer reaches outside its folder a stand-in).
// Usage: node tests/update.mjs            exit code 0 when every check passed
import { execFileSync, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(join(realpathSync(tmpdir()), 'local-ai-update-'));
const LINUX = process.platform === 'linux';
const PORT = 29700 + Math.floor(Math.random() * 200);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const failures = [];
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` (${detail})`}`); if (!ok) failures.push(name); };
const until = async (what, fn, ms) => { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(250); } };

// A copy of the app as a release holds it, at a version of the test's choosing.
const copy = (dir, version) => {
  mkdirSync(dir, { recursive: true });
  for (const part of ['server', 'web', 'install.sh', 'README.md']) cpSync(join(ROOT, part), join(dir, part), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')), version }, null, 2));
};
const OLD = join(TMP, 'installed'), NEW = join(TMP, 'release');
copy(OLD, '0.0.1');
copy(NEW, '0.0.2');
execFileSync('tar', ['-czf', join(TMP, 'local-ai-linux.tar.gz'), '-C', NEW, 'server', 'web', 'package.json', 'install.sh', 'README.md']);
const tarball = readFileSync(join(TMP, 'local-ai-linux.tar.gz'));

// The releases repository. `mode` is what it serves: a good release, one signed with another key, an older one, or a
// good list with a download that is not the file it names.
const ours = generateKeyPairSync('ed25519'), theirs = generateKeyPairSync('ed25519');
const listOf = (version, file = tarball) => Buffer.from(JSON.stringify({ app: 'local-ai', version, notes: ['Faster things'], files: { 'local-ai-linux.tar.gz': { size: file.length, sha256: createHash('sha256').update(file).digest('hex') } } }));
let mode = 'other-key';
const releases = createServer((req, res) => {
  const list = listOf(mode === 'older' ? '0.0.1' : '0.0.2'), key = mode === 'other-key' ? theirs.privateKey : ours.privateKey;
  const send = (code, body) => { res.writeHead(code); res.end(body); };
  if (req.url === '/latest/download/local-ai-update.json') return send(200, list);
  if (req.url === '/latest/download/local-ai-update.json.sig') return send(200, sign(null, list, key).toString('base64'));
  if (req.url === '/download/v0.0.2/local-ai-linux.tar.gz') return send(200, mode === 'tampered' ? Buffer.concat([tarball.subarray(0, -1), Buffer.from([tarball.at(-1) ^ 1])]) : tarball);
  send(404, 'not found');
});
await new Promise((done) => releases.listen(0, '127.0.0.1', done));

// systemd-run, as the copy starts its installer: it says what it was asked, and runs the installer with the settings
// it was given, but with stand-ins for every program the installer reaches outside its own folder.
const tools = join(TMP, 'tools'), asked = join(TMP, 'asked'), home = join(TMP, 'home');
mkdirSync(tools);
mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true });
if (LINUX) for (const name of ['bash', 'uname', 'dirname', 'sed', 'head', 'grep', 'mktemp', 'rm', 'mkdir', 'cp', 'mv', 'cat', 'id', 'seq', 'sleep', 'timeout', 'chmod', 'tar', 'sha256sum']) symlinkSync(execFileSync('which', [name], { encoding: 'utf8' }).trim(), join(tools, name));
for (const name of ['systemctl', 'loginctl']) writeFileSync(join(tools, name), `#!/bin/bash\necho "${name} $*" >> "${asked}"\n`, { mode: 0o755 });
writeFileSync(join(tools, 'curl'), '#!/bin/bash\necho \'{"app":"local-ai"}\'\n', { mode: 0o755 });
symlinkSync(process.execPath, join(tools, 'node'));
const bin = join(TMP, 'bin');
mkdirSync(bin);
writeFileSync(join(bin, 'systemd-run'), `#!/bin/bash
echo "systemd-run $*" >> "${asked}"
script="\${@: -1}"
for a in "$@"; do case "$a" in --setenv=LOCAL_AI_DIR=*) dir="\${a#--setenv=LOCAL_AI_DIR=}" ;; --setenv=LOCAL_AI_SHIPPED=*) shipped="\${a#--setenv=LOCAL_AI_SHIPPED=}" ;; esac; done
env -i PATH="${tools}" HOME="${home}" LOCAL_AI_DIR="$dir" LOCAL_AI_SHIPPED="$shipped" bash "$script" > "${join(TMP, 'installer.log')}" 2>&1 &
`, { mode: 0o755 });

const HOME = join(TMP, 'app-home');
const server = spawn(process.execPath, [join(OLD, 'server', 'index.js')], { cwd: OLD, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, LOCAL_AI_HOME: HOME, LOCAL_AI_PORT: String(PORT), LOCAL_AI_SHARE: '0', LOCAL_AI_DISCOVER: '0', LOCAL_AI_STAND_INS: '1',
  LOCAL_AI_RELEASES_URL: `http://127.0.0.1:${releases.address().port}`, LOCAL_AI_RELEASE_KEY: ours.publicKey.export({ type: 'spki', format: 'pem' }), PATH: `${bin}:${process.env.PATH}`, ...(LINUX ? {} : { LOCAL_AI_UPDATE_KIND: 'linux' }) } });
let log = '';
server.stderr.on('data', (d) => { log = `${log}${d}`.slice(-4000); });
const key = () => JSON.parse(readFileSync(join(HOME, 'config.json'), 'utf8')).key;
const api = async (path, method = 'GET') => { const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { authorization: `Bearer ${key()}` }, signal: AbortSignal.timeout(30000) }); return { status: res.status, json: await res.json().catch(() => null) }; };
const app = async () => (await api('/api/state')).json.app;

try {
  await until('the server', async () => (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok, 20000);
  check('an installed copy can update itself', (await app()).can && (await app()).kind === 'linux');

  mode = 'other-key';
  let v = (await api('/api/app/check', 'POST')).json;
  check('a release that is not signed with the release key is not offered', !v.latest && /not signed with the release key/.test(v.error || ''), JSON.stringify(v));
  mode = 'older';
  v = (await api('/api/app/check', 'POST')).json;
  check('a release that is not newer is not offered', !v.latest && !v.error, JSON.stringify(v));

  mode = 'tampered';
  v = (await api('/api/app/check', 'POST')).json;
  check('a signed, newer release is offered, with what changed and its page', v.latest === '0.0.2' && v.phase === 'available' && v.notes[0] === 'Faster things', JSON.stringify(v));
  check('installing it before it is downloaded is refused', (await api('/api/app/update', 'POST')).status === 409);
  await api('/api/app/download', 'POST');
  v = await until('the tampered download to be refused', async () => { const a = await app(); return a.phase === 'failed' && a; }, 20000);
  check('a download that is not the file the signed list names is not kept', /does not match the signed release/.test(v.error) && !existsSync(join(HOME, 'updates', '0.0.2-local-ai-linux.tar.gz')), JSON.stringify(v));

  mode = 'good';
  await api('/api/app/download', 'POST');
  v = await until('the download', async () => { const a = await app(); return a.phase === 'ready' && a; }, 20000);
  check('the release is downloaded and kept once it matches', v.progress === 1 && existsSync(join(HOME, 'updates', '0.0.2-local-ai-linux.tar.gz')));

  if (LINUX) {
    v = (await api('/api/app/update', 'POST')).json;
    const run = await until('the installer to be started', async () => readFileSync(asked, 'utf8').split('\n').find((l) => l.startsWith('systemd-run')), 10000);
    check('its installer is started as a unit of its own, as an update of this copy, with the Node this runs on',
      v.ok && /--user/.test(run) && run.includes(`--setenv=LOCAL_AI_DIR=${OLD}`) && run.includes('--setenv=LOCAL_AI_SHIPPED=update') && run.includes(`--setenv=PATH=${dirname(process.execPath)}:`), run);
    const done = await until('the installer to finish', async () => JSON.parse(readFileSync(join(OLD, 'package.json'), 'utf8')).version === '0.0.2', 30000).catch(() => false);
    check('and it installs the new version over this copy, and restarts its service', !!done && readFileSync(asked, 'utf8').includes('systemctl --user restart local-ai.service'), existsSync(join(TMP, 'installer.log')) ? readFileSync(join(TMP, 'installer.log'), 'utf8').slice(-600) : 'no installer log');
  }
} catch (e) {
  check('the update test ran to the end', false, e.message);
} finally {
  server.kill();
  releases.close();
  if (failures.length) console.log(`\n--- server log ---\n${log}`);
  rmSync(TMP, { recursive: true, force: true });
}
console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
