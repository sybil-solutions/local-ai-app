// Your other machines. Connected ones are polled and their API is proxied; Tailscale says which computers are yours at all.
import { spawn } from 'node:child_process';
import { bytesUpTo, config, jsonUpTo, event, fail, PAYLOAD, PORT, run, saveConfig } from './util.js';

const remote = new Map();
let tail = { at: 0, status: null }, seen = { at: 0, list: [] };

async function status() {
  if (Date.now() - tail.at > 15000) {
    let found = null;
    try { found = JSON.parse((await run('tailscale', ['status', '--json'], { timeout: 5000 })).stdout); } catch { /* no Tailscale here */ }
    tail = { at: Date.now(), status: found };
  }
  return tail.status;
}

// This machine on the tailnet: { name, ip, ips, user, tagged, magic }, or null without Tailscale. `tagged` machines
// all belong to one stand-in owner, so "the same owner" says nothing about them. `magic` is whether short names resolve
// through Tailscale itself.
export async function self() {
  const found = await status(), me = found?.Self;
  return me?.TailscaleIPs?.[0] ? { name: (me.DNSName || '').replace(/\.$/, ''), ip: me.TailscaleIPs[0], ips: me.TailscaleIPs, user: me.UserID, tagged: !!me.Tags?.length, magic: !!found.CurrentTailnet?.MagicDNSEnabled } : null;
}

// Your own computers on the tailnet, and whether each already answers as Local AI. Phones, VPN exit nodes and shared
// machines are left out. Asking each one takes up to a second and a half, so a list that is already known is given
// at once and looked up again behind it; `fresh` waits for the new one.
let looking = null;
export function peers({ fresh = false } = {}) {
  if (Date.now() - seen.at >= 10000 || fresh) looking ||= look().finally(() => { looking = null; });
  return seen.at && !fresh ? Promise.resolve(seen.list) : looking;
}
// Whether the list peers() just gave is older than ten seconds, and a newer one is on its way.
export const peersAreStale = () => !!looking;
async function look() {
  const linked = new Set(config.devices.map((d) => new URL(d.url).hostname)), found = await status(), names = new Set();
  const mine = found?.Self?.Tags?.length ? [] : Object.values(found?.Peer || {}).filter((p) => p.UserID === found.Self.UserID && !p.Tags?.length && !/ios|android|tvos/i.test(p.OS || ''));
  const list = await Promise.all(mine.map(async (p) => {
    const ip = p.TailscaleIPs?.[0];
    const app = p.Online && await fetch(`http://${ip}:${PORT}/api/health`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
    return { name: p.HostName, dns: (p.DNSName || '').replace(/\.$/, ''), ip, os: p.OS, online: !!p.Online, seen: p.LastSeen, app: !!app, linked: linked.has(ip) };
  }));
  // A machine that was set up twice appears twice; keep the one that is online, else the one seen last.
  list.sort((a, b) => b.online - a.online || String(b.seen).localeCompare(String(a.seen)));
  seen = { at: Date.now(), list: list.filter((p) => !names.has(p.name.toLowerCase()) && names.add(p.name.toLowerCase())) };
  return seen.list;
}

// Tailscale already proves which machines are yours, so those may connect and fetch the installer without a key.
// Yours means another machine signed in as the same person: not a tagged machine (they all share one stand-in owner),
// and not a program on this machine calling its own tailnet address. The Host must be this machine's own tailnet name
// or address, so a rebound DNS name can't borrow that trust; the short name counts only where Tailscale resolves it.
export async function isMine(req) {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, ''), me = await self();
  if (!me || me.tagged || me.ips.includes(ip)) return false;
  if (![me.ip, me.name, ...(me.magic ? [me.name.split('.')[0]] : [])].includes((req.headers.host || '').replace(/:\d+$/, ''))) return false;
  try { const node = JSON.parse((await run('tailscale', ['whois', '--json', ip], { timeout: 4000 })).stdout).Node; return node.User === me.user && !node.Tags?.length; } catch { return false; }
}

// Installs Local AI on one of your own Tailscale machines, so nobody has to paste a command there. This computer signs
// in over SSH the way you would: by the machine's name (which finds an entry in your SSH config), its tailnet name,
// then its address. The app's files go over that same connection, so the other machine never has to reach this one
// (a firewall here would stop it). Only a machine Tailscale lists as yours is ever contacted, and the name is passed
// to ssh as a word, never to a shell.
const SSH_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const unpackAndInstall = (mode) => `T="$(mktemp -d)" || exit 1; tar -xz -C "$T" && LOCAL_AI_SHIPPED=${mode} bash "$T/install.sh"; code=$?; rm -rf "$T"; exit $code`; // the folder it was unpacked to is not left behind
// Resolves with ssh's exit code and the last of what it printed. 255: it could not sign in. 3 and 4 are the
// installer declining (install.sh): the copy there updates itself, or Local AI is already running there.
// The app's files as one stream. A Mac's tar would add each file's Mac-only attributes, which another system unpacks
// as a ._ file beside it or warns about, so there they are left out.
const PLAIN = process.platform === 'darwin' ? ['--no-xattrs', '--no-mac-metadata'] : [];
export const pack = () => spawn('tar', [...PLAIN, '-czf', '-', '-C', PAYLOAD, 'server', 'web', 'package.json', 'install.sh', 'README.md'], { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, COPYFILE_DISABLE: '1' } });
const ship = (host, mode) => new Promise((done) => {
  const tar = pack();
  const ssh = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new', '--', host, unpackAndInstall(mode)], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  const keep = (text) => { out = `${out}${text}`.slice(-4000); };
  const timer = setTimeout(() => ssh.kill(), 600000);
  const end = (code) => { clearTimeout(timer); tar.kill(); done({ code, out: out.trim() }); };
  ssh.stdout.on('data', keep);
  ssh.stderr.on('data', keep);
  ssh.stdin.on('error', () => {}); // an ssh that could not sign in closes its end while tar still writes
  tar.on('error', () => ssh.kill());
  tar.stdout.pipe(ssh.stdin);
  ssh.on('error', () => end(127));
  ssh.on('close', (code) => end(code ?? 1));
});
// `update` replaces a copy that is already running there (one this computer installed earlier). Without it, a machine
// that turns out to run Local AI already is left as it is: this computer just can't reach it.
export async function install({ ip, update = false }) {
  const peer = (await peers({ fresh: true })).find((p) => p.ip === ip) || fail(404, 'That is not one of your Tailscale machines');
  if (!peer.online) fail(409, `${peer.name} is offline`);
  if (!/linux/i.test(peer.os)) fail(409, `Open the Local AI app on ${peer.name}. Installing it from here works on Linux machines`);
  // A copy that updates itself (it was cloned from the repo) is left to do that: writing files into it would break it.
  if ([...remote].some(([url, r]) => new URL(url).hostname === ip && r.state?.app?.can)) fail(409, `${peer.name} updates itself. Use Update there`);
  let last = '';
  for (const host of [...new Set([peer.name, peer.dns, peer.ip])].filter((h) => SSH_NAME.test(h || ''))) {
    const out = await ship(host, update ? 'update' : 'install');
    if (out.code === 3) fail(409, `${peer.name} updates itself. Use Update there`);
    if (out.code === 4) fail(409, `${peer.name} already runs Local AI, but this computer can’t reach it on your Tailscale (port ${PORT}). Check that nothing there blocks that port`);
    if (!out.code) {
      for (let i = 0; i < 40; i++) {
        if (await fetch(`http://${peer.ip}:${PORT}/api/health`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false)) { seen.at = 0; event('info', 'device.installed', { name: peer.name }); return { ok: true }; }
        await new Promise((done) => setTimeout(done, 500));
      }
      fail(502, `Local AI was installed on ${peer.name}, but it is not answering on your Tailscale yet. Is Tailscale running there?`);
    }
    last = out.out.split('\n').pop().slice(0, 200);
    if (out.code !== 255) { event('warn', 'device.install', { name: peer.name, error: last }); fail(502, `The install on ${peer.name} stopped: ${last}`); } // it signed in; the installer itself failed
  }
  event('warn', 'device.install', { name: peer.name, error: last });
  return fail(502, `This computer could not sign in to ${peer.name} over SSH, so it can’t install Local AI there for you`);
}

// What a connected machine says about itself, held to the shape the rest of the app reads. A snapshot that is not
// one is refused whole (the last good one is kept); inside one, anything that is not what it should be is left out, so
// neither this server nor the page has to trust another machine to be well.
const MAX_SNAPSHOT = 8e6;
const thing = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const things = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object' && !Array.isArray(x)) : []);
const wholes = (v) => (Array.isArray(v) ? v.filter(Number.isInteger) : []);
const words = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
export function conform(sent) {
  if (!sent || typeof sent !== 'object' || typeof sent.name !== 'string' || !Array.isArray(sent.runs) || !Array.isArray(sent.groups) || !Array.isArray(sent.gpus)) throw new Error('Did not answer as Local AI');
  const named = (r) => typeof r.id === 'string' && typeof r.name === 'string', recipe = (r) => ({ ...r, speed: thing(r.speed) });
  return {
    ...sent, name: words(sent.name, 120), devices: [], // its own connected machines are left out, or two machines connected to each other would nest each other's snapshots without end
    runs: things(sent.runs).filter((r) => Number.isInteger(r.id) && typeof r.name === 'string' && typeof r.phase === 'string').map((r) => ({ ...r, view: thing(r.view), gpus: wholes(r.gpus) })),
    groups: things(sent.groups).map((g) => ({ ...g, name: words(g.name), gpus: wholes(g.gpus), recipes: things(g.recipes).filter(named).map(recipe), blocked: things(g.blocked).filter(named).map((r) => ({ ...recipe(r), why: words(r.why, 160) || 'Can’t be started by this app' })), recommended: words(g.recommended, 200) || null, setups: things(g.setups).filter((x) => Number.isInteger(x.cards) && x.cards > 0 && Number.isInteger(x.machines) && x.machines > 0 && typeof x.label === 'string').map((x) => ({ cards: x.cards, machines: x.machines, label: words(x.label, 80) })), tiers: Object.fromEntries(Object.entries(thing(g.tiers)).filter(([, r]) => r && typeof r === 'object' && named(r)).map(([k, r]) => [k, recipe(r)])) })),
    gpus: things(sent.gpus), free: wholes(sent.free), docker: { ok: !!thing(sent.docker).ok, error: words(thing(sent.docker).error, 300) || null },
    catalog: thing(sent.catalog), usage: thing(sent.usage), app: sent.app && typeof sent.app === 'object' && !Array.isArray(sent.app) ? sent.app : null,
  };
}

// Whether every connected machine has answered, or failed to, at least once since the app started.
export const settled = () => config.devices.every((d) => remote.has(d.url));
export const views = () => config.devices.map((d, i) => ({ i, name: d.name, url: d.url, ...(remote.get(d.url) || { online: false, error: 'Connecting', state: null }) }));

// Each connected machine is followed the way its own page follows it: one request, which the machine answers the
// moment its snapshot changes, or after twenty seconds when nothing did. So a change there is here at once, and a
// machine with nothing to say is asked three times a minute and not twenty. Its answers come compressed.
// A slow link (Tailscale relayed through DERP can take seconds a round trip) is not an offline machine: it counts as
// offline after three misses in a row, and its last snapshot is kept for its name and models with nothing running.
let notify = () => {};
export const onChange = (fn) => { notify = fn; };
const following = new Map(); // url → the way to stop following it
async function track(device, stop) {
  let v = -1, misses = 0;
  while (!stop.aborted) {
    try {
      const res = await fetch(`${device.url}/api/state?v=${v}`, { headers: { authorization: `Bearer ${device.key}` }, signal: AbortSignal.any([stop, AbortSignal.timeout(35000)]) });
      if (!res.ok) throw Object.assign(new Error(res.status === 401 ? 'Wrong key' : `Answered ${res.status}`), { final: res.status === 401 });
      const sent = await jsonUpTo(res, MAX_SNAPSHOT);
      remote.set(device.url, { online: true, error: null, state: conform(sent) });
      v = Number.isInteger(sent.v) ? sent.v : -1;
      misses = 0;
      notify();
    } catch (e) {
      if (stop.aborted) return;
      v = -1; // whatever comes next is taken whole: the machine may have restarted and be counting versions from the start
      const was = remote.get(device.url);
      if (!(was?.online && ++misses < 3 && !e.final)) { // a miss or two keeps the last answer
        remote.set(device.url, { online: false, error: e.name === 'TimeoutError' ? 'Not responding' : e.cause?.code || e.message, state: was?.state ? { ...was.state, runs: [] } : null });
        if (was?.online !== false) event('warn', 'device.offline', { url: device.url, error: remote.get(device.url).error });
        notify();
      }
      await new Promise((done) => setTimeout(done, e.final ? 15000 : 3000));
    }
  }
}
// Starts following machines that were added and stops following ones that were removed.
export function follow() {
  for (const device of config.devices) {
    if (following.has(device.url)) continue;
    const stop = new AbortController();
    following.set(device.url, stop);
    track(device, stop.signal);
  }
  for (const [url, stop] of following) {
    if (config.devices.some((d) => d.url === url)) continue;
    stop.abort();
    following.delete(url);
    remote.delete(url);
  }
}

// One of your own Tailscale machines hands over its key when asked; anything else needs it typed.
export async function add({ url, key, name }) {
  if (!/^https?:\/\/[^\s/]+\/?$/.test(url || '')) fail(400, 'Enter a URL such as http://100.64.0.10:18700');
  const clean = url.replace(/\/$/, '');
  key ||= (await fetch(`${clean}/api/pair`, { method: 'POST', signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? r.json() : null), () => null))?.key;
  if (!key) fail(401, 'That machine needs its key. It’s under API endpoints there');
  if (config.devices.some((d) => d.url === clean)) fail(409, 'That device is already added');
  const res = await fetch(`${clean}/api/state`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) }).catch((e) => fail(502, `Could not reach it: ${e.cause?.code || e.message}`));
  if (!res.ok) fail(res.status === 401 ? 401 : 502, res.status === 401 ? 'That key is wrong' : `It answered ${res.status}`);
  config.devices.push({ url: clean, key, name: words(name, 120).trim() || conform(await jsonUpTo(res, MAX_SNAPSHOT)).name });
  saveConfig();
  follow();
  seen.at = 0;
  event('info', 'device.added', { url: clean });
  return { ok: true };
}

export function remove(index) {
  const i = index === null ? -1 : +index;
  if (!config.devices[i]) fail(404, 'No such device');
  config.devices.splice(i, 1);
  saveConfig();
  follow();
  return { ok: true };
}

// Runs any API call on a connected machine and hands back its answer as it came.
export async function forward(i, method, path, body) {
  const device = config.devices[i] || fail(404, 'No such device');
  const reply = await fetch(`${device.url}/api/${path}`, { method, body: method === 'GET' ? undefined : JSON.stringify(body), headers: { authorization: `Bearer ${device.key}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(60000) })
    .catch((e) => fail(502, `${device.name} is unreachable: ${e.cause?.code || e.message}`));
  const sent = await bytesUpTo(reply, 32e6).catch((e) => fail(502, `${device.name}: ${e.message}`));
  return { status: reply.status, type: reply.headers.get('content-type') || 'application/json', body: sent };
}
