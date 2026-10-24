// Live test: real Firefox + the real add-on + a real helper, driven over MCP.
//
//   node test/live.mjs                          helper from this checkout (node mcp-server/dist/host.js)
//   node test/live.mjs --helper dist/host/webmcp-host-linux-x64
//                                               a compiled helper; it installs itself first
//   node test/live.mjs --installed              the helper an installer already registered (CI)
//   node test/live.mjs --firefox /path/to/firefox --headful --keep
//
// Firefox runs with a throwaway profile, and (except --installed) a throwaway HOME, so the
// native-messaging registration it reads is ours, not the user's. The add-on is installed as a
// temporary add-on over WebDriver BiDi, which release Firefox allows without signing.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const flag = (k) => process.argv.includes(k);
const PORT = Number(arg('--port') ?? 8911);
const UUID = '6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const EXT_ID = 'webmcp-controller@hamb1y.github.io';

function findFirefox() {
  const given = arg('--firefox') ?? process.env.FIREFOX;
  if (given) return given;
  const cands = process.platform === 'darwin' ? ['/Applications/Firefox.app/Contents/MacOS/firefox']
    : process.platform === 'win32' ? [`${process.env.ProgramFiles}\\Mozilla Firefox\\firefox.exe`, `${process.env['ProgramFiles(x86)']}\\Mozilla Firefox\\firefox.exe`]
    : ['/usr/bin/firefox', '/usr/lib/firefox/firefox', '/snap/bin/firefox'];
  const hit = cands.find((c) => c && existsSync(c));
  if (!hit) throw new Error('Firefox not found; pass --firefox');
  return hit;
}

/* ------------------------------------------------------------ results */
let failed = 0, passed = 0;
const results = [];
function ok(name, cond, detail = '') {
  if (cond) passed++; else failed++;
  results.push(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail && !cond ? `  — ${String(detail).slice(0, 400)}` : ''}`);
  console.log(results[results.length - 1]);
}

/* ------------------------------------------------------------ fixtures */
const PAGES = {
  '/': `<title>Home</title><h1>Fixture home</h1><a href="/form">Form page</a> <a href="/chat">Chat</a> <a href="/long">Long</a>
        <button id="b1" onclick="document.title='clicked'">Click me</button>
        <button disabled>Can't touch</button>
        <p>The quick brown fox. Another fox line.</p><p hidden>secret fox</p>`,
  '/form': `<title>Form</title><form id="f" onsubmit="event.preventDefault(); document.title='submitted:'+new FormData(this).get('name')+':'+new FormData(this).get('color')+':'+(new FormData(this).get('agree')||'no')">
        <label>Name <input name="name" required></label>
        <label>Email <input name="email" type="email"></label>
        <label>Password <input name="pw" type="password"></label>
        <select name="color"><option value="">pick</option><option value="r">Red</option><option value="US">United States</option><optgroup label="x" disabled><option value="g">Green</option></optgroup></select>
        <label><input type="checkbox" name="agree" value="yes"> Agree</label>
        <textarea name="bio" readonly>fixed</textarea>
        <button type="submit">Save</button></form>`,
  '/chat': `<title>Chat</title><main><div class="composer"><textarea id="msg" aria-label="Message"></textarea>
        <button aria-label="Send message" onclick="window.sent=(window.sent||0)+1; document.title='sent '+window.sent+': '+document.getElementById('msg').value; document.getElementById('msg').value=''">Send</button></div></main>`,
  '/long': `<title>Long</title>${Array.from({ length: 200 }, (_, i) => `<p id="p${i}">Paragraph ${i}</p>`).join('')}<button id="bottom">Bottom</button>`,
  '/shadow': `<title>Shadow</title><x-card></x-card><script>customElements.define('x-card', class extends HTMLElement {
        connectedCallback() { const r = this.attachShadow({ mode: 'open' }); r.innerHTML = '<button id="in">Inside shadow</button><input aria-label="Shadow field">';
        r.getElementById('in').onclick = () => document.title = 'shadow clicked'; } });</script>`,
  '/late': `<title>Late</title><div id="slot"></div><script>setTimeout(() => document.getElementById('slot').innerHTML = '<p id="arrived">Arrived late</p>', 1500)</script>`,
  '/alert': `<title>Alert</title><button onclick="alert('Are you sure?'); document.title='after alert'">Warn me</button>`,
  '/confirm': `<title>Confirm</title><button onclick="document.title = confirm('Delete?') ? 'yes' : 'no'">Delete</button>`,
  '/leave': `<title>Leave</title><input aria-label="Draft" oninput="window.onbeforeunload = (e) => { e.preventDefault(); return ''; }">`,
  '/blank': `<title>Blank</title><a href="/" target="_blank">Open home in new tab</a>`,
  '/editor': `<title>Editor</title><div contenteditable="true" aria-label="Editor" role="textbox" oninput="document.title='ed:'+this.textContent"></div>`,
  '/react': `<title>React</title><input aria-label="Controlled"><script>
        const el = document.querySelector('input'); const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        let last = ''; Object.defineProperty(el, 'value', { get() { return proto.get.call(this); }, set(v) { last = v; proto.set.call(this, v); } });
        el.addEventListener('input', () => { document.title = 'react:' + proto.get.call(el) + ':' + (last === proto.get.call(el) ? 'stale' : 'fresh'); });</script>`,
  '/iframe': `<title>Iframe</title><p>Outer</p><iframe src="/" title="Inner frame" width="400" height="200"></iframe>`,
  '/hover': `<title>Hover</title><div id="m" onmouseenter="document.getElementById('menu').hidden=false" role="button" tabindex="0">Menu</div><ul id="menu" hidden><li><a href="/">Item</a></li></ul>`,
  '/big': `<title>Big</title>${Array.from({ length: 4000 }, (_, i) => `<div><a href="/x${i}">Link ${i}</a> <button>B${i}</button></div>`).join('')}`,
  '/download': `<title>Download</title><a href="/file.txt" download>Get file</a>`,
  '/frag': `<title>Frag</title><a href="#sec">Jump</a><div style="height:3000px"></div><h2 id="sec">Section</h2>`,
};
function fixtureServer() {
  const srv = createServer((req, res) => {
    const pth = new URL(req.url, 'http://x').pathname;
    if (pth === '/file.txt') { res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="webmcp-live.txt"' }); res.end('hello'); return; }
    if (pth === '/doc.pdf') {
      // Smallest valid one-page PDF.
      const pdf = '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF';
      res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(pdf); return;
    }
    if (pth === '/slow') { setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Slow</title>slow'); }, 3000); return; }
    const body = PAGES[pth];
    if (!body) { res.writeHead(404); res.end('nope'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8">${body}`);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

/* ------------------------------------------------------------ BiDi */
class Bidi {
  constructor(url) { this.url = url; this.id = 0; this.wait = new Map(); this.events = []; }
  open() {
    this.ws = new WebSocket(this.url);
    this.ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id !== undefined && this.wait.has(msg.id)) {
        const { res, rej } = this.wait.get(msg.id); this.wait.delete(msg.id);
        msg.type === 'error' ? rej(new Error(`${msg.error}: ${msg.message}`)) : res(msg.result);
      } else if (msg.type === 'event') this.events.push(msg);
    };
    return new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error('BiDi connect failed')); });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.wait.set(id, { res, rej }));
  }
  async evaluate(context, expression) {
    const r = await this.send('script.evaluate', { expression, target: { context }, awaitPromise: true, resultOwnership: 'none', serializationOptions: { maxObjectDepth: 6 } });
    if (r.type === 'exception') throw new Error(`evaluate: ${r.exceptionDetails?.text}`);
    return fromRemote(r.result);
  }
}
function fromRemote(v) {
  if (!v) return v;
  switch (v.type) {
    case 'undefined': case 'null': return null;
    case 'string': case 'number': case 'boolean': return v.value;
    case 'array': return (v.value || []).map(fromRemote);
    case 'object': return Object.fromEntries((v.value || []).map(([k, x]) => [typeof k === 'string' ? k : fromRemote(k), fromRemote(x)]));
    default: return v.value ?? null;
  }
}

/* ------------------------------------------------------------ setup */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(250); }
  throw new Error(`timed out waiting for ${what}: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

const tmp = mkdtempSync(path.join(tmpdir(), 'webmcp-live-'));
const profile = path.join(tmp, 'profile');
const home = path.join(tmp, 'home');
const env = { ...process.env };
if (!flag('--installed')) {
  Object.assign(env, { HOME: home, USERPROFILE: home, XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CONFIG_HOME: path.join(home, '.config') });
}

function installHelper() {
  if (flag('--installed')) return;
  const helper = arg('--helper');
  const cmd = helper ? [path.resolve(helper), ['install']] : [process.execPath, [path.join(root, 'mcp-server/dist/host.js'), 'install']];
  const r = spawnSync(cmd[0], cmd[1], { env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`helper install failed: ${r.stderr || r.error}`);
}

let ff, bidi, fixtures, client;
async function start() {
  installHelper();
  fixtures = await fixtureServer();
  writeFileSync(path.join(tmp, 'profile.keep'), '');
  spawnSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(profile)}, { recursive: true })`]);
  writeFileSync(path.join(profile, 'user.js'), [
    `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ [EXT_ID]: UUID }))});`,
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.startup.homepage_override.mstone", "ignore");',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
    'user_pref("browser.aboutwelcome.enabled", false);',
    'user_pref("extensions.autoDisableScopes", 0);',
  ].join('\n'));
  // System access lets BiDi open and script the add-on's own pages.
  const bidiPort = Number(arg('--bidi-port') ?? 9333);
  const args = ['-profile', profile, '-no-remote', '--remote-debugging-port', String(bidiPort), '-remote-allow-system-access'];
  if (!flag('--headful')) args.unshift('-headless');
  ff = spawn(findFirefox(), args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  // A fixed port rather than parsing Firefox's output: on Windows that output may not reach a pipe.
  let ffLog = '';
  ff.stderr.on('data', (d) => { ffLog = (ffLog + d).slice(-4000); });
  ff.stdout.on('data', (d) => { ffLog = (ffLog + d).slice(-4000); });
  let exited = null;
  ff.on('exit', (c) => { exited = c; });
  await until(async () => {
    if (exited !== null) throw new Error(`Firefox exited (${exited}): ${ffLog}`);
    bidi = new Bidi(`ws://127.0.0.1:${bidiPort}/session`);
    await bidi.open();
    return true;
  }, 90000, 'Firefox remote debugging port');
  // Leave page dialogs alone, like a real user who hasn't answered yet (BiDi dismisses them by default).
  await bidi.send('session.new', { capabilities: { alwaysMatch: { unhandledPromptBehavior: { default: 'ignore' } } } });
  await bidi.send('webExtension.install', { extensionData: { type: 'path', path: path.join(root, 'extension') } });
  // An extension page can talk to the background like the popup does.
  const ctx = (await bidi.send('browsingContext.create', { type: 'tab' })).context;
  await bidi.send('browsingContext.navigate', { context: ctx, url: `moz-extension://${UUID}/popup.html`, wait: 'complete' });
  const st0 = await until(() => bidi.evaluate(ctx, `browser.runtime.sendMessage({ type: 'get-status' })`), 20000, 'add-on status');
  // Our own port, so a real helper the user runs on 8901 is never disturbed.
  await bidi.evaluate(ctx, `browser.runtime.sendMessage({ type: 'set-config', port: ${PORT} })`);
  const st = await until(async () => {
    const s = await bidi.evaluate(ctx, `browser.runtime.sendMessage({ type: 'get-status' })`);
    return s && s.listening && s.port === PORT ? s : null;
  }, 45000, 'helper listening');
  console.log(`firefox ${st0.version} add-on, helper v${st.host && st.host.version} at ${st.url}`);
  client = new Client({ name: 'live-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(st.url), { requestInit: { headers: { Authorization: `Bearer ${st.token}` } } }));
  return { ctx, st };
}

const F = (p) => `http://127.0.0.1:${fixtures.address().port}${p}`;
async function tool(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return { r, text, isError: !!r.isError, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}
const refOf = (snap, re) => { const m = new RegExp(`\\[ref=(\\d+)\\][^\\n]*${re}`).exec(snap); return m ? Number(m[1]) : null; };
const title = async (tabId) => (await tool('page_info', { tabId })).json?.title;

/* ------------------------------------------------------------ scenario */
async function scenario() {
  const tools = await client.listTools();
  ok('lists 44 tools', tools.tools.length === 44, tools.tools.length);

  let t = await tool('extension_status');
  ok('extension_status says connected', /connected/i.test(t.text) && !t.isError, t.text);

  t = await tool('tab_create', { url: F('/'), waitForLoad: true, thought: 'Opening the fixture' });
  const tabId = t.json?.id;
  ok('tab_create waits for load', t.json?.loadComplete === true && tabId, t.text);

  t = await tool('tabs_list');
  ok('tabs_list includes the new tab', Array.isArray(t.json) && t.json.some((x) => x.id === tabId), t.text);

  t = await tool('tabs_query', { urlPattern: '127\\.0\\.0\\.1' });
  ok('tabs_query by url', Array.isArray(t.json) && t.json.some((x) => x.id === tabId), t.text);

  t = await tool('tabs_query', { urlPattern: '(a+)+' });
  ok('tabs_query rejects catastrophic regex', t.isError || /not supported/.test(t.text), t.text);

  t = await tool('active_tab');
  ok('active_tab is the new tab', t.json?.id === tabId, t.text);

  t = await tool('snapshot_ax', { tabId });
  const snap = t.text;
  ok('snapshot has refs', /\[ref=\d+\] button "Click me"/.test(snap), snap.slice(0, 500));
  ok('snapshot marks disabled', /button "Can't touch"[^\n]*\[disabled\]/.test(snap), snap.slice(0, 800));

  t = await tool('act_click', { tabId, ref: refOf(snap, '"Click me"') });
  ok('act_click', /clicked/.test(t.text) && (await title(tabId)) === 'clicked', t.text);

  t = await tool('act_click', { tabId, ref: refOf(snap, `"Can't touch"`) });
  ok('act_click refuses disabled', t.isError && /DISABLED/.test(t.text), t.text);

  t = await tool('page_text', { tabId });
  ok('page_text excludes hidden', /quick brown fox/.test(t.text) && !/secret fox/.test(t.text), t.text.slice(0, 300));

  t = await tool('act_find', { tabId, query: 'fox' });
  ok('act_find counts visible occurrences', /"count": 2/.test(t.text), t.text);

  t = await tool('page_html', { tabId, selector: 'h1' });
  ok('page_html selector', /<h1>Fixture home<\/h1>/.test(t.text) && /URL:/.test(t.text), t.text);

  t = await tool('screenshot', { tabId });
  ok('screenshot returns an image', (t.r.content || []).some((c) => c.type === 'image' && c.data.length > 1000), JSON.stringify(t.r.content?.map((c) => c.type)));

  // Forms
  t = await tool('tab_navigate', { tabId, url: F('/form'), waitForLoad: true });
  ok('tab_navigate waits for load', t.json?.loadComplete === true, t.text);
  const fs1 = (await tool('snapshot_ax', { tabId })).text;
  t = await tool('act_fill_form', { tabId, fields: [{ ref: refOf(fs1, 'textbox "Name"'), value: 'Ada' }, { ref: refOf(fs1, 'combobox'), value: 'us' }, { ref: refOf(fs1, 'checkbox "Agree"'), value: 'true' }], submit: true });
  ok('act_fill_form + submit (select is exact-value-first, case-insensitive fallback)', (await title(tabId)) === 'submitted:Ada:US:yes', `${t.text} title=${await title(tabId)}`);
  t = await tool('act_select', { tabId, ref: refOf(fs1, 'combobox'), values: ['g'] });
  ok('act_select refuses disabled optgroup', t.isError, t.text);
  t = await tool('act_type', { tabId, ref: refOf(fs1, 'textbox "Bio"') ?? refOf(fs1, 'textbox[^\\n]*readonly'), text: 'x' });
  ok('act_type refuses read-only', t.isError && /read-only|NOT_EDITABLE/.test(t.text), t.text);

  // Chat composer: exactly one send
  await tool('tab_navigate', { tabId, url: F('/chat'), waitForLoad: true });
  const cs = (await tool('snapshot_ax', { tabId })).text;
  t = await tool('act_type', { tabId, ref: refOf(cs, 'textbox "Message"'), text: 'hello', submit: true });
  await sleep(400);
  ok('chat submit sends exactly once', (await title(tabId)) === 'sent 1: hello', `${t.text} title=${await title(tabId)}`);

  // Keys
  t = await tool('act_click', { tabId, ref: refOf(cs, 'textbox "Message"') });
  t = await tool('act_key', { tabId, key: 'a' });
  ok('act_key types a printable key', /typed/.test(t.text), t.text);
  t = await tool('act_key', { tabId, key: 'a', modifiers: ['Ctrl'] });
  ok('act_key Ctrl+A selects all', /selected all/.test(t.text), t.text);

  // Scroll + wait + shadow + fragment
  await tool('tab_navigate', { tabId, url: F('/long'), waitForLoad: true });
  t = await tool('act_scroll', { tabId, to: 'bottom' });
  ok('act_scroll to bottom', /"atEnd": true/.test(t.text), t.text);
  await tool('tab_navigate', { tabId, url: F('/late'), waitForLoad: true });
  t = await tool('act_wait', { tabId, text: 'Arrived late', timeoutMs: 5000 });
  ok('act_wait sees late content', /"found": true/.test(t.text), t.text);
  await tool('tab_navigate', { tabId, url: F('/shadow'), waitForLoad: true });
  const ss = (await tool('snapshot_ax', { tabId })).text;
  t = await tool('act_click', { tabId, ref: refOf(ss, '"Inside shadow"') });
  ok('click inside open shadow root', (await title(tabId)) === 'shadow clicked', `${t.text} ${ss.slice(0, 300)}`);
  await tool('tab_navigate', { tabId, url: F('/frag'), waitForLoad: true });
  const t0 = Date.now();
  t = await tool('tab_navigate', { tabId, url: F('/frag#sec'), waitForLoad: true });
  ok('fragment navigation returns at once', t.json?.loadComplete === true && Date.now() - t0 < 5000, t.text);

  // Navigation history
  t = await tool('nav_back', { tabId });
  ok('nav_back', !t.isError, t.text);
  t = await tool('nav_forward', { tabId });
  ok('nav_forward', !t.isError, t.text);
  t = await tool('nav_reload', { tabId });
  ok('nav_reload', !t.isError, t.text);

  // Tab management
  t = await tool('tab_duplicate', { tabId });
  const dupId = t.json?.id;
  ok('tab_duplicate', !!dupId && dupId !== tabId, t.text);
  t = await tool('tab_pin', { tabId: dupId });
  ok('tab_pin', t.json?.pinned === true, t.text);
  t = await tool('tab_unpin', { tabId: dupId });
  ok('tab_unpin', t.json?.pinned === false, t.text);
  t = await tool('tab_mute', { tabId: dupId });
  ok('tab_mute', t.json?.muted === true, t.text);
  t = await tool('tab_move', { tabId: dupId, index: 0 });
  ok('tab_move', t.json?.index === 0, t.text);
  t = await tool('focus_tab', { tabId });
  ok('focus_tab', !t.isError, t.text);
  t = await tool('tab_close', { tabIds: [dupId] });
  ok('tab_close needs confirm', t.isError && /confirm/.test(t.text), t.text);
  t = await tool('tab_close', { tabIds: [dupId], confirm: true });
  ok('tab_close with confirm', !t.isError, t.text);

  // Windows
  t = await tool('window_list');
  ok('window_list', Array.isArray(t.json) && t.json.length >= 1, t.text);
  t = await tool('window_create', { url: F('/') });
  const winId = t.json?.id;
  ok('window_create', !!winId, t.text);
  t = await tool('window_focus', { windowId: winId });
  ok('window_focus', !t.isError, t.text);
  t = await tool('window_close', { windowId: winId, confirm: true });
  ok('window_close', !t.isError, t.text);

  // Browser data
  t = await tool('bookmarks_create', { title: 'Live test mark', url: F('/') });
  const bmId = t.json?.id;
  ok('bookmarks_create', !!bmId, t.text);
  t = await tool('bookmarks_search', { query: 'Live test mark' });
  ok('bookmarks_search', Array.isArray(t.json) && t.json.some((b) => b.id === bmId), t.text);
  t = await tool('bookmarks_remove', { id: bmId, confirm: true });
  ok('bookmarks_remove', !t.isError, t.text);
  t = await tool('history_search', { query: '127.0.0.1' });
  ok('history_search', Array.isArray(t.json), t.text);
  t = await tool('downloads_list');
  ok('downloads_list', Array.isArray(t.json), t.text);
  t = await tool('cookies_for_tab', { tabId });
  ok('cookies_for_tab', Array.isArray(t.json), t.text);
  t = await tool('sessions_recently_closed');
  ok('sessions_recently_closed', Array.isArray(t.json) && t.json.length > 0, t.text);
  const sid = t.json?.[0]?.tab?.sessionId ?? t.json?.[0]?.window?.sessionId;
  t = await tool('sessions_restore', { sessionId: sid });
  ok('sessions_restore', !t.isError, t.text);

  // Meta
  t = await tool('cursor_note', { note: 'Hello from the live test', tabId });
  ok('cursor_note', !t.isError, t.text);
  const waitP = tool('wait_for_tab_event', { types: ['tab.updated'], timeoutMs: 15000 });
  await sleep(300);
  await tool('nav_reload', { tabId });
  t = await waitP;
  ok('wait_for_tab_event sees a reload', !t.isError && /tab\.updated/.test(t.text), t.text);

  // Restricted pages
  await tool('tab_navigate', { tabId, url: 'about:blank', waitForLoad: true });
  t = await tool('snapshot_ax', { tabId });
  ok('restricted page error is clear', t.isError && /RESTRICTED_PAGE/.test(t.text), t.text);
}

async function timed(fn) { const t0 = Date.now(); const r = await fn(); r.ms = Date.now() - t0; return r; }
let popupCtx = null;
const ext = (expr) => bidi.evaluate(popupCtx, expr);

async function edges() {
  let t = await tool('tab_create', { url: F('/alert'), waitForLoad: true });
  const tabId = t.json?.id;
  let snap = (await tool('snapshot_ax', { tabId })).text;
  t = await timed(() => tool('act_click', { tabId, ref: refOf(snap, '"Warn me"') }));
  ok('click that opens an alert returns promptly', t.ms < 8000, `${t.ms}ms ${t.text}`);
  ok('click that opens an alert says so', /alert|dialog/i.test(t.text), t.text);
  t = await timed(() => tool('snapshot_ax', { tabId }));
  ok('page with an open alert: next call is prompt and explains', t.ms < 8000 && /alert|dialog/i.test(t.text), `${t.ms}ms ${t.text.slice(0, 300)}`);

  await tool('tab_navigate', { tabId, url: F('/confirm'), waitForLoad: true });
  snap = (await tool('snapshot_ax', { tabId })).text;
  t = await timed(() => tool('act_click', { tabId, ref: refOf(snap, '"Delete"') }));
  ok('click that opens confirm() returns promptly', t.ms < 8000, `${t.ms}ms ${t.text}`);

  t = await timed(() => tool('tab_navigate', { tabId, url: F('/leave'), waitForLoad: true }));
  snap = (await tool('snapshot_ax', { tabId })).text;
  await tool('act_type', { tabId, ref: refOf(snap, 'textbox "Draft"'), text: 'unsaved' });
  t = await timed(() => tool('tab_navigate', { tabId, url: F('/'), waitForLoad: true, timeoutMs: 8000 }));
  ok('navigating away from a page with a leave prompt returns and explains', t.ms < 12000 && (t.json?.loadComplete === true || /leave|unload|prompt|dialog/i.test(t.text)), `${t.ms}ms ${t.text.slice(0, 300)}`);

  t = await tool('tab_create', { url: F('/blank'), waitForLoad: true });
  const blankTab = t.json?.id;
  snap = (await tool('snapshot_ax', { tabId: blankTab })).text;
  const before = (await tool('tabs_list')).json.length;
  t = await tool('act_click', { tabId: blankTab, ref: refOf(snap, 'link "Open home') });
  await sleep(800);
  const after = (await tool('tabs_list')).json.length;
  ok('target=_blank click opens a tab', after === before + 1, `${before} -> ${after}`);
  ok('target=_blank click tells the agent about the new tab', /new tab|tabId|opened/i.test(t.text), t.text);

  await tool('tab_navigate', { tabId, url: F('/editor'), waitForLoad: true });
  snap = (await tool('snapshot_ax', { tabId })).text;
  t = await tool('act_type', { tabId, ref: refOf(snap, 'textbox "Editor"'), text: 'Hello editor' });
  ok('act_type into contenteditable', (await title(tabId)) === 'ed:Hello editor', `${t.text} title=${await title(tabId)}`);

  await tool('tab_navigate', { tabId, url: F('/react'), waitForLoad: true });
  snap = (await tool('snapshot_ax', { tabId })).text;
  t = await tool('act_type', { tabId, ref: refOf(snap, 'textbox "Controlled"'), text: 'abc' });
  ok('act_type into a React-style controlled input', /^react:abc:/.test(await title(tabId)), `${t.text} title=${await title(tabId)}`);

  await tool('tab_navigate', { tabId, url: F('/iframe'), waitForLoad: true });
  snap = (await tool('snapshot_ax', { tabId })).text;
  ok('snapshot tells the agent an iframe is there', /\] (iframe|frame)\b[^\n]*Inner frame/i.test(snap), snap.slice(0, 400));

  await tool('tab_navigate', { tabId, url: F('/hover'), waitForLoad: true });
  snap = (await tool('snapshot_ax', { tabId })).text;
  await tool('act_hover', { tabId, ref: refOf(snap, '"Menu"') });
  snap = (await tool('snapshot_ax', { tabId })).text;
  ok('act_hover opens a JS menu', /link "Item"/.test(snap), snap.slice(0, 300));

  await tool('tab_navigate', { tabId, url: F('/big'), waitForLoad: true });
  t = await timed(() => tool('snapshot_ax', { tabId, maxChars: 2000 }));
  ok('small snapshot of a huge page is fast and says it is truncated', t.ms < 3000 && /truncated/i.test(t.text), `${t.ms}ms ${t.text.slice(-300)}`);
  t = await timed(() => tool('snapshot_ax', { tabId }));
  ok('full snapshot of a huge page stays under the native-message limit', !t.isError, `${t.ms}ms ${t.text.slice(0, 300)}`);

  await tool('tab_navigate', { tabId, url: F('/download'), waitForLoad: true });
  snap = (await tool('snapshot_ax', { tabId })).text;
  const dl = tool('wait_for_tab_event', { types: ['download.done'], timeoutMs: 15000 });
  await sleep(200);
  await tool('act_click', { tabId, ref: refOf(snap, '"Get file"') });
  t = await dl;
  ok('download.done event arrives', /download\.done/.test(t.text), t.text);
  t = await tool('downloads_list');
  ok('downloads_list shows it', /webmcp-live/.test(t.text), t.text.slice(0, 300));

  t = await timed(() => tool('tab_navigate', { tabId, url: F('/slow'), waitForLoad: true }));
  ok('slow page load is waited for', t.json?.loadComplete === true && t.ms >= 2500, `${t.ms}ms ${t.text}`);

  // Pause mid-command: the wait stops right away and later commands say why.
  await tool('tab_navigate', { tabId, url: F('/'), waitForLoad: true });
  const w = timed(() => tool('act_wait', { tabId, text: 'never appears', timeoutMs: 20000 }));
  await sleep(700);
  await ext(`browser.runtime.sendMessage({ type: 'set-paused', paused: true })`);
  t = await w;
  ok('pausing stops a running command', t.ms < 5000 && t.isError, `${t.ms}ms ${t.text}`);
  t = await tool('tabs_list');
  ok('commands while paused are refused with a reason', t.isError && /PAUSED/.test(t.text), t.text);
  await ext(`browser.runtime.sendMessage({ type: 'set-paused', paused: false })`);
  t = await tool('tabs_list');
  ok('resume works', !t.isError, t.text);

  // A client that gives up: the command stops in Firefox too.
  const ac = new AbortController();
  const gone = client.callTool({ name: 'act_wait', arguments: { tabId, text: 'never', timeoutMs: 20000 } }, undefined, { signal: ac.signal }).catch((e) => e);
  await sleep(700);
  ac.abort();
  await gone;
  t = await timed(() => tool('page_info', { tabId }));
  ok('after a client cancels, the next command is not stuck behind it', t.ms < 3000 && !t.isError, `${t.ms}ms ${t.text}`);
}

async function robustness() {
  // A URL typed the way people type them.
  let t = await tool('tab_create', { url: `127.0.0.1:${fixtures.address().port}/`, waitForLoad: true });
  ok('tab_create accepts a URL without a scheme', t.json?.loadComplete === true && /^http:/.test(t.json?.url || ''), t.text);
  const tabId = t.json?.id;
  t = await tool('tab_navigate', { tabId, url: 'example.invalid', waitForLoad: true, timeoutMs: 10000 });
  ok('tab_navigate without a scheme is understood', !/Illegal|invalid url/i.test(t.text), t.text);

  // PDF in Firefox's viewer: add-ons can't script it; say so plainly.
  t = await tool('tab_navigate', { tabId, url: F('/doc.pdf'), waitForLoad: true });
  t = await tool('snapshot_ax', { tabId });
  ok('PDF tab gives a clear error', t.isError && /pdf/i.test(t.text), t.text);

  // A discarded (sleeping) tab.
  t = await tool('tab_create', { url: F('/'), waitForLoad: true, active: false });
  const sleepy = t.json?.id;
  await ext(`browser.tabs.discard(${sleepy})`);
  await sleep(500);
  if (process.env.DEBUG_DISCARD) {
    console.log('after discard', JSON.stringify(await ext(`browser.tabs.get(${sleepy}).then(t => ({ d: t.discarded, s: t.status, u: t.url }))`)));
    console.log('reload ->', JSON.stringify(await ext(`browser.tabs.reload(${sleepy}).then(() => 'ok', e => String(e))`)));
    await sleep(1500);
    console.log('after reload', JSON.stringify(await ext(`browser.tabs.get(${sleepy}).then(t => ({ d: t.discarded, s: t.status, u: t.url }))`)));
  }
  t = await tool('snapshot_ax', { tabId: sleepy });
  ok('snapshot of a discarded tab wakes it and works', !t.isError && /Click me/.test(t.text), t.text.slice(0, 300));

  // Several commands at once, on different tabs.
  const many = await Promise.all([1, 2, 3, 4, 5].map(() => tool('snapshot_ax', { tabId: sleepy })).concat([tool('tabs_list'), tool('page_info', { tabId: sleepy })]));
  ok('parallel commands all succeed', many.every((x) => !x.isError), many.filter((x) => x.isError).map((x) => x.text).join(' | '));

  // Text too big for one native message.
  await tool('tab_navigate', { tabId: sleepy, url: F('/chat'), waitForLoad: true });
  const cs = (await tool('snapshot_ax', { tabId: sleepy })).text;
  t = await tool('act_type', { tabId: sleepy, ref: refOf(cs, 'textbox "Message"'), text: 'x'.repeat(1_200_000) });
  ok('oversized input is refused with a clear error', t.isError && /too large|1 MB|PAYLOAD/i.test(t.text), t.text.slice(0, 300));

  // A new token: the old one stops working at once, the new one works.
  const oldToken = (await ext(`browser.runtime.sendMessage({ type: 'get-status' })`)).token;
  const st = await ext(`browser.runtime.sendMessage({ type: 'regenerate-token' })`);
  const res = await fetch(st.url, { method: 'POST', headers: { Authorization: `Bearer ${oldToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  ok('old token is refused after regenerating', res.status === 401, res.status);
  await client.close();
  client = new Client({ name: 'live-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(st.url), { requestInit: { headers: { Authorization: `Bearer ${st.token}` } } }));
  t = await tool('tabs_list');
  ok('new token works', !t.isError, t.text);

  // The helper dies: Firefox starts it again and the same URL and token work.
  if (!flag('--installed') && process.platform !== 'win32') {
    spawnSync('pkill', ['-f', `${path.join(root, 'mcp-server/dist/host.js')}`]);
    const back = await until(async () => { const r = await tool('tabs_list').catch((e) => ({ isError: true, text: String(e) })); return !r.isError && r; }, 30000, 'helper back').catch((e) => ({ isError: true, text: String(e) }));
    ok('helper restarts after a crash and keeps serving', !back.isError, back.text);
  }
}

async function realSites() {
  let t = await tool('tab_create', { url: 'https://en.wikipedia.org/wiki/Main_Page', waitForLoad: true, timeoutMs: 30000 });
  const tabId = t.json?.id;
  let snap = (await tool('snapshot_ax', { tabId })).text;
  const search = refOf(snap, '(searchbox|combobox|textbox) "Search Wikipedia');
  ok('wikipedia: search box found', !!search, snap.slice(0, 600));
  t = await tool('act_type', { tabId, ref: search, text: 'Firefox', submit: true });
  await tool('act_wait', { tabId, text: 'Mozilla', timeoutMs: 15000 });
  t = await tool('page_info', { tabId });
  ok('wikipedia: search submitted', /Firefox/.test(t.json?.title || ''), `${t.text}`);

  t = await tool('tab_navigate', { tabId, url: 'https://html.duckduckgo.com/html/', waitForLoad: true, timeoutMs: 30000 });
  snap = (await tool('snapshot_ax', { tabId })).text;
  const q = refOf(snap, '(searchbox|textbox|combobox)');
  t = await tool('act_type', { tabId, ref: q, text: 'webmcp controller firefox', submit: true });
  await tool('act_wait', { tabId, selector: '.result, .results', timeoutMs: 15000 });
  t = await tool('page_text', { tabId, maxChars: 2000 });
  ok('duckduckgo: results page', /result|webmcp/i.test(t.text), t.text.slice(0, 300));

  t = await tool('tab_navigate', { tabId, url: 'https://github.com/hamb1y/webmcp-controller', waitForLoad: true, timeoutMs: 30000 });
  snap = (await tool('snapshot_ax', { tabId })).text;
  const rel = refOf(snap, 'link "WebMCP Controller helper v');
  ok('github: release link in snapshot', !!rel, snap.slice(0, 600));
  if (rel) {
    t = await tool('act_click', { tabId, ref: rel });
    const url = await until(async () => { const u = (await tool('page_info', { tabId })).json?.url || ''; return /releases/.test(u) && u; }, 15000, 'release page').catch((e) => String(e));
    ok('github: click navigated to the release', /releases\/tag/.test(url), `${t.text} ${url}`);
  }
}

let code = 0;
try {
  const s = await start();
  popupCtx = s.ctx;
  if (arg('--dump')) {
    // Debug aid: write what the agent would see for one URL.
    const t = await tool('tab_create', { url: arg('--dump'), waitForLoad: true, timeoutMs: 30000 });
    if (process.env.DUMP_DELAY) await sleep(Number(process.env.DUMP_DELAY));
    const snap = await tool('snapshot_ax', { tabId: t.json?.id });
    writeFileSync(path.join(tmp, '..', 'webmcp-dump.txt'), snap.text);
    console.log(`wrote ${path.join(tmp, '..', 'webmcp-dump.txt')} (${snap.text.length} chars)`);
  } else {
    if (!process.env.ONLY_REAL) { await scenario(); await edges(); await robustness(); }
    if (flag('--real')) await realSites();
  }
} catch (e) {
  failed++;
  console.error(`FAIL harness: ${e.stack || e}`);
} finally {
  console.log(`\n${passed} passed, ${failed} failed`);
  code = failed ? 1 : 0;
  try { await client?.close(); } catch {}
  try { bidi?.ws.close(); } catch {}
  try { ff?.kill(); } catch {}
  fixtures?.close();
  await sleep(1500);
  if (!flag('--keep')) rmSync(tmp, { recursive: true, force: true });
  else console.log(`kept ${tmp}`);
}
process.exit(code);
