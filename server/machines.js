// Your other machines. Connected ones are polled and their API is proxied; Tailscale says which computers are yours at all.
import { config, event, fail, PORT, run, saveConfig } from './util.js';

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

// This machine on the tailnet: { name, ip, user }, or null without Tailscale.
export async function self() {
  const me = (await status())?.Self;
  return me?.TailscaleIPs?.[0] ? { name: (me.DNSName || '').replace(/\.$/, ''), ip: me.TailscaleIPs[0], user: me.UserID } : null;
}

// Your own computers on the tailnet, and whether each already answers as Local AI. Phones, VPN exit nodes and shared machines are left out.
export async function peers() {
  if (Date.now() - seen.at < 10000) return seen.list;
  const linked = new Set(config.devices.map((d) => new URL(d.url).hostname)), found = await status(), names = new Set();
  const mine = Object.values(found?.Peer || {}).filter((p) => p.UserID === found.Self.UserID && !/ios|android|tvos/i.test(p.OS || ''));
  const list = await Promise.all(mine.map(async (p) => {
    const ip = p.TailscaleIPs?.[0];
    const app = p.Online && await fetch(`http://${ip}:${PORT}/api/health`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
    return { name: p.HostName, ip, os: p.OS, online: !!p.Online, seen: p.LastSeen, app: !!app, linked: linked.has(ip) };
  }));
  // A machine that was set up twice appears twice; keep the one that is online, else the one seen last.
  list.sort((a, b) => b.online - a.online || String(b.seen).localeCompare(String(a.seen)));
  seen = { at: Date.now(), list: list.filter((p) => !names.has(p.name.toLowerCase()) && names.add(p.name.toLowerCase())) };
  return seen.list;
}

// Tailscale already proves which machines are yours, so those may connect and fetch the installer without a key.
// The Host must be this machine's own tailnet name or address, so a rebound DNS name can't borrow that trust.
export async function isMine(req) {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, ''), me = await self();
  if (!me || ![me.ip, me.name, me.name.split('.')[0]].includes((req.headers.host || '').replace(/:\d+$/, ''))) return false;
  try { return JSON.parse((await run('tailscale', ['whois', '--json', ip], { timeout: 4000 })).stdout).Node.User === me.user; } catch { return false; }
}

export const views = () => config.devices.map((d, i) => ({ i, name: d.name, url: d.url, ...(remote.get(d.url) || { online: false, error: 'Connecting', state: null }) }));

// A slow link (Tailscale relayed through DERP can take seconds a round trip) is not an offline machine: each machine
// gets 15 s to answer, is asked again only once it has, and counts as offline after three misses in a row.
const polling = new Set(), misses = new Map();
export const poll = () => Promise.all(config.devices.map(async (device) => {
  if (polling.has(device.url)) return;
  polling.add(device.url);
  try {
    const res = await fetch(`${device.url}/api/state`, { headers: { authorization: `Bearer ${device.key}` }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw Object.assign(new Error(res.status === 401 ? 'Wrong key' : `Answered ${res.status}`), { final: res.status === 401 });
    // Its own connected machines are left out, or two machines connected to each other would nest each other's snapshots without end.
    remote.set(device.url, { online: true, error: null, state: { ...(await res.json()), devices: [] } });
    misses.delete(device.url);
  } catch (e) {
    const was = remote.get(device.url), n = (misses.get(device.url) || 0) + 1;
    misses.set(device.url, n);
    if (was?.online && n < 3 && !e.final) return; // keep the last answer through a miss or two
    // An offline machine's last snapshot is kept for its name and models, but nothing on it is shown as running.
    remote.set(device.url, { online: false, error: e.name === 'TimeoutError' ? 'Not responding' : e.cause?.code || e.message, state: was?.state ? { ...was.state, runs: [] } : null });
    if (was?.online !== false) event('warn', 'device.offline', { url: device.url, error: remote.get(device.url).error });
  } finally { polling.delete(device.url); }
}));

// One of your own Tailscale machines hands over its key when asked; anything else needs it typed.
export async function add({ url, key, name }) {
  if (!/^https?:\/\/[^\s/]+\/?$/.test(url || '')) fail(400, 'Enter a URL such as http://100.90.62.80:18700');
  const clean = url.replace(/\/$/, '');
  key ||= (await fetch(`${clean}/api/pair`, { method: 'POST', signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? r.json() : null), () => null))?.key;
  if (!key) fail(401, 'That machine needs its key. It’s under API endpoints there');
  if (config.devices.some((d) => d.url === clean)) fail(409, 'That device is already added');
  const res = await fetch(`${clean}/api/state`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) }).catch((e) => fail(502, `Could not reach it: ${e.cause?.code || e.message}`));
  if (!res.ok) fail(res.status === 401 ? 401 : 502, res.status === 401 ? 'That key is wrong' : `It answered ${res.status}`);
  config.devices.push({ url: clean, key, name: name?.trim() || (await res.json()).name });
  saveConfig();
  seen.at = 0;
  event('info', 'device.added', { url: clean });
  return { ok: true };
}

export function remove(index) {
  const i = index === null ? -1 : +index;
  if (!config.devices[i]) fail(404, 'No such device');
  config.devices.splice(i, 1);
  saveConfig();
  return { ok: true };
}

// Runs any API call on a connected machine and hands back its answer as it came.
export async function forward(i, method, path, body) {
  const device = config.devices[i] || fail(404, 'No such device');
  const reply = await fetch(`${device.url}/api/${path}`, { method, body: method === 'GET' ? undefined : JSON.stringify(body), headers: { authorization: `Bearer ${device.key}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(60000) })
    .catch((e) => fail(502, `${device.name} is unreachable: ${e.cause?.code || e.message}`));
  return { status: reply.status, type: reply.headers.get('content-type') || 'application/json', body: Buffer.from(await reply.arrayBuffer()) };
}
