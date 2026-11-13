// Dev preview server: localhost only, static files only, nothing is proxied or published.
//   node dev-preview/serve.mjs [--port 8840] [--no-prepare]
//
//   /                  the built website (dist/cloudflare), as Cloudflare Pages would serve it
//   /_site-before/     the website as in git HEAD, for comparison
//   /_ext/<page>       the REAL extension page, with dev-preview/fixture.js injected (fake browser APIs)
//   /_ext-before/<p>   the same for the extension as in git HEAD
//   /_review/          the review gallery
import http from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare } from './prepare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
export const PORT = Number(arg('--port', 8840));

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.woff2': 'font/woff2',
  '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
const MOUNTS = [
  ['/_review/', here, { fixturePages: false }],
  ['/_ext-before/', path.join(here, 'before/extension'), { fixture: true }],
  ['/_ext/', path.join(root, 'extension'), { fixture: true }],
  ['/_site-before/', path.join(here, 'before/dist/cloudflare'), { prefixLinks: '/_site-before' }],
  ['/', path.join(root, 'dist/cloudflare'), {}]
];

function resolveFile(dir, rel) {
  const full = path.resolve(dir, rel);
  if (full !== dir && !full.startsWith(dir + path.sep)) return null;      // no path traversal
  for (const c of [full, full + '.html', path.join(full, 'index.html')]) {
    try { if (statSync(c).isFile()) return c; } catch { /* next */ }
  }
  return null;
}

export function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { res.writeHead(400).end('bad request'); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end('method not allowed'); return; }

    // Locale messages + announcement as a script (the announcement page's CSP forbids XHR but allows same-origin scripts).
    if (pathname === '/_review/fixture-data.js') {
      const mountName = ['_ext', '_ext-before'].includes(url.searchParams.get('root')) ? url.searchParams.get('root') : '_ext';
      const lang = ['en', 'de', 'es', 'fr', 'zh_CN'].includes(url.searchParams.get('lang')) ? url.searchParams.get('lang') : 'en';
      const dir = mountName === '_ext' ? path.join(root, 'extension') : path.join(here, 'before/extension');
      const data = {
        messages: JSON.parse(readFileSync(path.join(dir, '_locales', lang, 'messages.json'), 'utf8')),
        announcement: JSON.parse(readFileSync(path.join(root, 'popup-endpoint/public/popup.json'), 'utf8'))
      };
      res.writeHead(200, { 'Content-Type': TYPES['.js'], 'Cache-Control': 'no-store' });
      res.end('window.__FX = ' + JSON.stringify(data) + ';');
      return;
    }
    const mount = MOUNTS.find(([prefix]) => pathname === prefix.slice(0, -1) || pathname.startsWith(prefix));
    if (!mount) { res.writeHead(404).end('not found'); return; }
    const [prefix, dir, opts] = mount;
    if (pathname === prefix.slice(0, -1) && prefix !== '/') { res.writeHead(302, { Location: prefix }).end(); return; }
    const file = resolveFile(dir, pathname.slice(prefix.length));
    if (!file) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found: ' + pathname + (existsSync(dir) ? '' : ' (run: node dev-preview/prepare.mjs)')); return; }
    const ext = path.extname(file);
    let body = readFileSync(file);
    let type = TYPES[ext] || 'application/octet-stream';
    if (ext === '.html' && (opts.fixture || opts.prefixLinks)) {
      let html = body.toString('utf8');
      if (opts.fixture) {
        const data = `/_review/fixture-data.js?root=${prefix.slice(1, -1)}&lang=${encodeURIComponent(url.searchParams.get('lang') || 'en')}`;
        html = html.replace(/<head>/i, `<head><script src="${data}"></script><script src="/_review/fixture.js"></script>`);
      }
      if (opts.prefixLinks) html = html.replace(/(href|src)="\/(?!\/)/g, `$1="${opts.prefixLinks}/`);
      body = Buffer.from(html);
    }
    // Served download scripts are plain text, never executed by this server.
    if (/\/download\/(sh|ps)$/.test(pathname)) type = 'text/plain; charset=utf-8';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--no-prepare')) prepare();
  createServer().listen(PORT, '127.0.0.1', () => {
    console.log(`Foxhand UX preview (local only, nothing is published)\n  gallery  http://localhost:${PORT}/_review/\n  website  http://localhost:${PORT}/`);
  });
}
