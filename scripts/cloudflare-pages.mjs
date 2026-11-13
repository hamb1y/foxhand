// Render repository-owned Markdown only; escape HTML and permit HTTPS links.
const escape = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export function inline(text) {
  const tokens = [];
  const token = html => `\u0000${tokens.push(html) - 1}\u0000`;
  return escape(text).replace(/`([^`]+)`/g, (_, code) => token(`<code>${code}</code>`))
    .replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g, (_, label, url) => token(`<a href="${url}">${label}</a>`))
    .replace(/https:\/\/[^\s<]+/g, url => {
      const match = /^(.*?)([.,;:]*)$/.exec(url);
      return token(`<a href="${match[1]}">${match[1]}</a>${match[2]}`);
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\u0000(\d+)\u0000/g, (_, index) => tokens[Number(index)]);
}
export function markdown(source) {
  const lines = source.trim().split('\n'), out = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const heading = /^(#{1,6}) (.+)$/.exec(line);
    if (heading) { const level = heading[1].length; out.push(`<h${level}>${inline(heading[2])}</h${level}>`); i++; continue; }
    if (line.startsWith('|') && /^\|[\s:|-]+\|$/.test(lines[i + 1] || '')) {
      const cells = row => row.replace(/^\||\|$/g, '').split('|').map(cell => inline(cell.trim()));
      const headers = cells(line); i += 2;
      const rows = [];
      while ((lines[i] || '').startsWith('|')) rows.push(`<tr>${cells(lines[i++]).map(cell => `<td>${cell}</td>`).join('')}</tr>`);
      out.push(`<div class="table-scroll"><table><thead><tr>${headers.map(cell => `<th>${cell}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`); continue;
    }
    if (/^- /.test(line)) {
      const items = [];
      while (/^- /.test(lines[i] || '')) {
        let item = lines[i++].slice(2);
        while (/^\s+\S/.test(lines[i] || '')) item += ' ' + lines[i++].trim();
        items.push(`<li>${inline(item)}</li>`);
      }
      out.push(`<ul>${items.join('')}</ul>`); continue;
    }
    const paragraph = [line]; i++;
    while (i < lines.length && lines[i].trim() && !/^(#|\||- )/.test(lines[i])) paragraph.push(lines[i++]);
    out.push(`<p>${inline(paragraph.join(' '))}</p>`);
  }
  return out.join('\n');
}
export function documentPage(title, body, homepageStyle) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · Foxhand</title><meta name="theme-color" content="#0a0a0a"><link rel="icon" href="/icon.svg" type="image/svg+xml">
<style>${homepageStyle.replaceAll('url(GoogleSansFlex-latin.woff2)', 'url(/GoogleSansFlex-latin.woff2)')}
nav { flex-wrap: wrap; height: auto; min-height: 72px; padding-block: 16px; gap: 16px; }
.document { max-width: 850px; padding-top: 32px; padding-bottom: 48px; overflow-wrap: anywhere; }
.document h1 { font-size: clamp(36px,6vw,56px); line-height: 1.1; letter-spacing: -.035em; margin: 20px 0 28px; }
.document h2 { font-size: 28px; margin: 42px 0 16px; }
.document h3 { margin-top: 28px; }
.document p, .document li { color: var(--soft); }
.document li { margin-bottom: 8px; }
.document a { color: var(--orange); }
.document .btn.orange { color: var(--ink); }
.table-scroll { overflow-x: auto; } table { width: 100%; border-collapse: collapse; font-size: 15px; }
th, td { text-align: left; padding: 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
pre { overflow-x: auto; padding: 16px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; }
</style></head><body><div class="wrap"><nav aria-label="Main"><a class="brand" href="/"><img src="/icon.svg" width="28" height="28" alt="">Foxhand</a><a href="/download">Downloads</a><a href="/changelog">Changelog</a><a href="/privacy">Privacy</a></nav></div>
<main class="wrap document">${body}</main><footer><div class="wrap"><a href="/">Home</a><a href="https://github.com/hamb1y/foxhand">Source</a><a href="/download">Downloads</a><a href="/privacy">Privacy</a><a href="/changelog">Changelog</a></div></footer></body></html>\n`;
}
export function downloadsPage(version) {
  const base = `/download/${version}`;
  const rows = [['macOS', 'Apple Silicon (arm64)', 'darwin-arm64'], ['macOS', 'Intel (x64)', 'darwin-x64'], ['Linux', 'arm64', 'linux-arm64'], ['Linux', 'x64', 'linux-x64'], ['Windows', 'arm64', 'windows-arm64.exe'], ['Windows', 'x64', 'windows-x64.exe']];
  return `<h1>Downloads</h1><p>Foxhand ${escape(version)}. Install the Firefox add-on and its companion helper on the same computer.</p>
<h2>Firefox add-on</h2><p><a class="btn orange" href="https://addons.mozilla.org/firefox/addon/foxhand/">Get Foxhand for Firefox</a></p>
<h2>Install the helper</h2><p>The installer selects your platform, verifies the release checksum and registers the helper with Firefox. Review the script before running it.</p>
<h3>macOS, Linux or WSL</h3><pre><code>curl -fsSL https://foxhand.pages.dev/download/sh | sh</code></pre><p><a href="/download/sh">View shell installer</a></p>
<h3>Windows PowerShell</h3><pre><code>irm https://foxhand.pages.dev/download/ps | iex</code></pre><p><a href="/download/ps">View PowerShell installer</a></p>
<h2>Direct release files</h2><p>These links redirect to the original GitHub Release assets; binaries are hosted by GitHub. Choose your computer’s architecture. Downloading a helper binary alone does not register it with Firefox; use the installer above for setup.</p>
<div class="table-scroll"><table><thead><tr><th>Platform</th><th>Architecture</th><th>Helper binary</th></tr></thead><tbody>${rows.map(([os, arch, file]) => `<tr><td>${os}</td><td>${arch}</td><td><a href="${base}/foxhand-host-${file}">Download</a></td></tr>`).join('')}</tbody></table></div>
<p><a href="${base}/SHA256SUMS">SHA256SUMS</a> · <a href="${base}/foxhand.zip">Release add-on archive</a> · <a href="/download/latest.json">Release metadata</a></p><p><a href="/changelog">Read the changelog</a> · <a href="/privacy">Privacy policy</a></p>`;
}
