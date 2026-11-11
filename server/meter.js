// A host run's front door. Engines like mlx_lm.server have no /metrics, so the app listens on the run's port itself,
// passes every request through to the engine on an inner port, and counts the tokens each answer reports.
import { createServer, request } from 'node:http';
import { hostname, networkInterfaces } from 'node:os';

const COUNTED = /^\/(v1\/)?(chat\/completions|completions|responses|messages)$/;
const MAX_BODY = 16e6; // a non-streamed answer longer than this passes through uncounted
const MAX_LINE = 4e6; // a streamed line longer than this is not read for usage

// Who may use the port. The engine behind it answers anyone, so the door does the asking:
//   The address must be this machine's (loopback, one of its own addresses, or one of its names). A page on some
//   site that points its own name at this machine still says that name, and is refused.
//   A request from a web page says which site the page is from. Pages served from this machine may ask; another
//   site's page may not, and neither may a page that hides where it is from. Programs (agents, curl, apps) say nothing.
const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/;
const hostOf = (value) => String(value || '').toLowerCase().replace(/:\d+$/, '');
let own = { at: 0, names: new Set() };
function here(extra) {
  if (Date.now() - own.at > 30000) {
    const mine = Object.values(networkInterfaces()).flat().map((a) => (a.family === 'IPv6' ? `[${a.address.replace(/%.*$/, '')}]` : a.address));
    own = { at: Date.now(), names: new Set([...mine, hostname(), `${hostname()}.local`].map((n) => n.toLowerCase())) };
  }
  const also = extra().filter(Boolean).map((n) => String(n).toLowerCase());
  return (name) => LOOPBACK.test(name) || own.names.has(name) || also.includes(name);
}
export function refusal(headers, extra = () => []) {
  const known = here(extra);
  if (!known(hostOf(headers.host))) return 'This port answers only to this machine’s own address';
  if (headers.origin === undefined) return null;
  let from = null;
  try { from = new URL(headers.origin); } catch { /* "null", or not an address at all */ }
  return from && (!/^https?:$/.test(from.protocol) || known(from.hostname.toLowerCase())) ? null : 'This port does not answer pages from other sites';
}
// A number an engine reported, as a number: anything else counts as nothing.
const num = (x) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0);

export function meter(inner, names = () => []) {
  // Token and request counters are named as vLLM names them, so usage.js reads both the same way. Prefill is kept in
  // two pairs that are never mixed:
  //   engine_prefill_*: what the engine itself reports it computed and how long that took (the `timings` block
  //     llama.cpp-style servers put in an answer). This is prefill speed.
  //   ttft_*: uncached prompt tokens and the time from the request reaching this port to the first streamed token.
  //     That wait also holds queueing and the first decode step, so it is only an estimate, and is shown as one.
  const counts = { prompt_tokens_total: 0, generation_tokens_total: 0, request_success_total: 0, num_requests_running: 0,
    engine_prefill_tokens_sum: 0, engine_prefill_seconds_sum: 0, ttft_prompt_tokens_sum: 0, ttft_seconds_sum: 0 };
  const callers = new Map();
  let day = '';
  const caller = (ip) => {
    const now = new Date().toISOString();
    if (now.slice(0, 10) !== day) { day = now.slice(0, 10); callers.clear(); }
    const row = callers.get(ip) || { ip, requests: 0, last: now };
    row.requests++; row.last = now;
    callers.set(ip, row);
  };

  // Reads usage from an answer as it streams past: the final usage block when the engine sends one, else one token a chunk.
  function tap(streamed, began) {
    let tail = '', body = '', size = 0, usage = null, timings = null, chunks = 0, first = 0;
    return {
      add(buf) {
        if (!streamed) { size += buf.length; if (size <= MAX_BODY) body += buf; return; }
        const lines = (tail + buf).split('\n');
        tail = lines.pop();
        if (tail.length > MAX_LINE) tail = '';
        for (const line of lines) {
          if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
          let data;
          try { data = JSON.parse(line.slice(5)); } catch { continue; }
          if (!data || typeof data !== 'object') continue;
          if (data.usage) usage = data.usage;
          if (data.timings) timings = data.timings;
          const delta = data.choices?.[0]?.delta;
          if ((delta && (delta.content || delta.reasoning_content || delta.reasoning || delta.tool_calls)) || data.type === 'content_block_delta') { chunks++; first ||= performance.now(); }
        }
      },
      end(ok) {
        if (!streamed && size <= MAX_BODY) { try { const data = JSON.parse(body); usage = data.usage || null; timings = data.timings || null; } catch { /* not JSON */ } }
        if (!usage || typeof usage !== 'object') usage = null;
        const inTok = num(usage?.prompt_tokens ?? usage?.input_tokens), outTok = usage ? num(usage.completion_tokens ?? usage.output_tokens) : chunks;
        counts.prompt_tokens_total += inTok;
        counts.generation_tokens_total += outTok;
        if (ok) counts.request_success_total++;
        const cached = num(usage?.prompt_tokens_details?.cached_tokens), prefill = [num(timings?.prompt_n), num(timings?.prompt_ms)];
        if (ok && prefill[0] > 0 && prefill[1] > 0) { counts.engine_prefill_tokens_sum += prefill[0]; counts.engine_prefill_seconds_sum += prefill[1] / 1000; }
        else if (ok && first && inTok - cached > 0) { counts.ttft_prompt_tokens_sum += inTok - cached; counts.ttft_seconds_sum += (first - began) / 1000; }
      },
    };
  }

  const server = createServer((req, res) => {
    const why = refusal(req.headers, names);
    if (why) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: why })); req.resume(); return; }
    const counted = req.method === 'POST' && COUNTED.test(req.url.split('?')[0]), began = performance.now();
    if (counted) { counts.num_requests_running++; caller((req.socket.remoteAddress || '').replace(/^::ffff:/, '')); }
    let finished = false;
    const done = (ok, t) => { if (finished) return; finished = true; if (counted) { counts.num_requests_running--; t?.end(ok); } };
    const up = request({ host: '127.0.0.1', port: inner, method: req.method, path: req.url, headers: req.headers, agent: false }, (answer) => { // a connection of its own each time: one kept open can be closed by the engine just as a request is sent on it, and that request can't be sent again
      const t = counted ? tap(/event-stream/.test(answer.headers['content-type'] || ''), began) : null;
      res.writeHead(answer.statusCode, answer.headers);
      answer.on('data', (buf) => t?.add(buf.toString('utf8')));
      answer.on('end', () => done(answer.statusCode < 400, t));
      answer.on('error', () => { done(false, t); res.destroy(); });
      answer.pipe(res);
    });
    up.on('error', () => { done(false); if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end('{"error":"The engine is not answering"}'); } else res.destroy(); });
    res.on('close', () => { if (!res.writableFinished) { up.destroy(); done(false); } });
    req.pipe(up);
  });

  // Listens on every address the run is published on. The first must bind; a second address that is gone is skipped.
  async function listen(port, hosts) {
    const handler = server.listeners('request')[0];
    const servers = hosts.map((_, i) => (i ? createServer(handler) : server));
    await Promise.all(hosts.map((host, i) => new Promise((ok, failed) => {
      let bound = false;
      servers[i].on('error', (e) => { if (bound) return; if (i === 0) failed(e); else ok(); });
      servers[i].listen(port, host, () => { bound = true; ok(); });
    })));
    return () => servers.forEach((one) => { one.close(); one.closeAllConnections?.(); });
  }

  return { counts, callers, listen };
}
