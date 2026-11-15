#!/usr/bin/env node
// The integration test. Runs the real server the way a user does and checks what a user would notice. No mocks
// inside the app: it gets a registry served from here, engines that answer like real ones, a stand-in docker and
// nvidia-smi on PATH, and a second Local AI as another machine.
//   Everywhere: it starts and answers, the key guards the API, the page never hands the key to a caller on this
//   machine, files outside web/ can't be read and an unchanged one is not sent twice, pairing and the installer
//   refuse strangers, a model someone else started is found and its tokens and prefill speed are counted from its
//   /metrics, a container recipe starts, is adopted and stops, a second machine is connected and followed, and a look
//   costs what the README says it does (Docker asked every fifth one, nvidia-smi started once). Every recipe the
//   registry has for the machine's cards is listed, with the reason when the app will not start it; a recipe's typed
//   resources reach Docker; weights already on the machine are checked and used where they are, not downloaded.
//   On Apple silicon also: a pinned host recipe is offered (a tampered one is not), starts in its own venv, answers
//   through the app's port, counts its tokens, survives an app restart, and is gone after Stop.
// Usage: node tests/integration.mjs   (exit code 0 when every check passed)
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = mkdtempSync(join(tmpdir(), 'local-ai-integration-'));
const PORT = 28700 + Math.floor(Math.random() * 400) * 2; // run ports are PORT+1..99, host engines PORT+100..199
const APPLE = process.platform === 'darwin' && process.arch === 'arm64';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const failures = [];
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` (${detail})`}`); if (!ok) failures.push(name); };
const until = async (what, fn, ms) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${ms / 1000}s waiting for ${what}`);
    await sleep(500);
  }
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// A server that answers JSON from a function of the path; used for the registry and the outside engine.
function serve(handler) {
  const s = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const [code, data, type = 'application/json'] = handler(req, body);
    res.writeHead(code, { 'content-type': type });
    res.end(typeof data === 'string' ? data : JSON.stringify(data));
  });
  return new Promise((done) => s.listen(0, '127.0.0.1', () => done(s)));
}

// An engine started outside the app, with vLLM's counters. Each request reads 2000 prompt tokens in 1 s, then a short
// follow-up reads 200 in 0.5 s, too few to time: the speed shown stays 2000.
// It has already read 30,000 prompt tokens in 10 s before the app first sees it.
const counters = { prompt_tokens_total: 30000, generation_tokens_total: 0, request_success_total: 0, num_requests_running: 0, request_prefill_kv_computed_tokens_sum: 30000, request_prefill_time_seconds_sum: 10 };
const outside = await serve((req, body) => {
  if (req.url === '/v1/models') return [200, { data: [{ id: 'outside-model', max_model_len: 65536, owned_by: 'local-ai-tests' }] }]; // a stand-in, and it says so
  if (req.url === '/metrics') return [200, Object.entries(counters).map(([k, v]) => `vllm:${k}{model_name="outside-model"} ${v}`).join('\n'), 'text/plain'];
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    if (!body.includes('messages')) return [400, { error: 'messages required' }]; // the app's probe for which APIs it has
    const n = body.includes('short') ? 200 : 2000;
    Object.assign(counters, { prompt_tokens_total: counters.prompt_tokens_total + n, generation_tokens_total: counters.generation_tokens_total + 50, request_success_total: counters.request_success_total + 1,
      request_prefill_kv_computed_tokens_sum: counters.request_prefill_kv_computed_tokens_sum + n, request_prefill_time_seconds_sum: counters.request_prefill_time_seconds_sum + (n === 200 ? 0.5 : 1) });
    return [200, { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: n, completion_tokens: 50 } }];
  }
  return [404, { error: 'not found' }];
});

// The registry: on Apple silicon, a card that is exactly this chip with one good host recipe and one tampered one.
const script = readFileSync(join(ROOT, 'tests', 'stand-ins', 'fake_engine.py'), 'utf8');
const catalog = { cards: {}, models: {}, builds: {},
  recipes: { 'smoke/none/docker': { card: 'no-such-card', model: 'dock-1', engine: 'vllm', launch: { image: `example/engine@sha256:${'0'.repeat(64)}`, port: 8000, args: [] } } } };
// For the Docker path: a card the stand-in nvidia-smi reports, one good recipe for it, and recipes that each break
// one rule a registry recipe must keep. None of the broken ones may be offered or started.
const PINNED = `example/engine@sha256:${'1'.repeat(64)}`, DOCKED = 'smoke/gpu/good.docker';
const docked = (extra) => ({ card: 'smoke-gpu', model: 'dock-2', engine: 'vllm', proof: [{ tps: 50 }], launch: { image: PINNED, port: 8000, cards: 1, seqs: 1, ctx: 8192, args: ['--model', 'x'], flags: ['--ipc host', '--shm-size=1g'], env: { HF_HOME: '/cache' }, ...extra } });
catalog.cards['smoke-gpu'] = { name: 'Smoke Test GPU', vram_gb: 24, backend: 'nvidia' };
catalog.recipes[DOCKED] = docked({});
const BROKEN = {
  'an image that is not pinned': docked({ image: 'example/engine:latest' }),
  'an option that is not allowed': docked({ flags: ['--privileged'] }),
  'an empty option in front of ones that are not allowed': docked({ flags: ['', '--privileged', '-v /:/host'] }),
  'options that are not a list of text': docked({ flags: [['--privileged']] }),
  'an option with no value, which would take the next argument': docked({ flags: ['--ipc'] }),
  'a second option hidden in a value': docked({ flags: ['--ipc host --privileged'] }),
  'a value that is itself an option': docked({ flags: ['--workdir --privileged'] }),
  'a volume of its own': docked({ flags: ['-v /:/host'] }),
  'a port that is not a number': docked({ port: '8000 --privileged' }),
  'an environment name that is not a name': docked({ env: { '--privileged': '1' } }),
  'weights that are not pinned': docked({ weights: [{ repo: 'org/model', revision: 'main', at: '/models' }] }),
  'weights mounted outside a plain path': docked({ weights: [{ repo: 'org/model', revision: '0'.repeat(40), at: '/models/../../etc' }] }),
};
Object.entries(BROKEN).forEach(([, recipe], i) => { catalog.recipes[`smoke/gpu/broken-${i}.docker`] = recipe; });
// Recipes the registry holds for the same card that say more: notes from their source, what the host must have beside
// the card, typed resources, and weights. Two repos stand in for Hugging Face's: `kept` is already on this machine as
// it was published; `changed` is here too, but one file in it is not the published one.
const REV = 'c'.repeat(40), NOTED = 'smoke/gpu/noted.docker', CHANGED = 'smoke/gpu/changed.docker', HUNGRY = 'smoke/gpu/hungry.docker', HAVE = join(HOME, 'have');
const published = { 'config.json': '{"model_type":"stand-in"}\n', 'model.safetensors': 'w'.repeat(70000) };
const gitBlob = (text) => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0${text}`).digest('hex');
const tree = Object.entries(published).map(([path, text]) => ({ type: 'file', path, size: Buffer.byteLength(text), oid: gitBlob(text),
  ...(path.endsWith('.safetensors') ? { lfs: { oid: createHash('sha256').update(text).digest('hex'), size: Buffer.byteLength(text) } } : {}) }));
for (const [repo, files] of [['kept', published], ['changed', { ...published, 'model.safetensors': 'x'.repeat(70000) }]]) {
  mkdirSync(join(HAVE, repo), { recursive: true });
  for (const [path, text] of Object.entries(files)) writeFileSync(join(HAVE, repo, path), text);
}
const downloads = []; // every file asked of the stand-in Hugging Face
const hf = await serve((req) => {
  const listing = /^\/api\/models\/org\/(kept|changed)\/tree\/c{40}\?/.exec(req.url), file = /^\/org\/(kept|changed)\/resolve\/c{40}\/(.+)$/.exec(req.url);
  if (listing) return [200, tree];
  if (file && published[file[2]] !== undefined) { downloads.push(`${file[1]}/${file[2]}`); return [200, published[file[2]], 'application/octet-stream']; }
  return req.url.startsWith('/api/models?search=') ? [200, []] : [404, { error: 'not found' }];
});
catalog.recipes[NOTED] = { ...docked({ setup: 'NEEDS: one card. Measured on the reference host.', needs: { host_ram_gb: 1, disk_gb: 3, fast_storage: 'nvme' },
  resources: { ipcLock: true, memlockUnlimited: true, memoryBytes: 2 ** 33, memorySwapBytes: 2 ** 33 }, weights: [{ repo: 'org/kept', revision: REV, at: '/models' }] }), model: 'kept-1' };
catalog.recipes[CHANGED] = { ...docked({ weights: [{ repo: 'org/changed', revision: REV, at: '/models' }] }), model: 'changed-1' };
catalog.recipes[HUNGRY] = { ...docked({ needs: { host_ram_gb: 1e6 } }), model: 'hungry-1' };
catalog.recipes[NOTED].proof = [{ tps: 50, gates: 'load chat reasoning tools context speed' }]; // the lab saw this one call a tool; nothing in its arguments says it can
// Setups, as the registry names them: one card, the machine's two cards together, and two machines of the card.
// One recipe needs both cards; another is one engine across two machines.
const PAIR = 'smoke/gpu/pair.docker.2x', SPREAD = 'smoke/gpu/spread.docker.2x';
catalog.cards['smoke-gpu'].setups = [{ cards: 1, machines: 1, label: 'Smoke Test GPU' }, { cards: 2, machines: 1, label: '2 × Smoke Test GPU (one machine)' }, { cards: 1, machines: 2, label: '2 × Smoke Test GPU' }];
catalog.recipes[PAIR] = { ...docked({ cards: 2 }), model: 'pair-1', proof: [{ tps: 20 }] };
catalog.recipes[SPREAD] = { ...docked({ machines: 2, flags: ['--network host'] }), model: 'spread-1' };
// A third recipe for both cards whose only speed is from the registry's older acceptance, and a much higher one
// than the measured recipe's. The registry recommends the measured one for the two-card setup.
// A recipe that needs almost all of this machine's memory to be free: the machine has that much, so it is offered, but
// that much is never free, so it is not started.
const TIGHT = 'smoke/gpu/tight.docker';
catalog.recipes[TIGHT] = { ...docked({ needs: { host_ram_gb: totalmem() / 2 ** 30 - 0.01 } }), model: 'tight-1' };
const OLDFAST = 'smoke/gpu/oldfast.docker.2x';
catalog.recipes[OLDFAST] = { ...docked({ cards: 2 }), model: 'oldfast-1', proof: [{ tps: 500, legacy: true, gates: 'load chat' }] };
catalog.cards['smoke-gpu'].setups[1].picks = [PAIR, OLDFAST];
const HOSTED = 'smoke/chip/fake.host', TAMPERED = 'smoke/chip/tampered.host';
if (APPLE) {
  const sysctl = (key) => execFileSync('sysctl', ['-n', key], { encoding: 'utf8', timeout: 5000 }).trim();
  catalog.cards['smoke-chip'] = { name: sysctl('machdep.cpu.brand_string'), vram_gb: +sysctl('hw.memsize') / 2 ** 30, backend: 'metal' };
  const launch = (text) => ({ kind: 'host', backend: 'metal', image: null, pip: [], port: 8080, cards: 1, seqs: 1, ctx: 4096,
    command: ['python3', 'fake_engine.py', '--host', '127.0.0.1', '--port', '8080'], config: { at: 'fake_engine.py', text, sha256: createHash('sha256').update(script).digest('hex') } });
  catalog.recipes[HOSTED] = { card: 'smoke-chip', model: 'fake-1', engine: 'mlx', launch: launch(script), proof: [{ tps: 10 }] };
  catalog.recipes[TAMPERED] = { card: 'smoke-chip', model: 'tampered-1', engine: 'mlx', launch: launch(`${script}\nimport os  # changed after it was hashed\n`), proof: [{ tps: 10 }] };
}
const registry = await serve(() => [200, catalog]);
// A proxy in front of cloud models: answers /v1/models with several, has no engine counters. Not a model running here.
const proxy = await serve((req) => (req.url === '/v1/models' ? [200, { data: [{ id: 'cloud-a' }, { id: 'cloud-b' }] }] : [404, { error: 'not found' }]));

// The app itself.
const logFile = join(HOME, 'server.log');
let server = null, log = '';
// `nvidia: true` starts it as on an NVIDIA machine: the stand-in nvidia-smi and docker come first on the PATH.
const FAKE_DOCKER = join(HOME, 'docker'), THERE_DOCKER = join(HOME, 'docker-second');
function startServer({ nvidia = false } = {}) {
  server = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], { cwd: ROOT, env: { ...process.env, PI_CODING_AGENT_DIR: join(HOME, 'pi'), LOCAL_AI_HOME: HOME, LOCAL_AI_PORT: String(PORT), LOCAL_AI_SHARE: '0', LOCAL_AI_STAND_INS: '1', HF_HOME: join(HOME, 'hf'),
    HF_ENDPOINT: `http://127.0.0.1:${hf.address().port}`, LOCAL_AI_MODELS: `${join(HOME, 'models')}:${HAVE}`, // downloads go to the first folder; the second holds weights already here
    LOCAL_AI_REGISTRY: `http://127.0.0.1:${registry.address().port}/catalog.json`,
    ...(nvidia ? { LOCAL_AI_GPU: 'nvidia', FAKE_DOCKER_DIR: FAKE_DOCKER, PATH: `${join(ROOT, 'tests', 'stand-ins', 'bin')}:${process.env.PATH}` } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (b) => { log += b; });
  server.stderr.on('data', (b) => { log += b; });
  return until('the server to answer', async () => (await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(2000) })).ok, 30000);
}
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const gone = new Promise((done) => server.once('exit', done));
  server.kill('SIGTERM');
  await Promise.race([gone, sleep(10000)]);
  if (server.exitCode === null) server.kill('SIGKILL');
}
const key = () => JSON.parse(readFileSync(join(HOME, 'config.json'), 'utf8')).key;
async function api(path, { method = 'GET', body, auth = true } = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${key()}` } : {}) }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const state = async () => (await api('/api/state')).json;
// A raw request, so the Host header and the path go out exactly as written.
const raw = (path, host) => new Promise((done, failed) => {
  const req = request({ host: '127.0.0.1', port: PORT, path, headers: { host: host || `127.0.0.1:${PORT}` } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => done({ status: res.statusCode, body: b, headers: res.headers })); });
  req.on('error', failed);
  req.end();
});
const chat = (port, stream, content = 'hi') => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30000),
  body: JSON.stringify({ model: 'x', stream, ...(stream ? { stream_options: { include_usage: true } } : {}), messages: [{ role: 'user', content }] }) }).then((r) => r.text());

let hostPid = null;
const watchdog = setTimeout(() => { console.log('FAIL the integration test took longer than 10 minutes'); cleanup().then(() => process.exit(1)); }, 600e3);
async function cleanup() {
  clearTimeout(watchdog);
  await stopServer();
  let pids = [hostPid];
  for (const dir of [FAKE_DOCKER, THERE_DOCKER]) { try { for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) pids.push(JSON.parse(readFileSync(join(dir, f), 'utf8')).pid); } catch { /* the Docker path never ran */ } }
  try { pids = pids.concat(Object.values(JSON.parse(readFileSync(join(HOME, 'hosts.json'), 'utf8'))).map((h) => h.pid)); } catch { /* none started */ }
  for (const pid of pids) if (pid && alive(pid)) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }
  outside.close(); registry.close(); proxy.close(); hf.close();
  writeFileSync(logFile, log);
  if (failures.length) console.log(`\n--- server log (last 60 lines) ---\n${log.trim().split('\n').slice(-60).join('\n')}`);
  rmSync(HOME, { recursive: true, force: true });
}

try {
  await startServer();
  const first = await until('the first snapshot with the registry', async () => { const s = await state(); return s?.v && s.catalog.count && s; }, 30000);
  check('serves a snapshot with a version', !!first.v);
  check('reads the registry', first.catalog.count === Object.keys(catalog.recipes).length, `count ${first.catalog.count}`);
  check('the API needs the key', (await api('/api/state', { auth: false })).status === 401);
  check('a wrong key is refused', (await fetch(`http://127.0.0.1:${PORT}/api/state`, { headers: { authorization: 'Bearer nope' } })).status === 401);
  const page = await raw('/');
  check('the page names its scripts, so the browser fetches them side by side', /<link rel="modulepreload" href="\/app\.js">/.test(page.body) && page.body.includes('href="/components/home.js"'));
  // Every address the app answers on has a listener made the same way (listener() in server/index.js), this one included.
  check('a connection is kept open for five minutes, so the next request does not have to open one', /timeout=300\b/.test(page.headers['keep-alive'] || ''), page.headers['keep-alive']);
  const appJs = await fetch(`http://127.0.0.1:${PORT}/app.js`), tag = appJs.headers.get('etag');
  const unchanged = await fetch(`http://127.0.0.1:${PORT}/app.js`, { headers: { 'if-none-match': tag } });
  check('a file of the page is not sent again to a browser that already has it', appJs.status === 200 && !!tag && unchanged.status === 304 && (await unchanged.text()) === '');
  check('the page does not hand the key to whoever asks from this machine', page.status === 200 && !page.body.includes(key()) && !page.body.includes('__KEY__'));
  const nonce = 'ab'.repeat(16), health = await (await fetch(`http://127.0.0.1:${PORT}/api/health?nonce=${nonce}`)).json();
  check('the server proves it holds the key without showing it', health.proof === createHmac('sha256', key()).update(nonce).digest('hex') && !JSON.stringify(health).includes(key()));
  check('no proof is given for something that is not a nonce', !(await (await fetch(`http://127.0.0.1:${PORT}/api/health?nonce=${key()}x`)).json()).proof);
  check('a key that is one character short is refused', (await fetch(`http://127.0.0.1:${PORT}/api/state`, { headers: { authorization: `Bearer ${key().slice(0, -1)}` } })).status === 401);
  const rebound = await raw('/', 'evil.example:80');
  check('a rebound DNS name does not get the key', rebound.status === 200 && !rebound.body.includes(key()));
  for (const path of ['/../server/util.js', '/..%2fpackage.json', '/%2e%2e/config.json', '/server/index.js', '/web/../../etc/passwd']) {
    const res = await raw(path);
    check(`can't read ${path}`, res.status === 404 && !res.body.includes('import '), `status ${res.status}`);
  }
  check('pairing refuses a machine that is not on your tailnet', (await api('/api/pair', { method: 'POST', auth: false })).status === 403);
  check('the installer refuses a machine that is not on your tailnet', (await raw('/install')).status === 403);
  if (process.platform === 'linux') {
    // The installer, as another machine would send it here: it must leave alone a copy that updates itself, and one
    // that is already running (this server stands in for it) unless it was sent as an update. It stops before it
    // changes anything, and is given a home of its own in case it did not.
    const home = join(HOME, 'installer-home'), unit = join(home, '.config', 'systemd', 'user');
    mkdirSync(unit, { recursive: true });
    writeFileSync(join(unit, 'local-ai.service'), `[Service]\nEnvironment="LOCAL_AI_PORT=${PORT}"\n`);
    const sent = (mode, dest) => spawnSync('bash', [join(ROOT, 'install.sh')], { env: { PATH: process.env.PATH, HOME: home, LOCAL_AI_SHIPPED: mode, LOCAL_AI_DIR: dest }, encoding: 'utf8', timeout: 20000 });
    const clone = join(HOME, 'clone'), plain = join(HOME, 'plain');
    mkdirSync(join(clone, '.git'), { recursive: true });
    mkdirSync(plain);
    const kept = sent('update', clone), running = sent('install', plain);
    check('an install sent from another machine leaves a copy that updates itself alone', kept.status === 3 && readdirSync(clone).join() === '.git', `status ${kept.status} ${kept.stdout}`);
    check('and leaves a copy that is already running alone unless it is an update', running.status === 4 && !readdirSync(plain).length, `status ${running.status} ${running.stdout}`);
    // An update, run to its end. Everything the installer reaches outside its own folder is a stand-in here: curl
    // (which also stands in for nodejs.org), systemctl and loginctl. There is no node on its PATH, as on a machine
    // that got its Node from this installer.
    const tools = join(HOME, 'installer-tools'), asked = join(HOME, 'installer-asked');
    mkdirSync(tools);
    for (const name of ['bash', 'uname', 'dirname', 'sed', 'head', 'grep', 'mktemp', 'rm', 'mkdir', 'cp', 'mv', 'cat', 'id', 'seq', 'sleep', 'timeout', 'chmod', 'tar', 'sha256sum']) symlinkSync(execFileSync('which', [name], { encoding: 'utf8' }).trim(), join(tools, name));
    const standIn = (dir, name, does) => writeFileSync(join(dir, name), `#!/bin/bash\necho "${name} $*" >> "${asked}"\n${does}\n`, { mode: 0o755 });
    standIn(tools, 'curl', 'case "$*" in *nodejs.org*) for a in "$@"; do out="$a"; done; echo not-node > "$out" ;; *) echo \'{"app":"local-ai"}\' ;; esac');
    standIn(tools, 'systemctl', 'exit 0');
    standIn(tools, 'loginctl', 'exit 0');
    const update = (dest, path) => spawnSync('bash', [join(ROOT, 'install.sh')], { env: { PATH: path, HOME: home, LOCAL_AI_SHIPPED: 'update', LOCAL_AI_DIR: dest }, encoding: 'utf8', timeout: 60000 });
    const fetched = () => { try { return readFileSync(asked, 'utf8').includes('nodejs.org'); } catch { return false; } };
    // 1. The machine already has the Node this installer fetched before: it is used, and nothing is downloaded.
    const own = join(HOME, 'own');
    mkdirSync(join(own, 'node', 'bin'), { recursive: true });
    symlinkSync(process.execPath, join(own, 'node', 'bin', 'node'));
    const reused = update(own, tools);
    check('an update uses the Node an earlier install fetched, and downloads nothing', reused.status === 0 && !fetched() && existsSync(join(own, 'server', 'index.js')) && !existsSync(join(own, '.new'))
      && readFileSync(join(unit, 'local-ai.service'), 'utf8').includes(`ExecStart="${join(own, 'node', 'bin', 'node')}"`), `status ${reused.status} ${reused.stdout} ${reused.stderr}`);
    // 2. The Node here does not run, so one is fetched, but it cannot be unpacked (as on a full disk). What was
    // there stays exactly as it was: nothing is removed for something that is not here yet.
    const full = join(HOME, 'installer-tools-full'), broken = join(HOME, 'broken-node');
    mkdirSync(full);
    standIn(full, 'sha256sum', 'exit 0');
    standIn(full, 'tar', 'echo "tar: Cannot write: No space left on device" >&2; exit 2');
    mkdirSync(join(broken, 'node', 'bin'), { recursive: true });
    mkdirSync(join(broken, 'server'));
    writeFileSync(join(broken, 'node', 'bin', 'node'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(broken, 'server', 'index.js'), '// the version that was here\n');
    const stopped = update(broken, `${full}:${tools}`);
    check('an update that cannot unpack what it fetched changes nothing, and says so', stopped.status === 1 && fetched() && /Nothing was changed/.test(stopped.stdout) && readFileSync(join(broken, 'node', 'bin', 'node'), 'utf8').includes('exit 1')
      && readFileSync(join(broken, 'server', 'index.js'), 'utf8').includes('was here') && !existsSync(join(broken, 'node.new')) && !existsSync(join(broken, '.new')), `status ${stopped.status} ${stopped.stdout} ${stopped.stderr}`);
    // 3. The one-line installer the website gives (scripts/get.sh): it downloads the release and its checksum (curl
    // stands in for the release's address and hands over files made here), and runs the installer inside only when
    // the two match.
    const release = join(HOME, 'release'), getTools = join(HOME, 'get-tools');
    mkdirSync(release);
    mkdirSync(getTools);
    for (const name of readdirSync(tools).filter((n) => n !== 'curl')) symlinkSync(join(tools, name), join(getTools, name));
    for (const name of ['cut', 'gzip']) symlinkSync(execFileSync('which', [name], { encoding: 'utf8' }).trim(), join(getTools, name));
    execFileSync('tar', ['-czf', join(release, 'local-ai-linux.tar.gz'), '-C', ROOT, 'server', 'web', 'package.json', 'install.sh', 'README.md']);
    const sum = execFileSync('sha256sum', [join(release, 'local-ai-linux.tar.gz')], { encoding: 'utf8' }).split(' ')[0];
    standIn(getTools, 'curl', `for a in "$@"; do out="$a"; done; case "$*" in *release.test/local-ai-linux.tar.gz.sha256*) cat "${release}/sum" > "$out" ;; *release.test/local-ai-linux.tar.gz*) cat "${release}/local-ai-linux.tar.gz" > "$out" ;; *) echo '{"app":"local-ai"}' ;; esac`);
    const get = (dest) => spawnSync('bash', [join(ROOT, 'scripts', 'get.sh')], { env: { PATH: getTools, HOME: home, LOCAL_AI_RELEASE: 'http://release.test', LOCAL_AI_DIR: dest }, encoding: 'utf8', timeout: 60000 });
    const withNode = (dest) => { mkdirSync(join(dest, 'node', 'bin'), { recursive: true }); symlinkSync(process.execPath, join(dest, 'node', 'bin', 'node')); return dest; };
    writeFileSync(join(release, 'sum'), `${'0'.repeat(64)}  local-ai-linux.tar.gz\n`);
    const wrong = withNode(join(HOME, 'got-wrong')), refused = get(wrong);
    check('the one-line installer installs nothing when the download does not match its checksum', refused.status === 1 && /did not match its checksum/.test(refused.stdout) && !existsSync(join(wrong, 'server')), `status ${refused.status} ${refused.stdout} ${refused.stderr}`);
    writeFileSync(join(release, 'sum'), `${sum}  local-ai-linux.tar.gz\n`);
    const right = withNode(join(HOME, 'got-right')), got = get(right);
    check('and installs the release when it does', got.status === 0 && existsSync(join(right, 'server', 'index.js')) && existsSync(join(right, 'web', 'index.html')) && /Local AI is running/.test(got.stdout), `status ${got.status} ${got.stdout} ${got.stderr}`);
    mkdirSync(join(right, '.git'));
    const cloned = get(right);
    check('and leaves a copy that updates itself alone', cloned.status === 3 && /updates itself/.test(cloned.stdout), `status ${cloned.status} ${cloned.stdout}`);
  }
  check('settings reject an unknown background', (await api('/api/settings', { method: 'POST', body: { background: '../x' } })).status === 200 && (await state()).background !== '../x');

  // The engine someone else started: found, then its tokens and prefill speed counted.
  const port = outside.address().port;
  const found = await until('the outside engine to be found', async () => (await state()).runs.find((r) => r.external && r.id === port), 45000);
  check('finds a model started outside the app', found.served === 'outside-model');
  const sized = await until('its context length', async () => (await state()).runs.find((r) => r.id === port && r.ctx), 20000);
  check('reads a found model\'s context length from the engine', sized.ctx === 65536, `ctx ${sized.ctx}`);
  // Agents: Pi and Oh My Pi get the model through an extension, so they keep their own config folder and logins.
  const listed = await until('the model list for Pi', async () => { try { return Object.values(JSON.parse(readFileSync(join(HOME, 'agents', 'models.json'), 'utf8')).providers).map((p) => p.models[0]).find((m) => m.id === 'outside-model' && m.contextWindow === 65536); } catch { return null; } }, 20000);
  check('gives Pi the model with its whole context and no smaller output limit', listed.id === 'outside-model' && listed.contextWindow === 65536 && listed.maxTokens === 65536 && listed.omitMaxOutputTokens === true, JSON.stringify(listed));
  check('writes the extension that registers it', readFileSync(join(HOME, 'agents', 'local-ai.js'), 'utf8').includes('registerProvider'));
  const snap = await state();
  check('lists the terminals found here, and T3 Code and DeepSeek Harness among the agents', Array.isArray(snap.terminals) && ['t3', 'dsh'].every((id) => snap.agents.some((a) => a.id === id && a.app)));
  check('installing on a machine that is not one of your Tailscale machines is refused', [404, 503].includes((await api('/api/tailscale/install', { method: 'POST', body: { ip: '203.0.113.9' } })).status));
  check('the installer keeps the hash of the Node it may download', /NODE_SUM=[0-9a-f]{64}/.test(readFileSync(join(ROOT, 'install.sh'), 'utf8')));
  check('settings refuse a terminal that is not installed', (await api('/api/settings', { method: 'POST', body: { terminal: 'no-such-terminal' } })).status === 400);
  check('does not take a proxy of several models for a model running here', !(await state()).runs.some((r) => r.id === proxy.address().port));
  const seen = await until('a first read of its counters', async () => (await state()).runs.find((r) => r.id === port)?.stats, 15000);
  check('shows the engine\'s lifetime prefill speed before it sees a prefill, not 0', seen.pps === 3000, `pps ${seen.pps}`);
  await chat(port, false);
  const counted = await until('its tokens to be counted', async () => { const r = (await state()).runs.find((x) => x.id === port); return r?.stats?.used >= 2050 && r; }, 15000);
  check('counts its tokens from /metrics', counted.stats.used === 2050, `used ${counted.stats.used}`);
  check('reports its prefill speed, not its prompt tokens a second', counted.stats.pps === 2000 && counted.stats.ppsEst === false, JSON.stringify(counted.stats));
  await chat(port, false, 'short');
  const after = await until('the short request to be counted', async () => { const r = (await state()).runs.find((x) => x.id === port); return r?.stats?.used >= 2300 && r; }, 15000);
  check('a short prefill does not drag the prefill speed down', after.stats.pps === 2000, `pps ${after.stats.pps}`);
  check('stopping a model the app did not start is refused', (await api(`/api/runs/${port}`, { method: 'DELETE' })).status === 409);

  // A second Local AI, with a model of its own that this machine can also reach on a port here (as it would through
  // a forwarder). Until the two are connected nothing says whose model it is, so it is shown as running here. Once
  // they are, it is that machine's: it is not shown as running here, and what it served is counted there, not here.
  // The machine is followed, not asked again and again: what changes there is here at once.
  const THERE = PORT + 400, thereHome = join(HOME, 'second');
  const there = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, PI_CODING_AGENT_DIR: join(HOME, 'pi'), LOCAL_AI_HOME: thereHome, LOCAL_AI_PORT: String(THERE), LOCAL_AI_SHARE: '0', LOCAL_AI_DISCOVER: '0', LOCAL_AI_STAND_INS: '1', HF_HOME: join(HOME, 'hf'), LOCAL_AI_REGISTRY: `http://127.0.0.1:${registry.address().port}/catalog.json`,
    LOCAL_AI_GPU: 'nvidia', FAKE_DOCKER_DIR: THERE_DOCKER, PATH: `${join(ROOT, 'tests', 'stand-ins', 'bin')}:${process.env.PATH}` } });
  try {
    await until('the second machine to answer', async () => (await fetch(`http://127.0.0.1:${THERE}/api/health`, { signal: AbortSignal.timeout(2000) })).ok, 30000);
    const thereKey = JSON.parse(readFileSync(join(thereHome, 'config.json'), 'utf8')).key;
    const far = async (path, { method = 'GET', body } = {}) => (await fetch(`http://127.0.0.1:${THERE}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${thereKey}` }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(20000) })).json();
    const tell = (body) => far('/api/settings', { method: 'POST', body });
    await until('the second machine\'s models', async () => (await far('/api/state')).groups?.some((g) => g.recipes.some((r) => r.id === DOCKED)), 30000);
    const farPort = (await far('/api/runs', { method: 'POST', body: { recipe: DOCKED } })).id;
    await until('the second machine\'s model to be ready', async () => (await far('/api/state')).runs.find((r) => r.id === farPort && r.phase === 'ready'), 60000);
    const mistaken = await until('this machine to find that model on a port here', async () => (await state()).runs.find((r) => r.external && r.id === farPort), 45000);
    check('a model on a machine that is not connected is shown as running here: nothing says whose it is', mistaken.served === 'fake-engine');
    // Its speed is measured over there first; what that writes is not usage, there or here.
    await until('the second machine to have measured its model', async () => (await far('/api/state')).groups.flatMap((g) => g.recipes).find((r) => r.id === DOCKED)?.speed.measured, 120000);
    await sleep(4500);
    const countedHere = async () => (await api('/api/usage')).json.days.reduce((n, d) => n + (d.models['fake-engine'] || 0), 0);
    await chat(farPort, false);
    const meanwhile = await until('its tokens to be counted here', async () => (await countedHere()) >= 2000, 15000).then(() => true, () => false);
    check('and what it serves is counted here meanwhile', meanwhile, `${await countedHere()} tokens`);

    check('a machine is not connected on a wrong key', (await api('/api/devices', { method: 'POST', body: { url: `http://127.0.0.1:${THERE}`, key: 'wrong' } })).status === 401);
    check('a machine is connected by its address and key', (await api('/api/devices', { method: 'POST', body: { url: `http://127.0.0.1:${THERE}`, key: thereKey } })).status === 200);
    const linked = await until('the machine to be followed', async () => (await state()).devices.find((d) => d.online && d.state), 10000);
    check('a connected machine is shown with what it says about itself', Array.isArray(linked.state.groups) && Array.isArray(linked.state.runs) && linked.state.devices.length === 0);
    check('it says which engine each of its models is, so the same one reached from here can be told', typeof linked.state.runs.find((r) => r.id === farPort)?.born === 'number');
    await tell({ tone: 'gray' });
    const told = Date.now();
    let arrived = 0;
    while (!arrived && Date.now() - told < 5000) { if ((await state()).devices[0]?.state?.tone === 'gray') arrived = Date.now() - told; else await sleep(40); }
    check('a change on a connected machine is here in under a second', arrived > 0 && arrived < 1000, `${arrived} ms`);
    check('a call is run on the connected machine through this one', (await api('/api/devices/0/usage')).status === 200 && (await api('/api/devices/0/endpoints')).json?.key === thereKey);

    const theirs = await until('the model to be seen as that machine\'s', async () => !(await state()).runs.some((r) => r.id === farPort), 45000).then(() => true, () => false);
    check('once its machine is connected, a model reached through a port here is not shown as running here', theirs);
    const hours = (await api('/api/usage')).json.hours;
    check('what it served is taken out of this machine\'s usage', (await countedHere()) === 0 && !Object.values(hours).some((rows) => 'fake-engine' in rows), `${await countedHere()} tokens still counted here`);
    const farCount = (await state()).devices[0].state.usage.all;
    check('and is counted on the machine it runs on', farCount >= 2000, `${farCount} tokens there`);
    await chat(farPort, false);
    await until('the second machine to count another answer', async () => (await state()).devices[0].state.usage.all >= farCount + 2000, 15000);
    await sleep(2500); // long enough for this machine to have counted it too, had it still been counting
    check('nothing it serves afterwards is counted here', (await countedHere()) === 0 && (await state()).usage.all === (await state()).usage.days.reduce((n, d) => n + d.v, 0), `${await countedHere()} tokens`);

    await far(`/api/runs/${farPort}`, { method: 'DELETE' });
    there.kill('SIGKILL');
    await until('the machine to be seen as gone', async () => (await state()).devices[0]?.online === false, 30000);
    check('a machine that is gone is shown offline, with its last models and nothing running', (await state()).devices[0].state.runs.length === 0);
    check('a machine is forgotten when removed', (await api('/api/devices?i=0', { method: 'DELETE' })).status === 200 && (await state()).devices.length === 0);
  } finally { there.kill('SIGKILL'); }

  if (APPLE) {
    const s = await state();
    const group = s.groups.find((g) => g.card === 'smoke-chip');
    check('this Mac matches its own Metal card', !!group, JSON.stringify(s.gpus));
    check('Docker is not asked for on Apple silicon', s.needsDocker === false);
    check('offers the pinned host recipe', !!group?.recipes.some((r) => r.id === HOSTED && r.host));
    check('does not offer a host recipe whose script does not match its hash', !group?.recipes.some((r) => r.id === TAMPERED));
    check('starting the tampered recipe is refused', (await api('/api/runs', { method: 'POST', body: { recipe: TAMPERED } })).status === 409);

    // A host recipe runs as this user, so it waits to be allowed: the snapshot carries what to allow, and only that starts it.
    const asks = group?.recipes.find((r) => r.id === HOSTED)?.approve;
    check('a host recipe that was never allowed says so', /^[0-9a-f]{64}$/.test(asks || ''));
    check('it does not start before it is allowed', (await api('/api/runs', { method: 'POST', body: { recipe: HOSTED } })).status === 409);
    check('it does not start on a fingerprint that is not its own', (await api('/api/runs', { method: 'POST', body: { recipe: HOSTED, approve: 'f'.repeat(64) } })).status === 409);
    const { json: started } = await api('/api/runs', { method: 'POST', body: { recipe: HOSTED, approve: asks } });
    const id = started?.id;
    check('starts the host recipe', Number.isInteger(id), JSON.stringify(started));
    const ready = await until('the host run to be ready', async () => { const r = (await state()).runs.find((x) => x.id === id); if (r?.phase === 'failed') throw new Error(r.error); return r?.phase === 'ready' && r; }, 300000);
    check('the host run answers through the app', ready.served === 'fake-engine' && ready.host === true);
    check('once allowed, it is not asked about again', (await state()).groups.flatMap((g) => g.recipes).find((r) => r.id === HOSTED)?.approve === null);
    // The run's port is the app's own door in front of the engine. It answers this machine, not a page from another site.
    const door = (headers) => new Promise((done) => { const req = request({ host: '127.0.0.1', port: id, path: '/v1/models', headers }, (res) => { res.resume(); done(res.statusCode); }); req.on('error', () => done(-1)); req.end(); });
    check('the model’s port answers a program on this machine', (await door({})) === 200);
    check('it refuses a name that is not this machine’s (a rebound DNS name)', (await door({ host: 'evil.example:80' })) === 403);
    check('it refuses a page from another site', (await door({ origin: 'https://evil.example' })) === 403);
    check('it refuses a page that hides where it is from', (await door({ origin: 'null' })) === 403);
    check('it answers a page served from this machine', (await door({ origin: 'http://localhost:3000' })) === 200);
    check('the host run is not offered to other machines when the app listens on loopback', ready.reachable === false);
    hostPid = JSON.parse(readFileSync(join(HOME, 'hosts.json'), 'utf8'))[id]?.pid;
    check('remembers the engine process', alive(hostPid));
    await until('its speed to be measured', async () => (await state()).groups.flatMap((g) => g.recipes).find((r) => r.id === HOSTED)?.speed.measured, 120000);
    await sleep(4500); // the scrape just after a measurement is skipped, so the requests below land after it
    await chat(id, false);
    await chat(id, true);
    const used = await until('host tokens to be counted', async () => { const r = (await state()).runs.find((x) => x.id === id); return r?.stats?.used >= 4032 && r; }, 20000);
    check('counts host tokens at its own port, without the measurement', used.stats.used === 4032, `used ${used.stats.used}`);
    check('with no engine timings, host prefill is an estimate from the wait for the first token, and says so', used.stats.pps > 0 && used.stats.ppsEst === true, JSON.stringify(used.stats));
    // The engine queues this one for 0.5 s and reports 2000 tokens computed in 0.1 s: 20,000 tok/s, not 2000 / 0.6 s.
    await chat(id, true, 'timings');
    const timed = await until('engine timings to be used', async () => { const r = (await state()).runs.find((x) => x.id === id); return r?.stats?.ppsEst === false && r; }, 20000);
    check('engine-reported prefill timing replaces the estimate and leaves queue time out', timed.stats.pps === 20000, JSON.stringify(timed.stats));
    const logs = await api(`/api/runs/${id}/logs?tail=50`);
    check('shows the engine log', /POST \/v1\/chat\/completions/.test(logs.json?.text || ''));
    const ends = await api('/api/endpoints');
    check('lists its local address and no tailnet one', ends.json.runs.some((r) => r.id === id && r.local.endsWith(`:${id}/v1`) && r.tailnet === null));

    await stopServer();
    check('the engine keeps running when the app quits', alive(hostPid));
    await startServer();
    const back = await until('the host run to be adopted', async () => { const r = (await state()).runs.find((x) => x.id === id); return r?.phase === 'ready' && r; }, 60000);
    check('adopts the running engine after a restart', back.host === true);
    check('its port answers again after the restart', /fake-engine/.test(await chat(id, false)));

    check('stops the host run', (await api(`/api/runs/${id}`, { method: 'DELETE' })).status === 200);
    check('the engine process is gone', !alive(hostPid));
    check('forgets it', Object.keys(JSON.parse(readFileSync(join(HOME, 'hosts.json'), 'utf8'))).length === 0);
    check('its port is closed', await fetch(`http://127.0.0.1:${id}/v1/models`, { signal: AbortSignal.timeout(2000) }).then(() => false, () => true));
  }

  // The Docker path, as on an NVIDIA machine: the same server started again with the stand-in nvidia-smi and docker.
  await stopServer();
  await startServer({ nvidia: true });
  const nv = await until('the NVIDIA cards and their recipes', async () => { const s = await state(); return s?.groups?.some((g) => g.recipes.length) && s; }, 30000);
  const offered = nv.groups.flatMap((g) => g.recipes).map((r) => r.id);
  check('finds the NVIDIA cards and asks for Docker', nv.gpus.length === 2 && nv.needsDocker === true && nv.docker.ok === true, JSON.stringify([nv.gpus.length, nv.needsDocker, nv.docker]));
  check('offers the pinned container recipe', offered.includes(DOCKED), offered.join(' '));
  const refused = nv.groups.flatMap((g) => g.blocked);
  for (const [i, why] of Object.keys(BROKEN).entries()) {
    const id = `smoke/gpu/broken-${i}.docker`;
    check(`does not offer or start a recipe with ${why}`, !offered.includes(id) && (await api('/api/runs', { method: 'POST', body: { recipe: id } })).status === 409);
    check('and lists it with the reason, so nothing the registry has for the card goes missing', refused.some((r) => r.id === id && typeof r.why === 'string' && r.why.length > 3), JSON.stringify(refused.find((r) => r.id === id)?.why));
  }
  check('every recipe the registry has for the card is either offered or listed with why not', Object.entries(catalog.recipes).filter(([, r]) => r.card === 'smoke-gpu').every(([id]) => offered.includes(id) !== refused.some((r) => r.id === id)));
  // Recipes are listed by the setup they are for. This machine has two cards: the registry's two-card setup comes
  // first and gives a pick; a recipe that is one engine across two machines is listed under its own setup, with why not.
  const setups = nv.groups.find((g) => g.card === 'smoke-gpu')?.setups || [], picked = Object.values(nv.groups.find((g) => g.card === 'smoke-gpu')?.tiers || {}).filter(Boolean).map((r) => r.id);
  check('lists the setups this machine\'s cards can be part of, largest first, as the registry names them', setups.map((s) => s.label).join(' | ') === '2 × Smoke Test GPU (one machine) | 2 × Smoke Test GPU | Smoke Test GPU', JSON.stringify(setups));
  check('a recipe for both of the machine\'s cards is offered, and is one of the picks', offered.includes(PAIR) && picked.includes(PAIR) && nv.groups.flatMap((g) => g.recipes).find((r) => r.id === PAIR)?.cards === 2, picked.join(' '));
  const pairGroup = nv.groups.find((g) => g.card === 'smoke-gpu');
  check('a speed from the registry\'s older test does not make a model the fast pick over one that was measured', pairGroup?.tiers.fastest?.id === PAIR && pairGroup.recipes.find((r) => r.id === OLDFAST)?.speed.legacy === true && pairGroup.recipes.find((r) => r.id === PAIR)?.speed.legacy === false, pairGroup?.tiers.fastest?.id);
  check('the model shown first is the one the registry recommends for the largest setup', pairGroup?.recommended === PAIR, pairGroup?.recommended);
  const spread = refused.find((r) => r.id === SPREAD);
  check('a recipe that is one engine across two machines is listed under its setup, says so, and is not started', spread?.machines === 2 && /Runs across 2 machines/.test(spread?.why || '') && (await api('/api/runs', { method: 'POST', body: { recipe: SPREAD } })).status === 409, spread?.why);
  const hungry = refused.find((r) => r.id === HUNGRY);
  check('a recipe that needs more memory than this machine has says so and is not started', /Needs 1000000 GB of memory/.test(hungry?.why || '') && (await api('/api/runs', { method: 'POST', body: { recipe: HUNGRY } })).status === 409, hungry?.why);
  const tight = await api('/api/runs', { method: 'POST', body: { recipe: TIGHT } });
  check('a recipe is not started when the memory it needs is not free at that moment, and the refusal gives both numbers', offered.includes(TIGHT) && tight.status === 409 && /Needs \d+ GB of free memory beside the GPUs; \d+ GB is free/.test(tight.json?.error || '') && !(await state()).runs.some((r) => r.recipe === TIGHT), JSON.stringify(tight.json));
  check('notes from a recipe\'s source do not keep it from being offered', offered.includes(NOTED));
  const shown = (id) => nv.groups.flatMap((g) => g.recipes).find((r) => r.id === id);
  check('a recipe the lab saw call a tool is shown as able to, one with no such proof is not', shown(NOTED)?.tools === true && shown(DOCKED)?.tools === false);
  const noted = await api(`/api/card?id=${encodeURIComponent(NOTED)}`);
  check('they come with its card, with what it needs of the host, even when the model has no card', noted.status === 200 && /^NEEDS: one card/.test(noted.json?.notes || '') && noted.json.needs.ram === 1 && noted.json.needs.disk === 3 && noted.json.needs.nvme === true, JSON.stringify(noted.json));
  check('a recipe with no notes and no card still answers that it has none', (await api(`/api/card?id=${encodeURIComponent(DOCKED)}`)).status === 404);
  const begun = await api('/api/runs', { method: 'POST', body: { recipe: DOCKED } });
  check('starts the container recipe', Number.isInteger(begun.json?.id), JSON.stringify(begun));
  const cid = begun.json.id;
  const up = await until('the container to be ready', async () => { const r = (await state()).runs.find((x) => x.id === cid); if (r?.phase === 'failed') throw new Error(r.error); return r?.phase === 'ready' && r; }, 60000);
  check('the container run is ready and serves its model', up.served === 'fake-engine' && !up.host && !up.external);
  const made = JSON.parse(readFileSync(join(FAKE_DOCKER, `local-ai-${cid}.json`), 'utf8')), opt = (name) => made.options.filter((o) => o[0] === name).map((o) => o[1]);
  check('Docker was given the pinned image and nothing else as the image', made.image === PINNED);
  check('the container can gain no privileges and gets only the GPUs it was given', opt('--security-opt').join() === 'no-new-privileges' && opt('--gpus').join() === '"device=0"' && !made.options.some((o) => ['--privileged', '--cap-add', '--device', '--pid', '--network', '--net'].includes(o[0])), JSON.stringify(made.options));
  check('its port is published on loopback only, and the recipe\'s allowed options are passed', opt('--publish').join() === `127.0.0.1:${cid}:8000` && opt('--ipc').join() === 'host' && opt('--shm-size').join() === '1g');
  check('a second start of the same recipe is refused', (await api('/api/runs', { method: 'POST', body: { recipe: DOCKED } })).status === 409);
  // The app measures a new model's speed first; what that writes is not usage, so the request to count comes after it.
  await until('the container\'s speed to be measured', async () => (await state()).groups.flatMap((g) => g.recipes).find((r) => r.id === DOCKED)?.speed.measured, 120000);
  await sleep(4500);
  await chat(cid, true);
  const spent = await until('its tokens to be counted', async () => { const r = (await state()).runs.find((x) => x.id === cid); return r?.stats?.used > 0 && r; }, 30000);
  check('counts the container run\'s tokens from its /metrics', spent.stats.used >= 2016, `used ${spent.stats.used}`);
  check('shows the container log', /fake engine log line/.test((await api(`/api/runs/${cid}/logs`)).json?.text || ''));
  // A container that is up and answering is still read every tick, but Docker itself is asked what it is running
  // only every fifth tick, and nvidia-smi is left running instead of being started for every reading.
  const tally = (file, word) => { try { return readFileSync(join(FAKE_DOCKER, file), 'utf8').split('\n').filter((l) => l === word).length; } catch { return 0; } };
  const asked = tally('docker.calls', 'ps'), read = tally('nvidia-smi.calls', 'once');
  await sleep(12000);
  check('Docker is asked what it runs every fifth tick while nothing is changing', tally('docker.calls', 'ps') - asked >= 1 && tally('docker.calls', 'ps') - asked <= 2, `${tally('docker.calls', 'ps') - asked} listings in 12 s`);
  check('nvidia-smi is left running, not started for every reading', tally('nvidia-smi.calls', 'kept') === 1 && tally('nvidia-smi.calls', 'once') === read, `${tally('nvidia-smi.calls', 'once') - read} starts in 12 s`);
  check('the running container is still read every tick', (await state()).runs.find((x) => x.id === cid)?.phase === 'ready' && (await state()).gpus.length === 2);
  // The app restarts; the container is still there and is taken back.
  await stopServer();
  check('the container keeps running when the app quits', alive(made.pid));
  await startServer({ nvidia: true });
  const again = await until('the container to be adopted', async () => { const r = (await state()).runs.find((x) => x.id === cid); return r?.phase === 'ready' && r; }, 45000);
  check('adopts the running container after a restart', again.recipe === DOCKED);
  check('stops the container run', (await api(`/api/runs/${cid}`, { method: 'DELETE' })).status === 200);
  check('the container is gone', !alive(made.pid) && !readdirSync(FAKE_DOCKER).includes(`local-ai-${cid}.json`));
  // A container that dies on its own is a failed run with its reason, not a vanished one.
  const second = (await api('/api/runs', { method: 'POST', body: { recipe: DOCKED } })).json.id;
  await until('the second container to be ready', async () => (await state()).runs.find((x) => x.id === second)?.phase === 'ready', 60000);
  process.kill(JSON.parse(readFileSync(join(FAKE_DOCKER, `local-ai-${second}.json`), 'utf8')).pid, 'SIGKILL');
  const dead = await until('the dead container to be noticed', async () => { const r = (await state()).runs.find((x) => x.id === second); return r?.phase === 'failed' && r; }, 30000);
  check('a container that dies is shown as failed, with why', dead.view.word === 'Stopped' && /Engine stopped/.test(dead.error), JSON.stringify(dead.view));
  check('a failed run can be cleared', (await api(`/api/runs/${second}`, { method: 'DELETE' })).status === 200 && !(await state()).runs.some((x) => x.id === second));

  // Weights already on this machine. LOCAL_AI_MODELS names a second folder; the repo `kept` is in it exactly as
  // published, so the recipe is shown as ready, is checked against the published checksums once, and runs from there.
  const ready = (id) => nv.groups.flatMap((g) => g.recipes).find((r) => r.id === id)?.ready;
  check('weights already on this machine count as on disk', ready(NOTED) === true && ready(DOCKED) === true);
  const kept = (await api('/api/runs', { method: 'POST', body: { recipe: NOTED } })).json.id;
  await until('the recipe with weights already here to be ready', async () => { const r = (await state()).runs.find((x) => x.id === kept); if (r?.phase === 'failed') throw new Error(r.error); return r?.phase === 'ready'; }, 60000);
  const keptRun = JSON.parse(readFileSync(join(FAKE_DOCKER, `local-ai-${kept}.json`), 'utf8')), keptOpt = (name) => keptRun.options.filter((o) => o[0] === name).map((o) => o[1]);
  check('they are used where they are, read-only, and nothing is downloaded', keptOpt('--volume').join() === `${join(HAVE, 'kept')}:/models:ro` && !downloads.some((d) => d.startsWith('kept/')) && !existsSync(join(HOME, 'models', `kept-${REV.slice(0, 8)}`)), `${keptOpt('--volume')} ${downloads}`);
  check('what was checked is noted, so it is checked once', JSON.parse(readFileSync(join(HOME, 'found.json'), 'utf8'))[`org/kept@${REV}`]?.path === join(HAVE, 'kept') && readdirSync(join(HAVE, 'kept')).sort().join() === 'config.json,model.safetensors');
  check('a recipe\'s typed resources reach Docker: locked memory and a memory limit, and still no new privileges', keptOpt('--cap-add').join() === 'IPC_LOCK' && keptOpt('--ulimit').includes('memlock=-1:-1') && keptOpt('--memory').join() === String(2 ** 33) && keptOpt('--memory-swap').join() === String(2 ** 33) && keptOpt('--security-opt').join() === 'no-new-privileges', JSON.stringify(keptRun.options));
  await api(`/api/runs/${kept}`, { method: 'DELETE' });
  // The repo `changed` is here too, but one file is not the published one: it is left alone and the weights are downloaded.
  const other = (await api('/api/runs', { method: 'POST', body: { recipe: CHANGED } })).json.id;
  await until('the recipe whose weights here differ to be ready', async () => { const r = (await state()).runs.find((x) => x.id === other); if (r?.phase === 'failed') throw new Error(r.error); return r?.phase === 'ready'; }, 60000);
  const otherRun = JSON.parse(readFileSync(join(FAKE_DOCKER, `local-ai-${other}.json`), 'utf8')), own = join(HOME, 'models', `changed-${REV.slice(0, 8)}`);
  check('a folder that differs from what was published is not used: the weights are downloaded to the app\'s own folder', otherRun.options.filter((o) => o[0] === '--volume').map((o) => o[1]).join() === `${own}:/models:ro` && downloads.includes('changed/model.safetensors') && readFileSync(join(own, 'model.safetensors'), 'utf8') === published['model.safetensors'], `${downloads}`);
  check('and the folder that differs is left as it was', readFileSync(join(HAVE, 'changed', 'model.safetensors'), 'utf8') === 'x'.repeat(70000) && readdirSync(join(HAVE, 'changed')).length === 2);
  await api(`/api/runs/${other}`, { method: 'DELETE' });
} catch (e) {
  check('the integration test ran to the end', false, e.message);
}
await cleanup();
console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
