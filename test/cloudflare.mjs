import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkRelease } from '../scripts/check-cloudflare-release.mjs';
import { inline, markdown } from '../scripts/cloudflare-pages.mjs';
import worker from '../cloudflare/worker.mjs';
import vm from 'node:vm';

execFileSync(process.execPath, ['scripts/build-cloudflare.mjs']);
const text = file => readFileSync(`dist/cloudflare/${file}`, 'utf8');
const latest = JSON.parse(text('download/latest.json'));
assert.match(latest.base, /^https:\/\/foxhand.pages.dev\/download\/\d+\.\d+\.\d+$/);
assert.equal(text('announcement.json'), readFileSync('popup-endpoint/public/popup.json', 'utf8'));
assert.match(text('download/sh'), new RegExp(latest.base.replaceAll('.', '\\.')));
assert.match(text('download/ps'), new RegExp(latest.base.replaceAll('.', '\\.')));
assert.ok(text('download/sh').includes(String.raw`\$env:FOXHAND_BASE='$BASE'; irm $BASE/install.ps1 | iex`), 'WSL propagates its pinned base to the Windows installer');
assert.ok(!text('_headers').includes("default-src 'none'"), 'website inline code remains usable');
assert.match(text('_headers'), /Content-Type: text\/plain/);
assert.match(text('index.html'), /https:\/\/foxhand.pages.dev\/download\/sh/);
// Link previews: the og tags must name the live site and an image the build really ships.
assert.ok(text('index.html').includes('<meta property="og:url" content="https://foxhand.pages.dev/">'));
assert.ok(text('index.html').includes('<meta property="og:image" content="https://foxhand.pages.dev/shots/og.jpg">'));
assert.ok(readFileSync('dist/cloudflare/shots/og.jpg').length > 0);
assert.ok(!text('index.html').includes('hamb1y.github.io'), 'no legacy Pages URLs in the built homepage');
execFileSync('sh', ['-n', 'dist/cloudflare/download/sh']);
const env = {
  ASSETS: { async fetch(request) {
    const name = new URL(request.url).pathname.slice(1);
    if (name === 'announcement.json') return new Response(text(name));
    if (name === 'download/') return new Response(text('download/index.html'));
    if (name === 'download/latest.json') return Response.json(latest);
    return new Response('website');
  } }
};
const request = (url, options) => worker.fetch(new Request(`https://foxhand.pages.dev${url}`, options), env);
for (const os of ['darwin', 'linux', 'windows']) for (const arch of ['arm64', 'x64']) for (const prefix of ['foxhand', 'webmcp']) {
  const name = `${prefix}-host-${os}-${arch}${os === 'windows' ? '.exe' : ''}`;
  for (const method of ['GET', 'HEAD']) {
    const response = await request(`/download/0.5.7/${name}`, { method, headers: { Range: 'bytes=2-5' } });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('Location'), `https://github.com/hamb1y/foxhand/releases/download/v0.5.7/${name}`);
    assert.equal(response.headers.get('Cache-Control'), 'public, max-age=300');
    assert.equal(await response.text(), '');
  }
}
for (const name of ['SHA256SUMS', 'install.sh', 'install.ps1', 'foxhand.zip']) assert.equal((await request(`/download/0.5.7/${name}`)).status, 302);
let response;
response = await request('/download/latest/foxhand-host-darwin-arm64');
assert.equal(response.status, 302);
assert.equal(response.headers.get('Location'), `/download/${latest.version}/foxhand-host-darwin-arm64`);
assert.equal(response.headers.get('Cache-Control'), 'no-store');
response = await request('/endpoint/announcement');
assert.equal(response.headers.get('Cache-Control'), 'no-store');
assert.deepEqual(await response.json(), JSON.parse(text('announcement.json')));
for (const url of ['/download/0.5.7/evil.exe', '/download/0.5.7/https%3A%2F%2Fevil.test', '/download/v0.5.7/SHA256SUMS', '/download/0.5.7/foxhand-host-darwin-arm64/extra']) assert.equal((await request(url)).status, 404);
assert.equal((await request('/download/nope/foxhand-host-darwin-arm64')).status, 404);
assert.equal((await request('/download/latest.json/extra')).status, 404);
assert.equal((await request('/download/0.5.7/evil')).status, 404);
assert.equal((await request('/download/0.5.7/foxhand-host-darwin-arm64', { method: 'POST' })).status, 405);
for (const route of ['/download/sh', '/download/ps', '/download/latest.json']) {
  const response = await request(route);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.match(response.headers.get('Content-Type'), route.endsWith('.json') ? /application\/json/ : /text\/plain/);
}
assert.match(await (await request('/download')).text(), /<h1>Downloads<\/h1>/);
assert.match(await (await request('/download/')).text(), /hosted by GitHub/);
// Execute the generated WSL branch with fake platform tools: no Windows host is touched.
const wsl = mkdtempSync(path.join(tmpdir(), 'foxhand-wsl-'));
try {
  writeFileSync(path.join(wsl, 'grep'), '#!/bin/sh\nexit 0\n');
  writeFileSync(path.join(wsl, 'powershell.exe'), '#!/bin/sh\nprintf \'%s\\n\' "$@"\n');
  for (const name of ['grep', 'powershell.exe']) chmodSync(path.join(wsl, name), 0o755);
  const output = execFileSync('sh', ['dist/cloudflare/download/sh'], { encoding: 'utf8', env: { ...process.env, PATH: `${wsl}:${process.env.PATH}`, FOXHAND_BASE: latest.base, FOXHAND_FORCE: '', WEBMCP_FORCE: '' } });
  assert.ok(output.includes(`$env:FOXHAND_BASE='${latest.base}'; irm ${latest.base}/install.ps1 | iex`));
} finally { rmSync(wsl, { recursive: true, force: true }); }
// Metadata validation is deliberately not a claim to have checked binary bytes.
const names = ['SHA256SUMS', 'install.sh', 'install.ps1', 'foxhand.zip'];
for (const os of ['darwin', 'linux', 'windows']) for (const arch of ['arm64', 'x64']) for (const prefix of ['foxhand', 'webmcp']) names.push(`${prefix}-host-${os}-${arch}${os === 'windows' ? '.exe' : ''}`);
const release = { tagName: 'v0.5.7', isDraft: false, assets: names.map(name => ({ name, size: 1, state: 'uploaded' })) };
assert.equal(checkRelease(release, '0.5.7').length, 16);
assert.throws(() => checkRelease({ ...release, isDraft: true }, '0.5.7'));
assert.throws(() => checkRelease({ ...release, assets: release.assets.slice(1) }, '0.5.7'));
assert.throws(() => checkRelease(release, '0.5.8'));
assert.ok(!inline('<script>alert(1)</script>').includes('<script>'));
assert.ok(!inline('[bad](javascript:alert(1))').includes('href='));
assert.match(markdown('| A | B |\n|---|---|\n| C | D |'), /<table>/);
const sourceHome = readFileSync('site/index.html', 'utf8');
try {
  execFileSync(process.execPath, ['scripts/build-cloudflare.mjs'], { env: { ...process.env, RELEASE_VERSION: '9.8.7' } });
  const home = text('index.html');
  assert.match(home, /Version 9\.8\.7/);
  assert.equal(home.match(/alt="[^"]*v0\.5\.4[^"]*"/g)?.length, sourceHome.match(/alt="[^"]*v0\.5\.4[^"]*"/g)?.length, 'historical screenshot descriptions stay intact');
  for (const route of ['/privacy', '/changelog', '/download']) assert.ok(home.includes(`href="${route}"`));
  assert.match(text('download/index.html'), /download\/9\.8\.7\/foxhand-host-darwin-arm64/);
  assert.match(text('download/index.html'), /download\/9\.8\.7\/SHA256SUMS/);
  assert.match(text('changelog.html'), /<h2>0\.5\.7<\/h2>/);
  assert.match(text('changelog.html'), /<table>/);
  assert.match(text('privacy.html'), /Foxhand does not send browsing data/);
  assert.match(text('privacy.html'), /https:\/\/foxhand-popup-endpoint.pages.dev\/popup.json/);
  assert.ok(!text('privacy.html').includes('Notes to reviewer'));
  for (const page of ['privacy.html', 'changelog.html', 'download/index.html']) {
    assert.match(text(page), /--orange: #FF7139/);
    assert.match(text(page), /url\(\/GoogleSansFlex-latin.woff2\)/);
  }
  assert.equal(readFileSync('site/index.html', 'utf8'), sourceHome, 'legacy GitHub template is untouched');
  assert.equal(JSON.parse(text('download/latest.json')).version, '9.8.7');
} finally { execFileSync(process.execPath, ['scripts/build-cloudflare.mjs']); }
console.log('Cloudflare: allowlisted GitHub release redirects, pinned metadata/installers, WSL, pages/version/links, safe Markdown, announcement preservation and metadata validation passed.');

// Transition compatibility: actual shared extension commands and legacy output.
const context = vm.createContext({ window: {}, browser: {}, console });
vm.runInContext(readFileSync('extension/common.js', 'utf8'), context);
for (const [os, arch] of [['win', 'x86-64'], ['mac', 'aarch64'], ['linux', 'x86-64']]) {
  const setup = context.window.FxMcp.hostSetup({ os, arch });
  assert.ok(setup.cmd.includes(`https://foxhand.pages.dev/download/${os === 'win' ? 'ps' : 'sh'}`));
}
assert.ok(readFileSync('extension/common.js', 'utf8').includes("var DOWNLOAD = SITE + 'download/latest/';"));
assert.ok(readFileSync('extension/announcements.js', 'utf8').includes('https://foxhand.pages.dev/endpoint/announcement'));
assert.ok(readFileSync('test/live.mjs', 'utf8').includes("String(url) === 'https://foxhand.pages.dev/endpoint/announcement'"));
execFileSync(process.execPath, ['scripts/build-legacy-pages.mjs']);
assert.match(readFileSync('_site/index.html', 'utf8'), /http-equiv="refresh" content="0;url=https:\/\/foxhand.pages.dev\/"/);
assert.equal(readFileSync('_site/sh', 'utf8'), readFileSync('scripts/install.sh', 'utf8'));
assert.equal(readFileSync('_site/ps', 'utf8'), readFileSync('scripts/install.ps1', 'utf8'));
assert.equal(readFileSync('site/index.html', 'utf8'), sourceHome);
assert.ok(!text('index.html').includes('http-equiv="refresh"'), 'Cloudflare keeps the actual website');
console.log('Transition: shared install commands, announcement fixture and legacy homepage redirect/installers passed.');
