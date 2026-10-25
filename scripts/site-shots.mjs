// Screenshots for the website (site/shots/), taken from the real thing: real Firefox, this
// add-on and its helper, driven over MCP on a real website, like test/live.mjs does.
//
//   node scripts/site-shots.mjs [--firefox /path/to/firefox] [--headful]
//
// Needs `npm run build` and network access. Firefox gets a throwaway profile and HOME, so
// your own profile and helper are untouched. The bearer token is masked before any capture.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'site/shots');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const PORT = 8912, BIDI_PORT = 9334;
const UUID = '6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const EXT_ID = 'webmcp-controller@hamb1y.github.io';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms, what) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(250); }
  throw new Error(`timed out waiting for ${what}: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

class Bidi {
  constructor(url) { this.url = url; this.id = 0; this.wait = new Map(); }
  open() {
    this.ws = new WebSocket(this.url);
    this.ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id === undefined || !this.wait.has(msg.id)) return;
      const { res, rej } = this.wait.get(msg.id); this.wait.delete(msg.id);
      msg.type === 'error' ? rej(new Error(`${msg.error}: ${msg.message}`)) : res(msg.result);
    };
    return new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error('BiDi connect failed')); });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.wait.set(id, { res, rej }));
  }
  async evaluate(context, expression) {
    const r = await this.send('script.evaluate', { expression, target: { context }, awaitPromise: true, resultOwnership: 'none', serializationOptions: { maxObjectDepth: 4 } });
    if (r.type === 'exception') throw new Error(`evaluate: ${r.exceptionDetails?.text}`);
    return r.result?.type === 'object' ? Object.fromEntries(r.result.value.map(([k, v]) => [k, v.value])) : r.result?.value;
  }
}

const tmp = mkdtempSync(path.join(tmpdir(), 'foxhand-shots-'));
const profile = path.join(tmp, 'profile'), home = path.join(tmp, 'home');
const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CONFIG_HOME: path.join(home, '.config') };
let ff, bidi, client, token;

async function start() {
  const r = spawnSync(process.execPath, [path.join(root, 'mcp-server/dist/host.js'), 'install'], { env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`helper install failed: ${r.stderr}`);
  mkdirSync(profile, { recursive: true });
  writeFileSync(path.join(profile, 'user.js'), [
    `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ [EXT_ID]: UUID }))});`,
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.startup.homepage_override.mstone", "ignore");',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("browser.aboutwelcome.enabled", false);',
    'user_pref("intl.locale.requested", "en-US");',
    'user_pref("layout.css.prefers-color-scheme.content-override", 0);',
  ].join('\n'));
  const args = ['-profile', profile, '-no-remote', '--remote-debugging-port', String(BIDI_PORT), '-remote-allow-system-access'];
  if (!process.argv.includes('--headful')) args.unshift('-headless');
  const bin = arg('--firefox') ?? process.env.FIREFOX ?? '/usr/bin/firefox';
  if (!existsSync(bin)) throw new Error(`Firefox not found at ${bin}; pass --firefox`);
  ff = spawn(bin, args, { env: { ...env, MOZ_HEADLESS_WIDTH: '1100', MOZ_HEADLESS_HEIGHT: '1500' }, stdio: 'ignore' });
  await until(async () => { bidi = new Bidi(`ws://127.0.0.1:${BIDI_PORT}/session`); await bidi.open(); return true; }, 90000, 'Firefox');
  await bidi.send('session.new', { capabilities: {} });
  await bidi.send('webExtension.install', { extensionData: { type: 'path', path: path.join(root, 'extension') } });
  const ctx = (await bidi.send('browsingContext.create', { type: 'tab' })).context;
  await bidi.send('browsingContext.navigate', { context: ctx, url: `moz-extension://${UUID}/popup.html`, wait: 'complete' });
  await until(() => bidi.evaluate(ctx, `browser.runtime.sendMessage({ type: 'get-status' })`), 20000, 'add-on');
  await bidi.evaluate(ctx, `browser.runtime.sendMessage({ type: 'set-config', port: ${PORT} })`);
  const st = await until(async () => {
    const s = await bidi.evaluate(ctx, `browser.runtime.sendMessage({ type: 'get-status' })`);
    return s && s.listening && s.port === PORT ? s : null;
  }, 45000, 'helper');
  token = st.token;
  client = new Client({ name: 'site-shots', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(st.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return ctx;
}

async function tool(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${name}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}
const refOf = (snap, re) => { const m = new RegExp(`\\[ref=(\\d+)\\][^\\n]*${re}`).exec(snap); if (!m) throw new Error(`no ref for ${re}`); return Number(m[1]); };

async function contextFor(urlPart) {
  const { contexts } = await bidi.send('browsingContext.getTree', { maxDepth: 0 });
  const c = contexts.find((x) => x.url.includes(urlPart));
  if (!c) throw new Error(`no tab with ${urlPart}`);
  return c.context;
}
async function viewport(context, width, height, dpr = 2) {
  await bidi.send('browsingContext.setViewport', { context, viewport: { width, height }, devicePixelRatio: dpr });
}
async function shot(context, name) {
  const { data } = await bidi.send('browsingContext.captureScreenshot', { context, origin: 'viewport' });
  const png = path.join(tmp, `${name}.png`);
  writeFileSync(png, Buffer.from(data, 'base64'));
  // WebP keeps the page light; the site serves these files as they are.
  const r = spawnSync('magick', [png, '-quality', '88', path.join(out, `${name}.webp`)]);
  if (r.status !== 0) throw new Error(`magick: ${r.stderr}`);
  console.log(`wrote site/shots/${name}.webp`);
}
// Never publish a bearer token, even a throwaway one; show the default port, not ours.
const mask = () => `(() => { for (const el of document.querySelectorAll('pre, code, input, textarea')) {
  const k = 'value' in el && el.tagName !== 'PRE' ? 'value' : 'textContent';
  el[k] = el[k].split(${JSON.stringify(token)}).join('YOUR-TOKEN').split(':${PORT}/').join(':8901/'); } })()`;

async function extShot(ctx, page, name, box, until = box, pad = 0) {
  await bidi.send('browsingContext.navigate', { context: ctx, url: `moz-extension://${UUID}/${page}`, wait: 'complete' });
  // A background tab never runs its transitions, so the page would be caught mid-way.
  await bidi.evaluate(ctx, `browser.tabs.getCurrent().then((t) => browser.tabs.update(t.id, { active: true })).then(() => 1)`);
  await sleep(1000);
  // The setup page's "Connect your AI" step turns green on the first command after it opens.
  await tool('tab_query', { query: '*' });
  await sleep(1500);
  await bidi.evaluate(ctx, mask());
  // Headless Firefox ignores window resizes: the window is sized at launch, and the shot is
  // cropped to the width of `box`, from the top of the page down to `until` (plus `pad`).
  const { data, x, y, w, h } = await bidi.evaluate(ctx, `(async () => {
    const tab = await browser.tabs.getCurrent();
    const r = document.querySelector(${JSON.stringify(box)}).getBoundingClientRect();
    const end = document.querySelector(${JSON.stringify(until)}).getBoundingClientRect().bottom;
    const data = (await browser.tabs.captureTab(tab.id, { format: 'png', scale: 2 })).split(',')[1];
    return { data, x: r.left * 2, y: 0, w: r.width * 2, h: Math.min(end + ${pad}, innerHeight) * 2 };
  })()`);
  const png = path.join(tmp, `${name}.png`);
  writeFileSync(png, Buffer.from(data, 'base64'));
  const r = spawnSync('magick', [png, '-crop', `${Math.round(w)}x${Math.round(h)}+${Math.round(x)}+${Math.round(y)}`, '+repage', '-quality', '88', path.join(out, `${name}.webp`)]);
  if (r.status !== 0) throw new Error(`magick: ${r.stderr}`);
  console.log(`wrote site/shots/${name}.webp`);
}

async function main() {
  mkdirSync(out, { recursive: true });
  const ext = await start();

  // 1. The AI cursor at work on a real site.
  await tool('tab_create', { url: 'https://en.wikipedia.org/wiki/Main_Page', waitForLoad: true });
  const wiki = await contextFor('wikipedia.org');
  await viewport(wiki, 1280, 800);
  await sleep(500);
  let snap = await tool('page_snapshot', {});
  await tool('thought', { thought: 'Looking up the red panda, the animal Firefox is named after' });
  await tool('page_type', { ref: refOf(snap, 'searchbox|combobox "Search'), text: 'Red panda', submit: true, generation: snap.generation });
  await until(async () => (await tool('page_info', {})).title?.startsWith('Red panda'), 20000, 'article');
  await sleep(1200);
  snap = await tool('page_snapshot', {});
  // The article's own heading: hovering a link would open Wikipedia's preview over everything.
  await tool('thought', { thought: 'Reading up on the red panda, the animal Firefox is named after' });
  await tool('page_hover', { ref: refOf(snap, 'heading "Red panda"') });
  await sleep(900);
  await shot(wiki, 'cursor');
  // Link previews (og:image): the title, the bubble and the photo, at 1200×630.
  const og = spawnSync('magick', [path.join(tmp, 'cursor.png'), '-resize', '1280x800', '-crop', '1200x630+40+40', '+repage', '-quality', '86', path.join(out, 'og.jpg')]);
  if (og.status !== 0) throw new Error(`magick: ${og.stderr}`);
  // Phones: the same capture, cropped to the title, cursor and bubble.
  const sm = spawnSync('magick', [path.join(tmp, 'cursor.png'), '-crop', '1520x950+520+170', '+repage', '-quality', '86', path.join(out, 'cursor-sm.webp')]);
  if (sm.status !== 0) throw new Error(`magick: ${sm.stderr}`);

  // 2. The setup page once everything is connected, and the popup. BiDi can't screenshot
  //    add-on pages, so the add-on captures its own tab.
  await extShot(ext, 'onboarding.html', 'setup', 'main', '#s2', 16);
  await extShot(ext, 'popup.html', 'popup', 'body');
}

main().then(() => 0, (e) => { console.error(e); return 1; }).then(async (code) => {
  try { await client?.close(); } catch {}
  ff?.kill();
  await sleep(500);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(code);
});
