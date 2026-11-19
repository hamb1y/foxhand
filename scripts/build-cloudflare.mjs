// Local preparation only: never contacts or deploys to Cloudflare.
import { cpSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { documentPage, markdown, downloadsPage, loginBody, loginScript, statsBody, feedbackBody, uninstalledBody } from './cloudflare-pages.mjs';
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
  .replace(/(<p class="meta">[^<]*Version )\d+\.\d+\.\d+/, `$1${version}`));
const style = /<style>([\s\S]*?)<\/style>/.exec(homeSource)?.[1];
if (!style) throw new Error('Homepage style is missing');
const listing = readFileSync(path.join(root, 'docs/amo-listing.md'), 'utf8');
const policy = /^## Privacy policy\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(listing)?.[1];
if (!policy?.trim()) throw new Error('Privacy policy source is missing');
writeFileSync(path.join(out, 'privacy.html'), documentPage('Privacy policy', markdown('# Privacy policy\n\n' + policy), style));
writeFileSync(path.join(out, 'changelog.html'), documentPage('Changelog', markdown(readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')), style));
writeFileSync(path.join(out, 'download/index.html'), documentPage('Downloads', downloadsPage(version), style));
const page = file => readFileSync(path.join(root, 'cloudflare/pages', file), 'utf8');
// Stats pages: served by the Worker with a per-request nonce. Feedback pages are plain static files.
for (const [dir, title, body, script] of [['stats', 'Stats', statsBody(), page('stats.js')], ['stats/login', 'Stats', loginBody(), loginScript]]) {
  mkdirSync(path.join(out, dir), { recursive: true });
  writeFileSync(path.join(out, dir, 'index.html'), documentPage(title, body, style, { nonce: true, script, robots: true }));
}
writeFileSync(path.join(out, 'feedback.html'), documentPage('Feedback', feedbackBody(), style, { script: page('form.js') }));
writeFileSync(path.join(out, 'uninstalled.html'), documentPage('Uninstalled', uninstalledBody(), style, { script: page('form.js'), robots: true }));
for (const file of ['extension/icons/icon.svg', 'extension/fonts/GoogleSansFlex-latin.woff2']) cpSync(path.join(root, file), path.join(out, path.basename(file)));
const origin = 'https://foxhand.pages.dev';
const base = `${origin}/download/${version}`;
for (const [source, destination] of [['install.sh', 'sh'], ['install.ps1', 'ps']]) {
  let script = readFileSync(path.join(root, 'scripts', source), 'utf8');
  // The copies served here are pinned to this release; the scripts in the repo follow /download/latest.
  if (!script.includes(`${origin}/download/latest`)) throw new Error(`${source} has no default download base to pin`);
  script = script.replaceAll(`${origin}/download/latest`, base)
    .replace('irm $BASE/install.ps1 | iex', String.raw`\$env:FOXHAND_BASE='$BASE'; irm $BASE/install.ps1 | iex`);
  writeFileSync(path.join(out, 'download', destination), script);
}
writeFileSync(path.join(out, 'download/latest.json'), JSON.stringify({ version, base, checksums: `${base}/SHA256SUMS`, source: `https://github.com/hamb1y/foxhand/releases/tag/v${version}` }, null, 2) + '\n');
// Copy bytes verbatim: deploying the website must never alter announcement identity/content.
cpSync(path.join(root, 'popup-endpoint/public/popup.json'), path.join(out, 'announcement.json'));
cpSync(path.join(root, 'cloudflare/worker.mjs'), path.join(out, '_worker.js'));
// Pages redirects static .html URLs to extensionless paths. Google needs the exact URL.
const verificationFiles = readdirSync(out).filter(name => /^google[0-9a-f]+\.html$/.test(name));
for (const name of verificationFiles) renameSync(path.join(out, name), path.join(out, name + '.txt'));
writeFileSync(path.join(out, '_routes.json'), JSON.stringify({ version: 1, include: ['/download', '/download/*', '/endpoint/*', '/stats', '/stats/*', '/go/*', '/sh', '/ps', '/popup.json', ...verificationFiles.map(name => '/' + name)], exclude: [] }, null, 2));
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
