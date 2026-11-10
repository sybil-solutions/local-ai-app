// A host run's front door. Engines like mlx_lm.server have no /metrics, so the app listens on the run's port itself,
// passes every request through to the engine on an inner port, and counts the tokens each answer reports.
import { createServer, request } from 'node:http';

const COUNTED = /^\/(v1\/)?(chat\/completions|completions|responses|messages)$/;
const MAX_BODY = 16e6; // a non-streamed answer longer than this passes through uncounted

export function meter(inner) {
  // Named as vLLM names them, so usage.js reads both the same way. Prefill is timed from the request to the first token
// of a streamed answer; a prompt the engine found in its cache counts too, as it does in the engine's own reply.
  const counts = { prompt_tokens_total: 0, generation_tokens_total: 0, request_success_total: 0, num_requests_running: 0, request_prefill_kv_computed_tokens_sum: 0, request_prefill_time_seconds_sum: 0 };
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
    let tail = '', body = '', size = 0, usage = null, chunks = 0, first = 0;
    return {
      add(buf) {
        if (!streamed) { size += buf.length; if (size <= MAX_BODY) body += buf; return; }
        const lines = (tail + buf).split('\n');
        tail = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
          let data;
          try { data = JSON.parse(line.slice(5)); } catch { continue; }
          if (data.usage) usage = data.usage;
          const delta = data.choices?.[0]?.delta;
          if ((delta && (delta.content || delta.reasoning_content || delta.reasoning || delta.tool_calls)) || data.type === 'content_block_delta') { chunks++; first ||= performance.now(); }
        }
      },
      end(ok) {
        if (!streamed && size <= MAX_BODY) { try { usage = JSON.parse(body).usage || null; } catch { /* not JSON */ } }
        const inTok = usage?.prompt_tokens ?? usage?.input_tokens ?? 0, outTok = usage?.completion_tokens ?? usage?.output_tokens ?? (usage ? 0 : chunks);
        counts.prompt_tokens_total += inTok;
        counts.generation_tokens_total += outTok;
        if (ok) counts.request_success_total++;
        const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
        if (ok && first && inTok - cached > 0) { counts.request_prefill_kv_computed_tokens_sum += inTok - cached; counts.request_prefill_time_seconds_sum += (first - began) / 1000; }
      },
    };
  }

  const server = createServer((req, res) => {
    const counted = req.method === 'POST' && COUNTED.test(req.url.split('?')[0]), began = performance.now();
    if (counted) { counts.num_requests_running++; caller((req.socket.remoteAddress || '').replace(/^::ffff:/, '')); }
    let finished = false;
    const done = (ok, t) => { if (finished) return; finished = true; if (counted) { counts.num_requests_running--; t?.end(ok); } };
    const up = request({ host: '127.0.0.1', port: inner, method: req.method, path: req.url, headers: req.headers, agent: false }, (answer) => {
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
