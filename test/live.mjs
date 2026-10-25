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
  '/spin': `<title>Spin</title><div id="sp" role="status">Loading…</div><script>setTimeout(() => document.getElementById('sp').remove(), 1500)</script>`,
  '/names': `<title>Names</title><button onclick="document.title='first'">Save</button><button onclick="document.title='second'">Save</button>
        <label>City <input oninput="document.title='city:'+this.value"></label>
        <canvas width="200" height="100" onclick="document.title='canvas:'+event.offsetX+','+event.offsetY" style="position:absolute;left:0;top:200px"></canvas>`,
  // A cross-origin frame (the second fixture server), like a cookie banner or embedded sign-in.
  '/xo': `<title>xo</title><p>Outer page</p><iframe src="{{XO}}/xoinner" title="Consent" width="500" height="260" style="position:absolute;left:0;top:60px;border:0"></iframe>
        <script>addEventListener('message', (e) => { document.title = 'xo:' + e.data; });</script>`,
  '/xoinner': `<title>inner</title><h2>We value your privacy</h2><p>Consent text inside the frame</p>
        <button onclick="parent.postMessage('accepted', '*')">Accept all</button>
        <button onclick="parent.postMessage('rejected', '*')">Reject</button>
        <input aria-label="Frame email" oninput="parent.postMessage('typed:' + this.value, '*')">
        <div id="pt" style="position:absolute;left:300px;top:150px;width:100px;height:60px;background:#eee" onclick="parent.postMessage('point:' + event.offsetX + ',' + event.offsetY, '*')">Point</div>`,
  '/closed': `<title>Closed</title><x-closed></x-closed><script>customElements.define('x-closed', class extends HTMLElement {
        connectedCallback() { const r = this.attachShadow({ mode: 'closed' }); r.innerHTML = '<button>Closed inside</button>';
        r.querySelector('button').onclick = () => document.title = 'closed clicked'; } });</script>`,
  '/clicky': `<title>Clicky</title><style>.b{cursor:pointer;padding:4px;display:inline-block}</style>
        <ul><li><span>Order 1</span> <div class="b" data-k="e1">Edit</div> <div class="b" data-k="d1">Delete</div></li>
        <li><span>Order 2</span> <div class="b" data-k="e2">Edit</div> <div class="b" data-k="d2">Delete</div></li></ul>
        <div class="b" id="ic" aria-hidden="false"><svg width="16" height="16"><title>Close panel</title><rect width="16" height="16"/></svg></div>
        <script>document.querySelectorAll('.b').forEach((b) => b.addEventListener('click', () => { document.title = 'clicky:' + (b.dataset.k || b.id); }));</script>`,
  '/typing': `<title>Typing</title><input aria-label="City" autocomplete="off"><ul id="sug"></ul><input aria-label="Phone">
        <div><input maxlength="1" aria-label="Code 1"><input maxlength="1" aria-label="Code 2"><input maxlength="1" aria-label="Code 3"></div>
        <script>const [c, ph] = document.querySelectorAll('input');
        c.addEventListener('keyup', () => { document.getElementById('sug').innerHTML = c.value.length > 1 ? '<li role="option">' + c.value + ' Central</li>' : ''; });
        ph.addEventListener('keydown', (e) => { if (e.key.length === 1) { e.preventDefault(); if (/[0-9]/.test(e.key)) { const d = (ph.value.replace(/[^0-9]/g, '') + e.key).slice(0, 10);
          ph.value = d.length > 6 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : d; document.title = 'phone:' + ph.value; } } });
        const codes = [...document.querySelectorAll('[maxlength]')]; codes.forEach((i, k) => i.addEventListener('input', () => { if (i.value && codes[k + 1]) codes[k + 1].focus(); document.title = 'code:' + codes.map((x) => x.value).join(''); }));</script>`,
  // A click listener React-style: on the element's own expando, no cursor style, no role.
  '/fw': `<title>fw</title><div id="r">React row</div><div id="v">Vue row</div><script>
        const r = document.getElementById('r'); r.__reactProps$abc = { onClick: () => { document.title = 'fw:react'; } }; r.addEventListener('click', () => r.__reactProps$abc.onClick());
        const v = document.getElementById('v'); v._vei = { onClick: () => { document.title = 'fw:vue'; } }; v.addEventListener('click', () => v._vei.onClick());</script>`,
  '/modal': `<title>Modal</title><button>Behind</button><dialog id="d"><h2>Confirm order</h2><button onclick="d.close(); document.title='closed'">Close</button></dialog>
        <script>d.showModal()</script>`,
  '/md': `<title>MD</title><main><h1>Guide</h1><p>Read the <a href="/docs">docs</a> first.</p><ul><li>One</li><li>Two <b>bold</b></li></ul>
        <table><tr><th>Plan</th><th>Price</th></tr><tr><td>Pro</td><td>$5</td></tr></table></main>`,
  '/drop': `<title>Drop</title><div draggable="true" id="card" style="width:80px;height:40px">Card</div>
        <div id="zone" style="width:200px;height:100px;margin-top:40px" ondragover="event.preventDefault()" ondrop="event.preventDefault(); document.title='dropped'">Zone</div>
        <input type="file" aria-label="Attachment" onchange="this.files[0].text().then((t) => document.title='file:'+this.files[0].name+':'+t)">`,
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
    const body = PAGES[pth]?.replace('{{XO}}', globalThis.XO_ORIGIN || '');
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

let ff, bidi, fixtures, fixtures2, client;
async function start() {
  installHelper();
  fixtures = await fixtureServer();
  fixtures2 = await fixtureServer();
  globalThis.XO_ORIGIN = `http://127.0.0.1:${fixtures2.address().port}`;
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
  ok('lists 45 tools', tools.tools.length === 45, tools.tools.length);

  let t = await tool('extension_status');
  ok('extension_status says connected', /connected/i.test(t.text) && !t.isError, t.text);

  await tool('thought', { thought: 'Opening the fixture' });
  t = await tool('tab_create', { url: F('/').replace(/^http:\/\//, ''), waitForLoad: true });
  const tabId = t.json?.id;
  ok('tab_create adds http:// to an address without a scheme and waits for load', t.json?.loadComplete === true && tabId, t.text);

  t = await tool('tab_query', { query: '*' });
  ok('tab_query * includes the new tab', Array.isArray(t.json) && t.json.some((x) => x.id === tabId), t.text);

  t = await tool('tab_query', { query: 'HOME' });
  ok('tab_query by title text', Array.isArray(t.json) && t.json.some((x) => x.id === tabId), t.text);
  t = await tool('tab_query', { urlPattern: '127\\.0\\.0\\.1' });
  ok('tab_query by url', Array.isArray(t.json) && t.json.some((x) => x.id === tabId), t.text);

  t = await tool('tab_query', { urlPattern: '(a+)+' });
  ok('tab_query rejects catastrophic regex', t.isError || /not supported/.test(t.text), t.text);

  t = await tool('tab_check_active');
  ok('tab_check_active is the new tab', t.json?.id === tabId, t.text);

  t = await tool('page_snapshot', { tabId });
  const snap = t.text;
  ok('snapshot has refs', /\[ref=\d+\] button "Click me"/.test(snap), snap.slice(0, 500));
  ok('snapshot marks disabled', /button "Can't touch"[^\n]*\[disabled\]/.test(snap), snap.slice(0, 800));

  t = await tool('page_click', { tabId, ref: refOf(snap, '"Click me"') });
  ok('page_click', /clicked/.test(t.text) && (await title(tabId)) === 'clicked', t.text);

  t = await tool('page_click', { tabId, ref: refOf(snap, `"Can't touch"`) });
  ok('page_click refuses disabled', t.isError && /DISABLED/.test(t.text), t.text);

  t = await tool('page_text', { tabId });
  ok('page_text excludes hidden', /quick brown fox/.test(t.text) && !/secret fox/.test(t.text), t.text.slice(0, 300));

  t = await tool('page_find', { tabId, query: 'fox' });
  ok('page_find counts visible occurrences', /"count": 2/.test(t.text), t.text);

  t = await tool('page_html', { tabId, selector: 'h1' });
  ok('page_html selector', /<h1>Fixture home<\/h1>/.test(t.text) && /url:/i.test(t.text), t.text);

  t = await tool('page_screenshot', { tabId });
  ok('page_screenshot returns an image', (t.r.content || []).some((c) => c.type === 'image' && c.data.length > 1000), JSON.stringify(t.r.content?.map((c) => c.type)));

  // Forms
  t = await tool('tab_navigate', { tabId, url: F('/form'), waitForLoad: true });
  ok('tab_navigate waits for load', t.json?.loadComplete === true, t.text);
  const fs1 = (await tool('page_snapshot', { tabId })).text;
  t = await tool('page_fill', { tabId, fields: [{ ref: refOf(fs1, 'textbox "Name"'), value: 'Ada' }, { ref: refOf(fs1, 'combobox'), value: 'us' }, { ref: refOf(fs1, 'checkbox "Agree"'), value: 'true' }], submit: true });
  ok('page_fill + submit (select is exact-value-first, case-insensitive fallback)', (await title(tabId)) === 'submitted:Ada:US:yes', `${t.text} title=${await title(tabId)}`);
  t = await tool('page_select', { tabId, ref: refOf(fs1, 'combobox'), values: ['g'] });
  ok('page_select refuses disabled optgroup', t.isError, t.text);
  t = await tool('page_type', { tabId, ref: refOf(fs1, 'textbox "Bio"') ?? refOf(fs1, 'textbox[^\\n]*readonly'), text: 'x' });
  ok('page_type refuses read-only', t.isError && /read-only|NOT_EDITABLE/.test(t.text), t.text);

  // Chat composer: exactly one send
  await tool('tab_navigate', { tabId, url: F('/chat'), waitForLoad: true });
  const cs = (await tool('page_snapshot', { tabId })).text;
  t = await tool('page_type', { tabId, ref: refOf(cs, 'textbox "Message"'), text: 'hello', submit: true });
  await sleep(400);
  ok('chat submit sends exactly once', (await title(tabId)) === 'sent 1: hello', `${t.text} title=${await title(tabId)}`);

  // Keys
  t = await tool('page_click', { tabId, ref: refOf(cs, 'textbox "Message"') });
  t = await tool('page_key', { tabId, key: 'a' });
  ok('page_key types a printable key', /typed/.test(t.text), t.text);
  t = await tool('page_key', { tabId, key: 'a', modifiers: ['Ctrl'] });
  ok('page_key Ctrl+A selects all', /selected all/.test(t.text), t.text);

  // Scroll + wait + shadow + fragment
  await tool('tab_navigate', { tabId, url: F('/long'), waitForLoad: true });
  t = await tool('page_scroll', { tabId, to: 'bottom' });
  ok('page_scroll to bottom', /"atEnd": true/.test(t.text), t.text);
  await tool('tab_navigate', { tabId, url: F('/late'), waitForLoad: true });
  t = await tool('page_wait', { tabId, text: 'Arrived late', timeoutMs: 5000 });
  ok('page_wait sees late content', /"found": true/.test(t.text), t.text);
  await tool('tab_navigate', { tabId, url: F('/shadow'), waitForLoad: true });
  const ss = (await tool('page_snapshot', { tabId })).text;
  t = await tool('page_click', { tabId, ref: refOf(ss, '"Inside shadow"') });
  ok('click inside open shadow root', (await title(tabId)) === 'shadow clicked', `${t.text} ${ss.slice(0, 300)}`);
  await tool('tab_navigate', { tabId, url: F('/frag'), waitForLoad: true });
  const t0 = Date.now();
  t = await tool('tab_navigate', { tabId, url: F('/frag#sec'), waitForLoad: true });
  ok('fragment navigation returns at once', t.json?.loadComplete === true && Date.now() - t0 < 5000, t.text);

  // Targets without refs, waits for things to go, chunked text
  await tool('tab_navigate', { tabId, url: F('/names'), waitForLoad: true });
  t = await tool('page_click', { tabId, name: 'Save', role: 'button' });
  ok('two buttons with one name: AMBIGUOUS lists both', t.isError && /AMBIGUOUS/.test(t.text), t.text);
  t = await tool('page_click', { tabId, name: 'Save', role: 'button', nth: 2 });
  ok('name + role + nth clicks the second', (await title(tabId)) === 'second', t.text);
  t = await tool('page_type', { tabId, name: 'City', text: 'Oslo' });
  ok('page_type by label', (await title(tabId)) === 'city:Oslo', t.text);
  ok('actions report what changed', /changes/.test(t.text), t.text);
  t = await tool('page_click', { tabId, x: 50, y: 250 });
  ok('page_click at x,y (canvas)', /^canvas:/.test(await title(tabId) ?? ''), `${t.text} title=${await title(tabId)}`);
  t = await tool('page_click', { tabId });
  ok('page_click with no target is refused clearly', t.isError && /needs an element/.test(t.text), t.text);
  await tool('tab_navigate', { tabId, url: F('/spin'), waitForLoad: true });
  t = await tool('page_wait', { tabId, text: 'Loading…', gone: true, timeoutMs: 6000 });
  ok('page_wait gone:true waits for a spinner to go', !t.isError, t.text);
  await tool('tab_navigate', { tabId, url: F('/long'), waitForLoad: true });
  t = await tool('page_text', { tabId, maxChars: 500 });
  ok('page_text chunks long pages', /more follows/.test(t.text) && /offset: \d+/.test(t.text), t.text.slice(-200));
  const next = Number(/offset: (\d+)/.exec(t.text)?.[1]);
  t = await tool('page_text', { tabId, maxChars: 500, offset: next });
  ok('page_text offset continues', /chars \d+-\d+ of \d+/.test(t.text) && !/Paragraph 0\b/.test(t.text), t.text.slice(0, 200));
  t = await tool('page_snapshot', { tabId, within: { selector: '#p5' }, compact: false });
  ok('page_snapshot within one region', /Paragraph 5/.test(t.text) && !/Paragraph 6\b/.test(t.text), t.text.slice(0, 300));
  t = await tool('page_screenshot', { tabId, selector: '#bottom', format: 'jpeg', scale: 0.5 });
  ok('element screenshot as jpeg', (t.r.content || []).some((c) => c.type === 'image' && c.mimeType === 'image/jpeg'), t.text);
  await tool('tab_navigate', { tabId, url: F('/drop'), waitForLoad: true });
  t = await tool('page_drag', { tabId, name: 'Card', toSelector: '#zone' });
  ok('page_drag onto a drop zone', (await title(tabId)) === 'dropped', `${t.text} title=${await title(tabId)}`);
  t = await tool('page_upload', { tabId, name: 'Attachment', files: [{ name: 'a.txt', text: 'hi', mimeType: 'text/plain' }] });
  await sleep(200);
  ok('page_upload sets a file input', (await title(tabId)) === 'file:a.txt:hi', `${t.text} title=${await title(tabId)}`);

  // Navigation history
  t = await tool('tab_navigate', { tabId, go: 'back' });
  ok('tab_navigate go back', !t.isError, t.text);
  t = await tool('tab_navigate', { tabId, go: 'forward' });
  ok('tab_navigate go forward', !t.isError, t.text);
  t = await tool('tab_navigate', { tabId, go: 'reload' });
  ok('tab_navigate go reload', !t.isError, t.text);

  // Tab management
  t = await tool('tab_create', { duplicateOf: tabId });
  const dupId = t.json?.id;
  ok('tab_create duplicateOf', !!dupId && dupId !== tabId, t.text);
  t = await tool('tab_pin', { tabId: dupId });
  ok('tab_pin', t.json?.pinned === true, t.text);
  t = await tool('tab_pin', { tabId: dupId, pinned: false });
  ok('tab_pin pinned:false unpins', t.json?.pinned === false, t.text);
  t = await tool('tab_mute', { tabId: dupId });
  ok('tab_mute', t.json?.muted === true, t.text);
  t = await tool('tab_focus', { tabId });
  ok('tab_focus', !t.isError, t.text);
  t = await tool('tab_close', { tabIds: [dupId] });
  ok('tab_close needs confirm', t.isError && /confirm/.test(t.text), t.text);
  t = await tool('tab_close', { tabIds: [dupId], confirm: true });
  ok('tab_close with confirm', !t.isError, t.text);

  // Windows
  t = await tool('window_query');
  ok('window_query', Array.isArray(t.json) && t.json.length >= 1, t.text);
  t = await tool('window_create', { url: F('/') });
  const winId = t.json?.id;
  ok('window_create', !!winId, t.text);
  t = await tool('window_focus', { windowId: winId });
  ok('window_focus', !t.isError, t.text);
  t = await tool('window_close', { windowId: winId, confirm: true });
  ok('window_close', !t.isError, t.text);

  // Browser data
  t = await tool('bookmark_create', { title: 'Live test mark', url: F('/') });
  const bmId = t.json?.id;
  ok('bookmark_create', !!bmId, t.text);
  t = await tool('bookmark_query', { query: 'Live test mark' });
  ok('bookmark_query', Array.isArray(t.json) && t.json.some((b) => b.id === bmId), t.text);
  t = await tool('bookmark_remove', { id: bmId, confirm: true });
  ok('bookmark_remove', !t.isError, t.text);
  t = await tool('history_query', { query: '127.0.0.1' });
  ok('history_query', Array.isArray(t.json), t.text);
  t = await tool('download_query');
  ok('download_query', Array.isArray(t.json), t.text);
  t = await tool('cookie_set', { tabId, name: 'livetest', value: 'v1', expiresInSeconds: 600 });
  ok('cookie_set', !t.isError && t.json?.set === true, t.text);
  t = await tool('cookie_query', { tabId, name: 'livetest' });
  ok('cookie_query sees it', t.json?.cookies?.some((c) => c.name === 'livetest' && c.value === 'v1'), t.text);
  t = await tool('cookie_remove', { tabId, name: 'livetest', confirm: true });
  ok('cookie_remove', t.json?.removed >= 1, t.text);
  t = await tool('storage_set', { key: 'live/test', value: { n: 1, list: ['a'] } });
  ok('storage_set (agent)', !t.isError, t.text);
  t = await tool('storage_get', { key: 'live/test' });
  ok('storage_get (agent) returns the JSON', t.json?.found === true && t.json?.value?.list?.[0] === 'a', t.text);
  t = await tool('storage_get', { prefix: 'live/' });
  ok('storage_get lists keys by prefix', t.json?.keys?.some((k) => k.key === 'live/test'), t.text);
  t = await tool('storage_remove', { key: 'live/test' });
  ok('storage_remove (agent)', t.json?.removed === true, t.text);
  t = await tool('storage_set', { area: 'local', tabId, key: 'lt', value: 'page-value' });
  t = await tool('storage_get', { area: 'local', tabId, key: 'lt' });
  ok('page localStorage round trip', t.json?.value === 'page-value', t.text);
  t = await tool('session_query');
  ok('session_query', Array.isArray(t.json) && t.json.length > 0, t.text);
  const sid = t.json?.[0]?.tab?.sessionId ?? t.json?.[0]?.window?.sessionId;
  t = await tool('session_restore', { sessionId: sid });
  ok('session_restore', !t.isError, t.text);

  // Meta
  t = await tool('thought', { thought: 'Hello from the live test', tabId });
  ok('thought', !t.isError, t.text);
  const waitP = tool('event_wait', { types: ['tab.updated'], timeoutMs: 15000 });
  await sleep(300);
  await tool('tab_navigate', { tabId, go: 'reload' });
  t = await waitP;
  ok('event_wait sees a reload', !t.isError && /tab\.updated/.test(t.text), t.text);

  // Restricted pages
  await tool('tab_navigate', { tabId, url: 'about:blank', waitForLoad: true });
  t = await tool('page_snapshot', { tabId });
  ok('restricted page error is clear', t.isError && /RESTRICTED_PAGE/.test(t.text), t.text);
}

async function timed(fn) { const t0 = Date.now(); const r = await fn(); r.ms = Date.now() - t0; return r; }
let popupCtx = null;
const ext = (expr) => bidi.evaluate(popupCtx, expr);

async function edges() {
  let t = await tool('tab_create', { url: F('/alert'), waitForLoad: true });
  const tabId = t.json?.id;
  let snap = (await tool('page_snapshot', { tabId })).text;
  t = await timed(() => tool('page_click', { tabId, ref: refOf(snap, '"Warn me"') }));
  ok('click that opens an alert returns promptly', t.ms < 8000, `${t.ms}ms ${t.text}`);
  ok('click that opens an alert says so', /alert|dialog/i.test(t.text), t.text);
  t = await timed(() => tool('page_snapshot', { tabId }));
  ok('page with an open alert: next call is prompt and explains', t.ms < 8000 && /alert|dialog/i.test(t.text), `${t.ms}ms ${t.text.slice(0, 300)}`);

  await tool('tab_navigate', { tabId, url: F('/confirm'), waitForLoad: true });
  snap = (await tool('page_snapshot', { tabId })).text;
  t = await timed(() => tool('page_click', { tabId, ref: refOf(snap, '"Delete"') }));
  ok('click that opens confirm() returns promptly', t.ms < 8000, `${t.ms}ms ${t.text}`);

  t = await timed(() => tool('tab_navigate', { tabId, url: F('/leave'), waitForLoad: true }));
  snap = (await tool('page_snapshot', { tabId })).text;
  await tool('page_type', { tabId, ref: refOf(snap, 'textbox "Draft"'), text: 'unsaved' });
  t = await timed(() => tool('tab_navigate', { tabId, url: F('/'), waitForLoad: true, timeoutMs: 8000 }));
  ok('navigating away from a page with a leave prompt returns and explains', t.ms < 12000 && (t.json?.loadComplete === true || /leave|unload|prompt|dialog/i.test(t.text)), `${t.ms}ms ${t.text.slice(0, 300)}`);

  t = await tool('tab_create', { url: F('/blank'), waitForLoad: true });
  const blankTab = t.json?.id;
  snap = (await tool('page_snapshot', { tabId: blankTab })).text;
  const before = (await tool('tab_query')).json.length;
  t = await tool('page_click', { tabId: blankTab, ref: refOf(snap, 'link "Open home') });
  await sleep(800);
  const after = (await tool('tab_query')).json.length;
  ok('target=_blank click opens a tab', after === before + 1, `${before} -> ${after}`);
  ok('target=_blank click tells the agent about the new tab', /new tab|tabId|opened/i.test(t.text), t.text);

  await tool('tab_navigate', { tabId, url: F('/editor'), waitForLoad: true });
  snap = (await tool('page_snapshot', { tabId })).text;
  t = await tool('page_type', { tabId, ref: refOf(snap, 'textbox "Editor"'), text: 'Hello editor' });
  ok('page_type into contenteditable', (await title(tabId)) === 'ed:Hello editor', `${t.text} title=${await title(tabId)}`);

  await tool('tab_navigate', { tabId, url: F('/react'), waitForLoad: true });
  snap = (await tool('page_snapshot', { tabId })).text;
  t = await tool('page_type', { tabId, ref: refOf(snap, 'textbox "Controlled"'), text: 'abc' });
  ok('page_type into a React-style controlled input', /^react:abc:/.test(await title(tabId)), `${t.text} title=${await title(tabId)}`);

  await tool('tab_navigate', { tabId, url: F('/iframe'), waitForLoad: true });
  snap = (await tool('page_snapshot', { tabId })).text;
  ok('snapshot tells the agent an iframe is there', /\] (iframe|frame)\b[^\n]*Inner frame/i.test(snap), snap.slice(0, 400));

  await tool('tab_navigate', { tabId, url: F('/hover'), waitForLoad: true });
  snap = (await tool('page_snapshot', { tabId })).text;
  await tool('page_hover', { tabId, ref: refOf(snap, '"Menu"') });
  snap = (await tool('page_snapshot', { tabId })).text;
  ok('page_hover opens a JS menu', /link "Item"/.test(snap), snap.slice(0, 300));

  await tool('tab_navigate', { tabId, url: F('/big'), waitForLoad: true });
  t = await timed(() => tool('page_snapshot', { tabId, maxChars: 2000 }));
  ok('small snapshot of a huge page is fast and says it is truncated', t.ms < 3000 && /truncated/i.test(t.text), `${t.ms}ms ${t.text.slice(-300)}`);
  t = await timed(() => tool('page_snapshot', { tabId }));
  ok('full snapshot of a huge page stays under the native-message limit', !t.isError, `${t.ms}ms ${t.text.slice(0, 300)}`);

  await tool('tab_navigate', { tabId, url: F('/download'), waitForLoad: true });
  snap = (await tool('page_snapshot', { tabId })).text;
  const dl = tool('event_wait', { types: ['download.done'], timeoutMs: 15000 });
  await sleep(200);
  await tool('page_click', { tabId, ref: refOf(snap, '"Get file"') });
  t = await dl;
  ok('download.done event arrives', /download\.done/.test(t.text), t.text);
  t = await tool('download_query', { query: 'webmcp-live' });
  ok('download_query shows where it landed', /webmcp-live/.test(t.json?.[0]?.path ?? ''), t.text.slice(0, 300));
  t = await tool('download_start', { url: F('/file.txt'), filename: 'foxhand-live/started.txt' });
  ok('download_start waits and returns the path', t.json?.state === 'complete' && /started/.test(t.json?.path ?? ''), t.text);

  t = await timed(() => tool('tab_navigate', { tabId, url: F('/slow'), waitForLoad: true }));
  ok('slow page load is waited for', t.json?.loadComplete === true && t.ms >= 2500, `${t.ms}ms ${t.text}`);

  // Pause mid-command: the wait stops right away and later commands say why.
  await tool('tab_navigate', { tabId, url: F('/'), waitForLoad: true });
  const w = timed(() => tool('page_wait', { tabId, text: 'never appears', timeoutMs: 20000 }));
  await sleep(700);
  await ext(`browser.runtime.sendMessage({ type: 'set-paused', paused: true })`);
  t = await w;
  ok('pausing stops a running command', t.ms < 5000 && t.isError, `${t.ms}ms ${t.text}`);
  t = await tool('tab_query');
  ok('commands while paused are refused with a reason', t.isError && /PAUSED/.test(t.text), t.text);
  await ext(`browser.runtime.sendMessage({ type: 'set-paused', paused: false })`);
  t = await tool('tab_query');
  ok('resume works', !t.isError, t.text);

  // A client that gives up: the command stops in Firefox too.
  const ac = new AbortController();
  const gone = client.callTool({ name: 'page_wait', arguments: { tabId, text: 'never', timeoutMs: 20000 } }, undefined, { signal: ac.signal }).catch((e) => e);
  await sleep(700);
  ac.abort();
  await gone;
  t = await timed(() => tool('page_info', { tabId }));
  ok('after a client cancels, the next command is not stuck behind it', t.ms < 3000 && !t.isError, `${t.ms}ms ${t.text}`);
}

/* The things real pages do that a plain DOM walk misses. */
async function pages() {
  let t = await tool('tab_create', { url: F('/xo'), waitForLoad: true });
  const tabId = t.json?.id;
  await sleep(500);
  let snap = (await tool('page_snapshot', { tabId })).text;
  const accept = refOf(snap, 'button "Accept all"');
  ok('snapshot includes a cross-origin frame\'s content', !!accept && accept >= 10000000 && /Consent[^\n]*frame content follows/.test(snap), snap.slice(0, 600));
  t = await tool('page_click', { tabId, ref: accept });
  ok('page_click by ref inside a cross-origin frame', (await title(tabId)) === 'xo:accepted', t.text);
  t = await tool('page_click', { tabId, name: 'Reject' });
  ok('page_click by name finds a button inside a cross-origin frame', (await title(tabId)) === 'xo:rejected' && /frame/i.test(t.text), t.text);
  t = await tool('page_type', { tabId, name: 'Frame email', text: 'a@b.c' });
  ok('page_type by name inside a cross-origin frame', (await title(tabId)) === 'xo:typed:a@b.c', t.text);
  t = await tool('page_click', { tabId, x: 320, y: 220 });
  ok('page_click at a point over a cross-origin frame clicks inside it', /^xo:point:/.test(await title(tabId)), `${t.text} ${await title(tabId)}`);
  t = await tool('page_text', { tabId });
  ok('page_text includes a cross-origin frame\'s text', /Outer page/.test(t.text) && /Consent text inside the frame/.test(t.text), t.text.slice(0, 400));
  t = await tool('page_find', { tabId, query: 'value your privacy' });
  ok('page_find searches cross-origin frames', /value your privacy/.test(t.text) && /"ref": ?\d{8,}/.test(t.text), t.text.slice(0, 400));

  await tool('tab_navigate', { tabId, url: F('/closed'), waitForLoad: true });
  snap = (await tool('page_snapshot', { tabId })).text;
  ok('snapshot sees into closed shadow roots', /button "Closed inside"/.test(snap), snap);
  t = await tool('page_click', { tabId, name: 'Closed inside' });
  ok('page_click inside a closed shadow root', (await title(tabId)) === 'closed clicked', t.text);

  await tool('tab_navigate', { tabId, url: F('/clicky'), waitForLoad: true });
  snap = (await tool('page_snapshot', { tabId })).text;
  ok('script-only clickable divs show up', /clickable "Edit"/.test(snap) && /clickable "Close panel"/.test(snap), snap);
  ok('rows group their controls', /listitem "Order 2[^\n]*\n\s+\[ref=\d+\] clickable "Edit"/.test(snap), snap);
  const del2 = (() => { const i = snap.indexOf('listitem "Order 2'); return refOf(snap.slice(i), 'clickable "Delete"'); })();
  t = await tool('page_click', { tabId, ref: del2 });
  ok('clicking a script-only div by ref', (await title(tabId)) === 'clicky:d2', t.text);
  t = await tool('page_click', { tabId, name: 'Close panel' });
  ok('clicking an icon-only control by its svg title', (await title(tabId)) === 'clicky:ic', t.text);

  await tool('tab_navigate', { tabId, url: F('/fw'), waitForLoad: true });
  snap = (await tool('page_snapshot', { tabId })).text;
  ok('React and Vue click handlers make a div clickable', /clickable "React row"/.test(snap) && /clickable "Vue row"/.test(snap), snap);
  await tool('page_click', { tabId, name: 'Vue row' });
  ok('clicking a framework-handled div', (await title(tabId)) === 'fw:vue', await title(tabId));

  await tool('tab_navigate', { tabId, url: F('/typing'), waitForLoad: true });
  t = await tool('page_type', { tabId, name: 'City', text: 'Oslo' });
  ok('typing fires key events (autocomplete appears)', /Oslo Central/.test(t.text), t.text);
  t = await tool('page_type', { tabId, name: 'Phone', text: '5551234567' });
  ok('typing into a masked field', (await title(tabId)) === 'phone:(555) 123-4567', `${t.text} ${await title(tabId)}`);
  t = await tool('page_type', { tabId, name: 'Code 1', text: '123' });
  ok('typing a code into one-box-per-digit fields', (await title(tabId)) === 'code:123' && /3 fields/.test(t.text), `${t.text} ${await title(tabId)}`);
  await tool('tab_navigate', { tabId, url: F('/names'), waitForLoad: true });
  t = await tool('page_click', { tabId, name: 'Save changes', waitMs: 0 });
  ok('a name that isn\'t there lists the closest ones', t.isError && /REF_NOT_FOUND/.test(t.text) && /Closest on the page:[\s\S]*button "Save"/.test(t.text), t.text);

  await tool('tab_navigate', { tabId, url: F('/modal'), waitForLoad: true });
  snap = (await tool('page_snapshot', { tabId })).text;
  ok('snapshot header warns about an open modal', /MODAL OPEN: \[ref=\d+\] dialog "Confirm order"/.test(snap), snap.slice(0, 400));
  await tool('page_click', { tabId, name: 'Close' });

  await tool('tab_navigate', { tabId, url: F('/md'), waitForLoad: true });
  t = await tool('page_text', { tabId, format: 'markdown' });
  ok('page_text markdown keeps headings, links, lists and tables', /# Guide/.test(t.text) && /\[docs\]\(\/docs\)/.test(t.text) && /- Two \*\*bold\*\*/.test(t.text) && /\| Pro \| \$5 \|/.test(t.text), t.text);

  const nav = tool('page_wait', { tabId, urlContains: '/form', timeoutMs: 8000 });
  await sleep(300);
  await tool('tab_navigate', { tabId, url: F('/form'), waitForLoad: false });
  t = await nav;
  ok('page_wait urlContains waits for a navigation', t.json?.found === true, t.text);

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
  t = await tool('page_snapshot', { tabId });
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
  t = await tool('page_snapshot', { tabId: sleepy });
  ok('snapshot of a discarded tab wakes it and works', !t.isError && /Click me/.test(t.text), t.text.slice(0, 300));

  // Several commands at once, on different tabs.
  const many = await Promise.all([1, 2, 3, 4, 5].map(() => tool('page_snapshot', { tabId: sleepy })).concat([tool('tab_query'), tool('page_info', { tabId: sleepy })]));
  ok('parallel commands all succeed', many.every((x) => !x.isError), many.filter((x) => x.isError).map((x) => x.text).join(' | '));

  // Text too big for one native message.
  await tool('tab_navigate', { tabId: sleepy, url: F('/chat'), waitForLoad: true });
  const cs = (await tool('page_snapshot', { tabId: sleepy })).text;
  t = await tool('page_type', { tabId: sleepy, ref: refOf(cs, 'textbox "Message"'), text: 'x'.repeat(1_200_000) });
  ok('oversized input is refused with a clear error', t.isError && /too large|1 MB|PAYLOAD/i.test(t.text), t.text.slice(0, 300));

  // A new token: the old one stops working at once, the new one works.
  const oldToken = (await ext(`browser.runtime.sendMessage({ type: 'get-status' })`)).token;
  const st = await ext(`browser.runtime.sendMessage({ type: 'regenerate-token' })`);
  const res = await fetch(st.url, { method: 'POST', headers: { Authorization: `Bearer ${oldToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  ok('old token is refused after regenerating', res.status === 401, res.status);
  await client.close();
  client = new Client({ name: 'live-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(st.url), { requestInit: { headers: { Authorization: `Bearer ${st.token}` } } }));
  t = await tool('tab_query');
  ok('new token works', !t.isError, t.text);

  // The helper dies: Firefox starts it again and the same URL and token work.
  if (!flag('--installed') && process.platform !== 'win32') {
    spawnSync('pkill', ['-f', `${path.join(root, 'mcp-server/dist/host.js')}`]);
    const back = await until(async () => { const r = await tool('tab_query').catch((e) => ({ isError: true, text: String(e) })); return !r.isError && r; }, 30000, 'helper back').catch((e) => ({ isError: true, text: String(e) }));
    ok('helper restarts after a crash and keeps serving', !back.isError, back.text);
  }
}

async function realSites() {
  let t = await tool('tab_create', { url: 'https://en.wikipedia.org/wiki/Main_Page', waitForLoad: true, timeoutMs: 30000 });
  const tabId = t.json?.id;
  let snap = (await tool('page_snapshot', { tabId })).text;
  const search = refOf(snap, '(searchbox|combobox|textbox) "Search Wikipedia');
  ok('wikipedia: search box found', !!search, snap.slice(0, 600));
  t = await tool('page_type', { tabId, ref: search, text: 'Firefox', submit: true });
  await tool('page_wait', { tabId, text: 'Mozilla', timeoutMs: 15000 });
  t = await tool('page_info', { tabId });
  ok('wikipedia: search submitted', /Firefox/.test(t.json?.title || ''), `${t.text}`);

  t = await tool('tab_navigate', { tabId, url: 'https://html.duckduckgo.com/html/', waitForLoad: true, timeoutMs: 30000 });
  snap = (await tool('page_snapshot', { tabId })).text;
  const q = refOf(snap, '(searchbox|textbox|combobox)');
  t = await tool('page_type', { tabId, ref: q, text: 'webmcp controller firefox', submit: true });
  await tool('page_wait', { tabId, selector: '.result, .results', timeoutMs: 15000 });
  t = await tool('page_text', { tabId, maxChars: 2000 });
  ok('duckduckgo: results page', /result|webmcp/i.test(t.text), t.text.slice(0, 300));

  t = await tool('tab_navigate', { tabId, url: 'https://github.com/hamb1y/webmcp-controller', waitForLoad: true, timeoutMs: 30000 });
  snap = (await tool('page_snapshot', { tabId })).text;
  const rel = refOf(snap, 'link "WebMCP Controller helper v');
  ok('github: release link in snapshot', !!rel, snap.slice(0, 600));
  if (rel) {
    t = await tool('page_click', { tabId, ref: rel });
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
    const snap = await tool('page_snapshot', { tabId: t.json?.id });
    writeFileSync(path.join(tmp, '..', 'webmcp-dump.txt'), snap.text);
    console.log(`wrote ${path.join(tmp, '..', 'webmcp-dump.txt')} (${snap.text.length} chars)`);
  } else if (arg('--steps')) {
    // Debug aid: run tool calls from a JSON file of [tool, args] pairs. In args, "$tab" is the
    // tab from the first tab_create and "$ref:<regex>" is the first ref in the last snapshot whose line matches.
    const steps = JSON.parse(readFileSync(arg('--steps'), 'utf8'));
    let tabId = null, last = '';
    for (const [name, raw] of steps) {
      if (name === 'sleep') { await sleep(raw); continue; }
      const args = JSON.parse(JSON.stringify(raw ?? {}), (k, v) => {
        if (v === '$tab') return tabId;
        if (typeof v === 'string' && v.startsWith('$ref:')) return refOf(last, v.slice(5));
        return v;
      });
      const t0 = Date.now();
      const t = await tool(name, args);
      t.ms = Date.now() - t0;
      if (name === 'tab_create' && tabId === null) tabId = t.json?.id;
      if (name === 'page_snapshot') last = t.text;
      console.log(`### ${name} ${JSON.stringify(args)}${t.isError ? ' ERROR' : ''} (${t.ms}ms)\n${t.text.slice(0, Number(process.env.STEP_CHARS || 2500))}\n`);
    }
  } else {
    if (!process.env.ONLY_REAL) { await scenario(); await edges(); await pages(); await robustness(); }
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
  fixtures2?.close();
  await sleep(1500);
  if (!flag('--keep')) rmSync(tmp, { recursive: true, force: true });
  else console.log(`kept ${tmp}`);
}
process.exit(code);
