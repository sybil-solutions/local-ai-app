// DeepSeek Harness keeps its models in a YAML file it reloads as the file changes, and their keys in a file beside
// it. Opening the Harness from Local AI writes the models Local AI is running into that file, each as a provider of
// its own named as Pi's are (la-<machine>-<port>), and makes the one that was opened the model new conversations
// start on. So the Harness is on that exact model, not on whatever its default was.
//
// Both files are the person's own, written by hand and by the Harness. They are edited as text, in three places
// only: the providers whose names are Local AI's, the two lines that name the default model, and one line for the
// key. Everything else is left byte for byte, and a file that is not laid out as expected is left alone.
import { copyFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const OURS = /^la-(self|\d+)-\d+$/;
// Engines take any key, but the Harness asks every provider for one, by name. This is the name, and its value.
const KEY_NAME = 'LOCAL_AI_API_KEY';

const indent = (line) => line.length - line.trimStart().length;
const quiet = (line) => !line.trim() || line.trimStart().startsWith('#'); // blank, or a comment
const pad = (n) => ' '.repeat(n);
const q = (text) => JSON.stringify(String(text)); // a JSON string is a YAML string

// One entry of the file's top-level list: from its `- id:` line to the line before the next entry. Null when the
// file has none with that id.
function entryOf(lines, id) {
  const start = lines.findIndex((l) => new RegExp(`^- id:\\s*(["']?)${id}\\1\\s*$`).test(l));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith('- ')) end++;
  while (end > start + 1 && quiet(lines[end - 1])) end--; // what is written before the next entry is not this one's
  return { start, end };
}

// The file with an entry added at its end. A new file is an empty list (`[]`), which the entry takes the place of.
// Null when the file is not a plain list of entries.
function appended(text, entry) {
  const lines = text.split('\n'), real = lines.filter((l) => !quiet(l) && indent(l) === 0);
  if (real.some((l) => !l.startsWith('- ') && l.trim() !== '[]')) return null;
  const empty = lines.findIndex((l) => l.trim() === '[]');
  if (empty >= 0) return [...lines.slice(0, empty), ...entry, ...lines.slice(empty + 1)].join('\n');
  return `${text.replace(/\n*$/, '\n')}${entry.join('\n')}\n`;
}

// One model as a provider, its name `at` spaces in.
const provider = (m, at) => [
  `${pad(at)}${m.key}:`, `${pad(at + 2)}displayName: ${q(`${m.title} (Local AI)`)}`, `${pad(at + 2)}apiKeyEnv: ${KEY_NAME}`,
  `${pad(at + 2)}api: openai-completions`, `${pad(at + 2)}baseURL: ${q(`${m.url}/v1`)}`, `${pad(at + 2)}models:`,
  // An answer may be as long as the model's window: no smaller cap is set.
  `${pad(at + 4)}- id: ${q(m.model)}`, `${pad(at + 6)}name: ${q(m.title)}`, `${pad(at + 6)}contextWindow: ${m.ctx}`, `${pad(at + 6)}maxTokens: ${m.ctx}`,
  `${pad(at + 6)}input:`, `${pad(at + 8)}- text`, ...(m.vision ? [`${pad(at + 8)}- image`] : []),
];

// The settings with Local AI's providers replaced by `models` ({ key, model, title, url, ctx, vision }). Providers
// that are not Local AI's keep their place and their text. Null when the providers are not written as expected.
export function withModels(text, models) {
  const lines = text.split('\n'), entry = entryOf(lines, 'llm-pi-ai');
  if (!entry) return appended(text, ['- id: llm-pi-ai', '  name: "@deepseek-ai/dsh-llm-pi-ai"', '  config:', '    providers:', ...models.flatMap((m) => provider(m, 6))]);
  const head = lines.findIndex((l, i) => i > entry.start && i < entry.end && /^\s+providers:\s*$/.test(l));
  if (head < 0) return null;
  let end = head + 1;
  while (end < entry.end && (quiet(lines[end]) || indent(lines[end]) > indent(lines[head]))) end++;
  while (end > head + 1 && quiet(lines[end - 1])) end--;
  const first = lines.slice(head + 1, end).find((l) => !quiet(l)), at = first ? indent(first) : indent(lines[head]) + 2;
  if (at <= indent(lines[head])) return null;
  const kept = [];
  for (let i = head + 1; i < end;) {
    const name = !quiet(lines[i]) && indent(lines[i]) === at ? /^\s*(["']?)([^"'#:\s][^"':]*)\1:\s*$/.exec(lines[i])?.[2] : null;
    let next = i + 1;
    // A provider is its name and everything further in. Blank lines after it go with it; a comment at its own depth does not.
    if (name) while (next < end && (!lines[next].trim() || indent(lines[next]) > at)) next++;
    if (!(name && OURS.test(name))) kept.push(...lines.slice(i, next));
    i = next;
  }
  return [...lines.slice(0, head + 1), ...kept, ...models.flatMap((m) => provider(m, at)), ...lines.slice(end)].join('\n');
}

// The settings with the model new conversations start on set to this provider and model. Null when the entry that
// names it is not written as expected.
export function withDefault(text, key, model) {
  const lines = text.split('\n'), entry = entryOf(lines, 'agent-default-model');
  if (!entry) return appended(text, ['- id: agent-default-model', '  name: "@deepseek-ai/dsh-agent-default-model"', '  config:', `    provider: ${q(key)}`, `    model: ${q(model)}`]);
  const line = (name) => lines.findIndex((l, i) => i > entry.start && i < entry.end && new RegExp(`^\\s+${name}:`).test(l));
  const a = line('provider'), b = line('model');
  if (a < 0 || b < 0) return null;
  lines[a] = `${pad(indent(lines[a]))}provider: ${q(key)}`;
  lines[b] = `${pad(indent(lines[b]))}model: ${q(model)}`;
  return lines.join('\n');
}

// The keys file with Local AI's key in it. `text` is null when there is no file yet. Null when the file is not the
// layout this knows (version 1, keys listed under `refs:`).
export function withKey(text) {
  const ours = `${KEY_NAME}: local`;
  if (text === null) return `version: 1\nrefs:\n  ${ours}\n`;
  if (new RegExp(`^\\s+${KEY_NAME}:\\s*\\S`, 'm').test(text)) return text;
  if (!/^version:\s*1\s*$/m.test(text)) return null;
  const lines = text.split('\n'), refs = lines.findIndex((l) => /^refs:/.test(l));
  if (refs < 0) return text.replace(/^version:\s*1\s*$/m, `version: 1\nrefs:\n  ${ours}`);
  if (!/^refs:\s*$/.test(lines[refs])) return null;
  // The new line is as far in as the keys already there, or the list would no longer be one list.
  const first = lines[refs + 1], at = first !== undefined && !quiet(first) && indent(first) > 0 ? indent(first) : 2;
  return [...lines.slice(0, refs + 1), `${pad(at)}${ours}`, ...lines.slice(refs + 1)].join('\n');
}

// Replaces a file whole, in one step, with the permissions it had (a new one is readable only by its owner).
function replace(file, text) {
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600, next = `${file}.local-ai.tmp`;
  writeFileSync(next, text, { mode });
  renameSync(next, file);
}

// Writes the running models into the Harness's settings and makes `chosen` ({ key, model }) the one it starts on.
// Returns null when done, else why not, as the end of a sentence. The settings as they were before Local AI first
// changed them are kept beside them (cordis.patch.yml.before-local-ai).
export const NOT_SET_UP = 'it has not been set up on this computer yet'; // its first start writes the settings
export function wire(models, chosen) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh'), settings = join(home, 'profiles', 'web', 'cordis.patch.yml'), keys = join(home, '.credentials.yaml');
  if (!existsSync(settings)) return NOT_SET_UP;
  const before = readFileSync(settings, 'utf8'), listed = withModels(before, models), after = listed === null ? null : withDefault(listed, chosen.key, chosen.model);
  if (after === null) return 'its settings file is not laid out the way Local AI expects';
  const had = existsSync(keys) ? readFileSync(keys, 'utf8') : null, keyed = withKey(had);
  if (keyed === null) return 'its keys file is not laid out the way Local AI expects';
  if (keyed !== had) replace(keys, keyed); // the key first, so a provider finds it the moment it appears
  if (after !== before) {
    if (!existsSync(`${settings}.before-local-ai`)) copyFileSync(settings, `${settings}.before-local-ai`);
    replace(settings, after);
  }
  return null;
}
