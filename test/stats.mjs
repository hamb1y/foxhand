// Usage counts: the add-on's report (built stats.js in a vm) and the Worker's counters, stats JSON,
// token protection, download counting and feedback rules (real SQLite through a small D1 stand-in).
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import worker from '../cloudflare/worker.mjs';

/* ---------------------------------------------------------- D1 stand-in */
function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync('cloudflare/migrations/0001_stats.sql', 'utf8'));
  db.exec(readFileSync('cloudflare/migrations/0002_clicks.sql', 'utf8'));
  db.exec(readFileSync('cloudflare/migrations/0003_used.sql', 'utf8'));
  const statement = (sql, args = []) => ({
    bind: (...a) => statement(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => { db.prepare(sql).run(...args); return { success: true }; },
    all: async () => ({ results: db.prepare(sql).all(...args) }),
  });
  return { db, prepare: sql => statement(sql), batch: async list => { const out = []; for (const s of list) out.push(await s.all()); return out; } };
}
const assets = { async fetch(request) {
  const p = new URL(request.url).pathname;
  if (p === '/download/latest.json') return Response.json({ version: '0.6.0' });
  return new Response('page ' + p, { status: 200 });
} };
const TOKEN = 'secret-token-for-tests';
const mkEnv = (extra = {}) => ({ ASSETS: assets, DB: makeDb(), STATS_TOKEN: TOKEN, ...extra });
const call = (env, path, init) => worker.fetch(new Request('https://foxhand.pages.dev' + path, init), env, { waitUntil: p => p });
const post = (env, path, body, headers = { 'Content-Type': 'application/json' }) => call(env, path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
const auth = { Authorization: 'Bearer ' + TOKEN };
const ID = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const PING = { id: ID(1), v: '0.6.0', os: 'linux', stage: 0, reason: 'missing', harnesses: ['claude-code', 'codex'], picked: 'claude-code', used: false };
const TODAY = new Date().toISOString().slice(0, 10);
const daysAgo = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

/* ---------------------------------------------------------- Worker: reports */
let env = mkEnv();
assert.equal((await post(env, '/endpoint/ping', PING)).status, 204);
// the same install again the same day: still one active install; the stage only goes up, the pick follows the latest report
assert.equal((await post(env, '/endpoint/ping', { ...PING, stage: 2, reason: null, harnesses: ['claude-code'], picked: 'codex', used: true })).status, 204);
assert.equal((await post(env, '/endpoint/ping', { ...PING, stage: 1, reason: null, harnesses: [] })).status, 204);
assert.equal((await post(env, '/endpoint/ping', { ...PING, id: ID(2), os: 'win', stage: 1, reason: null, harnesses: ['codex'], picked: null })).status, 204);
let stats = await (await call(env, '/endpoint/stats', { headers: auth })).json();
assert.equal(stats.installs, 2);
assert.deepEqual(stats.funnel, { installed: 2, helper: 2, command: 1 }, 'highest stage per install');
assert.deepEqual(stats.daily, [{ day: TODAY, n: 2, used: 1 }], 'distinct installs per day; used stays set once any report that day had it');
assert.deepEqual(stats.rolling, { mau: 2, aau7: 1, aau30: 1 }, 'AAU: installs with a command, not just a report');
assert.equal(stats.months[0].n, 2); assert.ok(!('years' in stats) && !('aau' in stats.rolling));
assert.deepEqual(stats.byOs.map(x => [x.name, x.n]).sort(), [['linux', 1], ['win', 1]]);
assert.deepEqual(stats.harnesses.map(h => [h.name, h.picked, h.used30]).sort(), [['claude-code', 1, 1], ['codex', 0, 2]], 'distinct installs per kind; picks from the latest report');
assert.equal(stats.stuck.length, 0, 'nobody is at stage 0 any more');
assert.ok(!JSON.stringify(stats).includes(ID(1)) && !JSON.stringify(stats).includes('0000-4000'), 'no install ID in the stats JSON');
assert.equal(stats.feedback.total, 0);
for (const bad of [
  { ...PING, extra: 1 }, { ...PING, url: 'https://x' }, { ...PING, v: '1.2' }, { ...PING, os: 'beos' }, { ...PING, stage: 3 }, { ...PING, stage: '1' },
  { ...PING, reason: 'oops: C:\\Users\\me' }, { ...PING, harnesses: ['Claude Code 1.2.3'] }, { ...PING, harnesses: ['codex', 'codex'] }, { ...PING, picked: 'gemini' }, { ...PING, picked: undefined },
  { ...PING, id: undefined }, { ...PING, used: undefined }, { ...PING, used: 'yes' }, { ...PING, used: 1 }, { ...PING, id: 'not-a-uuid' }, { ...PING, id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }, { ...PING, id: '00000000-0000-1000-8000-000000000003' }, { ...PING, id: '00000000-0000-4000-c000-000000000003' },
  { ...PING, id: ID(3) + ' ' }, { ...PING, id: 5 }, [], 'text', null, { v: 'x'.repeat(600) },
]) assert.equal((await post(env, '/endpoint/ping', bad)).status, 400, JSON.stringify(bad).slice(0, 70));
assert.equal((await post(env, '/endpoint/ping', '{not json')).status, 400);
assert.equal((await call(env, '/endpoint/ping')).status, 405, 'GET is refused');
const { db } = env.DB;
for (const table of ['users', 'activity', 'harness_use', 'downloads', 'feedback', 'limits', 'clicks']) {
  const cols = db.prepare('PRAGMA table_info(' + table + ')').all().map(c => c.name).join();
  assert.ok(!/\bip\b|agent|addr|\bua\b/i.test(cols), table + ' has no address or agent column: ' + cols);
}
assert.ok(!db.prepare('PRAGMA table_info(feedback)').all().some(c => c.name === 'id' && false) && !db.prepare('PRAGMA table_info(feedback)').all().some(c => /uuid|user/i.test(c.name)), 'feedback carries no install ID');
// metrics from first_day / activity: rolling windows, calendar months, stuck age, retention
env = mkEnv();
const put = (id, first, last, stage, reason, os = 'linux', v = '0.6.0') => env.DB.db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?,NULL)').run(ID(id), first, last, v, os, stage, reason);
const act = (id, d, used = 0) => env.DB.db.prepare('INSERT INTO activity (day, id, used) VALUES (?,?,?)').run(d, ID(id), used);
put(10, daysAgo(40), daysAgo(40), 0, 'missing'); act(10, daysAgo(40));                                   // stuck, 40 days old, gone
put(11, daysAgo(40), daysAgo(1), 2, null, 'mac'); for (const d of [40, 39, 33, 10, 1]) act(11, daysAgo(d), d === 39 || d === 10 || d === 1 ? 1 : 0); // kept on day 1 and 7
put(12, daysAgo(0), daysAgo(0), 0, 'noanswer'); act(12, daysAgo(0));                                      // stuck, day 0
put(13, daysAgo(200), daysAgo(100), 1, null, 'win', '0.5.9'); act(13, daysAgo(200)); act(13, daysAgo(100));  // only in the 365-day window
put(14, daysAgo(2), daysAgo(0), 1, null); act(14, daysAgo(2)); act(14, daysAgo(0), 1);
stats = await (await call(env, '/endpoint/stats', { headers: auth })).json();
assert.equal(stats.installs, 5);
assert.deepEqual(stats.funnel, { installed: 5, helper: 3, command: 1 });
assert.equal(stats.rolling.mau, 3, 'ids active in the last 30 days: 11, 12, 14');
assert.deepEqual([stats.rolling.aau7, stats.rolling.aau30], [2, 2], 'ids with a command in the last 7 / 30 days: 11 and 14');
assert.equal(stats.daily.find(d => d.day === TODAY).used, 1);
assert.equal(stats.daily.find(d => d.day === TODAY).n, 2);
assert.deepEqual(stats.stuck.map(s => [s.reason, s.age, s.n]).sort(), [['missing', '7+', 1], ['noanswer', '0', 1]]);
assert.deepEqual(stats.retention.map(r => [r.day, r.cohort, r.kept, r.keptUsed]), [[1, 4, 1, 1], [7, 3, 1, 0], [30, 3, 1, 1]], 'retention: cohort and active-again counts');
assert.deepEqual(stats.byVersion.map(v => [v.name, v.n]), [['0.6.0', 3]], 'versions of installs active in the last 30 days');
assert.equal(stats.firsts.reduce((a, x) => a + x.n, 0), 4, 'installs by first day, last 90 days');
// hourly ceiling: further reports are dropped without an error
env = mkEnv();
const hour = new Date().toISOString().slice(0, 13);
env.DB.db.prepare('INSERT INTO limits (kind, hour, n) VALUES (?, ?, ?)').run('ping', hour, 5000);
await post(env, '/endpoint/ping', PING);
assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0, 'over the ceiling: not counted');
console.log('ok  reports: one row per install, distinct counting, rolling windows, retention, stuck, validation, no address columns, ceiling');

/* ---------------------------------------------------------- token protection */
env = mkEnv({ STATS_TOKEN: undefined });
for (const p of ['/stats', '/stats/', '/stats/login', '/endpoint/stats']) assert.equal((await call(env, p)).status, 404, p + ' without a configured token');
env = mkEnv();
assert.equal((await call(env, '/endpoint/stats')).status, 401);
assert.equal((await call(env, '/endpoint/stats', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
assert.equal((await call(env, '/endpoint/stats', { headers: { Authorization: 'Bearer ' + TOKEN + 'x' } })).status, 401);
let r = await call(env, '/stats');
assert.equal(r.status, 303); assert.equal(r.headers.get('Location'), '/stats/login');
r = await post(env, '/stats/login', 'token=nope', { 'Content-Type': 'application/x-www-form-urlencoded' });
assert.equal(r.headers.get('Location'), '/stats/login?wrong=1'); assert.equal(r.headers.get('Set-Cookie'), null);
r = await post(env, '/stats/login', 'token=' + TOKEN, { 'Content-Type': 'application/x-www-form-urlencoded' });
const cookie = /fxstats=[0-9a-f]{64}/.exec(r.headers.get('Set-Cookie'))[0];
assert.match(r.headers.get('Set-Cookie'), /HttpOnly; Secure; SameSite=Strict/);
assert.ok(!r.headers.get('Set-Cookie').includes(TOKEN), 'the cookie is not the token');
r = await call(env, '/stats', { headers: { Cookie: cookie } });
assert.equal(r.status, 200);
assert.match(r.headers.get('Content-Security-Policy'), /script-src 'nonce-/);
const nonce = /nonce-([^']+)'/.exec(r.headers.get('Content-Security-Policy'))[1];
assert.ok(!(await r.text()).includes('__NONCE__') || nonce);
assert.equal((await call(env, '/endpoint/stats', { headers: { Cookie: cookie } })).status, 200);
assert.equal((await call(env, '/endpoint/stats', { headers: { Cookie: 'fxstats=' + '0'.repeat(64) } })).status, 401);
console.log('ok  token: 404 without one, 401/redirect with a wrong one, bearer and cookie work');

/* ---------------------------------------------------------- downloads */
env = mkEnv();
for (let i = 0; i < 3; i++) await call(env, '/download/0.6.0/foxhand-host-linux-x64');
await call(env, '/download/0.6.0/foxhand-host-linux-x64', { method: 'HEAD' });
await call(env, '/download/latest/SHA256SUMS');
await call(env, '/download/0.6.0/evil.exe');
stats = await (await call(env, '/endpoint/stats', { headers: auth })).json();
const byName = Object.fromEntries(stats.downloads.assets.map(a => [a.name, a.n]));
assert.deepEqual(byName, { 'foxhand-host-linux-x64': 3 }, 'GET redirects counted once, HEAD / latest hop / rejects not');
env.DB.prepare = () => { throw new Error('db down'); };
assert.equal((await call(env, '/download/0.6.0/foxhand-host-linux-x64')).status, 302, 'a database failure never breaks a download');
console.log('ok  download redirects counted per day and asset');

/* ---------------------------------------------------------- outbound links */
env = mkEnv();
let hop = await call(env, '/go/github?from=site');
assert.equal(hop.status, 302);
assert.equal(hop.headers.get('Location'), 'https://github.com/hamb1y/foxhand');
await call(env, '/go/github?from=site');
await call(env, '/go/github?from=site', { method: 'HEAD' });
assert.equal((await call(env, '/go/amo?from=https://evil.example')).headers.get('Location'), 'https://addons.mozilla.org/firefox/addon/foxhand/');
hop = await call(env, '/go/issue?from=addon&title=Helper%20stuck&body=v0.6.0&to=https://evil.example');
assert.equal(hop.headers.get('Location'), 'https://github.com/hamb1y/foxhand/issues/new?title=Helper+stuck&body=v0.6.0', 'only title, body and labels pass through');
for (const bad of ['/go/', '/go/evil', '/go/https://evil.example', '/go/__proto__', '/go/github/extra']) assert.equal((await call(env, bad)).status, 404, bad);
stats = await (await call(env, '/endpoint/stats', { headers: auth })).json();
assert.deepEqual(Object.fromEntries(stats.clicks.map(c => [c.target + ':' + c.src, c.n])), { 'github:site': 2, 'amo:other': 1, 'issue:addon': 1 }, 'GET counted per target and source; unknown sources become other; HEAD not counted');
env.DB.prepare = () => { throw new Error('db down'); };
assert.equal((await call(env, '/go/github?from=site')).status, 302, 'a database failure never breaks a link');
console.log('ok  /go redirects: fixed targets only, counted per day, target and source');

/* ---------------------------------------------------------- feedback */
env = mkEnv();
const fb = (body, headers) => post(env, '/endpoint/feedback', body, headers);
assert.equal((await fb({ text: 'Setup failed.', v: '0.6.0', os: 'mac', s: 0, r: 'missing', page: 'uninstalled' })).status, 200);
r = await fb('text=Hello+there&v=0.6.0&os=win&page=feedback', { 'Content-Type': 'application/x-www-form-urlencoded' });
assert.equal(r.status, 303); assert.equal(r.headers.get('Location'), '/feedback?sent=1');
assert.equal((await fb({ text: 'bot', website: 'x' })).status, 200);
assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM feedback').get().n, 2, 'the hidden field catches bots');
for (const bad of [{ text: '' }, { text: '   ' }, { text: 5 }, { text: 'x'.repeat(2001) }, { text: '<script>alert(1)</script>' }, { text: 'a <b>b</b>' }, { text: 'x\u0000y' }, { text: 'rtl \u202e' }, { text: '\ud800' }, {}, []]) assert.equal((await fb(bad)).status, 400, JSON.stringify(bad).slice(0, 40));
assert.equal((await fb('x'.repeat(9000), { 'Content-Type': 'application/json' })).status, 413);
assert.equal((await fb('text=hi', { 'Content-Type': 'text/html' })).status, 415);
assert.equal((await fb({ text: 'a < b and c > d, 5 < 6' })).status, 200, 'plain comparison signs are fine');
const row = env.DB.db.prepare('SELECT * FROM feedback WHERE id = 1').get();
assert.deepEqual({ ...row, at: undefined }, { id: 1, at: undefined, v: '0.6.0', os: 'mac', stage: '0', reason: 'missing', body: 'Setup failed.' });
assert.match(row.at, /^\d{4}-\d\d-\d\d$/);
env.DB.db.prepare("UPDATE limits SET n = 20 WHERE kind = 'feedback'").run();
assert.equal((await fb({ text: 'too many' })).status, 429);
assert.equal((await call(env, '/endpoint/stats', { headers: auth }).then(x => x.json())).feedback.items.length, 3);
env = mkEnv();
assert.equal((await post(env, '/endpoint/feedback', { text: 'hi' })).status, 200);
assert.equal((await (await call(env, '/endpoint/stats')).status), 401, 'feedback text is behind the token');
console.log('ok  feedback: plain text only, length cap, bots, rate limit, stored and shown with the token');

/* ---------------------------------------------------------- the add-on's report */
const code = readFileSync('build/extension/stats.js', 'utf8');
function addon({ granted = true, store = {}, os = 'linux', fail = false, version = '0.6.0' } = {}) {
  const sent = [], listeners = {}, uninstall = [], timers = [];
  const state = { granted };
  let n = 0;
  const context = vm.createContext({
    browser: {
      runtime: {
        getManifest: () => ({ version }), getPlatformInfo: async () => ({ os }),
        setUninstallURL: async url => { uninstall.push(url); },
        onInstalled: { addListener: fn => { listeners.installed = fn; } },
      },
      permissions: { getAll: async () => (state.granted ? { permissions: [], origins: [], data_collection: ['technicalAndInteraction'] } : { permissions: [], origins: [] }),
        onAdded: { addListener: fn => { listeners.added = fn; } }, onRemoved: { addListener: fn => { listeners.removed = fn; } } },
      storage: { local: { get: async keys => Object.fromEntries(keys.filter(k => k in store).map(k => [k, store[k]])), set: async o => { Object.assign(store, o); } },
        onChanged: { addListener: fn => { listeners.changed = fn; } } },
    },
    crypto: { randomUUID: () => crypto.randomUUID() },
    fetch: async (url, init) => { sent.push({ url, init }); if (fail) throw new Error('offline'); return new Response(null, { status: 204 }); },
    AbortController, setTimeout: (fn, ms) => { timers.push([fn, ms]); return 1; }, clearTimeout() {}, setInterval: () => 1, Date, JSON, encodeURIComponent,
  });
  vm.runInContext(code, context);
  return { sent, store, state, uninstall, listeners, tick: () => timers.find(t => t[1] === 20000)[0](), settle: () => new Promise(r => setImmediate(r)) };
}
const wait = async a => { await a.settle(); await a.settle(); await new Promise(r => setTimeout(r, 20)); };
const ALLOWED = ['harnesses', 'id', 'os', 'picked', 'reason', 'stage', 'used', 'v'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let a = addon();
a.listeners.installed({ reason: 'install' });
await wait(a);
assert.equal(a.sent.length, 1);
assert.equal(a.sent[0].url, 'https://foxhand.pages.dev/endpoint/ping');
assert.equal(a.sent[0].init.credentials, 'omit'); assert.equal(a.sent[0].init.referrerPolicy, 'no-referrer'); assert.equal(a.sent[0].init.method, 'POST');
let body = JSON.parse(a.sent[0].init.body);
assert.deepEqual(Object.keys(body).sort(), ALLOWED, 'only the allowed fields');
assert.match(body.id, UUID); assert.equal(a.store.statsId, body.id, 'the ID is kept locally');
assert.deepEqual({ ...body, id: 0 }, { id: 0, v: '0.6.0', os: 'linux', stage: 0, reason: 'unknown', harnesses: [], picked: null, used: false });
assert.ok(!/https?:|token|port|localhost|tab/i.test(a.sent[0].init.body), 'nothing about browsing, token or ports');
a.tick(); await wait(a);
assert.equal(a.sent.length, 1, 'at most one report per day');
const id = body.id;
// a later day: same ID, new stage, harness kinds once
a.store.statsStage = 2; a.store.statsLast = '2000-01-01'; a.store.statsHarnesses = ['codex', 'bogus', 'claude-code']; a.store.statsPicked = 'codex'; a.store.statsUsed = true;
a.tick(); await wait(a);
body = JSON.parse(a.sent[1].init.body);
assert.deepEqual(body, { id, v: '0.6.0', os: 'linux', stage: 2, reason: null, harnesses: ['claude-code', 'codex'], picked: 'codex', used: true });
assert.equal(a.store.statsUsed, false, 'cleared after a successful report');
assert.equal(JSON.stringify(a.store.statsHarnesses), '[]', 'reported kinds are cleared');
// permission off: nothing is sent, the ID stays, turning it back on keeps the same ID
a = addon({ granted: false });
a.listeners.installed({ reason: 'install' }); a.tick(); await wait(a);
assert.equal(a.sent.length, 0, 'nothing is sent while the permission is not granted');
const kept = a.store.statsId; assert.match(kept, UUID);
assert.equal(a.uninstall.at(-1), 'https://foxhand.pages.dev/uninstalled', 'the uninstall page carries nothing without the permission');
a.state.granted = true; a.tick(); await wait(a);
assert.equal(a.sent.length, 1, 'sends once it is granted (checked at send time)');
assert.equal(JSON.parse(a.sent[0].init.body).id, kept, 'the same ID, not a new user');
a.state.granted = false; a.store.statsLast = '2000-01-01'; a.tick(); await wait(a);
assert.equal(a.sent.length, 1, 'revoked again: nothing more');
// an update from an older version (no ID stored) gets one on first run; a stored ID is never replaced; junk IDs are replaced
a = addon({ store: { statsStage: 1 } }); a.tick(); await wait(a);
body = JSON.parse(a.sent[0].init.body);
assert.match(body.id, UUID); assert.equal(body.stage, 1); assert.equal(body.reason, null);
a = addon({ store: { statsId: ID(7) } }); a.tick(); await wait(a);
assert.equal(JSON.parse(a.sent[0].init.body).id, ID(7));
a = addon({ store: { statsId: 'whatever' } }); a.tick(); await wait(a);
assert.match(JSON.parse(a.sent[0].init.body).id, UUID);
// failed sends are retried, not marked done
a = addon({ fail: true }); a.listeners.installed({ reason: 'install' }); await wait(a);
assert.equal(a.store.statsLast, undefined, 'a failed report is not recorded');
// uninstall URL: version, OS, stage and reason only
a = addon({ os: 'win', store: { statsStage: 0, statsReason: 'noanswer' } }); a.tick(); await wait(a);
const u = new URL(a.uninstall.at(-1));
assert.equal(u.origin + u.pathname, 'https://foxhand.pages.dev/uninstalled');
assert.deepEqual([...u.searchParams.keys()].sort(), ['os', 'r', 's', 'v']);
assert.equal(u.searchParams.get('r'), 'noanswer'); assert.equal(u.searchParams.get('s'), '0'); assert.equal(u.searchParams.get('os'), 'win');
assert.ok(!a.uninstall.at(-1).includes(a.store.statsId) && a.uninstall.every(x => x.length <= 1023));
a.store.statsStage = 2; a.listeners.changed({ statsStage: {} }, 'local'); await wait(a);
assert.ok(!new URL(a.uninstall.at(-1)).searchParams.has('r') && new URL(a.uninstall.at(-1)).searchParams.get('s') === '2', 'the uninstall URL follows the stage');
const shared = await import('../shared/dist/protocol.js');
assert.deepEqual([...shared.HARNESSES].sort(), ['antigravity', 'chatgpt-desktop', 'claude-code', 'claude-desktop', 'codex', 'cursor', 'mcp-remote', 'omp', 'openclaw', 'opencode', 'other', 'pi']);
assert.equal(shared.harnessOf(undefined), 'other'); assert.equal(shared.harnessOf({}), 'other'); assert.equal(shared.harnessOf('Gemini CLI'), 'other');
console.log('ok  add-on: payload fields, random ID kept, one report a day, permission checked at send time, retry, uninstall URL');
