/* Anonymous usage counts. At most one small report per UTC day, only while Firefox's
 * "technical and interaction data" permission is granted, only to foxhand.pages.dev.
 * The report carries a random install ID (crypto.randomUUID, kept in storage.local). It is tied to
 * nothing: no hardware, profile, account or browsing data, and it is used for nothing but this report.
 * Also keeps the uninstall page URL up to date (add-on version, OS, setup stage and reason). */
import type { Harness, HelperReason, PingPayload } from './messages';
import { HARNESSES } from '../../shared/src/protocol';

(function () {
'use strict';
var B = browser;
var ENDPOINT = 'https://foxhand.pages.dev/endpoint/ping';
var UNINSTALL = 'https://foxhand.pages.dev/uninstalled';
var PERMISSION = 'technicalAndInteraction' as const;

/* What this add-on keeps locally for the counts. */
interface StatsStore {
  statsId?: unknown;         // random install ID (kept when the permission is turned off)
  statsLast?: unknown;       // UTC date of the last successful report
  statsStage?: unknown;      // highest setup stage reached (written by background.js)
  statsReason?: unknown;     // why the helper is not working, as a category (written by background.js)
  statsHarnesses?: unknown;  // kinds of AI client seen since the last report (written by background.js)
  statsPicked?: unknown;     // kind picked on the setup page (written by background.js)
  statsMinutes?: unknown;    // clock minutes with an AI command since the last report (written by background.js)
  statsUsed?: unknown;       // true once an AI command ran since the last report (written by background.js)
}
var KEYS = ['statsId', 'statsLast', 'statsStage', 'statsReason', 'statsHarnesses', 'statsPicked', 'statsUsed', 'statsMinutes'];
var REASONS: string[] = ['missing', 'old', 'noanswer', 'port', 'stopped', 'unknown'];
var UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
var VERSION = (function () { try { return B.runtime.getManifest().version; } catch (e) { return '0.0.0'; } })();
var busy = false;
var lastUninstall = '';

function utcDay(): string { return new Date().toISOString().slice(0, 10); }
function stageOf(store: StatsStore): 0 | 1 | 2 { return store.statsStage === 2 ? 2 : store.statsStage === 1 ? 1 : 0; }
function reasonOf(store: StatsStore): HelperReason { return REASONS.indexOf(store.statsReason as string) >= 0 ? store.statsReason as HelperReason : 'unknown'; }
function kinds(value: unknown): Harness[] {
  var list = Array.isArray(value) ? value : [];
  return HARNESSES.filter(function (h) { return list.indexOf(h) >= 0; });
}

async function osName(): Promise<PingPayload['os']> {
  try {
    var os = (await B.runtime.getPlatformInfo()).os;
    return os === 'win' || os === 'mac' || os === 'linux' ? os : 'other';
  } catch (e) { return 'other'; }
}

/* Is Firefox's data consent for this add-on on right now? Asked every time, never remembered. */
async function consent(): Promise<boolean> {
  try {
    var all = await B.permissions.getAll();
    return !!all.data_collection && all.data_collection.indexOf(PERMISSION) >= 0;
  } catch (e) { return false; }
}

async function readStore(): Promise<StatsStore> {
  try { return (await B.storage.local.get(KEYS)) as StatsStore; } catch (e) { return {}; }
}

/* The ID is made once, on the first run of this code, and then kept. */
async function ensureId(store: StatsStore): Promise<string> {
  if (typeof store.statsId === 'string' && UUID_V4.test(store.statsId)) return store.statsId;
  var id = crypto.randomUUID();
  await B.storage.local.set({ statsId: id });
  store.statsId = id;
  return id;
}

/* The report for today, or null when one was already sent today (or the clock went backwards). */
function buildPayload(store: StatsStore, today: string, os: PingPayload['os']): PingPayload | null {
  var last = typeof store.statsLast === 'string' && /^\d{4}-\d\d-\d\d$/.test(store.statsLast) ? store.statsLast : '';
  if (last >= today || typeof store.statsId !== 'string') return null;
  var stage = stageOf(store);
  var picked = kinds([store.statsPicked])[0] || null;
  var minutes = typeof store.statsMinutes === 'number' && store.statsMinutes > 0 ? Math.min(1440, Math.floor(store.statsMinutes)) : 0;
  return { id: store.statsId, v: VERSION, os: os, stage: stage, reason: stage < 1 ? reasonOf(store) : null, harnesses: kinds(store.statsHarnesses), picked: picked, used: store.statsUsed === true || minutes > 0, minutes: minutes };
}

async function post(payload: PingPayload): Promise<boolean> {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, 10000);
  try {
    var response = await fetch(ENDPOINT, {
      method: 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' },
      credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal
    });
    return response.ok;
  } catch (e) { return false; } finally { clearTimeout(timer); }
}

async function report(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    var store = await readStore();
    await ensureId(store);
    if (!(await consent())) return;
    var today = utcDay();
    var payload = buildPayload(store, today, await osName());
    if (!payload) return;
    if (!(await post(payload))) return;
    // Clearing statsUsed here could drop a command that ran during the request; that costs at most one day.
    await B.storage.local.set({
      statsLast: today,
      statsUsed: false,
      statsMinutes: 0,
      statsHarnesses: kinds(store.statsHarnesses).filter(function (h) { return payload!.harnesses.indexOf(h) < 0; })
    });
  } catch (e) {
    // A failed report is dropped; it never disturbs the helper connection.
  } finally { busy = false; }
}

/* The page Firefox opens after uninstalling: version, OS and how far setup got, only while consent is on. */
function uninstallUrl(store: StatsStore, os: PingPayload['os']): string {
  var stage = stageOf(store);
  var q = 'v=' + encodeURIComponent(VERSION) + '&os=' + os + '&s=' + stage;
  if (stage < 1) q += '&r=' + reasonOf(store);
  return UNINSTALL + '?' + q;
}

async function syncUninstall(): Promise<void> {
  try {
    var url = (await consent()) ? uninstallUrl(await readStore(), await osName()) : UNINSTALL;
    if (url === lastUninstall) return;
    await B.runtime.setUninstallURL(url);
    lastUninstall = url;
  } catch (e) {}
}

async function tick(): Promise<void> {
  await report();
  await syncUninstall();
}

B.runtime.onInstalled.addListener(function (d) {
  if (d && d.reason === 'install') tick().catch(function () {});
});
if (B.permissions && B.permissions.onAdded) B.permissions.onAdded.addListener(function () { tick(); });
if (B.permissions && B.permissions.onRemoved) B.permissions.onRemoved.addListener(function () { tick(); });
B.storage.onChanged.addListener(function (changes, area) {
  if (area === 'local' && (changes.statsStage || changes.statsReason)) syncUninstall();
});
setTimeout(tick, 20000);
setInterval(tick, 60 * 60 * 1000);
})();
