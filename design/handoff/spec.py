# The technical half of the handoff: what each screen reads, what each control calls, and the API it needs.
# Paths like state.runs[] refer to GET /api/state. "Exists" means the route is in ~/local-ai-sandbox/server today.

API = [
    # method, path, status, purpose, request, response
    ('GET', '/api/state?v=', 'Exists', 'One snapshot of everything on this machine. Long-polls: with v= it waits up to 20 s for a change.', '—', 'State'),
    ('POST', '/api/runs', 'Exists', 'Start a recipe. Downloads weights and the engine image first when missing.', '{ recipe, gpus? }', 'Run'),
    ('DELETE', '/api/runs/:port', 'Exists', 'Stop a run, or cancel one that is still starting or downloading.', '—', '{ ok }'),
    ('GET', '/api/runs/:port/logs?tail=50', 'Exists', 'Last lines of engine output. Shown only next to a failure.', '—', '{ lines[] }'),
    ('POST', '/api/runs/:port/measure', 'Exists', 'Measure C1/C4/C8 speed on a ready run.', '—', '{ ok }'),
    ('GET', '/api/recipe?id=', 'Exists', 'The full recipe, for the editor.', '—', 'Recipe'),
    ('POST', '/api/recipes', 'Exists', 'Save an edited recipe as a local recipe.', 'Recipe', '{ id }'),
    ('DELETE', '/api/recipes?id=', 'Exists', 'Drop local changes and go back to the registry recipe.', '—', '{ id }'),
    ('POST', '/api/refresh', 'Exists', 'Fetch the registry again.', '—', 'Catalog'),
    ('POST', '/api/devices', 'Exists', 'Connect another machine running Local AI.', '{ url, key | code }', 'Device'),
    ('DELETE', '/api/devices?i=', 'Exists', 'Forget a machine.', '—', '{ ok }'),
    ('ANY', '/api/devices/:i/*', 'Exists', 'Every route above, run on another machine. The app talks to remote machines only through this proxy.', 'as the route', 'as the route'),
    ('POST', '/api/open', 'Exists', 'Open an agent pointed at a running model.', '{ device, port, harness, folder }', '{ ok, command? }'),
    ('POST', '/api/settings', 'Extend', 'Saves settings. Today: folder, harness. Add: home, background, autoUpdate, hfToken.', '{ folder?, harness?, home?, background?, autoUpdate?, hfToken? }', '{ ok }'),
    ('GET', '/api/agents', 'New', 'Agents with the installed and newest version. Can also ride in state.harnesses.', '—', 'Agent[]'),
    ('POST', '/api/agents/:id/install', 'New', 'Install an agent with its own installer. Progress shows in state.harnesses[].job.', '—', '{ ok }'),
    ('POST', '/api/agents/:id/update', 'New', 'Update one agent. Update all calls it once per outdated agent.', '—', '{ ok }'),
    ('GET', '/api/usage?span=run|today|month|all', 'New', 'Totals, the cumulative series for the chart, and the split by model. The server already stores tokens per model per day; Today needs hourly buckets and This run needs a per-run counter.', '—', 'Usage'),
    ('GET', '/api/models/card?repo=', 'New', 'The Hugging Face model card: metadata from huggingface.co/api/models/{repo} and README.md, rendered to HTML, sanitized, cached for a day.', '—', 'ModelCard'),
    ('GET', '/api/endpoints', 'New', 'Both addresses and the key. The Tailscale name comes from `tailscale status --json` (Self.DNSName).', '—', 'Endpoints'),
    ('GET', '/api/requests/sources?since=today', 'New', 'Where requests come from: one row per device and app, never the requests themselves.', '—', 'Source[]'),
    ('GET', '/api/tailscale/peers', 'New', 'Machines on the tailnet for Machines › On your Tailscale, with whether each answers as Local AI.', '—', 'Peer[]'),
    ('POST', '/api/devices/install', 'New', 'Install Local AI on a tailnet machine over SSH.', '{ host }', '{ ok }'),
    ('GET', '/api/app/version', 'New', 'This app\'s version, the newest release and its notes.', '—', 'AppVersion'),
    ('POST', '/api/app/update', 'New', 'Download the newest release and restart. Engines run in Docker, so models keep running.', '—', '{ ok }'),
    ('POST', '/api/background', 'New', 'Upload your own picture (JPEG, longest side 2400 px). Settings stores only which picture.', 'image', '{ ok }'),
    ('POST', '/api/docker/start', 'New', 'Start Docker (systemctl on Linux, Docker Desktop elsewhere).', '—', '{ ok }'),
]

TYPES = [
    ('State', 'GET /api/state', '''{
  name, platform, url, v,
  docker: { ok, error },
  gpus: [{ index, name, total, used }],          // MiB
  free: [index],
  groups: [{ card, name, supported, untested,     // untested = the tested card it borrows from
             gpus: [index], tiers: { fastest, balanced, smartest }, recipes: [RecipeView], hidden }],
  runs: [Run],
  usage: { today, week, all, days: [{ d, v }], models: [{ name, in, out, req }] },
  catalog: { source, commit, at, error, count },
  harnesses: [{ id, name, needs, installed }],    // extend: version, latest, job
  folder, harness, last,
  devices: [{ i, name, url, online, error, state: State }],
  events: [{ at, level, kind, ... }]
}'''),
    ('Run', 'state.runs[]', '''{
  id,               // the port it serves on
  recipe, name, gpus: [index], since,
  phase,            // queued · weights · image · starting · testing · ready · unresponsive · stopping · failed
  detail, progress, // progress 0..1 while phase = weights
  error, failure: { word, line },
  view: { word, line, p },
  apis: { openai, responses, anthropic },
  stats: { tps, prefill, tokens }
}'''),
    ('RecipeView', 'state.groups[].recipes[]', '''{ id, name, engine, ctx, cards, tps, smart, vision, think, tools, kv,
  speed: { c1, c4, c8, measured, ttft }, sizeGb, released, local }'''),
    ('Agent', 'GET /api/agents', '''{ id, name, installed, version, latest, isDefault,
  job: null | { kind: 'install' | 'update', phase: 'running' | 'failed', error } }'''),
    ('Usage', 'GET /api/usage', '''{ span, tokens, generated, requests, since, label,
  series: [{ at, cumulative }],                   // chart: run = minutes, today = hours, month/all = days
  byModel: [{ name, tokens, requests }],
  days: [{ d, tokens, requests }] }               // calendar; days, weeks and months group on the client'''),
    ('ModelCard', 'GET /api/models/card', '''{ repo, license, downloads, likes, updated, html }   // 404 when the model has no card'''),
    ('Endpoints', 'GET /api/endpoints', '''{ local: "http://127.0.0.1:<port>/v1", tailnet: "http://<host>.<tailnet>.ts.net:<port>/v1" | null,
  key: "sk-local-…3f9a", apis: { openai_chat, responses, anthropic } }'''),
    ('Source', 'GET /api/requests/sources', '''{ device,            // tailscale whois name, else the IP
  ip, app,           // from User-Agent when the engine logs it, else "Unknown app"
  requests, last, onTailnet }'''),
    ('AppVersion', 'GET /api/app/version', '''{ current, latest, notes: [string], auto, phase: idle | downloading | restarting | failed, error }'''),
]

# What each screen shows, and where it comes from.
SHOWS = {
    'off': 'Machine name (state.name). Three picks from state.groups[].tiers, the chosen one from state.last. Line: load time from the recipe\'s last load (speed.loadSeconds), or "Made for X · untested here" when groups[].untested is set. Home widgets in the order of settings.home.',
    'waking': 'The starting run: runs[].view.word and line, progress bar from runs[].view.p. Phases queued, image, starting and testing all show this screen.',
    'awake': 'Ready run: runs[].stats (decode and prefill tok/s), session tokens, lifetime tokens from usage.all. Open uses state.harness.',
    'chooser': 'Installed agents (harnesses[]), default marked. Missing ones offer Install.',
    'opened': 'As Running, line says which agent is open.',
    'runthis': 'The command from POST /api/open when no terminal could be opened (response.command).',
    'sleeping': 'Run in phase stopping.',
    'boot': 'Before the first state arrives.',
    'first': 'Like Off, but the chosen recipe\'s weights are not on disk; line shows the download size (sizeGb).',
    'dl': 'Run in phase weights: detail ("12 of 63 GB") and progress.',
    'netwait': 'Run in phase weights after a network error; it resumes on its own.',
    'checking': 'Run in phase weights while verifying checksums.',
    'adv-models': 'Every runnable recipe for this machine (groups[].recipes), newest first, with capability icons.',
    'model-page': 'One RecipeView, plus its Hugging Face card from GET /api/models/card (repo from catalog.models[model].hf, else the base model).',
    'edit': 'GET /api/recipe for the selected recipe: context, GPUs, requests at once, KV cache, extra arguments.',
    'settings': 'General list. Footer: app version and update from GET /api/app/version.',
    'background': 'The four choices, the chosen one from settings.background, a thumbnail of each.',
    'app-update': 'GET /api/app/version: newest version, notes, the auto-update switch.',
    'app-updating': 'AppVersion.phase downloading or restarting.',
    'app-fail': 'AppVersion.phase failed, with error.',
    'home-edit': 'settings.home: the order of all five blocks and which are on.',
    'agent': 'GET /api/agents: version here, newest version, default, install and update jobs. Folder from state.folder.',
    'machines': 'Connected: state.devices (+ this machine). On your Tailscale: GET /api/tailscale/peers, offline peers with last seen.',
    'addmachine': 'Host and pairing code typed by the user.',
    'advanced': 'Advanced list. Same footer as General.',
    'endpoints': 'GET /api/endpoints and GET /api/requests/sources?since=today.',
    'usage': 'GET /api/usage for the chosen span; the calendar from Usage.days.',
    'logs': 'GET /api/runs/:port/logs?tail=50 for the failed run.',
    'registry': 'state.catalog: source, commit, recipe count, when scores were taken.',
    'hf-token': 'Whether a token is saved (masked). The token never comes back from the server in full.',
    'm-connect': 'POST /api/devices in flight.',
    'm-install': 'The peer answered SSH but has no Local AI.',
    'm-installing': 'POST /api/devices/install in flight.',
    'm-linked': 'The new device from state.devices.',
    'nogpu': 'state.gpus is empty. Offers another connected machine that has models.',
    'needsdocker': 'state.docker.error says Docker is not installed.',
    'dockeroff': 'state.docker.ok is false and Docker is installed.',
    'nothing': 'GPUs exist but no group has recipes, even borrowed. Offers another connected machine.',
    'busy': 'All of the card\'s GPUs are in use by something else (state.free is short and no run of ours holds them).',
    'needs': 'The chosen recipe needs more free GPUs than state.free has.',
    'cantconnect': 'GET /api/state is failing; the app retries.',
    'unreachable': 'A device in state.devices with online = false.',
    'key': 'The page was opened from another device without the key; requests answer 401.',
}
for k, v in {'room': 'Ran out of room', 'quit': 'Stopped', 'never': 'Never woke up', 'noengine': 'No engine', 'locked': 'Locked model', 'space': 'Not enough space', 'damaged': 'Download damaged', 'noconn': 'No connection'}.items():
    SHOWS[k] = f'Run in phase failed with failure.word "{v}" (engine.js FAILURES). Engine output link opens the last 50 lines.'
SHOWS['noreply'] = 'Run in phase unresponsive: no answer to health checks; line from the last time it was heard.'
SHOWS['slow'] = 'Run still starting after its usual load time (elapsed > loadSeconds).'
for k in ['p-get', 'p-data', 'p-dl', 'p-off', 'p-waking', 'p-ready', 'p-chat', 'p-hot', 'p-paused', 'p-space', 'p-small']:
    SHOWS[k] = 'Phone app. Runs one small model on the phone itself (on-device runtime), not through the server. Use pop-os switches to a desktop machine through /api/devices.'

# Which run phase or condition puts the app on a screen. Order matters: first match wins.
RESOLVE = [
    ('GET /api/state fails', 'cantconnect'),
    ('Answer is 401 (opened from another device)', 'key'),
    ('Chosen device has online = false', 'unreachable'),
    ('AppVersion.phase is downloading or restarting', 'app-updating'),
    ('docker.ok is false: not installed', 'needsdocker'),
    ('docker.ok is false: installed but stopped', 'dockeroff'),
    ('gpus is empty', 'nogpu'),
    ('No group has recipes', 'nothing'),
    ('A run of ours: phase weights', 'dl, netwait or checking (by detail)'),
    ('A run of ours: queued, image, starting, testing', 'waking, then slow once past its usual load time'),
    ('A run of ours: ready', 'awake, or opened after Open'),
    ('A run of ours: unresponsive', 'noreply'),
    ('A run of ours: stopping', 'sleeping'),
    ('A run of ours: failed', 'room, quit, never, noengine, locked, space, damaged or noconn, by failure.word'),
    ('Chosen recipe needs more free GPUs than are free', 'needs, or busy when another program holds them'),
    ('Chosen recipe\'s weights not on disk', 'first'),
    ('Otherwise', 'off'),
]

PHASES = ['queued', 'weights', 'image', 'starting', 'testing', 'ready', 'stopping']


def api_for(frame, c):
    """The call a control makes, or '' when it only moves between screens."""
    a, to, f = c['attrs'], c['to'], frame
    if c['label'] == 'Close' or c['label'].startswith('Machine:') or c['label'] == 'Settings': return ''
    if 'install' in a: return 'POST /api/agents/:id/install'
    if 'upd' in a: return 'POST /api/agents/:id/update'
    if 'updall' in a: return 'POST /api/agents/:id/update (each)'
    if 'copy' in a: return 'Clipboard'
    if 'bg' in a: return 'POST /api/settings { background }' + (' + POST /api/background' if a['bg'] == 'own' else '')
    if 'wtoggle' in a: return 'POST /api/settings { home }'
    if 'uspan' in a: return 'GET /api/usage?span=' + a['uspan']
    if 'period' in a: return 'Client: regroup Usage.days'
    if 'appauto' in a: return 'POST /api/settings { autoUpdate }'
    if 'appdone' in a: return 'Server event: AppVersion.phase → idle'
    if 'tier' in a: return 'Client: choose pick'
    if 'all' in a: return 'Client: choose recipe'
    if 'exp' in a: return 'Client: show details'
    if 'use' in a: return 'Client: switch machine (routes go through /api/devices/:i/*)'
    if 'agent' in a and f == 'agent': return 'POST /api/settings { harness }'
    if 'agent' in a: return 'POST /api/open'
    if 'adv' in a: return 'GET /api/models/card'
    if 'cell' in a: return ''
    if to == 'opened': return 'POST /api/open'
    if to in ('waking', 'dl') and f not in ('slow',): return 'POST /api/runs { recipe }'
    if to == 'sleeping': return 'DELETE /api/runs/:port'
    if f in ('waking', 'slow', 'dl', 'netwait') and to in ('off', 'first'): return 'DELETE /api/runs/:port'
    if to == 'logs': return 'GET /api/runs/:port/logs?tail=50'
    if to == 'm-connect' and f in ('addmachine', 'machines', 'unreachable'): return 'POST /api/devices'
    if to == 'm-installing': return 'POST /api/devices/install'
    if to == 'app-updating': return 'POST /api/app/update'
    if f == 'registry' and to == 'registry': return 'POST /api/refresh'
    if f == 'edit' and c['label'] == 'Save': return 'POST /api/recipes'
    if f == 'edit' and c['label'] == 'Reset': return 'DELETE /api/recipes?id='
    if f == 'hf-token' and c['label'] == 'Save': return 'POST /api/settings { hfToken }'
    if f == 'hf-token': return 'POST /api/settings { hfToken: null }'
    if f == 'dockeroff' and to == 'off': return 'POST /api/docker/start'
    if f == 'needsdocker': return 'Opens the Docker install page'
    if f == 'key' and to == 'off': return 'Client: keep key, retry GET /api/state'
    if to == 'model-page': return 'GET /api/models/card'
    if f.startswith('p-') and to in ('p-dl', 'p-waking', 'p-off', 'p-ready', 'p-get'): return 'Phone runtime'
    return ''
