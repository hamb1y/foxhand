// Real announcement controller, plus real Firefox rendering hostile remote HTML.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { firefox } from 'playwright';

const code = fs.readFileSync(new URL('../extension/announcements.js', import.meta.url), 'utf8');
const PAGE = 'moz-extension://test/announcement.html';
const item = { id: 'first', html: '<h2>Hello</h2>' };
function harness(store = {}) {
  const messages = [], removed = [], timers = [], intervals = [], opened = [];
  let feed = item, failWindow = false, failStorage = false, requests = 0;
  const context = vm.createContext({
    browser: {
      runtime: { id: 'foxhand', getURL: p => 'moz-extension://test/' + p,
        onMessage: { addListener: fn => messages.push(fn) } },
      storage: { local: {
        get: async key => structuredClone({ [key]: store[key] }),
        set: async data => { if (failStorage) throw Error('disk full'); Object.assign(store, structuredClone(data)); }
      } },
      windows: {
        create: async props => { if (failWindow) throw Error('window failed'); opened.push(props); return { id: opened.length }; },
        onRemoved: { addListener: fn => removed.push(fn) }
      }
    },
    fetch: async (_url, options) => {
      requests++;
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'error');
      if (feed instanceof Error) throw feed;
      return new Response(typeof feed === 'string' ? feed : JSON.stringify(feed));
    },
    AbortController, TextDecoder, TextEncoder, Uint8Array,
    setTimeout: (fn, delay) => { if (delay === 15000) timers.push(fn); return 1; },
    clearTimeout() {}, setInterval: fn => intervals.push(fn)
  });
  vm.runInContext(code, context);
  const sender = { id: 'foxhand', url: PAGE, tab: { windowId: 1 } };
  return {
    store, opened, set feed(value) { feed = value; }, set failWindow(value) { failWindow = value; },
    set failStorage(value) { failStorage = value; }, get requests() { return requests; },
    start: () => timers[0](), check: () => intervals[0](),
    close: id => removed[0](id),
    send: (msg, as = sender) => messages[0](msg, as)
  };
}
let h = harness();
await h.start();
assert.equal(h.opened.length, 1);
assert.equal(h.store.shownPopupIds, undefined, 'opening alone must not consume ID');
assert.equal((await h.send({ type: 'announcement-get' })).id, 'first');
assert.equal(h.send({ type: 'announcement-get' }, { id: 'foxhand', url: 'https://evil.test/' }), undefined);
assert.equal(await h.send({ type: 'announcement-get' }, { id: 'foxhand', url: PAGE, tab: { windowId: 9 } }), null);
assert.equal(await h.send({ type: 'announcement-shown', id: 'wrong' }), null);
await h.check();
assert.equal(h.opened.length, 1, 'do not duplicate an open announcement');
h.failStorage = true;
await assert.rejects(h.send({ type: 'announcement-shown', id: 'first' }));
assert.equal(h.store.shownPopupIds, undefined);
h.failStorage = false;
await h.send({ type: 'announcement-shown', id: 'first' });
assert.deepEqual(h.store.shownPopupIds, ['first']);
h.close(1);
await h.check();
assert.equal(h.opened.length, 1);
const persisted = h.store;
h = harness(persisted);
await h.start();
assert.equal(h.opened.length, 0, 'seen IDs survive background restarts');
h.feed = { ...item, id: 'second' };
await h.check();
assert.equal(h.opened.length, 1);
await h.send({ type: 'announcement-shown', id: 'second' });
h.close(1);
h.feed = item;
await h.check();
assert.equal(h.opened.length, 1, 'old IDs stay suppressed after newer announcements');
for (const feed of [null, {}, { id: '', html: 'hi' }, { id: 'x', html: 'a'.repeat(32769) }, '{bad json', 'x'.repeat(65537), new Error('offline')]) {
  h = harness(); h.feed = feed; await h.start();
  assert.equal(h.opened.length, 0);
  assert.equal(h.store.shownPopupIds, undefined);
}
h = harness(); h.failWindow = true; await h.start();
assert.equal(h.store.shownPopupIds, undefined);
h.failWindow = false; await h.check();
assert.equal(h.opened.length, 1, 'window creation failure can retry');
h = harness(); await h.start(); h.close(1); await h.check();
assert.equal(h.opened.length, 2, 'closing before display acknowledgement allows retry');
console.log('ok  announcement persistence, sender checks, failures, retries, and deduplication');

const browser = await firefox.launch();
try {
  const page = await browser.newPage({ viewport: { width: 460, height: 520 } });
  const hostile = `<h2 onclick="window.pwned=1" style="color:red">Hello</h2>
    <script>window.pwned=1</script><img src="https://evil.test/track" onerror="window.pwned=1">
    <iframe src="https://evil.test/"></iframe><svg onload="window.pwned=1"></svg>
    <form><input value="secret"></form><style>body{display:none}</style>
    <a href="javascript:alert(1)">bad</a><a href="data:text/html,bad">data</a>
    <a href="https://user:pass@example.com">creds</a>
    <a href="https://example.com/donate" onclick="window.pwned=1">Donate</a>
    <strong>Thanks</strong><custom>kept text</custom>`;
  await page.addInitScript(({ html }) => {
    window.messages = [];
    window.browser = { runtime: { sendMessage: async msg => {
      window.messages.push(msg);
      return msg.type === 'announcement-get' ? { id: 'test', html } : { ok: true };
    } } };
  }, { html: hostile });
  await page.goto(new URL('../extension/announcement.html', import.meta.url).href);
  await page.waitForFunction(() => window.messages.some(m => m.type === 'announcement-shown'));
  assert.equal(await page.locator('#announcement').isVisible(), true);
  assert.equal(await page.locator('#announcement h2').textContent(), 'Hello');
  assert.equal(await page.locator('#announcement script, #announcement img, #announcement iframe, #announcement svg, #announcement form, #announcement style').count(), 0);
  assert.equal(await page.locator('#announcement [onclick], #announcement [style]').count(), 0);
  assert.equal(await page.locator('#announcement a[href]').count(), 1);
  assert.equal(await page.locator('#announcement a[href]').getAttribute('href'), 'https://example.com/donate');
  assert.equal(await page.locator('#announcement a[href]').getAttribute('rel'), 'noopener noreferrer');
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  assert.ok((await page.locator('#announcement').textContent()).includes('kept text'));
  await page.screenshot({ path: '/tmp/foxhand-announcement-test.png' });
  await page.close();
  const empty = await browser.newPage();
  await empty.addInitScript(() => {
    window.messages = []; window.didClose = false; window.close = () => { window.didClose = true; };
    window.browser = { runtime: { sendMessage: async msg => {
      window.messages.push(msg); return { id: 'empty', html: '<script>alert(1)</script>' };
    } } };
  });
  await empty.goto(new URL('../extension/announcement.html', import.meta.url).href);
  await empty.waitForFunction(() => window.didClose);
  assert.equal(await empty.evaluate(() => window.messages.some(m => m.type === 'announcement-shown')), false);
  console.log('ok  Firefox renders safe formatting/links, strips active HTML, and acknowledges only useful content');
} finally { await browser.close(); }
