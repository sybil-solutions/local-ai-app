// Tries to break the parts of the app that decide what is safe, with inputs nobody would write by hand.
//   1. The grammar of a recipe's Docker options, checked exhaustively over every short string of an alphabet of
//      troublemakers: whatever the check accepts must be exactly one allowed option with one plain value.
//   2. Random hostile registry recipes: whenever the app would start one, the command it builds is read back the way
//      Docker reads it, and must run the pinned image with only the options the app allows, mounting only its own
//      folders read-only.
//   3. File names in a Hugging Face listing: an accepted name must stay inside the download folder.
//   4. Model cards and the html tag: hostile text must never come out as markup, and a card built to keep the
//      renderer busy must still be drawn quickly.
//   5. What a connected machine says about itself: junk is refused whole or cut down to the shape the app reads.
//   6. The door in front of a model's port: only this machine's own address, and no page from another site.
//   7. Host recipes (programs run on the machine itself): one that is accepted runs its own hashed script and nothing else.
//   8. DeepSeek Harness's settings, which the app edits as text: whatever models are written in, with whatever names,
//      every line that was the person's own is still there, in order, and taking the models out again gives the file back.
//   9. The running server: every short path made of traversal pieces must give a file from web/ or 404, and random
//      requests to the API must never crash it, hang it, or give anything away without the key.
// Usage: node scripts/fuzz.mjs [seed]     exit code 0 when nothing was found. FUZZ_N sets how many random cases (default 40000).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { Agent, createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRun } from './docker-model.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = mkdtempSync(join(tmpdir(), 'local-ai-fuzz-'));
process.env.LOCAL_AI_HOME = HOME; // the server's modules write their state here when they are loaded
process.env.HF_HOME = join(HOME, 'hf');
const N = +(process.env.FUZZ_N || 40000), seed = +(process.argv[2] || 20261111);
const failures = [];
const found = (what, detail) => { if (failures.length < 40) console.log(`FOUND ${what}: ${detail}`); failures.push(what); };
const section = (name, cases) => console.log(`ok   ${name} (${cases.toLocaleString('en-US')} cases)`);
// A small seeded generator, so a finding can be reproduced from its seed.
let state = seed >>> 0;
const rnd = () => { state = (state + 0x6D2B79F5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (list) => list[Math.floor(rnd() * list.length)];
const some = (list, most) => Array.from({ length: Math.floor(rnd() * (most + 1)) }, () => pick(list));
const text = (alphabet, most) => Array.from({ length: Math.floor(rnd() * (most + 1)) }, () => pick(alphabet)).join('');

const { flagProblem, flagsOf, dockerArgs } = await import('../server/docker.js');
const { problemWith } = await import('../server/recipes.js');
const weights = await import('../server/weights.js');
const { markdown } = await import('../web/markdown.js');
const { conform } = await import('../server/machines.js');
const { refusal } = await import('../server/meter.js');
const dsh = await import('../server/dsh.js');
const { createHash } = await import('node:crypto');
const { html } = await import('../web/html.js');

// ---- 1. the option grammar, exhaustively --------------------------------------------------------------------------
{
  const ALLOWED = ['--ipc', '--network', '--net', '--gpus', '--shm-size', '--ulimit', '--workdir', '-w'];
  const names = [...ALLOWED, '--privileged', '-v', '--pid', '--cap-add', '', '-', '--'], seps = ['', ' ', '=', '\n', '\t', '  ', '= ', ' =', '=='];
  const alphabet = ['-', ' ', '=', '\n', 'a', '/', '"'];
  const values = [''];
  for (let len = 1; len <= 4; len++) for (const v of values.filter((x) => x.length === len - 1)) for (const ch of alphabet) values.push(v + ch);
  let cases = 0;
  for (const name of names) for (const s of seps) for (const value of values) {
    const flag = `${name}${s}${value}`;
    cases++;
    if (flagProblem({ flags: [flag] })) continue;
    const pairs = flagsOf({ flags: [flag] }), [got, val] = pairs[0];
    if (pairs.length !== 1 || !ALLOWED.includes(got) || typeof val !== 'string' || !val || /\s/.test(val) || val.startsWith('-')) { found('an option accepted that is not one allowed option with one plain value', JSON.stringify(flag)); continue; }
    const read = parseRun([`${got}=${val}`, 'image']);
    if (read.error || read.options.length !== 1 || read.options[0][0] !== got || read.options[0][1] !== val || read.image !== 'image') found('an accepted option that Docker would read as something else', JSON.stringify(flag));
  }
  // Lists of options: one bad option anywhere must refuse the whole list.
  const good = ['--ipc host', '--shm-size=1g', '-w /x'], bad = ['', ' ', '--privileged', '--ipc', '-v /:/host', '--ipc host --privileged', '--pid=host', null, 7, {}, ['--privileged']];
  for (let i = 0; i < 20000; i++) {
    const list = some([...good, ...bad], 5);
    cases++;
    if (list.some((f) => bad.includes(f)) && !flagProblem({ flags: list })) found('a list with a bad option accepted', JSON.stringify(list));
    if (!list.some((f) => bad.includes(f)) && flagProblem({ flags: list })) found('a list of good options refused', JSON.stringify(list));
  }
  section('the option grammar: only one allowed option with one plain value is ever accepted', cases);
}

// ---- 2. random hostile recipes against Docker's reading of the command --------------------------------------------
{
  const PIN = `example/engine@sha256:${'a'.repeat(64)}`, REV = 'b'.repeat(40);
  const NASTY = ['', ' ', '-', '--', '--privileged', '--pid=host', '-v /:/host', '--volume=/:/host', '--network host', '--cap-add=ALL', '--security-opt seccomp=unconfined', '--device /dev/sda', '--entrypoint sh', '--name x', '--rm',
    'evil/image:latest', 'x --privileged', 'a\nb', '../../etc', '/', '$(id)', '`id`', ';id', '&&id', '|id', '\0', '"', "'", '\\', '%0a', '--', '=', '--=', '-=x', '--ipc', '--ipc host --privileged', '--ipc=host\n--privileged'];
  const flagPool = ['--ipc host', '--ipc=host', '--shm-size 2g', '--ulimit memlock=-1', '-w /work', '--workdir=/x', '--gpus all', '--network host', ...NASTY, null, 3, {}, ['--privileged'], true];
  const str = () => (rnd() < 0.5 ? pick(NASTY) : text(['-', ' ', '=', '\n', 'a', 'z', '/', ':', '.', '@', '0', '"', "'", '\\', '$', ';'], 12));
  const maybe = (good, p = 0.85) => (rnd() < p ? good : (rnd() < 0.5 ? str() : pick([null, 0, -1, 1.5, 70000, {}, [], true, [str()]])));
  const options = new Set(['-d', '--name', '--label', '--gpus', '--publish', '--security-opt', '--shm-size', '--env', '--volume', '--entrypoint', '--ipc', '--ulimit', '--workdir', '-w']);
  const roots = [join(HOME, 'models'), join(HOME, 'hf', 'hub'), join(HOME, 'runs')];
  let started = 0;
  for (let i = 0; i < N; i++) {
    const launch = { image: maybe(PIN, 0.9), port: maybe(8000, 0.9), args: rnd() < 0.8 ? some(['--model', 'x', '--port', '8000', ...NASTY], 6) : maybe(['a']), cards: 1 };
    if (rnd() < 0.7) launch.flags = rnd() < 0.9 ? some(flagPool, 4) : maybe(['--ipc host']);
    if (rnd() < 0.4) launch.env = rnd() < 0.8 ? Object.fromEntries(some(['HF_HOME', 'A_B', 'X1', ...NASTY], 3).map((k) => [k, maybe('v', 0.8)])) : maybe({});
    if (rnd() < 0.3) launch.shm = maybe(pick(['1g', '512m', '2G', '16gb', 4096]), 0.7);
    if (rnd() < 0.3) launch.entrypoint = rnd() < 0.8 ? some(['python3', '-m', 'engine', ...NASTY], 3) : maybe(['x']);
    if (rnd() < 0.3) launch.config = { at: maybe(pick(['/app/config.yml', '/etc/engine/c.json']), 0.7), text: maybe('a: 1', 0.9) };
    if (rnd() < 0.4) launch.weights = some([{ repo: 'org/model', revision: REV, at: '/models' }, { repo: maybe('org/m', 0.6), revision: maybe(REV, 0.6), at: maybe('/weights', 0.6) }, { path: '/etc', at: '/x' }, { repo: 'org/m', revision: REV, at: '/models', layout: 'hub' }], 2);
    for (const k of ['build', 'setup', 'prepare', 'resources', 'machines']) if (rnd() < 0.03) launch[k] = maybe(2, 0.5);
    const recipe = { card: 'c', model: 'm', engine: 'vllm', launch };
    let why;
    try { why = problemWith(recipe); } catch (e) { found('the recipe check threw instead of refusing', `${e.message} for ${JSON.stringify(recipe).slice(0, 300)}`); continue; }
    if (why) continue;
    started++;
    const run = { id: 18701, recipe: 'r/x', gpus: [0], since: 1, reachable: false };
    let args;
    try { args = dockerArgs({ run, launch, name: 'local-ai-18701', bind: ['127.0.0.1'], mounts: weights.mounts(launch), configFile: launch.config ? join(HOME, 'runs', '18701', 'c') : null }); } catch (e) { found('building the command threw for a recipe that passed', `${e.message} for ${JSON.stringify(launch).slice(0, 300)}`); continue; }
    const show = () => `${JSON.stringify(args).slice(0, 400)} from ${JSON.stringify(launch).slice(0, 300)}`;
    if (args.some((a) => typeof a !== 'string')) { found('an argument that is not text', show()); continue; }
    const read = parseRun(args.slice(1));
    if (read.error) { found('a command Docker would refuse', `${read.error}: ${show()}`); continue; }
    if (read.image !== PIN) found('a command that would run another image than the pinned one', show());
    const of = (flag) => read.options.filter(([name]) => name === flag).map(([, value]) => value);
    for (const [name] of read.options) if (!options.has(name)) found(`an option the app never allows (${name})`, show());
    if (of('--name').join() !== 'local-ai-18701' || of('--gpus').join() !== '"device=0"' || of('--publish').join() !== `127.0.0.1:18701:${launch.port}` || of('--security-opt').join() !== 'no-new-privileges') found('the app\'s own options were changed', show());
    for (const v of of('--volume')) { const [from, , mode] = v.split(':'); if (mode !== 'ro' || !roots.some((r) => resolve(from) === r || resolve(from).startsWith(`${r}${sep}`))) found('a mount that is not one of the app\'s own folders, read-only', `${v} in ${show()}`); }
    for (const v of of('--env')) if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(v)) found('an environment setting that is not NAME=value', `${v} in ${show()}`);
  }
  section(`hostile registry recipes: every one the app would start (${started.toLocaleString('en-US')}) runs the pinned image with only the app's options`, N);
}

// ---- 3. file names in a Hugging Face listing -----------------------------------------------------------------------
{
  const dest = join(HOME, 'models', 'x-12345678'), parts = ['..', '.', '', 'a', 'b.bin', '%2e%2e', '..\\', '\\', '~', 'C:', '\0', ' ', 'config.json', '-x', '@v'];
  let cases = 0;
  const check = (name) => { cases++; if (weights.safeName(name) && !resolve(dest, name).startsWith(`${dest}${sep}`)) found('a listed file name accepted that leaves the download folder', JSON.stringify(name)); };
  for (const a of parts) { check(a); check(`/${a}`); for (const b of parts) { check(`${a}/${b}`); check(`${a}\\${b}`); for (const c of parts) check(`${a}/${b}/${c}`); } }
  for (let i = 0; i < 20000; i++) check(text(['.', '/', '\\', 'a', '%', '2', 'e', '\0', ' ', '-', '~', ':'], 10));
  for (const bad of [null, undefined, 5, {}, ['a'], '', '/etc/passwd', '../x', 'a/../../x', 'a/./b', 'a//b']) { cases++; if (weights.safeName(bad)) found('an unsafe file name accepted', JSON.stringify(bad)); }
  section('file names in a download listing: an accepted name stays inside the download folder', cases);
}

// ---- 4. model cards and the html tag -------------------------------------------------------------------------------
{
  const bits = ['<script>', '</script>', '<img src=x onerror=alert(1)>', '<svg/onload=alert(1)>', '[', ']', '(', ')', '!', 'javascript:alert(1)', 'https://a.b/c', 'http://a.b', 'data:text/html,x', '"', "'", '`', '**', '#', '\n', '|', '---', '- ', '1. ', '```', ' ', 'x', '&', '&lt;', '<a href="javascript:x">', 'onerror=', '\0', '<', '>', '<!--', '-->', '\\'];
  const ALLOWED_TAG = /<\/?(p|b|code|pre|ul|ol|li|table|tr|th|td|h[2-5]|a|img)(\s[^<>]*)?>/g;
  let cases = 0;
  for (let i = 0; i < N; i++) {
    const doc = Array.from({ length: 1 + Math.floor(rnd() * 14) }, () => pick(bits)).join('');
    cases++;
    let out;
    try { out = String(markdown(doc)); } catch (e) { found('the model card renderer threw', `${e.message} for ${JSON.stringify(doc)}`); continue; }
    if (/[<>]/.test(out.replace(ALLOWED_TAG, ''))) found('a model card produced a tag that is not one of the app\'s', `${JSON.stringify(doc)} -> ${JSON.stringify(out).slice(0, 200)}`);
    for (const m of out.matchAll(/<(a|img)\s([^<>]*)>/g)) {
      const ok = m[1] === 'a' ? /^href="https?:\/\/[^"\s]+" target="_blank" rel="noopener"$/.test(m[2]) : /^alt="[^"]*" src="https:\/\/[^"\s]+" loading="lazy"$/.test(m[2]);
      if (!ok) found('a model card produced a link or picture with something other than a plain web address', `${JSON.stringify(doc)} -> ${m[0]}`);
    }
    const cell = String(html`<i title="${doc}">${doc}</i>${[doc, doc]}`);
    cases++;
    if ((cell.match(/</g) || []).length !== 2 || (cell.match(/"/g) || []).length !== 2) found('the html tag let text through as markup', JSON.stringify(doc));
  }
  // Cards made to keep the renderer looking ahead: each is drawn in well under a second however long it is.
  for (const piece of ['<a', '[', '![', '<!--', '[x](https://', '**', '`', '<', '|', '# ', '- ', '](', '<a href="', '\n<!--\n', '<a\n']) {
    for (const size of [20000, 200000]) {
      const began = performance.now();
      markdown(piece.repeat(Math.ceil(size / piece.length)));
      cases++;
      if (performance.now() - began > 1500) found('a model card that holds the page still', `${JSON.stringify(piece)} x ${size}: ${Math.round(performance.now() - began)} ms`);
    }
  }
  for (const odd of [null, undefined, 5, {}, [], true]) { cases++; try { markdown(odd); } catch (e) { found('the model card renderer threw on something that is not text', `${JSON.stringify(odd)}: ${e.message}`); } }
  section('model cards and the html tag: hostile text never comes out as markup, and none holds the page still', cases);
}

// ---- 5. what a connected machine says about itself -------------------------------------------------------------------
{
  const junk = () => pick([null, undefined, true, 0, -1, 1.5, 'x', '', '<img src=x onerror=alert(1)>', [], {}, [[]], [null], [5], ['x'], { id: 'x' }, { id: 1, name: 'n', phase: 'ready' }, { recipes: 5 }, { recipes: [null, 5, { id: 'r', name: 'R' }] }, 'a'.repeat(500)]);
  const KEYS = ['name', 'runs', 'groups', 'gpus', 'free', 'docker', 'catalog', 'usage', 'app', 'devices', 'agents', 'home'];
  const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  let cases = 0, kept = 0;
  for (let i = 0; i < N; i++) {
    const sent = rnd() < 0.05 ? junk() : Object.fromEntries(KEYS.filter(() => rnd() < 0.85).map((k) => [k, rnd() < 0.5 ? junk() : { name: 'box', runs: some([{ id: 18701, name: 'm', phase: 'ready', view: junk(), gpus: junk() }, junk()], 3), groups: some([{ name: junk(), gpus: junk(), recipes: junk(), tiers: junk() }, junk()], 3), gpus: some([{ index: 0 }, junk()], 3) }[k] ?? junk()]));
    cases++;
    let out;
    try { out = conform(sent); } catch { continue; } // refused whole
    kept++;
    const bad = typeof out.name !== 'string' || out.name.length > 120 || out.devices.length !== 0
      || !out.runs.every((r) => plain(r) && Number.isInteger(r.id) && typeof r.name === 'string' && typeof r.phase === 'string' && plain(r.view) && r.gpus.every(Number.isInteger))
      || !out.groups.every((g) => plain(g) && typeof g.name === 'string' && g.gpus.every(Number.isInteger) && g.recipes.every((r) => plain(r) && typeof r.id === 'string' && typeof r.name === 'string' && plain(r.speed)) && Object.values(g.tiers).every((r) => plain(r) && typeof r.id === 'string' && plain(r.speed)))
      || !out.gpus.every(plain) || !out.free.every(Number.isInteger) || typeof out.docker.ok !== 'boolean' || !plain(out.catalog) || !plain(out.usage) || (out.app !== null && !plain(out.app));
    if (bad) found('a machine\'s snapshot kept in a shape the app does not read', JSON.stringify(sent).slice(0, 300));
  }
  section(`connected machines: a snapshot is refused whole or held to the shape the app reads (${kept.toLocaleString('en-US')} kept)`, cases);
}

// ---- 6. the door in front of a model's port ---------------------------------------------------------------------------
{
  const mine = ['127.0.0.1', 'localhost', '[::1]', '127.0.0.1:18701', 'localhost:18701', 'LOCALHOST:1', 'box.tail.ts.net', 'box', 'box:18701'];
  const theirs = ['evil.example', 'evil.example:18701', '127.0.0.1.evil.example', 'localhost.evil.example', 'box.evil.example', 'xbox', '', ' ', '127.0.0.1@evil.example', 'evil.example#localhost', '[::2]', '0.0.0.0', '8.8.8.8', 'localhost\t', 'evil.example:80:127.0.0.1'];
  const pages = { ok: ['http://localhost', 'http://localhost:3000', 'http://127.0.0.1:8080', 'https://box.tail.ts.net', 'http://[::1]:5173', 'app://local', 'tauri://localhost', 'vscode-webview://abc'], no: ['https://evil.example', 'http://evil.example:18701', 'null', '', 'http://localhost.evil.example', 'https://127.0.0.1.evil.example', 'x', 'http://', 'http://evil.example@localhost.evil.example'] };
  const names = () => ['127.0.0.1', null, 'box.tail.ts.net', 'box'];
  let cases = 0;
  for (const host of mine) { cases++; if (refusal({ host }, names)) found('the port refused this machine\'s own address', host); }
  for (const host of theirs) { cases++; if (!refusal({ host }, names)) found('the port answered a name that is not this machine\'s', JSON.stringify(host)); }
  for (const origin of pages.ok) { cases++; if (refusal({ host: '127.0.0.1:18701', origin }, names)) found('the port refused a page served from this machine, or an app', origin); }
  for (const origin of pages.no) { cases++; if (!refusal({ host: '127.0.0.1:18701', origin }, names)) found('the port answered a page from another site', JSON.stringify(origin)); }
  for (let i = 0; i < 20000; i++) {
    const host = text(['l', 'o', 'c', 'a', 'h', 's', 't', '.', ':', '1', '2', '7', '0', '[', ']', 'e', 'v', 'i', '@', '#', '/', ' '], 14), origin = rnd() < 0.5 ? undefined : `${pick(['http', 'https'])}://${text(['l', 'o', 'c', 'a', 'h', 's', 't', '.', '1', '2', '7', '0', 'e', 'v', 'i', '-'], 12)}`;
    cases++;
    let why;
    try { why = refusal({ host, origin }, names); } catch (e) { found('the port\'s door threw', `${JSON.stringify([host, origin])}: ${e.message}`); continue; }
    if (why) continue;
    const bare = host.toLowerCase().replace(/:\d+$/, ''), own = (n) => /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(n) || ['box.tail.ts.net', 'box'].includes(n);
    if (!own(bare)) found('the port answered a made-up name', JSON.stringify(host));
    if (origin !== undefined && !own(new URL(origin).hostname)) found('the port answered a page from a made-up site', origin);
  }
  section('a model\'s port: answers only this machine\'s own address, and no page from another site', cases);
}

// ---- 7. host recipes ---------------------------------------------------------------------------------------------------
if (process.platform === 'darwin' && process.arch === 'arm64') {
  const script = 'print(1)\n', sha = createHash('sha256').update(script).digest('hex'), REV = 'c'.repeat(40);
  const words = ['python3', 'python', 'serve.py', 'other.py', '-c', '-m', 'http.server', 'import os', '--port', '8080', '--host', '0.0.0.0', '127.0.0.1', '--port=9999', '--host=0.0.0.0', '-', '--', '', '/bin/sh', 'sh', '../serve.py', '-W', 'ignore', '-u', '-S'];
  let cases = 0, passed = 0;
  for (let i = 0; i < N; i++) {
    const good = rnd() < 0.5;
    const command = good ? ['python3', 'serve.py', ...some(['--model', 'm', '--host', '127.0.0.1', '--port', '8080', '--port=1', '-c', 'x'], 6)] : some(words, 7);
    const launch = { kind: 'host', backend: 'metal', command: rnd() < 0.03 ? pick([null, 'python3 serve.py', {}, [1, 2]]) : command, pip: some(good && rnd() < 0.8 ? ['mlx-lm==0.30.0', 'x==1'] : ['mlx-lm==0.30.0', 'x==1', 'evil', 'x>=1', 'git+https://x', '-r req.txt', '--index-url=http://x'], 3),
      config: good && rnd() < 0.8 ? { at: 'serve.py', text: script, sha256: sha } : rnd() < 0.9 ? { at: pick(['serve.py', 'serve.py', 'other.py', '../serve.py', 'serve', '/tmp/x.py']), text: pick([script, script, 'import os\n']), sha256: sha } : pick([undefined, null, 'serve.py']),
      weights: some(good && rnd() < 0.8 ? [{ repo: 'org/m', revision: REV, at: 'model' }] : [{ repo: 'org/m', revision: REV, at: 'model' }, { path: '/etc', at: 'x' }, { repo: 'org/m', revision: 'main', at: 'model' }, { repo: 'org/m', revision: REV, at: '../x' }, null], 2) };
    if (rnd() < 0.3) launch.env = pick([{ A: '1' }, { 'B C': '1' }, { DYLD_INSERT_LIBRARIES: { x: 1 } }, [], 'x', { OK_1: 2 }]);
    cases++;
    let why;
    try { why = problemWith({ card: 'c', model: 'm', engine: 'mlx', launch }); } catch (e) { found('the host recipe check threw instead of refusing', `${e.message} for ${JSON.stringify(launch).slice(0, 300)}`); continue; }
    if (why) continue;
    passed++;
    const c = launch.command, show = JSON.stringify(launch).slice(0, 300);
    if (!/^python3?$/.test(c[0]) || c[1] !== launch.config.at || launch.config.at !== 'serve.py' || launch.config.text !== script) found('a host recipe accepted that runs something other than its own hashed script', show);
    if (c.filter((x) => x === '--port').length !== 1 || c.filter((x) => x === '--host').length > 1 || c.some((x) => /^--(port|host)=/.test(x)) || ['--port', '--host'].includes(c[c.length - 1])) found('a host recipe accepted that can choose its own port or address', show);
    if (launch.pip.some((p) => !/^[A-Za-z0-9][\w.-]*==[\w.+-]+$/.test(p))) found('a host recipe accepted with a package that is not pinned', show);
    if (launch.weights.some((w) => !w || w.path || w.revision !== REV || w.at.includes('..'))) found('a host recipe accepted with weights that are not pinned inside its folder', show);
    if (launch.env !== undefined && (Array.isArray(launch.env) || typeof launch.env !== 'object' || Object.entries(launch.env).some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v === 'object'))) found('a host recipe accepted with an odd environment', show);
  }
  section(`host recipes: every one accepted (${passed.toLocaleString('en-US')}) runs its own hashed script, pinned, on the port the app gives it`, cases);
}

// ---- 8. DeepSeek Harness's settings ---------------------------------------------------------------------------------
{
  const mine = (n) => Array.from({ length: n }, (_, i) => [`      box-${i}:`, `        displayName: Box ${i} # mine`, '        apiKeyEnv: BOX_KEY', '        baseURL: http://box:8080/v1', '        models:', `          - id: model-${i}`, '            contextWindow: 262144', ...(i % 2 ? ['', '      # a note of mine'] : [])]).flat();
  const file = (n, extra = []) => ['# Your patch layer.', '- id: ui', '  config:', '    welcome: 1', '- id: llm-pi-ai', '  name: "@deepseek-ai/dsh-llm-pi-ai"', '  config:', '    providers:', ...mine(n), ...extra, '- id: agent-default-model', '  config:', '    provider: box-0', '    model: model-0', '- id: last', '  config:', '    x: 1', ''].join('\n');
  const odd = ['plain', 'with "quotes"', "it's", 'a: b', '# not a comment', '- not an item', 'line\nbreak', '  spaces  ', '{braces}', '[x]', '!!js evil', '&anchor *alias', '\\ back', 'ünï · code', '', '\t', '|', '>', '---', '%'];
  let cases = 0;
  for (let i = 0; i < Math.min(N, 20000); i++) {
    const before = file(Math.floor(rnd() * 4)), keys = new Set();
    const models = Array.from({ length: Math.floor(rnd() * 4) }, () => ({ key: `la-${pick(['self', '0', '1', '12'])}-${18701 + Math.floor(rnd() * 50)}`, model: pick(odd), title: pick(odd), url: `http://${pick(['127.0.0.1', '100.64.0.10'])}:${8000 + Math.floor(rnd() * 99)}`, ctx: pick([8192, 1048576]), vision: rnd() < 0.5 })).filter((m) => !keys.has(m.key) && keys.add(m.key));
    cases++;
    let after;
    try { after = dsh.withModels(before, models); } catch (e) { found('writing models into the Harness settings threw', `${e.message} for ${JSON.stringify(models)}`); continue; }
    if (after === null) { found('a settings file laid out as expected was refused', JSON.stringify(models)); continue; }
    const was = before.split('\n'), now = after.split('\n');
    let at = 0;
    for (const line of now) if (at < was.length && line === was[at]) at++; // every line of the person's own, in order
    if (at !== was.length) found('a line of the person\'s own went missing from the Harness settings', JSON.stringify(models));
    if (now.length !== was.length + models.reduce((n, m) => n + 12 + (m.vision ? 1 : 0), 0)) found('the Harness settings gained lines that are not a model\'s', JSON.stringify(models));
    if (now.filter((l) => l.startsWith('- ')).length !== was.filter((l) => l.startsWith('- ')).length) found('a model\'s name became an entry of its own in the Harness settings', JSON.stringify(models));
    if (dsh.withModels(after, models) !== after) found('writing the same models twice changed the Harness settings', JSON.stringify(models));
    if (dsh.withModels(after, []) !== before) found('taking the models out again did not give the Harness settings back', JSON.stringify(models));
    const chosen = models[0] || { key: 'la-0-8000', model: pick(odd) }, set = dsh.withDefault(after, chosen.key, chosen.model);
    if (set === null || set.split('\n').length !== now.length || set.split('\n').filter((l, n) => l !== now[n]).length > 2) found('setting the Harness\'s default model changed more than its two lines', JSON.stringify(chosen));
  }
  for (const [text, lines] of [[null, 3], ['version: 1\nrefs:\n  A_KEY: x\nrecords:\n  a/b:\n    kind: k\n', 1], ['version: 1\nrecords: {}\n', 2], ['version: 1\nrefs:\n    A_KEY: x\n', 1]]) {
    const keyed = dsh.withKey(text);
    cases++;
    if (keyed === null || dsh.withKey(keyed) !== keyed || keyed.split('\n').length !== (text === null ? 1 : text.split('\n').length) + lines || !/^\s+LOCAL_AI_API_KEY: local$/m.test(keyed) || (text !== null && !text.split('\n').every((l) => keyed.split('\n').includes(l)))) found('the Harness keys file was not given one key and left otherwise alone', JSON.stringify(text));
  }
  for (const text of ['A_KEY: x\n', 'version: 2\nrefs:\n  A: x\n', 'version: 1\nrefs: { A: x }\n']) { cases++; if (dsh.withKey(text) !== null) found('a Harness keys file in another layout was edited', JSON.stringify(text)); }
  section('DeepSeek Harness settings: models go in and out, and every line that was the person\'s own stays', cases);
}

// ---- 9. the running server -----------------------------------------------------------------------------------------
const PORT = 29700 + Math.floor(rnd() * 200) * 2;
const registry = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ cards: {}, models: {}, builds: {}, recipes: { 'fuzz/none': { card: 'none', model: 'm', engine: 'vllm', launch: { image: 'x', port: 1 } } } })); });
await new Promise((done) => registry.listen(0, '127.0.0.1', done));
let log = '';
const server = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], { cwd: ROOT, env: { ...process.env, PI_CODING_AGENT_DIR: join(HOME, 'pi'), LOCAL_AI_PORT: String(PORT), LOCAL_AI_SHARE: '0', LOCAL_AI_REGISTRY: `http://127.0.0.1:${registry.address().port}/c.json` }, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', (b) => { log += b; });
server.stderr.on('data', (b) => { log += b; });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
// Connections are kept open and used again. The server may close one between two requests; a request that was sent on
// a connection that had been used before and was closed under it is sent once more on a new one (it never arrived),
// and only what happens then counts.
const pool = new Agent({ keepAlive: true, maxSockets: 32 });
const send = (method, path, { headers = {}, body } = {}, agent = pool) => new Promise((done) => {
  const req = request({ host: '127.0.0.1', port: PORT, method, path, headers, timeout: 8000, agent }, (res) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => done({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers })); });
  req.on('timeout', () => { req.destroy(); done({ status: 0, body: Buffer.from('timed out') }); });
  req.on('error', (e) => done(req.reusedSocket && agent === pool && ['ECONNRESET', 'EPIPE'].includes(e.code) ? send(method, path, { headers, body }, false) : { status: -1, body: Buffer.from(e.message) }));
  req.end(body);
});
try {
  for (let i = 0; i < 60 && (await send('GET', '/api/health')).status !== 200; i++) await sleep(250);
  const key = JSON.parse(readFileSync(join(HOME, 'config.json'), 'utf8')).key;
  // The files that may be served: what is in web/, one folder deep.
  const WEB = join(ROOT, 'web'), files = new Map();
  for (const f of readdirSync(WEB, { withFileTypes: true })) {
    if (f.isFile()) files.set(`/${f.name}`, readFileSync(join(WEB, f.name)));
    else for (const g of readdirSync(join(WEB, f.name))) files.set(`/${f.name}/${g}`, readFileSync(join(WEB, f.name, g)));
  }
  const pieces = ['', '.', '..', '%2e%2e', '%2e', '%2f', '%5c', '\\', 'web', 'server', 'components', 'index.js', 'util.js', 'app.js', 'icons.js', 'index.html', 'style.css', 'config.json', 'package.json', 'install.sh', '.git', 'HEAD', '~', 'etc', 'passwd', '%00', 'app.js%00.png', 'fonts', 'hanken.woff2'];
  const paths = new Set();
  for (const a of pieces) { paths.add(`/${a}`); for (const b of pieces) { paths.add(`/${a}/${b}`); if (rnd() < 0.25) for (const c of pieces) paths.add(`/${a}/${b}/${c}`); } }
  let cases = 0;
  const list = [...paths];
  for (let i = 0; i < list.length; i += 16) {
    await Promise.all(list.slice(i, i + 16).map(async (path) => {
      const res = await send('GET', path, { headers: { host: 'evil.example' } }); // a browser on another site: never the key
      cases++;
      if (res.body.includes(key)) return found('the key served to a request that should not get it', path);
      // The server reads a path the way a URL is read (a/../b is b), so that is the file it may serve: one in web/, or nothing.
      const plain = new URL(`http://local${path}`).pathname, file = files.get(plain === '/' ? '/index.html' : plain);
      if (res.status === 200) {
        if (!file || (plain !== '/' && plain !== '/index.html' && !file.equals(res.body))) found('a path served something that is not that file in web/', path);
      } else if (res.status !== 404) found(`a path answered ${res.status}`, `${path}: ${res.body.toString().slice(0, 120)}`);
      else if (file) found('a file in web/ was not served', path);
      if (res.status === 200 && !/default-src 'self'/.test(res.headers['content-security-policy'] || '')) found('a page served without its content policy', path);
    }));
  }
  section('file paths: every path built from traversal pieces is a file in web/ or not found, and never carries the key', cases);

  // Random requests to the API. Left out on purpose: the routes that would install agents, start Docker or update the app.
  const junk = () => pick([null, true, 0, -1, 1e308, 'x', '', '__proto__', 'constructor', 'toString', '../x', 'a'.repeat(3000), [], {}, [[[[]]]], { __proto__: { a: 1 } }, { constructor: { prototype: { x: 1 } } }, '\u0000', '💥', 'http://127.0.0.1:1', 'http://[::1]:1/', 'file:///etc/passwd', 'javascript:1']);
  const obj = () => Object.fromEntries(some(['recipe', 'gpus', 'id', 'launch', 'card', 'url', 'key', 'name', 'agent', 'device', 'port', 'folder', 'home', 'background', 'tone', 'picture', 'autoUpdate', 'hfToken', 'terminal', 'ip', '__proto__', 'constructor'], 5).map((k) => [k, rnd() < 0.3 ? { order: junk(), on: junk(), image: junk(), port: junk(), kind: junk() } : junk()]));
  const routes = [['GET', '/api/state'], ['POST', '/api/runs'], ['DELETE', '/api/runs/X'], ['GET', '/api/runs/X/logs'], ['POST', '/api/runs/X/measure'], ['GET', '/api/recipe'], ['POST', '/api/recipes'], ['DELETE', '/api/recipes'], ['GET', '/api/card'],
    ['GET', '/api/usage'], ['GET', '/api/endpoints'], ['POST', '/api/open'], ['POST', '/api/settings'], ['GET', '/api/background'], ['POST', '/api/devices'], ['DELETE', '/api/devices'], ['GET', '/api/devices/X/state'], ['POST', '/api/devices/X/runs'],
    ['POST', '/api/tailscale/install'], ['GET', '/api/health'], ['POST', '/api/pair'], ['GET', '/install'], ['GET', '/install.tgz'], ['GET', '/api/nope'], ['POST', '/api/'], ['PUT', '/api/state'], ['OPTIONS', '/api/state'], ['HEAD', '/api/health']];
  const ids = ['0', '1', '-1', '18701', '99999999999', 'NaN', 'x', '__proto__', 'constructor', '%00', '..', '%2e%2e', 'a/b', ''];
  let calls = 0, unauthorised = 0;
  const batch = [];
  for (let i = 0; i < Math.min(N, 6000); i++) {
    const [method, route] = pick(routes), path = route.replace('X', encodeURIComponent(pick(ids))) + (rnd() < 0.4 ? `?${pick(['id', 'i', 'tail', 'v', 'x'])}=${encodeURIComponent(String(pick(ids)))}` : '');
    const authed = rnd() < 0.7, raw = rnd() < 0.15 ? pick(['{', '[1,2]', 'null', '"x"', '{"a":', '\u0000', 'x'.repeat(5000), '{"__proto__":{"polluted":1}}']) : JSON.stringify(obj());
    const headers = { 'content-type': pick(['application/json', 'text/plain', '', 'application/x-www-form-urlencoded']), ...(authed ? { authorization: `Bearer ${key}` } : rnd() < 0.5 ? { authorization: pick(['Bearer ', 'Bearer x', 'Basic eDp5', key, `bearer ${key}`, `Bearer ${key}x`, `Bearer  ${key}`, `Bearer ${key.slice(0, -1)}`]) } : {}), ...(rnd() < 0.2 ? { host: pick(['evil.example', 'localhost', '127.0.0.1.evil.example', '[::1]', '']) } : {}) };
    batch.push((async () => {
      // The snapshot is asked for at a version it is not at, or the answer would wait for a change.
      const res = await send(method, path.startsWith('/api/state') ? '/api/state?v=-1' : path, { headers, body: method === 'GET' || method === 'HEAD' ? undefined : raw });
      calls++;
      const open = /^\/(api\/health|api\/pair|install)/.test(path);
      if (res.status === 0) found('a request the server never answered', `${method} ${path}`);
      else if (res.status === -1) found('a request that broke the connection', `${method} ${path}: ${res.body}`);
      else if (res.status >= 500 && res.status !== 502 && res.status !== 503) found(`a request answered ${res.status}`, `${method} ${path} ${raw.slice(0, 200)} -> ${res.body.toString().slice(0, 200)}`);
      if (!authed && !open) { unauthorised++; if (res.status !== 401) found('the API answered without the key', `${method} ${path} -> ${res.status}`); if (res.body.includes(key)) found('the key given away without the key', `${method} ${path}`); }
    })());
    if (batch.length >= 25) { await Promise.all(batch.splice(0)); }
  }
  await Promise.all(batch);
  const after = await send('GET', '/api/health');
  if (after.status !== 200) found('the server was no longer answering after the API fuzz', String(after.status));
  if (server.exitCode !== null) found('the server exited during the fuzz', String(server.exitCode));
  if ({}.polluted !== undefined || Object.prototype.a !== undefined) found('something reached Object.prototype in this process', '');
  let config = null;
  try { config = JSON.parse(readFileSync(join(HOME, 'config.json'), 'utf8')); } catch (e) { found('the config file was left unreadable', e.message); }
  if (config && config.key !== key) found('the key was changed by a request', '');
  if (/"level":"error","name":"(tick\.failed|loop\.failed|server\.fatal)"/.test(log)) found('a server loop failed during the fuzz', log.split('\n').filter((l) => /tick\.failed|loop\.failed|server\.fatal/.test(l)).slice(0, 3).join(' | ').slice(0, 400));
  if (existsSync(join(HOME, 'config.json.corrupt'))) found('a state file was marked corrupt', 'config.json');
  section(`the API: no crash, no hang, no 5xx, and nothing without the key (${unauthorised.toLocaleString('en-US')} of them sent without it)`, calls);
} finally {
  pool.destroy();
  server.kill('SIGKILL');
  registry.close();
  rmSync(HOME, { recursive: true, force: true });
}
console.log(failures.length ? `\n${failures.length} finding(s), seed ${seed}` : `\nnothing found, seed ${seed}`);
process.exit(failures.length ? 1 : 0);
