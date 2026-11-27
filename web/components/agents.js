// Coding agents: the list you open one from, and the page where each shows its version and its one action.
import { attrs, data, html } from '../html.js';
import { newer, outdated, run, runHost, runHosts, s } from '../state.js';
import { Button, Field, Select } from './controls.js';

// mode 'open': a press opens it on the running model. mode 'agent': a press makes it the default, and it can be installed or updated.
function AgentRow(h, mode, host) {
  const failed = h.job?.phase === 'failed', change = data({ act: 'agent', agent: h.id }), why = attrs({ title: h.job?.error || '' });
  if (h.job?.phase === 'running') return html`<div class="item vrow busy"><span><b>${h.name}</b><small>${h.job.kind === 'update' ? 'Updating…' : 'Installing…'}</small></span><i class="instbar"></i></div>`;
  // One that cannot be installed from here is downloaded from its own page.
  if (!h.installed && !h.canInstall) return html`<div class="item vrow"><span class="vpick"><span><b>${h.name}</b><small>Not installed</small></span></span>${h.site && html`<a class="inst vact" href="${h.site}" target="_blank" rel="noopener">Download</a>`}</div>`;
  if (!h.installed) return html`<button class="item vrow"${change}${why}><span><b>${h.name}</b><small>${failed ? 'Couldn’t install' : `Not installed${h.latest ? ` · ${h.latest}` : ''}`}</small></span><span class="inst">${failed ? 'Try again' : 'Install'}</span></button>`;
  // One whose command no longer starts (what it runs with was removed) is installed again over itself.
  if (h.broken) return html`<div class="item vrow"><span class="vpick"><span><b>${h.name}</b><small>${failed ? 'Couldn’t reinstall' : 'Doesn’t start'}</small></span></span>${h.canInstall ? html`<button class="inst vact"${change}${why}>${failed ? 'Try again' : 'Reinstall'}</button>` : h.site && html`<a class="inst vact" href="${h.site}" target="_blank" rel="noopener">Download</a>`}</div>`;
  const isDefault = h.id === host.agent;
  if (mode === 'open') {
    const wrong = run()?.apis && !run().apis.includes(h.needs);
    return html`<button class="item"${data({ act: 'open', agent: h.id })}${attrs({ disabled: !!wrong })}>${h.name}<small>${wrong ? 'Not for this model' : [h.version, isDefault && 'Default'].filter(Boolean).join(' · ')}</small></button>`;
  }
  const label = !h.canUpdate ? '' : failed ? 'Try again' : h.version && h.latest && newer(h.latest, h.version) ? `Update to ${h.latest}` : h.latest ? '' : 'Update';
  // "Up to date" is only said when both its version and the newest one are known.
  const right = label ? html`<button class="inst vact"${change}${why}>${label}</button>` : html`<small>${!h.canUpdate ? 'Updates itself' : h.version && h.latest ? 'Up to date' : ''}</small>`;
  return html`<div class="item vrow"><button class="vpick"${data({ act: 'default', agent: h.id })}><span><b>${h.name}</b><small>${h.version || 'Installed'}${isDefault ? ' · Default' : ''}${failed ? ' · Couldn’t update' : ''}</small></span></button>${right}</div>`;
}
// Where an agent runs: defaults to this computer (where the app is running), and can be switched to any online connected machine.
export const RunOnSelect = () => {
  const hosts = runHosts();
  if (hosts.length < 2) return '';
  return Select({ label: 'Run on', save: 'runon', value: String(runHost().i), options: hosts.map((h) => ({ id: String(h.i), name: h.local ? `This computer (${h.name})` : h.name })) });
};
export const AgentList = (mode) => { const host = runHost().state; return (host?.agents || []).map((h) => AgentRow(h, mode, host)); };
// Under the agents: update them all, where agents open, the folder they open in, and the terminal (asked for only where there is a choice).
export const AgentsFoot = () => {
  const host = runHost().state;
  return html`${outdated().length > 0 && Button({ label: `Update all (${outdated().length})`, act: 'updateall' })}${RunOnSelect()}${Field({ name: 'folder', label: 'Folder', value: s.form.folder ?? (host?.folder || ''), save: 'folder' })}${(host?.terminals || []).length > 1 && Select({ label: 'Terminal', save: 'terminal', value: host.terminal, options: host.terminals })}`;
};
