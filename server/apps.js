// Agents that are desktop apps, not terminal programs: each is opened on a model in its own way.
import * as dsh from './dsh.js';
import { shareWithPi, syncPi, WINDOW } from './pi.js';
import { launched, q } from './shell.js';
import { config, event, fail, run, saveConfig } from './util.js';

// A model as an app's own list shows it: "glm-5.3-flash · workstation".
const titleOf = (t) => `${t.name} · ${t.device}`;

// T3 Code: a thread is started on this exact model. T3 Code runs Pi itself and keeps a model for every thread, so
// Pi is given the extension (which lists the model as la-<machine>-<port>/<model>) and the thread is asked for under
// that name, with Pi as its provider. Nothing is left to "Pi default", which would be T3 Code's choice of model, not
// this one. A thread has to begin with a message, so it begins by asking the model to say it is there: the answer
// is the proof that the thread is on the model and the model works.
const T3_PROVIDER = 'pi';
export async function openT3(bin, target, folder, targets) {
  shareWithPi();
  syncPi(targets);
  if (config.prefer) { delete config.prefer; saveConfig(); } // older versions kept a model here for "Pi default" to pick up
  const model = `${target.key}/${target.model}`, title = titleOf(target);
  const hello = `Local AI opened this thread on ${target.name}, running on ${target.device}. Reply with one short line to say you are ready.`;
  const start = () => run(bin, ['thread', 'start', folder, hello, '--provider', T3_PROVIDER, '--model', model, '--title', title, '--json'], { timeout: 60000 });
  const said = (out) => (out.stderr.trim() || out.stdout.trim()).split('\n').pop().slice(0, 200);
  let started = await start();
  // A folder T3 Code has not seen yet is added as a project first.
  if (started.code && /No T3 Code project matches/.test(`${started.stdout}${started.stderr}`) && !(await run(bin, ['project', 'add', folder], { timeout: 30000 })).code) started = await start();
  let thread = null;
  try { thread = JSON.parse(started.stdout.trim().split('\n').pop()).threadId || null; } catch { /* it did not start: said below */ }
  const shown = await run(bin, ['app', folder], { timeout: 30000 });
  if (!thread && shown.code) fail(502, `T3 Code did not open: ${said(shown) || 'is it running?'}`);
  event(thread ? 'info' : 'warn', 'harness.open', { agent: 't3', model, thread, opened: true, ...(thread ? {} : { error: said(started) }) });
  const command = `${q(bin)} thread start ${q(folder)} ${q(hello)} --provider ${T3_PROVIDER} --model ${q(model)}`;
  return { opened: true, command, thread, note: thread ? `A T3 Code thread is open on ${title} (Pi, ${model})` : `T3 Code is open, but no thread could be started: ${said(started) || 'it gave no reason'}. Start one there and choose Pi, then ${model}` };
}

// DeepSeek Harness: the running models are written into its settings as providers named as Pi's are, and the one
// opened becomes the model its new conversations start on (see dsh.js). Then the app is opened.
// Returns why that could not be done, or null. The `dsh` command (no app) reads the same files.
export function wireDsh(target, targets) {
  const models = targets.filter((t) => !t.apis || t.apis.includes('chat')).map((t) => ({ key: t.key, model: t.model, title: titleOf(t), url: t.url, ctx: t.ctx || WINDOW, vision: !!t.vision }));
  try { return dsh.wire(models, { key: target.key, model: target.model }) || null; } catch (e) { return e.message; }
}
export async function openDsh(bundle, target, _folder, targets) {
  const why = wireDsh(target, targets);
  const opened = await launched('open', [bundle]);
  event(opened && !why ? 'info' : 'warn', 'harness.open', { agent: 'dsh', model: `${target.key}/${target.model}`, opened, ...(why ? { error: why } : {}) });
  if (!opened) fail(502, 'DeepSeek Harness did not open');
  return { opened: true, command: `open ${q(bundle)}`, note: why ? `DeepSeek Harness is open, but ${target.name} could not be added to it: ${why}. Add ${target.url}/v1 there by hand` : `DeepSeek Harness now starts new conversations on ${titleOf(target)} (${target.key}, ${target.model})` };
}
