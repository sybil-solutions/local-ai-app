#!/usr/bin/env node
// Runs the real server the way a user does and checks what matters end to end. No mocks inside the app: it gets a
// registry served from here and engines that answer like real ones.
//   Everywhere: it starts and answers, the key guards the API, the page never hands the key to a caller on this machine, files outside
//   web/ can't be read, pairing and the installer refuse strangers, a model someone else started is found, and its
//   tokens and prefill speed are counted from its /metrics.
//   On Apple silicon also: a pinned host recipe is offered (a tampered one is not), starts in its own venv, answers
//   through the app's port, counts its tokens, survives an app restart, and is gone after Stop.
// Usage: node scripts/smoke.mjs   (exit code 0 when every check passed)
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = mkdtempSync(join(tmpdir(), 'local-ai-smoke-'));
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
  if (req.url === '/v1/models') return [200, { data: [{ id: 'outside-model', max_model_len: 65536 }] }];
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
const script = readFileSync(join(ROOT, 'scripts', 'fake_engine.py'), 'utf8');
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
const FAKE_DOCKER = join(HOME, 'docker');
function startServer({ nvidia = false } = {}) {
  server = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], { cwd: ROOT, env: { ...process.env, PI_CODING_AGENT_DIR: join(HOME, 'pi'), LOCAL_AI_HOME: HOME, LOCAL_AI_PORT: String(PORT), LOCAL_AI_SHARE: '0', HF_HOME: join(HOME, 'hf'),
    LOCAL_AI_REGISTRY: `http://127.0.0.1:${registry.address().port}/catalog.json`,
    ...(nvidia ? { LOCAL_AI_GPU: 'nvidia', FAKE_DOCKER_DIR: FAKE_DOCKER, PATH: `${join(ROOT, 'scripts', 'fakebin')}:${process.env.PATH}` } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const req = request({ host: '127.0.0.1', port: PORT, path, headers: { host: host || `127.0.0.1:${PORT}` } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => done({ status: res.statusCode, body: b })); });
  req.on('error', failed);
  req.end();
});
const chat = (port, stream, content = 'hi') => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30000),
  body: JSON.stringify({ model: 'x', max_tokens: 16, stream, ...(stream ? { stream_options: { include_usage: true } } : {}), messages: [{ role: 'user', content }] }) }).then((r) => r.text());

let hostPid = null;
const watchdog = setTimeout(() => { console.log('FAIL the smoke test took longer than 10 minutes'); cleanup().then(() => process.exit(1)); }, 600e3);
async function cleanup() {
  clearTimeout(watchdog);
  await stopServer();
  let pids = [hostPid];
  try { for (const f of readdirSync(FAKE_DOCKER).filter((x) => x.endsWith('.json'))) pids.push(JSON.parse(readFileSync(join(FAKE_DOCKER, f), 'utf8')).pid); } catch { /* the Docker path never ran */ }
  try { pids = pids.concat(Object.values(JSON.parse(readFileSync(join(HOME, 'hosts.json'), 'utf8'))).map((h) => h.pid)); } catch { /* none started */ }
  for (const pid of pids) if (pid && alive(pid)) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }
  outside.close(); registry.close(); proxy.close();
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
  for (const [i, why] of Object.keys(BROKEN).entries()) {
    const id = `smoke/gpu/broken-${i}.docker`;
    check(`does not offer or start a recipe with ${why}`, !offered.includes(id) && (await api('/api/runs', { method: 'POST', body: { recipe: id } })).status === 409);
  }
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
} catch (e) {
  check('the smoke test ran to the end', false, e.message);
}
await cleanup();
console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
