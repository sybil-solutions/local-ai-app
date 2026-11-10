# Builds the Local AI build map: screens, how they connect, what they read and call. Scratchpad only.
import base64, html, io, json, sys
from PIL import Image
sys.path.insert(0, sys.argv[1])
from spec import API, TYPES, SHOWS, RESOLVE, api_for

H = sys.argv[1]
G = json.load(open(H + '/shots/graph.json'))
ids = {f['id']: f for f in G}
esc = lambda s: html.escape(str(s), quote=True)
Q = '"'
def link(i, text=None): return '<a href=' + Q + '#s-' + esc(i) + Q + '>' + esc(text if text is not None else ids[i]['title']) + '</a>'

def webp(path, w, q=72):
    im = Image.open(path).convert('RGB')
    im = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
    b = io.BytesIO(); im.save(b, 'WEBP', quality=q, method=6)
    return 'data:image/webp;base64,' + base64.b64encode(b.getvalue()).decode()

thumbs = {f['id']: webp(f"{H}/shots/{f['id']}.png", 240) for f in G}
NAVONLY = lambda c: c['label'].startswith('Machine:') or c['label'] == 'Settings'

# Edges: every control and every server event, minus the header shortcuts every screen shares.
edges, seen = [], set()
for f in G:
    for c in f['controls']:
        if NAVONLY(c) or c['to'] in (f['id'], 'back') or c['to'] not in ids: continue
        k = (f['id'], c['to'], 'tap')
        if k in seen: continue
        seen.add(k); edges.append({'from': f['id'], 'to': c['to'], 'kind': 'tap', 'label': c['label']})
    for n in f['next']:
        k = (f['id'], n['to'], 'event')
        if k in seen: continue
        seen.add(k); edges.append({'from': f['id'], 'to': n['to'], 'kind': 'event', 'label': n['label']})
incoming = {}
for e in edges: incoming.setdefault(e['to'], []).append(e)

LANES = []
for f in sorted(G, key=lambda f: (f['row'], f['col'])):
    if not LANES or LANES[-1][0] != f['lane']: LANES.append((f['lane'], []))
    LANES[-1][1].append(f['id'])
LANE_NOTE = {'Every day': 'Start a model, open an agent, stop.', 'First time': 'Opening the app and the first download.', 'Details and settings': 'General settings, agents, machines, usage, app updates.', 'When something fails': 'A run that started and then failed. Each one offers the engine output.', 'When it can’t start': 'The machine itself is not ready.', 'On a phone': 'The phone app, with one small on-device model.', 'Advanced': 'Models, endpoints, registry, token.'}

uses = {}
for f in G:
    for c in f['controls']:
        a = api_for(f['id'], c)
        if a.startswith(('GET', 'POST', 'DELETE')): uses.setdefault(a.split(' {')[0].split(' (')[0].split('?')[0].replace(' + POST /api/background', ''), set()).add(f['id'])
uses.setdefault('GET /api/state', set()).update(ids)

def route_key(m, p): return f"{m} {p.split('?')[0]}"
def used_by(m, p):
    k = route_key(m, p); hit = set()
    for u, s in uses.items():
        if u == k or (k.endswith(':id/update') and u.startswith('POST /api/agents/:id/update')): hit |= s
    if k == 'POST /api/background': hit |= uses.get('POST /api/settings', set()) & {'background'}
    if k == 'GET /api/endpoints' or k == 'GET /api/requests/sources': hit.add('endpoints')
    if k == 'GET /api/tailscale/peers': hit.add('machines')
    if k == 'GET /api/app/version': hit |= {'settings', 'advanced', 'app-update'}
    if k == 'GET /api/agents': hit |= {'agent', 'chooser'}
    if k == 'GET /api/state': return ['every screen']
    if k == 'ANY /api/devices/:i/*': return ['every screen, on another machine']
    return sorted(hit)

def card(f):
    rows = []
    for c in f['controls']:
        if NAVONLY(c): continue
        to = c['to']; t = 'Back to the previous screen' if to == 'back' else ('Stays here' if to == f['id'] else ids.get(to, {}).get('title', to))
        rows.append(f"<tr><td>{esc(c['label'] or '—')}</td><td>{link(to, t) if to in ids and to != f['id'] else esc(t)}</td><td><code>{esc(api_for(f['id'], c) or '—')}</code></td></tr>")
    ev = ''.join(f"<tr><td>{esc(n['label'])}</td><td>{link(n['to'])}</td></tr>" for n in f['next'] if n['to'] in ids)
    inc = sorted({e['from'] for e in incoming.get(f['id'], [])})
    header = any(NAVONLY(c) for c in f['controls'])
    return f'''<article class="spec" id="s-{esc(f['id'])}">
  <img src="{thumbs[f['id']]}" alt="{esc(f['title'])} screen" loading="lazy" width="120" height="240">
  <div class="sbody">
    <div class="shead"><h3>{esc(f['title'])}</h3><code>{esc(f['id'])}</code></div>
    <p>{esc(SHOWS.get(f['id'], ''))}</p>
    {f'<table class="t"><thead><tr><th>Control</th><th>Goes to</th><th>Calls</th></tr></thead><tbody>{"".join(rows)}</tbody></table>' if rows else ''}
    {f'<table class="t ev"><thead><tr><th>When the server says</th><th>Goes to</th></tr></thead><tbody>{ev}</tbody></table>' if ev else ''}
    <div class="from">{'Header: machine name opens Machines, menu opens Settings. ' if header else ''}{'Reached from ' + ', '.join(link(i) for i in inc) + '.' if inc else 'Entry point.'}</div>
  </div>
</article>'''

desk = [('home', 'Home, off', 'off'), ('awake', 'Home, running', 'awake'), ('agents', 'Agents', 'agent'), ('homeedit', 'Settings › Home screen', 'home-edit'), ('usage', 'Usage', 'usage'), ('models', 'Models, one open with its card', 'model-page'), ('endpoints', 'Settings › API endpoints', 'endpoints'), ('appupdate', 'Settings › App update', 'app-update')]
desk_html = ''.join(f'<figure><img src="{webp(f"{H}/../ud/sw/d-{k}.png", 960, 70)}" alt="{esc(t)} on desktop" loading="lazy" width="960" height="600"><figcaption><b>{esc(t)}</b> uses the same content as {link(i)}</figcaption></figure>' for k, t, i in desk)

counts = {s: sum(1 for a in API if a[2] == s) for s in ('Exists', 'Extend', 'New')}
api_rows = ''.join(f'<tr><td><span class="st {s.lower()}">{s}</span></td><td><code>{esc(m)} {esc(p)}</code><div class="purp">{esc(d)}</div></td><td><code>{esc(rq)}</code></td><td><code>{esc(rs)}</code></td><td>{", ".join(u if u.startswith("every") else link(u) for u in used_by(m, p)) or "—"}</td></tr>' for m, p, s, d, rq, rs in API)
types_html = ''.join(f'<div class="type"><div class="thead"><h3>{esc(n)}</h3><code>{esc(src)}</code></div><pre>{esc(body)}</pre></div>' for n, src, body in TYPES)
resolve_html = ''.join(f'<li><span>{esc(c)}</span><b>{" ".join(link(w.strip(",."), w) if w.strip(",.") in ids else esc(w) for w in t.split(" "))}</b></li>' for c, t in RESOLVE)
lanes_html = ''.join(f'<div class="lane"><div class="lname"><b>{esc(n)}</b><span>{esc(LANE_NOTE.get(n, ""))}</span></div><div class="lcards">' + ''.join(f'<button class="node" data-id="{esc(i)}" title="{esc(ids[i]["title"])}"><img src="{thumbs[i]}" alt="" width="84" height="168"><span>{esc(ids[i]["title"])}</span></button>' for i in l) + '</div></div>' for n, l in LANES)
specs_html = ''.join(f'<section class="lanespec"><h2 class="lh">{esc(n)}</h2><p class="ln">{esc(LANE_NOTE.get(n, ""))}</p>' + ''.join(card(ids[i]) for i in l) + '</section>' for n, l in LANES)

page = open(H + '/page.html').read()
for k, v in {'__LANES__': lanes_html, '__EDGES__': json.dumps(edges), '__SPECS__': specs_html, '__API__': api_rows, '__TYPES__': types_html, '__RESOLVE__': resolve_html, '__DESK__': desk_html,
             '__NSCREENS__': str(len(G)), '__NEDGES__': str(len(edges)), '__NLANES__': str(len(LANES)), '__NAPI__': str(len(API)), '__NEXISTS__': str(counts['Exists']), '__NEXTEND__': str(counts['Extend']), '__NNEW__': str(counts['New'])}.items():
    page = page.replace(k, v)
open(H + '/local-ai-build-map.html', 'w').write(page)
print('built', len(page) // 1024, 'KB', len(G), 'screens', len(edges), 'edges')
