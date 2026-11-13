// Local preparation only: never contacts or deploys to Cloudflare.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { documentPage, markdown, downloadsPage } from './cloudflare-pages.mjs';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.env.RELEASE_VERSION || JSON.parse(readFileSync(path.join(root, 'package.json'))).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid RELEASE_VERSION');
const out = path.join(root, 'dist/cloudflare');
rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, 'download'), { recursive: true });
cpSync(path.join(root, 'site'), out, { recursive: true });
const homepage = path.join(out, 'index.html');
const homeSource = readFileSync(homepage, 'utf8');
writeFileSync(homepage, homeSource
  .replace(/(<p class="meta">[^<]*Version )\d+\.\d+\.\d+/, `$1${version}`)
  .replaceAll('https://github.com/hamb1y/foxhand/releases/latest', '/download')
  .replaceAll('https://github.com/hamb1y/foxhand/blob/main/CHANGELOG.md', '/changelog')
  .replace('<a href="/changelog">Changelog</a>', '<a href="/changelog">Changelog</a>\n    <a href="/privacy">Privacy</a>')
  .replaceAll('https://hamb1y.github.io/foxhand/sh', 'https://foxhand.pages.dev/download/sh')
  .replaceAll('https://hamb1y.github.io/foxhand/ps', 'https://foxhand.pages.dev/download/ps')
  .replaceAll('https://hamb1y.github.io/foxhand/', 'https://foxhand.pages.dev/'));
const style = /<style>([\s\S]*?)<\/style>/.exec(homeSource)?.[1];
if (!style) throw new Error('Homepage style is missing');
const listing = readFileSync(path.join(root, 'docs/amo-listing.md'), 'utf8');
const policy = /^## Privacy policy\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(listing)?.[1];
if (!policy?.trim()) throw new Error('Privacy policy source is missing');
writeFileSync(path.join(out, 'privacy.html'), documentPage('Privacy policy', markdown('# Privacy policy\n\n' + policy), style));
writeFileSync(path.join(out, 'changelog.html'), documentPage('Changelog', markdown(readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')), style));
writeFileSync(path.join(out, 'download/index.html'), documentPage('Downloads', downloadsPage(version), style));
for (const file of ['extension/icons/icon.svg', 'extension/fonts/GoogleSansFlex-latin.woff2']) cpSync(path.join(root, file), path.join(out, path.basename(file)));
const origin = 'https://foxhand.pages.dev';
const base = `${origin}/download/${version}`;
for (const [source, destination] of [['install.sh', 'sh'], ['install.ps1', 'ps']]) {
  let script = readFileSync(path.join(root, 'scripts', source), 'utf8');
  script = script.replaceAll('https://github.com/hamb1y/foxhand/releases/latest/download', base)
    .replaceAll('https://hamb1y.github.io/foxhand/sh', `${origin}/download/sh`)
    .replaceAll('https://hamb1y.github.io/foxhand/ps', `${origin}/download/ps`)
    .replace('irm $BASE/install.ps1 | iex', String.raw`\$env:FOXHAND_BASE='$BASE'; irm $BASE/install.ps1 | iex`);
  writeFileSync(path.join(out, 'download', destination), script);
}
writeFileSync(path.join(out, 'download/latest.json'), JSON.stringify({ version, base, checksums: `${base}/SHA256SUMS`, source: `https://github.com/hamb1y/foxhand/releases/tag/v${version}` }, null, 2) + '\n');
// Copy bytes verbatim: deploying the website must never alter announcement identity/content.
cpSync(path.join(root, 'popup-endpoint/public/popup.json'), path.join(out, 'announcement.json'));
cpSync(path.join(root, 'cloudflare/worker.mjs'), path.join(out, '_worker.js'));
writeFileSync(path.join(out, '_routes.json'), JSON.stringify({ version: 1, include: ['/download', '/download/*', '/endpoint/*', '/sh', '/ps', '/popup.json'], exclude: [] }, null, 2));
writeFileSync(path.join(out, '_headers'), '/download/sh\n  Content-Type: text/plain; charset=utf-8\n/download/ps\n  Content-Type: text/plain; charset=utf-8\n/download/latest.json\n  Content-Type: application/json; charset=utf-8\n/download/*\n  Cache-Control: no-store\n  X-Content-Type-Options: nosniff\n/announcement.json\n  Cache-Control: no-store\n  Content-Type: application/json; charset=utf-8\n');
// Prevent accidental upload of an oversized asset to Pages.
function check(dir) {
  for (const entry of readdirSync(dir)) {
    const file = path.join(dir, entry), stat = statSync(file);
    if (stat.isDirectory()) check(file);
    else if (stat.size > 25 * 1024 * 1024) throw new Error(`Pages asset exceeds 25 MiB: ${file}`);
  }
}
check(out);
console.log(`Prepared ${out} for release ${version}; no deployment performed.`);
