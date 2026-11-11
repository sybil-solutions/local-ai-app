// Pi and Oh My Pi: the running models reach them through an extension the app writes and a list it keeps current.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { at, writeJson } from './util.js';

// Pi and Oh My Pi keep their own config folder, so they stay signed in. The running models reach them through an
// extension the app writes (see syncPi): it registers one provider per model for that run only.
const piExt = at('agents', 'local-ai.js'), piModels = at('agents', 'models.json');
// What a terminal Pi is started with: the extension, and the model by its exact name.
export const piArgs = (t) => ({ env: {}, args: ['-e', piExt, '--model', `${t.key}/${t.model}`] });
// A model whose context length is unknown is given this one.
export const WINDOW = 32768;

// Every running model as a Pi provider. Pi sends at most maxTokens per answer and needs a number, so it gets the
// whole context; Oh My Pi leaves the limit out.
const providersFor = (targets) => Object.fromEntries(targets.map((t) => [t.key, {
  baseUrl: `${t.url}/v1`, apiKey: 'local', api: 'openai-completions',
  models: [{ id: t.model, name: `${t.name} · ${t.device}`, reasoning: true, contextWindow: t.ctx || WINDOW, maxTokens: t.ctx || WINDOW, omitMaxOutputTokens: true,
    input: t.vision ? ['text', 'image'] : ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsDeveloperRole: false } }],
}]));
// The extension reads the model list each time Pi starts, so it is always what is running now. A missing or broken
// list registers nothing, so Pi still starts. It only adds models: which one a session uses is always said outright,
// on the command line for a terminal Pi and by its exact name (la-<machine>-<port>/<model>) for an app that drives Pi.
// Pi's own default is never changed.
const EXTENSION = `// Written by Local AI. Registers each model Local AI is running as a provider. Safe to delete.
import { readFileSync } from 'node:fs';
const read = () => { try { return JSON.parse(readFileSync(${JSON.stringify(piModels)}, 'utf8')); } catch { return {}; } };
export default function (pi) {
  const { providers = {} } = read();
  for (const [id, provider] of Object.entries(providers)) pi.registerProvider(id, provider);
}
`;
const writeExtension = (file) => { if (!existsSync(file) || readFileSync(file, 'utf8') !== EXTENSION) writeFileSync(file, EXTENSION, { mode: 0o600 }); };

// T3 Code starts Pi itself, with Pi's own config folder. Pi loads every extension in that folder's extensions/, so the
// same extension is placed there the first time T3 Code is opened from here. Nothing else of Pi's is touched.
const piHome = () => process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
const piShared = () => join(piHome(), 'extensions', 'local-ai.js');

// The copy in Pi's own folder is kept current only when it is this instance's: one that reads another Local AI's
// list (a second install) is left alone, and one whose list is gone (an install since removed) is taken over.
function sharedIsOurs() {
  if (!existsSync(piShared())) return false;
  const reads = /readFileSync\(("(?:[^"\\]|\\.)*")/.exec(readFileSync(piShared(), 'utf8'))?.[1];
  try { const list = JSON.parse(reads); return list === piModels || !existsSync(list); } catch { return false; }
}

let lastModels = null;
// Keeps the extension's model list equal to what is running.
export function syncPi(targets) {
  const text = JSON.stringify({ providers: providersFor(targets) });
  if (text === lastModels) return;
  mkdirSync(at('agents'), { recursive: true, mode: 0o700 });
  writeJson(piModels, JSON.parse(text));
  writeExtension(piExt);
  if (sharedIsOurs()) writeExtension(piShared());
  lastModels = text;
}

// Puts the extension where Pi itself looks, for an app that starts Pi for you (T3 Code).
export function shareWithPi() {
  mkdirSync(join(piHome(), 'extensions'), { recursive: true, mode: 0o700 });
  writeExtension(piShared());
}
