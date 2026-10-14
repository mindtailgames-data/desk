// A small, safe Markdown renderer for the checker's reports: everything is escaped first, then only headings,
// tables, bold, code and github.com links are formatted. Nothing in a report can become page code.

export const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https:\/\/github\.com\/[^)\s]+)\)/g, (m, t, u) => '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + t + '</a>');
}
const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());

export function render(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n'), out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*\|/.test(l) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const head = cells(l); i++;
      const rows = []; while (i + 1 < lines.length && /^\s*\|/.test(lines[i + 1])) rows.push(cells(lines[++i]));
      out.push('<div class="table"><table><thead><tr>' + head.map(c => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>' +
        rows.map(r => '<tr class="' + (r[0] === '✗' ? 'bad' : r[0] === '!' ? 'warn' : '') + '">' + r.map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>');
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    if (h) { out.push('<h' + (h[1].length + 2) + '>' + inline(h[2]) + '</h' + (h[1].length + 2) + '>'); continue; }
    if (/^\s*[-*]\s+/.test(l)) { const items = [l]; while (i + 1 < lines.length && /^\s*[-*]\s+/.test(lines[i + 1])) items.push(lines[++i]); out.push('<ul>' + items.map(x => '<li>' + inline(x.replace(/^\s*[-*]\s+/, '')) + '</li>').join('') + '</ul>'); continue; }
    if (l.trim()) out.push('<p>' + inline(l) + '</p>');
  }
  return out.join('\n');
}
