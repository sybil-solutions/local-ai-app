// How the page writes HTML. Everything is built with the `html` tag, which escapes whatever is put into a template
// unless it is itself the result of `html` (or of `raw`, for markup this app wrote itself). So text the page is told,
// such as a model's name, a machine's name or an error from another machine, can never become markup, whichever
// component shows it. scripts/screens.mjs checks this for every screen.
class Markup {
  constructor(text) { this.text = text; }
  toString() { return this.text; }
}
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
// What a value becomes inside a template: markup stays, a list is each of its items, nothing and booleans are empty
// (so `${cond && html`...`}` works), and anything else is text.
const put = (v) => (v instanceof Markup ? v.text : Array.isArray(v) ? v.map(put).join('') : v == null || v === false || v === true ? '' : esc(v));
export const html = (parts, ...values) => new Markup(parts.reduce((text, part, i) => text + put(values[i - 1]) + part));
export const raw = (text) => new Markup(String(text));
// Attributes from an object: `true` writes the bare name, `false` and nothing leave it out, the rest are escaped.
export const attrs = (list) => raw(Object.entries(list).filter(([, v]) => v != null && v !== false).map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${esc(v)}"`)).join(''));
// The same for data-* attributes, which is how a button says what it does: { act: 'pick', id: recipe.id }.
export const data = (list = {}) => attrs(Object.fromEntries(Object.entries(list).map(([k, v]) => [`data-${k}`, v])));
