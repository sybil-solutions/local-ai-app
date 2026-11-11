// A model card is someone else's Markdown. Every tag in it is dropped, and only this app's own few are written:
// headings, paragraphs, lists, tables, code, bold, links and pictures that point at http(s).
import { esc, raw } from './html.js';

// One pass over the escaped text: what a rule writes is never read again by another rule, so a card can't smuggle
// markup through one into the next.
const RULES = /!\[([^\]]*)\]\((https:\/\/[^)\s]+)\)|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*/g;
const inline = (text) => esc(text).replace(RULES, (_, alt, src, label, href, code, bold) => (src ? `<img alt="${alt}" src="${src}" loading="lazy">`
  : href ? `<a href="${href}" target="_blank" rel="noopener">${label}</a>` : code ? `<code>${code}</code>` : `<b>${bold}</b>`));

export function markdown(text) {
  const out = [];
  let list = null, code = null, table = false, para = [];
  const flush = () => { if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`); if (list) out.push(`</${list}>`); if (table) out.push('</table>'); para = []; list = null; table = false; };
  for (const line0 of String(text).replace(/<!--[\s\S]*?-->/g, '').replace(/<\/?[a-zA-Z][^>]*>/g, '').split('\n')) {
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
