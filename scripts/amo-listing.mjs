#!/usr/bin/env node
// Update the AMO listing (name, summary, description in every language, homepage,
// support link, privacy policy) from docs/amo-listing.md, then read it back.
//
//   node scripts/amo-listing.mjs --dry-run      print what would be sent
//   AMO_JWT_ISSUER=... AMO_JWT_SECRET=... node scripts/amo-listing.mjs
//
// The keys live only as repo secrets; the "AMO listing" workflow runs this.
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUID = JSON.parse(readFileSync(path.join(root, 'extension/manifest.json'), 'utf8')).browser_specific_settings.gecko.id;
const API = `https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(GUID)}/`;
const dry = process.argv.includes('--dry-run');

/* ---- parse docs/amo-listing.md ---- */
const md = readFileSync(path.join(root, 'docs/amo-listing.md'), 'utf8');
const sections = {}; // "## heading" -> body
let cur = null;
for (const line of md.split('\n')) {
  const h = /^## (.+)$/.exec(line);
  if (h) { cur = h[1].trim(); sections[cur] = []; continue; }
  if (cur) sections[cur].push(line);
}
const body = (name) => (sections[name] || []).join('\n');
const tidy = (s) => s.replace(/\n---\s*$/, '').trim();

// "### Summary" / "### Description" in each language section: first is the summary, second the description.
function langParts(name) {
  const parts = body(name).split(/^### .*$/m).slice(1).map(tidy);
  if (parts.length < 2 || !parts[0] || !parts[1]) throw new Error(`${name}: expected a summary and a description`);
  return { summary: parts[0], description: parts[1] };
}
const LANGS = [
  ['English (default)', ['en-US']],
  ['Español (es)', ['es-ES', 'es']],
  ['Français (fr)', ['fr']],
  ['Deutsch (de)', ['de']],
  ['简体中文 (zh-CN)', ['zh-CN']],
];
const texts = LANGS.map(([name, locales]) => ({ name, locales, ...langParts(name) }));
for (const t of texts) {
  if (t.summary.length > 250) throw new Error(`${t.name}: summary is ${t.summary.length} chars (AMO allows 250)`);
}
const name = tidy(body('Name'));
const privacy = tidy(body('Privacy policy'));
const urls = tidy(body('Support')).match(/https?:\/\/\S+/g) || [];
const support = urls[0];
const homepage = 'https://hamb1y.github.io/foxhand/';

/* ---- AMO API ---- */
function jwt() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const claims = b64({ iss: process.env.AMO_JWT_ISSUER, jti: randomUUID(), iat: now, exp: now + 60 });
  const sig = createHmac('sha256', process.env.AMO_JWT_SECRET).update(`${head}.${claims}`).digest('base64url');
  return `${head}.${claims}.${sig}`;
}
async function api(method, url, data) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `JWT ${jwt()}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: data ? JSON.stringify(data) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

// Locale keys: the first of each language's candidates that AMO accepts.
function payload(pick) {
  const summary = {}, description = {};
  texts.forEach((t, i) => { summary[t.locales[pick[i]]] = t.summary; description[t.locales[pick[i]]] = t.description; });
  return {
    name: { 'en-US': name },
    summary,
    description,
    homepage: { 'en-US': homepage },
    support_url: { 'en-US': support },
  };
}

if (dry) {
  const p = payload(texts.map(() => 0));
  console.log(`addon ${GUID}`);
  console.log(`name: ${name}\nhomepage: ${homepage}\nsupport: ${support}`);
  for (const [loc, s] of Object.entries(p.summary)) console.log(`\n[${loc}] summary (${s.length} chars): ${s}\n[${loc}] description: ${p.description[loc].length} chars, starts "${p.description[loc].slice(0, 70)}…"`);
  console.log(`\nprivacy policy: ${privacy.length} chars, starts "${privacy.slice(0, 70)}…"`);
  process.exit(0);
}

if (!process.env.AMO_JWT_ISSUER || !process.env.AMO_JWT_SECRET) {
  console.error('Set AMO_JWT_ISSUER and AMO_JWT_SECRET (the "AMO listing" workflow passes the repo secrets).');
  process.exit(1);
}

const before = await api('GET', API);
if (!before.ok) { console.error(`GET ${API}: ${before.status} ${before.text.slice(0, 500)}`); process.exit(1); }
console.log(`listing: ${before.json.url} (slug ${before.json.slug}), current version ${before.json.current_version?.version}`);

// Try the preferred locale keys; if AMO rejects one, fall back to that language's next candidate.
let pick = texts.map(() => 0);
let res;
for (let attempt = 0; attempt < 3; attempt++) {
  res = await api('PATCH', API, payload(pick));
  if (res.ok) break;
  const err = res.text;
  let changed = false;
  texts.forEach((t, i) => {
    if (pick[i] + 1 < t.locales.length && err.includes(t.locales[pick[i]])) { pick[i]++; changed = true; }
  });
  if (!changed) break;
}
if (!res.ok) { console.error(`PATCH listing: ${res.status} ${res.text.slice(0, 1500)}`); process.exit(1); }
console.log('updated name, summary and description (' + texts.map((t, i) => t.locales[pick[i]]).join(', ') + '), homepage and support link');

const pol = await api('PATCH', `${API}eula_policy/`, { privacy_policy: { 'en-US': privacy } });
if (!pol.ok) { console.error(`PATCH privacy policy: ${pol.status} ${pol.text.slice(0, 800)}`); process.exit(1); }
console.log('updated the privacy policy');

// Read it back: every language must now carry exactly what the doc says.
const after = await api('GET', API);
const bad = [];
texts.forEach((t, i) => {
  const loc = t.locales[pick[i]];
  if ((after.json.summary || {})[loc] !== t.summary) bad.push(`${loc} summary`);
  if (!String((after.json.description || {})[loc] || '').includes(t.description.split('\n')[0])) bad.push(`${loc} description`);
});
if ((after.json.name || {})['en-US'] !== name) bad.push('name');
if (bad.length) { console.error(`read back differs: ${bad.join(', ')}`); process.exit(1); }
console.log(`verified: ${after.json.name['en-US']} — ${Object.keys(after.json.summary).length} languages; ${after.json.url}`);
