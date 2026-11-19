// Pages advanced-mode worker: stable public URLs redirect to published GitHub assets, plus
// anonymous usage counters, a feedback inbox and a token-protected stats page backed by D1 (binding DB).
//
// The add-on's daily report and the feedback form are counted or stored here. No IP address, user agent
// or identifier is read, logged or stored: requests are only counted, and rate limits are global buckets.
const VERSION = /^\d+\.\d+\.\d+$/;
const ASSET = /^(?:(?:foxhand|webmcp)-host-(?:darwin|linux)-(?:arm64|x64)|(?:foxhand|webmcp)-host-windows-(?:arm64|x64)\.exe|SHA256SUMS|install\.sh|install\.ps1|foxhand\.zip)$/;
const error = (status, text) => new Response(text, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

// Open the stats page and its numbers to everyone: change this to true. Feedback texts stay behind the token.
const STATS_PUBLIC = false;

const REASONS = ['missing', 'old', 'noanswer', 'port', 'stopped', 'unknown'];
const OSES = ['win', 'mac', 'linux', 'other'];
const HARNESSES = ['claude-code', 'claude-desktop', 'codex', 'chatgpt-desktop', 'opencode', 'pi', 'omp', 'openclaw', 'antigravity', 'cursor', 'mcp-remote', 'other'];
const PING_KEYS = ['id', 'v', 'os', 'stage', 'reason', 'harnesses', 'picked', 'used', 'minutes'].sort().join();
// A random per-install ID (UUID v4, made by the add-on). It is stored only to count each install once; it is never shown or returned.
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Global per-hour ceilings (nobody's address is involved): they stop a flood from filling the database.
const LIMITS = { ping: 5000, feedback: 20, login: 40 };
const FEEDBACK_MAX = 2000;
// Outbound links go through /go/<target>?from=<where the link was>, so clicks can be counted. Fixed lists only.
const GO = {
  github: 'https://github.com/hamb1y/foxhand',
  amo: 'https://addons.mozilla.org/firefox/addon/foxhand/',
  issues: 'https://github.com/hamb1y/foxhand/issues',
  issue: 'https://github.com/hamb1y/foxhand/issues/new',
  releases: 'https://github.com/hamb1y/foxhand/releases',
  source: 'https://github.com/hamb1y/foxhand/tree/main'
};
const GO_FROM = ['site', 'readme', 'addon', 'amo', 'npm', 'brew', 'registry', 'hn', 'ph', 'reddit', 'post', 'other'];

const json = (status, body, extra = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra } });
const empty = (status, extra = {}) => new Response(null, { status, headers: { 'Cache-Control': 'no-store', ...extra } });
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const day = () => new Date().toISOString().slice(0, 10);

/* ----------------------------------------------------------- limits and auth */

// Counts requests per kind and hour. True while under the ceiling.
async function allow(env, kind) {
  const hour = new Date().toISOString().slice(0, 13);
  const row = await env.DB.prepare('INSERT INTO limits (kind, hour, n) VALUES (?, ?, 1) ON CONFLICT (kind, hour) DO UPDATE SET n = n + 1 RETURNING n').bind(kind, hour).first();
  if (row.n === 1) await env.DB.prepare('DELETE FROM limits WHERE hour < ?').bind(new Date(Date.now() - 48 * 3600e3).toISOString().slice(0, 13)).run();
  return row.n <= LIMITS[kind];
}

const encoder = new TextEncoder();
const sha256 = async text => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
// Constant time: both sides are hashed to the same length, then compared without an early exit.
async function sameSecret(given, expected) {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
const cookieFor = async token => hex(await sha256('foxhand-stats|' + token));

async function authed(request, env) {
  if (!env.STATS_TOKEN) return false;
  const bearer = /^Bearer (.+)$/.exec(request.headers.get('Authorization') || '')?.[1];
  if (bearer && await sameSecret(bearer, env.STATS_TOKEN)) return true;
  const cookie = /(?:^|; )fxstats=([0-9a-f]{64})(?:;|$)/.exec(request.headers.get('Cookie') || '')?.[1];
  return !!cookie && await sameSecret(cookie, await cookieFor(env.STATS_TOKEN));
}

/* ----------------------------------------------------------- the daily report */

function validPing(data) {
  if (!isObject(data) || Object.keys(data).sort().join() !== PING_KEYS) return null;
  const { id, v, os, stage, reason, harnesses, picked, used, minutes } = data;
  if (typeof used !== 'boolean' || !Number.isInteger(minutes) || minutes < 0 || minutes > 1440) return null;
  if (typeof id !== 'string' || !UUID_V4.test(id)) return null;
  if (typeof v !== 'string' || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v) || !OSES.includes(os)) return null;
  if (![0, 1, 2].includes(stage) || (reason !== null && !REASONS.includes(reason))) return null;
  if (!Array.isArray(harnesses) || harnesses.length > HARNESSES.length || new Set(harnesses).size !== harnesses.length || !harnesses.every(h => HARNESSES.includes(h))) return null;
  if (picked !== null && !HARNESSES.includes(picked)) return null;
  return { id, v, os, stage, reason, harnesses, picked, used, minutes };
}

async function readBody(request, limit) {
  if (Number(request.headers.get('Content-Length') || 0) > limit) return null;
  const text = await request.text();
  return encoder.encode(text).length > limit ? null : text;
}

async function ping(request, env) {
  if (!env.DB) return empty(503);
  const text = await readBody(request, 512);
  let data = null;
  try { data = validPing(JSON.parse(text)); } catch { /* rejected below */ }
  if (!data) return empty(400);
  if (!await allow(env, 'ping')) return empty(204); // over the hourly ceiling: drop quietly
  const today = day();
  // One row per install; the same ID counts once per day however often it reports. The stage only goes up.
  const statements = [
    env.DB.prepare(
      'INSERT INTO users (id, first_day, last_day, v, os, stage, reason, picked) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT (id) DO UPDATE SET last_day = excluded.last_day, v = excluded.v, os = excluded.os, ' +
      'stage = MAX(stage, excluded.stage), reason = excluded.reason, picked = excluded.picked'
    ).bind(data.id, today, today, data.v, data.os, data.stage, data.reason, data.picked),
    // A day counts as "used" if any report that day said an AI command ran; minutes add up over the day's reports (at most 1440).
    env.DB.prepare('INSERT INTO activity (day, id, used, minutes) VALUES (?, ?, ?, ?) ON CONFLICT (day, id) DO UPDATE SET used = MAX(used, excluded.used), minutes = MIN(1440, minutes + excluded.minutes)').bind(today, data.id, data.used ? 1 : 0, data.minutes)
  ];
  for (const kind of data.harnesses) statements.push(env.DB.prepare('INSERT OR IGNORE INTO harness_use (day, id, kind) VALUES (?, ?, ?)').bind(today, data.id, kind));
  await env.DB.batch(statements);
  return empty(204);
}

/* ----------------------------------------------------------- feedback */

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const MARKUP = /<\/?[a-z!][^>]*>/i;

// Plain text only: a string, no control or direction characters, no HTML tags, 1 to 2000 characters.
function cleanFeedback(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (!text || [...text].length > FEEDBACK_MAX || CONTROL.test(text) || LONE_SURROGATE.test(text) || MARKUP.test(text)) return null;
  return text;
}
const pick = (value, allowed) => (typeof value === 'string' && allowed.includes(value) ? value : '');

async function feedback(request, env) {
  if (!env.DB) return empty(503);
  const type = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  const asForm = type === 'application/x-www-form-urlencoded';
  if (!asForm && type !== 'application/json') return error(415, 'Send JSON or a form');
  const raw = await readBody(request, 8192);
  if (raw === null) return error(413, 'Too long');
  let fields;
  try { fields = asForm ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw); } catch { return error(400, 'Not readable'); }
  if (!isObject(fields)) return error(400, 'Not readable');
  const page = fields.page === 'uninstalled' ? 'uninstalled' : 'feedback';
  const reply = () => (asForm ? new Response(null, { status: 303, headers: { Location: '/' + page + '?sent=1', 'Cache-Control': 'no-store' } }) : json(200, { ok: true }));
  if (typeof fields.website === 'string' && fields.website) return reply(); // a form field people never see: only bots fill it
  const text = cleanFeedback(fields.text);
  if (!text) return error(400, 'Plain text only, 1 to ' + FEEDBACK_MAX + ' characters');
  if (!await allow(env, 'feedback')) return error(429, 'Too many messages right now; try again later');
  const v = typeof fields.v === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(fields.v) ? fields.v : '';
  await env.DB.prepare('INSERT INTO feedback (at, v, os, stage, reason, body) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(day(), v, pick(fields.os, OSES), pick(String(fields.s ?? ''), ['0', '1', '2']), pick(fields.r, REASONS), text).run();
  return reply();
}

/* ----------------------------------------------------------- the numbers */

// Average and median of a sorted list of per-user daily minutes.
function minuteStats(rows) {
  const list = rows.map(r => r.minutes);
  if (!list.length) return { days: 0, avg: 0, median: 0 };
  const mid = list.length >> 1;
  return { days: list.length, avg: Math.round(list.reduce((a, b) => a + b, 0) / list.length * 10) / 10, median: list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2 };
}

async function numbers(env, withFeedback) {
  const today = day();
  const since = n => new Date(Date.parse(today + 'T00:00:00Z') - n * 86400e3).toISOString().slice(0, 10);
  const q = (sql, ...args) => env.DB.prepare(sql).bind(...args);
  // Of the installs first seen at least k days ago, how many were active again on exactly day k.
  const kept = k => q("SELECT COUNT(*) AS cohort, COALESCE(SUM(EXISTS (SELECT 1 FROM activity a WHERE a.id = u.id AND a.day = date(u.first_day, '+" + k + " day'))), 0) AS kept, COALESCE(SUM(EXISTS (SELECT 1 FROM activity a WHERE a.id = u.id AND a.used = 1 AND a.day = date(u.first_day, '+" + k + " day'))), 0) AS keptUsed FROM users u WHERE u.first_day <= date(?, '-" + k + " day')", today);
  const [daily, months, windows, totals, firsts, byVersion, byOs, downloads, assets, stuck, harnesses, r1, r7, r30, m7, m30, mBuckets, clicks, count, recent] = (await env.DB.batch([
    q('SELECT day, COUNT(*) AS n, SUM(used) AS used, SUM(minutes) AS minutes FROM activity WHERE day >= ? GROUP BY day ORDER BY day', since(89)),
    q('SELECT substr(day, 1, 7) AS month, COUNT(DISTINCT id) AS n FROM activity GROUP BY month ORDER BY month DESC LIMIT 24'),
    q('SELECT (SELECT COUNT(DISTINCT id) FROM activity WHERE day >= ?) AS mau, (SELECT COUNT(DISTINCT id) FROM activity WHERE used = 1 AND day >= ?) AS aau7, (SELECT COUNT(DISTINCT id) FROM activity WHERE used = 1 AND day >= ?) AS aau30', since(29), since(6), since(29)),
    q('SELECT COUNT(*) AS users, SUM(stage >= 0) AS f0, SUM(stage >= 1) AS f1, SUM(stage >= 2) AS f2, MIN(first_day) AS since FROM users'),
    q('SELECT first_day AS day, COUNT(*) AS n FROM users WHERE first_day >= ? GROUP BY first_day ORDER BY first_day', since(89)),
    q('SELECT v AS name, COUNT(*) AS n FROM users WHERE last_day >= ? GROUP BY v ORDER BY n DESC', since(29)),
    q('SELECT os AS name, COUNT(*) AS n FROM users WHERE last_day >= ? GROUP BY os ORDER BY n DESC', since(29)),
    q('SELECT day, SUM(n) AS n FROM downloads WHERE day >= ? GROUP BY day ORDER BY day', since(89)),
    q('SELECT asset AS name, SUM(n) AS n, SUM(CASE WHEN day >= ? THEN n ELSE 0 END) AS recent FROM downloads GROUP BY asset ORDER BY n DESC', since(29)),
    q("SELECT COALESCE(reason, 'unknown') AS reason, CASE WHEN julianday(?) - julianday(first_day) < 1 THEN '0' WHEN julianday(?) - julianday(first_day) < 7 THEN '1-6' ELSE '7+' END AS age, COUNT(*) AS n FROM users WHERE stage = 0 GROUP BY 1, 2", today, today),
    q('SELECT p.kind AS name, p.picked, COALESCE(d.n, 0) AS used30, COALESCE(y.n, 0) AS usedYesterday FROM (SELECT picked AS kind, COUNT(*) AS picked FROM users WHERE picked IS NOT NULL GROUP BY picked UNION SELECT kind, 0 FROM harness_use WHERE kind NOT IN (SELECT picked FROM users WHERE picked IS NOT NULL) GROUP BY kind) p ' +
      'LEFT JOIN (SELECT kind, COUNT(DISTINCT id) AS n FROM harness_use WHERE day >= ? GROUP BY kind) d ON d.kind = p.kind LEFT JOIN (SELECT kind, COUNT(DISTINCT id) AS n FROM harness_use WHERE day = ? GROUP BY kind) y ON y.kind = p.kind ORDER BY used30 DESC, picked DESC', since(29), since(1)),
    kept(1), kept(7), kept(30),
    q('SELECT minutes FROM activity WHERE used = 1 AND day >= ? ORDER BY minutes', since(6)),
    q('SELECT minutes FROM activity WHERE used = 1 AND day >= ? ORDER BY minutes', since(29)),
    q("SELECT CASE WHEN minutes < 5 THEN 'under 5' WHEN minutes < 30 THEN '5-29' WHEN minutes < 120 THEN '30-119' ELSE '120+' END AS label, COUNT(*) AS n FROM activity WHERE used = 1 AND day >= ? GROUP BY 1", since(29)),
    q('SELECT target, src, SUM(n) AS n, SUM(CASE WHEN day >= ? THEN n ELSE 0 END) AS recent FROM clicks GROUP BY target, src ORDER BY n DESC', since(29)),
    q('SELECT COUNT(*) AS n FROM feedback'),
    withFeedback ? q('SELECT id, at, v, os, stage, reason, body AS text FROM feedback ORDER BY id DESC LIMIT 100') : q('SELECT 1 WHERE 0')
  ])).map(result => result.results);
  const t = totals[0] || {};
  return {
    today,
    since: t.since || null,
    users: t.users || 0,
    installs: t.users || 0,
    // Rolling windows of distinct installs: MAU = reported in the last 30 days; AAU (actual active users) =
    // had an AI command run, in the last 7 / 30 days. Per-day counts are in daily (n reported, used ran a command).
    rolling: { mau: windows[0].mau, aau7: windows[0].aau7, aau30: windows[0].aau30 },
    funnel: { installed: t.f0 || 0, helper: t.f1 || 0, command: t.f2 || 0 },
    daily, months, firsts, byVersion, byOs, harnesses,
    // Minutes per actual active user per day (a report covers the time since the previous one).
    minutes: {
      last7: minuteStats(m7), last30: minuteStats(m30),
      buckets: ['under 5', '5-29', '30-119', '120+'].map(label => ({ label, n: mBuckets.find(b => b.label === label)?.n || 0 }))
    },
    retention: [[1, r1], [7, r7], [30, r30]].map(([day, rows]) => ({ day, cohort: rows[0].cohort, kept: rows[0].kept, keptUsed: rows[0].keptUsed })),
    downloads: { daily: downloads, assets },
    clicks,
    stuck,
    feedback: withFeedback ? { total: count[0]?.n || 0, items: recent } : null
  };
}

const PAGE_HEADERS = nonce => ({
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'nonce-" + nonce + "'; font-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
});

async function statsPage(env, url, request, asset) {
  const response = await env.ASSETS.fetch(new Request(new URL(asset, url), request));
  if (!response.ok) return error(503, 'Page unavailable');
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  return new Response((await response.text()).replaceAll('__NONCE__', nonce), { status: 200, headers: PAGE_HEADERS(nonce) });
}

// Everything under /stats and /endpoint/stats. Without a token configured (and STATS_PUBLIC off) none of it exists.
async function stats(request, env, url) {
  if (!STATS_PUBLIC && !env.STATS_TOKEN) return error(404, 'Not found');
  const path = url.pathname;
  const signedIn = await authed(request, env);
  if (path === '/stats/login') {
    if (!env.STATS_TOKEN) return error(404, 'Not found');
    if (request.method === 'GET' || request.method === 'HEAD') return signedIn ? empty(303, { Location: '/stats' }) : statsPage(env, url, request, '/stats/login/');
    if (request.method !== 'POST') return error(405, 'Method not allowed');
    if (!env.DB || !await allow(env, 'login')) return error(429, 'Try again later');
    const given = new URLSearchParams(await readBody(request, 1024) || '').get('token') || '';
    if (!given || !await sameSecret(given, env.STATS_TOKEN)) return empty(303, { Location: '/stats/login?wrong=1' });
    return empty(303, { Location: '/stats', 'Set-Cookie': 'fxstats=' + await cookieFor(env.STATS_TOKEN) + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000' });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return error(405, 'Method not allowed');
  if (!STATS_PUBLIC && !signedIn) return path === '/endpoint/stats' ? error(401, 'Token required') : empty(303, { Location: '/stats/login' });
  if (path === '/endpoint/stats') {
    if (!env.DB) return error(503, 'No database');
    return json(200, await numbers(env, signedIn), { 'X-Robots-Tag': 'noindex' });
  }
  if (path === '/stats' || path === '/stats/') return statsPage(env, url, request, '/stats/');
  return error(404, 'Not found');
}

/* ----------------------------------------------------------- outbound links */

// /go/<target>?from=<source>: count the click, then redirect. A new issue keeps its pre-filled title and body.
async function go(request, env, ctx, url) {
  const target = url.pathname.slice(4).replace(/\/$/, '');
  if (!Object.hasOwn(GO, target)) return error(404, 'Not found');
  const from = url.searchParams.get('from');
  const src = GO_FROM.includes(from) ? from : 'other';
  let location = GO[target];
  if (target === 'issue') {
    const keep = new URLSearchParams();
    for (const key of ['title', 'body', 'labels']) {
      const value = url.searchParams.get(key);
      if (value) keep.set(key, value.slice(0, 4000));
    }
    if ([...keep].length) location += '?' + keep;
  }
  if (request.method === 'GET' && env.DB) {
    // A failure here must never break the link.
    const work = (async () => { await env.DB.prepare('INSERT INTO clicks (day, target, src, n) VALUES (?, ?, ?, 1) ON CONFLICT (day, target, src) DO UPDATE SET n = n + 1').bind(day(), target, src).run(); })().catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(work); else await work;
  }
  return new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' } });
}

/* ----------------------------------------------------------- downloads */

// One more redirect for this asset today. A failure here must never break the download.
function countDownload(env, ctx, name) {
  if (!env.DB) return undefined;
  const work = (async () => { await env.DB.prepare('INSERT INTO downloads (day, asset, n) VALUES (?, ?, 1) ON CONFLICT (day, asset) DO UPDATE SET n = n + 1').bind(day(), name).run(); })().catch(() => {});
  if (ctx && ctx.waitUntil) { ctx.waitUntil(work); return undefined; }
  return work;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/endpoint/ping' || url.pathname === '/endpoint/feedback') {
      if (request.method !== 'POST') return error(405, 'Method not allowed');
      try { return await (url.pathname === '/endpoint/ping' ? ping(request, env) : feedback(request, env)); } catch { return error(500, 'Failed'); }
    }
    if (url.pathname === '/stats' || url.pathname.startsWith('/stats/') || url.pathname === '/endpoint/stats') {
      try { return await stats(request, env, url); } catch { return error(500, 'Failed'); }
    }
    if (!['GET', 'HEAD'].includes(request.method)) return error(405, 'Method not allowed');
    if (url.pathname.startsWith('/go/')) return go(request, env, ctx, url);
    // Legacy aliases on the new hostname, too. The old Pages projects remain untouched.
    const aliases = { '/sh': '/download/sh', '/ps': '/download/ps', '/popup.json': '/endpoint/announcement' };
    if (aliases[url.pathname]) return Response.redirect(new URL(aliases[url.pathname], url), 302);
    if (url.pathname === '/endpoint/announcement') {
      const response = await env.ASSETS.fetch(new Request(new URL('/announcement.json', url), request));
      const headers = new Headers(response.headers);
      headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      headers.set('Content-Type', 'application/json; charset=utf-8');
      headers.set('Cache-Control', 'no-store');
      headers.set('X-Content-Type-Options', 'nosniff');
      return new Response(response.body, { status: response.status, headers });
    }
    if (['/download/sh', '/download/ps', '/download/latest.json'].includes(url.pathname)) {
      const response = await env.ASSETS.fetch(request);
      const headers = new Headers(response.headers);
      headers.set('Content-Type', url.pathname.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8');
      headers.set('Cache-Control', 'no-store');
      headers.set('X-Content-Type-Options', 'nosniff');
      return new Response(response.body, { status: response.status, headers });
    }
    if (url.pathname.startsWith('/endpoint/')) return error(404, 'Not found');
    if (url.pathname === '/download' || url.pathname === '/download/') return env.ASSETS.fetch(new Request(new URL('/download/', url), request));
    const match = /^\/download\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (match) {
      const [, version, name] = match;
      if (!ASSET.test(name)) return error(404, 'Not found');
      if (version === 'latest') {
        const metadata = await env.ASSETS.fetch(new Request(new URL('/download/latest.json', url)));
        if (!metadata.ok) return error(503, 'Release metadata unavailable');
        const latest = await metadata.json();
        if (!VERSION.test(latest.version)) return error(503, 'Invalid release metadata');
        return new Response(null, { status: 302, headers: { Location: `/download/${latest.version}/${name}`, 'Cache-Control': 'no-store' } });
      }
      if (!VERSION.test(version)) return error(404, 'Not found');
      // Counted here, not on /download/latest/..., which redirects to this route.
      if (request.method === 'GET') await countDownload(env, ctx, name);
      return new Response(null, { status: 302, headers: {
        Location: `https://github.com/hamb1y/foxhand/releases/download/v${version}/${name}`,
        'Cache-Control': 'public, max-age=300',
        'X-Content-Type-Options': 'nosniff'
      } });
    }
    if (url.pathname.startsWith('/download/') && !['/download/sh', '/download/ps', '/download/latest.json'].includes(url.pathname)) return error(404, 'Not found');
    return env.ASSETS.fetch(request);
  }
};
