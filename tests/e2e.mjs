#!/usr/bin/env node
// End to end: the real desktop app, driven through its window the way a person uses it. Nothing inside the app is
// replaced. Around it stand a registry served from here, a stand-in docker and nvidia-smi (so any machine "has"
// two GPUs), engines that answer like real ones, and a second Local AI to connect to.
//
// It starts a model and watches it come up, opens an agent on it, edits and resets a recipe, reads Usage, switches
// Home's blocks, changes the background, reads the endpoints, connects the second machine and looks at its model,
// goes to the panel and back, and stops the model. Any error the page logs on the way fails the run, and so does a
// page that keeps working when nothing is happening.
//
// Usage: node tests/e2e.mjs        (on Linux without a display: xvfb-run -a node tests/e2e.mjs)
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'), BIN = join(ROOT, 'tests', 'stand-ins', 'bin');
const WORK = mkdtempSync(join(tmpdir(), 'local-ai-e2e-'));
const PORT = 26700 + Math.floor(Math.random() * 300) * 4, OTHER = PORT + 400, DEBUG = PORT + 800; // each app's runs take the 199 ports after its own
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const failures = [];
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` (${detail})`}`); if (!ok) failures.push(name); };
async function until(what, ask, ms = 20000) {
  for (const end = Date.now() + ms; ;) {
    const got = await ask().catch(() => null);
    if (got) return got;
    if (Date.now() > end) throw new Error(`timed out after ${ms / 1000} s waiting for ${what}`);
    await sleep(250);
  }
}

// The registry: one card (the stand-in nvidia-smi's) and three models for it, so Home has its three picks.
const image = (n) => `example/engine@sha256:${String(n).repeat(64)}`;
const recipe = (model, tps, n) => ({ card: 'smoke-gpu', model, engine: 'vllm', proof: [{ tps }], launch: { image: image(n), port: 8000, cards: 1, seqs: 1, ctx: 8192, args: ['--model', model, '--max-num-seqs', '1'] } });
const catalog = {
  cards: { 'smoke-gpu': { name: 'Smoke Test GPU', vram_gb: 24, backend: 'nvidia' } }, builds: {},
  models: { 'swift-1': { name: 'Swift One', released: '2026-03-01', aa: { index: 30 } }, 'even-3': { name: 'Even Three', released: '2026-05-01', aa: { index: 45 } }, 'sage-2': { name: 'Sage Two', released: '2026-07-01', aa: { index: 60 } } },
  recipes: { 'e2e/fast': recipe('swift-1', 90, 1), 'e2e/balanced': recipe('even-3', 60, 2), 'e2e/smart': recipe('sage-2', 30, 3) },
};
const registry = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(catalog)); });
await new Promise((done) => registry.listen(0, '127.0.0.1', done));

// What both apps run in: their own home, the stand-ins first on the PATH, an agent to find (a stand-in `pi`), no
// terminal to open (so Open hands back its command for the test to read), and no looking for models started
// elsewhere (both apps are on this one machine, and each would find the other's).
writeFileSync(join(WORK, 'pi'), '#!/bin/sh\necho "pi 9.9.9"\n');
chmodSync(join(WORK, 'pi'), 0o755);
const world = (name, port) => ({ ...process.env, LOCAL_AI_HOME: join(WORK, name), LOCAL_AI_PORT: String(port), LOCAL_AI_SHARE: '0', LOCAL_AI_GPU: 'nvidia', LOCAL_AI_TERMINAL: 'none', LOCAL_AI_DISCOVER: '0',
  LOCAL_AI_REGISTRY: `http://127.0.0.1:${registry.address().port}/catalog.json`, FAKE_DOCKER_DIR: join(WORK, `${name}-docker`), HF_HOME: join(WORK, 'hf'),
  PI_CODING_AGENT_DIR: join(WORK, 'pi-home'), DSH_HOME: join(WORK, 'dsh-home'), PATH: `${BIN}:${WORK}:${process.env.PATH}` });
const keyOf = (name) => JSON.parse(readFileSync(join(WORK, name, 'config.json'), 'utf8')).key;
const api = async (port, name, path, { method = 'GET', body } = {}) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${keyOf(name)}` }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  return res.json().catch(() => null);
};
const state = (port, name) => api(port, name, '/api/state?v=-1');

const children = [];
let logs = '';
function launch(cmd, args, env) {
  const child = spawn(cmd, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (b) => { logs += b; });
  child.stderr.on('data', (b) => { logs += b; });
  children.push(child);
  return child;
}
async function cleanup() {
  for (const child of children) child.kill('SIGTERM');
  await sleep(1500);
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  // The engines the stand-in docker started live on their own.
  for (const dir of ['here-docker', 'there-docker']) {
    try { for (const f of readdirSync(join(WORK, dir)).filter((x) => x.endsWith('.json'))) { try { process.kill(JSON.parse(readFileSync(join(WORK, dir, f), 'utf8')).pid, 'SIGKILL'); } catch { /* gone */ } } } catch { /* never started */ }
  }
  registry.close();
  if (failures.length) console.log(`\n--- the apps' output (last 40 lines) ---\n${logs.trim().split('\n').slice(-40).join('\n')}`);
  rmSync(WORK, { recursive: true, force: true });
}
const watchdog = setTimeout(() => { console.log('FAIL the end-to-end test took longer than 8 minutes'); cleanup().then(() => process.exit(1)); }, 480e3);

// The window, over the DevTools protocol.
let ws, sent = 0;
const waiting = new Map(), problems = [];
const call = (method, params = {}) => new Promise((done) => { const id = ++sent; waiting.set(id, done); ws.send(JSON.stringify({ id, method, params })); });
// Runs an expression in the page and gives back its value.
async function page(expression) {
  const out = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (out?.exceptionDetails) throw new Error(`in the page: ${out.exceptionDetails.exception?.description?.split('\n')[0] || out.exceptionDetails.text}`);
  return out?.result?.value;
}
const seen = (selector) => `[...document.querySelectorAll(${JSON.stringify(selector)})].filter((e) => e.getClientRects().length)`;
// Presses the first thing on screen that matches, once it is there.
async function press(selector, { nth = 0, ms = 10000 } = {}) {
  await until(`${selector} to be on screen`, () => page(`${seen(selector)}.length > ${nth}`), ms);
  await page(`${seen(selector)}[${nth}].click()`);
  await sleep(250);
}
const text = (selector) => page(`(${seen(selector)}[0] || {}).innerText?.replace(/\\s+/g, ' ').trim() ?? null`);
const shows = (what, selector, pattern, ms) => until(`${what}`, async () => { const t = await text(selector); return t !== null && pattern.test(t) && t; }, ms);
// Types into a field the way the page hears typing.
const type = (selector, value) => page(`(() => { const el = ${seen(selector)}[0]; el.focus(); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);

try {
  // The second machine: a plain server with a model already running on it.
  launch(process.execPath, [join(ROOT, 'server', 'index.js')], world('there', OTHER));
  await until('the second machine to answer', async () => (await fetch(`http://127.0.0.1:${OTHER}/api/health`)).ok, 30000);
  await until('its model list', async () => (await state(OTHER, 'there')).groups?.[0]?.recipes.length === 3, 30000);
  await api(OTHER, 'there', '/api/runs', { method: 'POST', body: { recipe: 'e2e/balanced' } });

  // The app.
  launch(join(ROOT, 'node_modules', '.bin', 'electron'), ['.', `--user-data-dir=${join(WORK, 'window')}`, `--remote-debugging-port=${DEBUG}`, ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [])], world('here', PORT));
  const target = await until('the app\'s window', async () => (await (await fetch(`http://127.0.0.1:${DEBUG}/json`)).json()).find((t) => t.type === 'page' && t.url.includes(`:${PORT}`)), 60000);
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done, failed) => { ws.onopen = done; ws.onerror = failed; });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id) return waiting.get(d.id)?.(d.result ?? d.error);
    if (d.method === 'Runtime.exceptionThrown') problems.push(`exception: ${d.params.exceptionDetails.exception?.description?.split('\n')[0] || d.params.exceptionDetails.text}`);
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') problems.push(`console.error: ${d.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 200)}`);
    // A model with no page on Hugging Face answers 404 for its card, which the browser logs. That is not a fault.
    if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error' && !/\/api\/card/.test(d.params.entry.url || '')) problems.push(`log: ${d.params.entry.text.slice(0, 160)} ${d.params.entry.url || ''}`);
    return undefined;
  };
  await call('Runtime.enable'); await call('Log.enable'); await call('Page.enable');

  // 1. It opens signed in, on Home, ready to start the model it picked.
  await until('Home', () => page('!!document.querySelector(".nlinks") && !!document.querySelector(".cin .nname")'), 30000);
  check('the app opens on Home without asking for a key', await page('!document.querySelector("[data-f=key]") && location.hash === ""'));
  check('it is the desktop layout, named Local AI', await page('document.documentElement.classList.contains("wide") && document.title === "Local AI"'));
  check('the logo is beside the machine\'s name', await page('!!document.querySelector(".nav .mark.chip .dove")'));
  check('Home offers three picks for the GPU', (await page(`${seen('.cpicks > *')}.length`)) === 3);
  check('the balanced model is the one picked', /Even Three/.test(await text('.cin .nname')), await text('.cin .nname'));

  // 2. Pick another, start it, and watch it come up.
  await press('.cpicks [data-id="e2e/fast"]');
  check('pressing a pick chooses it', /Swift One/.test(await text('.cin .nname')), await text('.cin .nname'));
  await press('.cright [data-act=start]');
  await shows('the model to be running', '.cin .nsub', /^Running/, 90000);
  const mine = (await state(PORT, 'here')).runs.find((r) => r.recipe === 'e2e/fast');
  check('the model starts and Home shows it running', mine?.phase === 'ready' && /Swift One/.test(await text('.cin .nname')));
  check('the top bar shows it live', /tok\/s/.test(await text('.nlive')));
  check('Home shows its live numbers', /Decode tok\/s/.test(await text('.cin .stats')));

  // 3. Open an agent on it. With no terminal to open, the app hands over the command, which names the exact model.
  await press('.cright [data-act=open]');
  const command = await shows('the command to run', '#page .box.mono', /pi/, 20000);
  check('Open gives the agent the exact model', command.includes(`--model la-self-${mine.id}/fake-engine`) && command.includes('local-ai.js'), command);
  await press('[data-nav=home]');

  // 4. What the model answers is counted, and Usage shows it. The app measures a new model's speed first, and what
  // that writes is not usage, so the request to count is sent once the measurement is over.
  await until('its speed to be measured', async () => (await state(PORT, 'here')).groups[0].recipes.find((r) => r.id === 'e2e/fast')?.speed.measured, 120000);
  await sleep(4500);
  await fetch(`http://127.0.0.1:${mine.id}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fake-engine', messages: [{ role: 'user', content: 'hi' }] }) }).then((r) => r.text());
  await until('its tokens to be counted', async () => (await state(PORT, 'here')).usage.all > 0, 60000);
  await press('[data-nav=usage]');
  check('Usage shows what was served', /served|tokens/i.test(await shows('the Usage page', '#page', /\d/, 10000)));

  // 5. Models: the list, a model's page, and editing a recipe and putting it back.
  await press('[data-nav=adv-models]');
  check('Models lists all three', (await page(`${seen('.mitem')}.length`)) === 3);
  await press('.mitem[data-id="e2e/smart"]');
  check('choosing one shows its numbers', /Sage Two/.test(await text('.mright .ptitle')) && /Requests at once 1/.test(await text('.mright .kv')));
  await press('.macts [data-go=edit]');
  await press('[data-act=draft][data-k=seqs][data-v="2"]');
  await press('[data-act=saveedit]');
  await until('the edit to be saved', async () => (await api(PORT, 'here', '/api/recipe?id=e2e/smart')).launch?.seqs === 2);
  check('an edited recipe is saved as your own', /Requests at once 2/.test(await shows('the edited model', '.mright .kv', /Requests at once 2/)));
  await press('.macts [data-go=edit]');
  await press('[data-act=resetedit]');
  check('Reset puts the registry\'s recipe back', /Requests at once 1/.test(await shows('the reset model', '.mright .kv', /Requests at once 1/)));

  // 6. Settings: Home's blocks, the background, the endpoints.
  await press('[data-nav=home-edit]');
  await page(`${seen('.hrow .switch:not(.on)')}.forEach((b) => b.click())`);
  await until('every block to be on', async () => (await state(PORT, 'here')).home?.on.length === 5);
  await press('[data-nav=home]');
  const widgets = await shows('Home\'s widgets', '#ui .cwid', /GPUs/, 10000);
  check('switching a block on shows its data on Home', /Usage/.test(widgets) && /GPU 0/.test(widgets) && /GPU 1/.test(widgets), widgets);
  await press('[data-nav=home-edit]');
  await press('[data-nav=background]');
  await press('[data-act=bg][data-bg=fresco]');
  await until('the background to change', async () => (await state(PORT, 'here')).background === 'fresco');
  check('the background changes', (await page('document.documentElement.dataset.bg')) === 'fresco');
  await press('[data-act=bg][data-bg=clouds]');
  await press('[data-nav=endpoints]');
  const address = await shows('the model\'s address', '#page .addr', /127\.0\.0\.1/, 15000);
  check('API endpoints shows the model\'s address and hides the key', address.includes(`http://127.0.0.1:${mine.id}/v1`) && !(await text('#page')).includes(keyOf('here')));

  // 7. Machines: connect the second one by its address and key, look at its model, come back.
  await press('[data-nav=machines]');
  await press('#page [data-go=addmachine]');
  await type('[data-f=host]', `http://127.0.0.1:${OTHER}`);
  await type('[data-f=mkey]', keyOf('there'));
  await press('[data-act=connect]');
  await press('[data-act=uselinked]', { ms: 20000 });
  await shows('the other machine\'s model', '.cin .nname', /Even Three/, 60000);
  check('a connected machine\'s model is shown as that machine\'s', await page('!!document.querySelector(".where")') && /Running/.test(await text('.cin .nsub')));
  await press('[data-nav=machines]');
  await press('[data-act=use][data-dev="-1"]');
  check('back on this computer, Home shows its own model', /Swift One/.test(await shows('this computer\'s model', '.cin .nname', /Swift One/)) && !(await page('!!document.querySelector(".where")')));

  // 8. The panel: the window takes its shape, with nothing around it, and comes back.
  await press('[data-act=fs]');
  await until('the panel', () => page('!document.documentElement.classList.contains("wide")'));
  await sleep(1200);
  const gaps = await page('(() => { const p = document.querySelector(".frame .screen").getBoundingClientRect(); return [p.left, innerWidth - p.right, p.top, innerHeight - p.bottom].map(Math.round); })()');
  check('the panel fills its window exactly', gaps.every((g) => g === 0), gaps.join());
  check('the panel shows the running model', /Swift One/.test(await text('.frame .screen')));
  // With no picture chosen the panel draws its two hands, once, when it is drawn.
  await api(PORT, 'here', '/api/settings', { method: 'POST', body: { background: 'none' } });
  await until('the picture to go', () => page('document.documentElement.dataset.bg === "none"'));
  const painted = '(() => { const c = document.querySelector("canvas.art"); if (!c || !c.width) return 0; const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; })()';
  const drawn = await until('the hands', async () => (await page(painted)) > 1000, 10000).then(() => true, () => false);
  check('with no picture, the panel draws its hands', drawn, `${await page(painted)} pixels painted`);
  await api(PORT, 'here', '/api/settings', { method: 'POST', body: { background: 'clouds' } });
  await until('the picture to come back', () => page('document.documentElement.dataset.bg === "clouds"'));
  await press('[data-act=fs]');
  await until('the desktop layout again', () => page('document.documentElement.classList.contains("wide")'));
  await page('document.fullscreenElement ? document.exitFullscreen() : null');

  // 9. Stop it.
  await press('[data-act=stop]');
  await until('the model to stop', async () => !(await state(PORT, 'here')).runs.some((r) => r.recipe === 'e2e/fast'), 60000);
  check('Stop stops the model and Home offers to start one again', /Swift One/.test(await shows('Home, ready to start', '.cin .nname', /./)) && (await page(`${seen('.cright [data-act=start]')}.length`)) === 1);

  // 10. Left alone, the page does no work: it draws when the machine changes, not on every frame of the display.
  const frames = await page('new Promise((done) => { const real = window.requestAnimationFrame; let n = 0; window.requestAnimationFrame = (f) => { n++; return real(f); }; setTimeout(() => { window.requestAnimationFrame = real; done(n); }, 1500); })');
  check('a page nobody touches asks for no animation frames', frames === 0, `${frames} in 1.5 s`);

  check('the page logged no errors', problems.length === 0, problems.slice(0, 4).join(' | '));
} catch (e) {
  check(`the end-to-end test ran to the end (${e.message})`, false, problems.slice(0, 3).join(' | '));
} finally {
  clearTimeout(watchdog);
  ws?.close();
  await cleanup();
}
console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
