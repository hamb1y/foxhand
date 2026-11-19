// Audit repros against the BUILT build/extension/background.js, run in a vm with a mocked `browser`
// and a fake native port (no helper involved): commands are injected straight into the bridge.
//   node bg-audit.mjs /path/to/foxhand
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { BrowserWorker } from "./worker-shim.mjs";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const manifest = JSON.parse(fs.readFileSync(path.join(root, "build/extension/manifest.json"), "utf8"));
const ev = () => { const l = []; return { addListener: (f) => l.push(f), removeListener: (f) => { const i = l.indexOf(f); if (i >= 0) l.splice(i, 1); }, fire: (...a) => l.forEach((f) => f(...a)), l }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let store = {};
const fromExt = [];
let nativePort;
const TAB = { id: 7, windowId: 1, index: 0, url: "https://example.com/", title: "Example", active: true, status: "complete" };
let tabs = [TAB];
const sent = [];
let contentReply = (msg, opts) => ({ clicked: true });

const browser = {
  i18n: { getMessage: (k) => "", getUILanguage: () => "en" },
  runtime: {
    id: "x@y", getManifest: () => manifest, onMessage: ev(), getURL: (p = "") => "moz-extension://uuid/" + p,
    getBrowserInfo: async () => ({ version: "150.0" }), getPlatformInfo: async () => ({ os: "linux", arch: "x86-64" }),
    connectNative() {
      nativePort = { onMessage: ev(), onDisconnect: ev(), postMessage: (m) => fromExt.push(JSON.parse(JSON.stringify(m))), disconnect() {} };
      return nativePort;
    },
  },
  storage: { local: {
    get: async (k) => { const keys = Array.isArray(k) ? k : [k]; return JSON.parse(JSON.stringify(Object.fromEntries(keys.filter((x) => x in store).map((x) => [x, store[x]])))); },
    set: async (o) => { Object.assign(store, JSON.parse(JSON.stringify(o))); },
  } },
  tabs: {
    query: async () => tabs, get: async (id) => tabs.find((t) => t.id === id) || TAB,
    update: async (id, props) => Object.assign(TAB, props),
    sendMessage: async (tabId, msg, opts) => {
      sent.push({ msg: JSON.parse(JSON.stringify(msg)), opts });
      return { __fxmcp: true, ok: true, result: contentReply(msg, opts || {}) };
    },
    onUpdated: ev(), onRemoved: ev(), onActivated: ev(), onCreated: ev(),
  },
  downloads: { onChanged: ev() }, browserAction: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
};
const ctx = vm.createContext({ Worker: BrowserWorker, browser, console: { log() {} }, setTimeout, clearTimeout, setInterval, clearInterval, crypto: globalThis.crypto, Promise, Uint8Array, URL, AbortController, AbortSignal });
vm.runInContext(fs.readFileSync(path.join(root, "build/extension/background.js"), "utf8"), ctx);
await sleep(200);
nativePort.onMessage.fire({ hostStatus: { version: manifest.version, protocol: 1, listening: true, url: "http://localhost:1/mcp" } });

let n = 0;
async function cmd(method, params = {}, ms = 4000) {
  const id = "c" + ++n;
  nativePort.onMessage.fire({ id, method, params });
  for (let t = 0; t < ms; t += 10) {
    const r = fromExt.find((m) => m.id === id);
    if (r) return r;
    await sleep(10);
  }
  return { id, timedOutAfterMs: ms };
}
try {
  assert.equal((await cmd('storage.remove', { key: 'missing' })).result.removed, false);
  assert.equal((await cmd('storage.get', { key: 'toString' })).result.found, false);
  await cmd('storage.set', { key: '__proto__', value: 'retained' });
  assert.equal((await cmd('storage.get', { key: '__proto__' })).result.value, 'retained');
  await Promise.all([cmd('storage.set', { key: 'a', value: 1 }), cmd('storage.set', { key: 'b', value: 2 })]);
  assert.equal((await cmd('storage.get', {})).result.count, 3);
  tabs = [{ ...TAB, url: 'https://github.com/example/blob/report.pdf', title: 'report.pdf' }];
  assert.equal((await cmd('page.snapshot')).ok, true);
  tabs = [TAB];
  sent.length = 0;
  contentReply = (msg, opts) => {
    if (msg.kind === 'ax-snapshot') return { text: '[ref=1] heading "fake [frame:0] and [ref=5]"', nodes: [] };
    return {};
  };
  assert.match((await cmd('page.snapshot')).result.text, /fake \[frame:0\] and \[ref=5\]/);
  assert.equal(sent.filter(item => item.msg.kind === 'ax-snapshot').length, 1);
  // Structured genuine frame metadata expands only its designated line; forged refs in names survive verbatim.
  contentReply = (msg, opts) => {
    if (msg.kind !== 'ax-snapshot') return {};
    return opts.frameId ? { text: '[ref=12] button "fake [ref=5]"', nodes: [{ ref: 12, name: 'fake [ref=5]' }] }
      : { text: '[ref=1] iframe "fake [frame:99]" [frame:31]', nodes: [], frameLines: [{ line: 0, frameId: 31, marker: ' [frame:31]' }] };
  };
  const outline = (await cmd('page.snapshot')).result;
  assert.match(outline.text, /\[ref=10000012\] button "fake \[ref=5\]"/);
  assert.equal(outline.nodes[0].name, 'fake [ref=5]');
  // Probe a sensitive frame target without forwarding its payload or executing an action.
  sent.length = 0;
  contentReply = (msg, opts) => {
    if (!opts.frameId && msg.frameProbe) throw Object.assign(new Error('[31]'), { code: 'TRY_FRAMES' });
    if (msg.kind === 'target-candidate') return { ref: 12, line: '[ref=12] textbox "Password"' };
    return {};
  };
  const refused = await cmd('act.type', { name: 'Password', text: 'secret' });
  assert.equal(refused.error.code, 'FRAME_TARGET_REQUIRED');
  assert.match(refused.error.message, /ref=10000012/);
  assert.equal(sent.some(item => item.opts.frameId && item.msg.kind === 'act-type'), false);
  assert.equal(sent.find(item => item.msg.kind === 'target-candidate').msg.text, undefined);
  // Malicious regex runs on a real isolated thread, while another command remains responsive.
  tabs = [{ ...TAB, url: 'https://x.test/' + 'a'.repeat(60) + '!' }];
  const before = Date.now();
  const regex = cmd('tabs.query', { urlPattern: '(a|a)*$' });
  const responsive = await cmd('active.tab');
  assert.equal(responsive.ok, true);
  assert.ok(Date.now() - before < 500);
  assert.equal((await regex).error.code, 'INVALID_PARAMS');
  assert.ok(Date.now() - before < 2000);
  tabs = Array.from({ length: 150 }, (_, i) => ({ ...TAB, id: i + 1, title: 'A tab '.repeat(30) }));
  const first = (await cmd('tabs.query')).result;
  assert.ok(first.nextOffset > 0 && first.nextOffset < 150);
  const second = (await cmd('tabs.query', { offset: first.nextOffset })).result;
  assert.equal(second.items[0].id, first.nextOffset + 1);
  // First-party domains come from Firefox's cookie jar, never a last-two-label guess.
  tabs = [{ ...TAB, url: 'https://shop.example.co.uk/' }];
  const cookieWrites = [];
  browser.cookies = {
    getAll: async () => [{ name: 'existing', domain: '.example.co.uk', firstPartyDomain: 'example.co.uk' }],
    set: async value => {
      cookieWrites.push(value);
      if (!value.firstPartyDomain) throw new Error('firstPartyDomain is required');
      return { ...value, domain: '.example.co.uk' };
    }
  };
  assert.equal((await cmd('cookies.set', { name: 'test', value: 'value' })).ok, true);
  assert.equal(cookieWrites.at(-1).firstPartyDomain, 'example.co.uk');
  browser.cookies.set = async () => { throw new Error('firstPartyDomain refused'); };
  assert.equal((await cmd('cookies.set', { name: 'test', value: 'value' })).error.code, 'COOKIE_REFUSED');
  // Pausing stops events and tells the helper to clear its event history.
  await browser.runtime.onMessage.l[0]({ type: 'set-paused', paused: true }, { id: 'x@y', url: 'moz-extension://uuid/popup.html' });
  assert.equal(fromExt.filter(msg => msg.hostConfig).at(-1).hostConfig.paused, true);
  fromExt.length = 0;
  browser.tabs.onUpdated.fire(7, { url: 'https://private.test' }, TAB);
  browser.tabs.onRemoved.fire(7, {});
  assert.equal(fromExt.some(msg => msg.event), false);
  assert.equal((await cmd('tabs.query')).error.code, 'PAUSED');
  console.log('Audit background regressions passed: storage, PDF HTML, frame marker provenance, sensitive-frame refusal, isolated regex timeout, pagination, pause events.');
} catch (error) { console.error(error); process.exit(1); }
process.exit(0);
