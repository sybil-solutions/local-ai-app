// A model card is someone else's Markdown. Every tag in it is dropped, and only this app's own few are written:
// headings, paragraphs, lists, tables, code, bold, links and pictures that point at http(s).
import { esc, raw } from './html.js';

// One pass over the escaped text: what a rule writes is never read again by another rule, so a card can't smuggle
// markup through one into the next.
const RULES = /!\[([^\]]*)\]\((https:\/\/[^)\s]+)\)|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*/g;
// A line longer than this is shown as plain text, and a card longer than MAX is cut: the rules above look ahead, and a
// card made to keep them looking would hold the page still.
const MAX = 40000, LINE = 4000;
const inline = (text) => (text.length > LINE ? esc(text) : esc(text).replace(RULES, (_, alt, src, label, href, code, bold) => (src ? `<img alt="${alt}" src="${src}" loading="lazy">`
  : href ? `<a href="${href}" target="_blank" rel="noopener">${label}</a>` : code ? `<code>${code}</code>` : `<b>${bold}</b>`)));

// The text with every comment and tag taken out, in one pass. A "<" that opens neither stays, and is escaped later.
function untagged(text) {
  let out = '', i = 0, closes = true, ends = true; // whether a ">" and a "-->" are still ahead
  while (i < text.length) {
    const open = text.indexOf('<', i);
    if (open < 0) break;
    out += text.slice(i, open);
    i = open + 1;
    if (text.startsWith('!--', i)) {
      const end = ends ? text.indexOf('-->', i + 3) : -1;
      if (end >= 0) { i = end + 3; continue; }
      ends = false;
    } else if (/[a-zA-Z/]/.test(text[i] || '') && /[a-zA-Z]/.test(text[i] === '/' ? text[i + 1] || '' : text[i])) {
      const end = closes ? text.indexOf('>', i) : -1;
      if (end >= 0) { i = end + 1; continue; }
      closes = false;
    }
    out += '<';
  }
  return out + text.slice(i);
}

export function markdown(text) {
  const out = [];
  let list = null, code = null, table = false, para = [];
  const flush = () => { if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`); if (list) out.push(`</${list}>`); if (table) out.push('</table>'); para = []; list = null; table = false; };
  for (const line0 of untagged(String(text ?? '').slice(0, MAX)).split('\n')) {
    const line = line0.trim(), head = /^(#{1,4})\s+(.*)/.exec(line), li = /^(?:[-*]|(\d+\.))\s+(.*)/.exec(line);
    if (code !== null) { if (line.startsWith('```')) { out.push(`<pre>${esc(code)}</pre>`); code = null; } else code += `${line0}\n`; continue; }
    if (line.startsWith('```')) { flush(); code = ''; } else if (!line) flush();
    else if (head) { flush(); out.push(`<h${head[1].length + 1}>${inline(head[2])}</h${head[1].length + 1}>`); }
    else if (li) { const kind = li[1] ? 'ol' : 'ul'; if (list !== kind) { flush(); out.push(`<${kind}>`); list = kind; } out.push(`<li>${inline(li[2])}</li>`); }
    else if (line.startsWith('|')) {
      if (/^\|[\s:|-]+\|?$/.test(line)) continue;
      const tag = table ? 'td' : 'th';
      if (!table) { flush(); out.push('<table>'); table = true; }
      out.push(`<tr>${line.replace(/^\||\|$/g, '').split('|').map((c) => `<${tag}>${inline(c.trim())}</${tag}>`).join('')}</tr>`);
    } else para.push(line);
  }
  if (code !== null) out.push(`<pre>${esc(code)}</pre>`); // a code block the card never closed
  flush();
  return raw(out.join(''));
}
