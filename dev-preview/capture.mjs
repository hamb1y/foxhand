// Dev preview only: screenshots of the REAL pages (fixture data), before and after, into review/screens/.
//   node dev-preview/capture.mjs [--only popup,site]      needs: npx playwright install firefox
// Uses a fresh headless Firefox with throwaway contexts. It never touches your own Firefox or profile.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { firefox } from 'playwright';
import { createServer } from './serve.mjs';
import { prepare } from './prepare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'review/screens');
mkdirSync(out, { recursive: true });
const only = (process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : '').split(',').filter(Boolean);
prepare();

const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://localhost:${server.address().port}`;

// [area, name, path-with-query, viewport, options]   "ext" pages exist for before and after; "site" too.
const POPUP = { width: 360, height: 400 };
const DESK = { width: 1180, height: 900 }, MOBILE = { width: 390, height: 844 };
const shots = [];
for (const state of ['ready', 'idle', 'paused', 'disconnected', 'missing', 'port', 'update']) shots.push(['popup', state, `popup.html?state=${state}&badge=0`, POPUP, { ext: true }]);
for (const state of ['missing', 'idle', 'connected']) shots.push(['onboarding', state, `onboarding.html?state=${state}&badge=0`, DESK, { ext: true, wait: state === 'connected' ? 3400 : 0 }]);
shots.push(['onboarding', 'idle-mobile', 'onboarding.html?state=idle&badge=0', MOBILE, { ext: true }]);
for (const state of ['ready', 'missing', 'wsl', 'empty']) shots.push(['settings', state, `options.html?state=${state}&badge=0`, DESK, { ext: true }]);
shots.push(['settings', 'ready-mobile', 'options.html?state=ready&badge=0', MOBILE, { ext: true }]);
shots.push(['announcement', 'approved', 'announcement.html?badge=0', { width: 480, height: 700 }, { ext: true, full: false }]);
shots.push(['website', 'desktop', '', { width: 1440, height: 900 }, { site: true }]);
shots.push(['website', 'mobile', '', MOBILE, { site: true }]);

const browser = await firefox.launch();
let n = 0;
for (const [area, name, route, viewport, o] of shots) {
  if (only.length && !only.includes(area)) continue;
  for (const side of ['before', 'after']) {
    const url = o.site ? `${origin}${side === 'before' ? '/_site-before/' : '/'}` : `${origin}/${side === 'before' ? '_ext-before' : '_ext'}/${route}`;
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(o.wait || 700);
    const file = path.join(out, `${area}-${name}-${side}.png`);
    await page.screenshot({ path: file, fullPage: o.full !== false });
    await ctx.close();
    n++;
    console.log(`${errors.length ? 'ERR ' : 'ok  '}${path.relative(here, file)}${errors.length ? '  ' + errors.join('; ') : ''}`);
  }
}
await browser.close();
server.close();
console.log(`${n} screenshots in ${path.relative(process.cwd(), out)}`);
