import type { BridgeErrorCode, HostStatus, BridgeMethod, BridgeParams, CodedError, ContentEnvelope, ErrLike, ErrObj, ContentMessage, SetConfigError, Status, UiMessage } from './messages';
import { PROTOCOL } from '../../shared/src/protocol';
/* Foxhand (formerly WebMCP Controller) — background page.
 * Plain classic script (no modules). Firefox launches the companion helper
 * (native messaging host "webmcp_controller") on connectNative(); the helper
 * serves MCP over HTTP to your AI harness and relays tool calls here.
 *
 * Wire protocol (see shared/src/protocol.ts), framed by Firefox:
 *   ext -> host : { hello: {...} }                     (first message)
 *   ext -> host : { hostConfig: { token, port, ... } }  (after hello / on change)
 *   host -> ext : { hostStatus: {...} }                 (listener state, version, protocol)
 *   host -> ext : { hostExit: { reason } }              (about to quit, e.g. binary updated)
 *   host -> ext : { id, method, params }                (command)
 *   ext -> host : { id, ok, result|error }              (response)
 *   ext -> host : { event, data }                       (unsolicited event)
 */
(function () {
'use strict';

/* ------------------------------------------------------------------ setup */

var B = ((typeof browser !== 'undefined') ? browser : chrome) as typeof browser;
var HAS_PROMISES = (typeof browser !== 'undefined');
var EXT_VERSION = (function () { try { return B.runtime.getManifest().version; } catch (e) { return '0.0.0'; } })();
// The ID predates the rename to Foxhand; changing it would make AMO treat this as a new add-on.
var EXT_ID_FALLBACK = 'webmcp-controller@hamb1y.github.io';
// Breaking wire-protocol version: PROTOCOL comes from shared/src/protocol.ts, so the helper and the add-on can't drift.

var NATIVE_HOST = 'webmcp_controller';
var DEFAULT_PORT = 8901;
var DEFAULT_BIND = '127.0.0.1';
var BACKOFFS = [1000, 2000, 5000, 10000, 30000]; // ms, last value repeats
var MISSING_BACKOFF_MS = 60000; // helper not installed: retry slowly (Retry button is instant)
var START_TIMEOUT_MS = 20000;   // a helper that launched but never spoke is stuck: start it again

var CAPABILITIES: BridgeMethod[] = [
  'tabs.list', 'tabs.query', 'windows.list', 'active.tab',
  'tab.create', 'tab.update', 'tab.close', 'tab.duplicate', 'tab.move',
  'tab.pin', 'tab.unpin', 'tab.mute',
  'window.create', 'window.focus', 'window.remove',
  'nav.back', 'nav.forward', 'nav.reload',
  'page.snapshot', 'page.text', 'page.html', 'page.shot', 'page.info',
  'act.click', 'act.type', 'act.fillForm', 'act.select', 'act.hover',
  'act.scroll', 'act.key', 'act.wait', 'act.find',
  'bookmarks.search', 'bookmarks.create', 'bookmarks.remove',
  'history.search', 'downloads.list',
  'cookies.forTab', 'sessions.recentlyClosed', 'sessions.restore',
  'cursor.say',
  'tab.navigate', 'act.drag', 'act.upload',
  'cookies.query', 'cookies.set', 'cookies.remove',
  'downloads.query', 'downloads.start',
  'storage.get', 'storage.set', 'storage.remove'
];

/* Methods whose thought is shown by the content script as part of the action itself. */
var CONTENT_METHODS = /^(page\.(snapshot|text|html)|act\.)/;
/* Methods that navigate or close the page: a note shown there would vanish immediately. */
var NO_NOTE_METHODS = /^(tab\.(create|update|navigate|close|duplicate)|nav\.|window\.|sessions\.restore|page\.shot)/;

var CFG = { token: '', port: DEFAULT_PORT, bind: DEFAULT_BIND, allowWsl: false, confirmDestructive: true, showCursor: true };
interface Ctx { id: string; signal: AbortSignal; }
interface HelperEvent { at: number; text: string; level: string; site: string; count?: number; }

var pauseEpoch = 0;
var paused = false;        // the user paused AI control: every command is refused until they resume
var port: browser.runtime.Port | null = null;           // runtime.Port to the native helper
var backoffIdx = 0;
var connectTimer: number | null = null;
var startTimer: number | null = null;     // fires if a just-launched helper never says anything
var hostMissing = false;   // Firefox couldn't find/launch the helper
var hostStatus: HostStatus | null = null;     // last { hostStatus } from the helper
var hostRestarting = false; // helper said it's exiting to make way for an updated binary
var lastError = '';        // human-readable reason for the popup/options page
var connectedAt = 0;
var events: HelperEvent[] = [];          // recent helper ups and downs, newest last, for the settings page
var EVENTS_MAX = 60;

/* Remember what happened to the helper, so "it stopped working" can be traced afterwards. */
function note(text: string, level?: string, site?: string): void {
  var lastEv = events[events.length - 1];
  if (lastEv && lastEv.text === text && (lastEv.site || '') === (site || '')) {
    lastEv.at = Date.now(); lastEv.count = (lastEv.count || 1) + 1; return;
  }
  events.push({ at: Date.now(), text: text, level: level || 'info', site: site || '' });
  if (events.length > EVENTS_MAX) events.splice(0, events.length - EVENTS_MAX);
}
var inflight = new Map<string, AbortController>();  // command id -> AbortController, for { cancel: id }
var cmdCount = 0;
var platform = { os: '', arch: '' };

/* ---------------------------------------------------------------- helpers */

/* Compare dotted versions numerically: <0 if a<b, 0 if equal, >0 if a>b. */
function cmpVersion(a: unknown, b: unknown): number {
  var x = String(a || '0').split(/[.+-]/), y = String(b || '0').split(/[.+-]/);
  for (var i = 0; i < 3; i++) {
    var d = (parseInt(x[i], 10) || 0) - (parseInt(y[i], 10) || 0);
    if (d) return d;
  }
  return 0;
}

/* Is the running helper compatible with this add-on? */
function compat(): Status['compat'] {
  if (!hostStatus) return { state: 'unknown' };
  var hv = String(hostStatus.version || '0.0.0');
  var hp = Number(hostStatus.protocol) || 1; // helpers before 0.3.0 didn't send it; they speak 1
  if (hp < PROTOCOL) return { state: 'helper-old', helper: hv, addon: EXT_VERSION };
  if (hp > PROTOCOL) return { state: 'addon-old', helper: hv, addon: EXT_VERSION };
  if (cmpVersion(hv, EXT_VERSION) < 0) return { state: 'helper-update', helper: hv, addon: EXT_VERSION };
  return { state: 'ok', helper: hv, addon: EXT_VERSION };
}

/* A UI string in the browser's language. Messages for the AI itself stay in English. */
function t(key: string, subs?: unknown): string {
  var m = '';
  try { m = B.i18n.getMessage(key, subs === undefined ? undefined : ([] as unknown[]).concat(subs).map(String)); } catch (e) {}
  return m || key;
}

function log(...parts: unknown[]): void;
function log(): void {
  try { console.log.apply(console, ['[fxmcp]'].concat([].slice.call(arguments))); } catch (e) {}
}

/* Promise adapter: browser.* returns promises; chrome.* needs callbacks. */
function pcall(fn: (...a: unknown[]) => unknown, ...rest: unknown[]): Promise<unknown>;
function pcall(fn: (...a: unknown[]) => unknown): Promise<unknown> {
  var args: unknown[] = [].slice.call(arguments, 1);
  if (HAS_PROMISES) return fn.apply(null, args) as Promise<unknown>;
  return new Promise(function (resolve, reject) {
    args.push(function (res: unknown) {
      var err = chrome!.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(res);
    });
    try { fn.apply(null, args); } catch (e) { reject(e); }
  });
}

/* call(B.tabs, 'query', {...}) — late-bound so missing APIs throw cleanly. */
type ApiFn<F> = F extends (...a: never[]) => unknown ? F : never;
function call<O extends object, M extends keyof O & string>(obj: O | null | undefined, method: M,
  ...args: Parameters<ApiFn<O[M]>>): Promise<Awaited<ReturnType<ApiFn<O[M]>>>>;
function call(obj: Record<string, unknown> | null | undefined, method: string): Promise<unknown> {
  var args = [].slice.call(arguments, 2);
  if (!obj || typeof obj[method] !== 'function') {
    throw be('NOT_SUPPORTED', 'API not available: ' + method);
  }
  return (pcall as (...a: unknown[]) => Promise<unknown>).apply(null, [(obj[method] as Function).bind(obj)].concat(args));
}

function num(v: unknown, dflt: number): number;
function num<D>(v: unknown, dflt: D): number | D;
function num(v: unknown, dflt: unknown): unknown {
  var n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function be(code: BridgeErrorCode, message: unknown): CodedError {
  var e = new Error(String(message)) as CodedError;
  e.code = code;
  return e;
}

function toBridgeError(e: ErrLike): { code: string; message: string } {
  if (e && typeof e.code === 'string') return { code: e.code, message: String(e.message || e.code) };
  var msg = String((e && e.message) || e);
  if (/no tab with id|tab .*not found|invalid tab id|no such tab/i.test(msg)) {
    return { code: 'TAB_NOT_FOUND', message: msg };
  }
  if (/timed out|timeout|timedout/i.test(msg)) return { code: 'TIMEOUT', message: msg };
  if (/missing host permission|privileged|not allowed|restricted|illegal url/i.test(msg)) {
    return { code: 'RESTRICTED_PAGE', message: msg };
  }
  if (/receiving end does not exist|could not establish connection|no content script/i.test(msg)) {
    return { code: 'NO_CONTENT_SCRIPT', message: msg };
  }
  return { code: 'INTERNAL', message: msg };
}

/* --------------------------------------------------------------- tab utils */

function toTabInfo(t: browser.tabs.Tab | null | undefined) {
  if (!t) throw be('TAB_NOT_FOUND', 'Tab not found');
  return {
    id: t.id,
    windowId: t.windowId,
    index: t.index,
    url: t.url || '',
    title: t.title || '',
    active: !!t.active,
    pinned: !!t.pinned,
    audible: !!t.audible,
    muted: !!(t.mutedInfo && t.mutedInfo.muted),
    discarded: !!t.discarded,
    loading: t.status === 'loading'
  };
}

function toWindowInfo(w: browser.windows.Window) {
  return {
    id: w.id,
    focused: !!w.focused,
    incognito: !!w.incognito,
    type: w.type || 'normal',
    tabCount: Array.isArray(w.tabs) ? w.tabs.length : 0
  };
}

/* Resolve a tab id, defaulting to the active tab of the focused window. */
async function resolveTab(tabId?: unknown): Promise<browser.tabs.Tab> {
  if (tabId !== undefined && tabId !== null && tabId !== '') {
    var id = Number(tabId);
    try {
      return await call(B.tabs, 'get', id);
    } catch (e) {
      throw be('TAB_NOT_FOUND', 'No tab with id ' + tabId);
    }
  }
  var cands = await call(B.tabs, 'query', { active: true, lastFocusedWindow: true });
  if (!cands || !cands.length) cands = await call(B.tabs, 'query', { active: true, currentWindow: true });
  if (!cands || !cands.length) cands = await call(B.tabs, 'query', { active: true });
  if (!cands || !cands.length) throw be('TAB_NOT_FOUND', 'No active tab');
  return cands[0];
}

var RESTRICTED_RE = /^(about|chrome|resource|moz-extension|view-source|jar|data|blob):/i;
var AMO_RE = /^https:\/\/addons\.mozilla\.org\//i;

function assertContentAllowed(tab: { url?: string } | null | undefined): void {
  var url = String((tab && tab.url) || '');
  if (RESTRICTED_RE.test(url)) {
    throw be('RESTRICTED_PAGE', 'Content scripting is forbidden on this page: ' + (url || '(no url yet)'));
  }
  if (AMO_RE.test(url)) {
    throw be('RESTRICTED_PAGE', 'Content scripting is forbidden on addons.mozilla.org');
  }
}

var CONTENT_FILES = ['content/cursor.js', 'content/ax.js'];

async function injectAx(tabId: number, frameId?: number): Promise<void> {
  if (frameId) {
    // A cross-origin frame gets the page script only; the AI cursor stays in the top page.
    await call(B.tabs, 'executeScript', tabId, { file: 'content/ax.js', frameId: frameId });
    return;
  }
  if (B.tabs && typeof B.tabs.executeScript === 'function') {
    for (var i = 0; i < CONTENT_FILES.length; i++) {
      await call(B.tabs, 'executeScript', tabId, { file: CONTENT_FILES[i] });
    }
    return;
  }
  if (B.scripting && typeof B.scripting.executeScript === 'function') {
    await call(B.scripting, 'executeScript', { target: { tabId: tabId }, files: CONTENT_FILES.slice() });
    return;
  }
  throw be('NO_CONTENT_SCRIPT', 'No script-injection API available');
}

/** What a content script may answer: our envelope, or anything else a page-side listener returned. */
type ContentReply = { __fxmcp?: boolean; ok?: boolean; result?: unknown; error?: { code?: string; message?: string } } | null | undefined;

function unwrapContentResponse(res: ContentReply): unknown {
  if (res && res.__fxmcp === true) {
    if (res.ok) return res.result;
    var err = res.error || {};
    throw be((err.code || 'INTERNAL') as BridgeErrorCode, err.message || 'Content script error');
  }
  return res;
}

/* Send a message to a tab's content script, re-injecting once on failure.
 * p is the command's params: when the AI cursor is on, the model's `thought`
 * rides along so the page can show it next to the cursor. */
/* A discarded (sleeping) tab has no page loaded: load it before talking to its content script. */
async function wake(tabId: number): Promise<void> {
  var tab;
  try { tab = await call(B.tabs, 'get', tabId); } catch (e) { return; }
  if (!tab || !tab.discarded) return;
  try { await call(B.tabs as { reload(tabId: number): Promise<void> }, 'reload', tabId); } catch (e) { return; }
  // A waking tab doesn't always report 'loading' first, so watch its state rather than events.
  for (var end = Date.now() + 20000; Date.now() < end;) {
    await sleep(150);
    try { tab = await call(B.tabs, 'get', tabId); } catch (e) { return; }
    if (!tab.discarded && tab.status === 'complete') return;
  }
}

async function sendToTab(tabId: number, p: BridgeParams, msg: ContentMessage, frameId?: number): Promise<unknown> {
  frameId = frameId || 0;
  await wake(tabId);
  if (CFG.showCursor && msg.kind !== 'cursor' && !frameId) {
    msg.cursor = { note: typeof p.thought === 'string' ? p.thought.slice(0, 300) : '' };
  }
  // Always one frame: frames we injected into would answer a tab-wide message too.
  var opts = { frameId: frameId };
  var firstErr: ErrLike = null;
  try {
    return unwrapContentResponse(await call(B.tabs, 'sendMessage', tabId, msg, opts));
  } catch (e) {
    firstErr = e as ErrLike;
  }
  var m = String((firstErr && firstErr.message) || firstErr);
  if (/receiving end does not exist|could not establish connection|could not send|no response/i.test(m)) {
    try {
      await injectAx(tabId, frameId);
    } catch (inj) {
      if (!frameId && /\.pdf([?#]|$)/i.test(String((await call(B.tabs, 'get', tabId)).url || ''))) throw be('RESTRICTED_PAGE', 'Firefox may be displaying a PDF viewer that cannot be scripted. Use page_screenshot to inspect it.');
      if (frameId) throw be('REF_STALE', 'That frame is gone or can\'t be scripted. Take a new page_snapshot.');
      throw be('NO_CONTENT_SCRIPT', 'No content script in tab ' + tabId + ' (restricted page?)');
    }
    try {
      return unwrapContentResponse(await call(B.tabs, 'sendMessage', tabId, msg, opts));
    } catch (e2) {
      // An answer from the page (e.g. REF_STALE) or a page that navigated isn't a missing script.
      if (((e2 as ErrObj) && (e2 as ErrObj).code) || PAGE_GONE_RE.test(String(((e2 as ErrObj) && (e2 as ErrObj).message) || e2))) throw e2;
      throw be('NO_CONTENT_SCRIPT', 'No content script in tab ' + tabId + ' (restricted page?)');
    }
  }
  throw firstErr;
}

function sleep(ms: number): Promise<void> { return new Promise(function (r) { setTimeout(r, ms); }); }

/* The page went away (navigated, reloaded, closed) before its content script replied. */
var PAGE_GONE_RE = /destroyed before|message manager disconnected|context is inactive|page (was )?unloaded/i;
var READ_KINDS = /^(ax-snapshot|page-text|page-html|act-find|page-storage|page-metrics|element-rect)$/;

/* sendToTab, but an action that navigated the page before replying isn't reported as a failure
 * (the AI would repeat a click that worked), and a read retries once on the page that replaced it. */
async function sendToPage(tabId: number, p: BridgeParams, msg: ContentMessage, frameId?: number): Promise<unknown> {
  try {
    return await sendToTab(tabId, p, msg, frameId);
  } catch (e) {
    if (!PAGE_GONE_RE.test(String(((e as ErrObj) && (e as ErrObj).message) || e))) throw e;
    if (READ_KINDS.test(msg.kind)) {
      await sleep(500);
      return await sendToTab(tabId, p, msg, frameId);
    }
    if (msg.kind === 'act-wait') throw be('NAVIGATED', 'The page navigated away while waiting; take a new snapshot');
    return { done: true, pageChanged: true, note: 'The page navigated or reloaded as a result; take a new snapshot before using refs' };
  }
}

/* ---- cross-origin frames ----
 * A cross-origin <iframe> (cookie banners, sign-in buttons, payment fields,
 * embeds) runs its own copy of ax.js. Its refs are shown as slot * FRAME_REF +
 * the frame's own ref, so one number names the frame and the element in it. */
/** A tab's cross-origin frames: frameId -> slot number, and slot -> frameId (slot 0 is the page). */
interface FrameSlots { ids: Map<number, number>; byslot: number[]; }
/** A frame's outline line that holds the [frame:N] marker, from the content script. */
interface FrameLine { line: number; frameId: number; marker: string; }
/** A cross-origin frame the page reports (for page_text and page_find). */
interface PageFrame { frameId: number; name?: string; src?: string; ref?: number; }
/** A page answer as the background reads and reshapes it: every field is optional, each command fills its own. */
interface PageResult {
  text?: string;
  nodes?: unknown[];
  truncated?: boolean;
  totalChars?: number;
  nextOffset?: number;
  frames?: PageFrame[];
  frameLines?: FrameLine[];
  matches?: Array<{ frame?: string; [k: string]: unknown }>;
  count?: number;
  line?: string;
  frame?: string;
  url?: string;
  title?: string;
  loaded?: boolean;
  note?: string;
  navigating?: boolean;
  pageChanged?: boolean;
  ready?: boolean;
  href?: string;
  rect?: ShotRect;
  width?: number;
  height?: number;
  [k: string]: unknown;
}
/** A content message as the background builds and reshapes it (any target or action field may be present). */
type PageMsg = ContentMessage & { [k: string]: unknown };

var FRAME_REF = 10000000;
var frameSlots = new Map<number, FrameSlots>(); // tabId -> { ids: Map(frameId -> slot), byslot: [frameId] }

function frameSlot(tabId: number, frameId: number): number {
  var t = frameSlots.get(tabId);
  if (!t) { t = { ids: new Map<number, number>(), byslot: [0] }; frameSlots.set(tabId, t); }
  var s = t.ids.get(frameId);
  if (!s) { s = t.byslot.length; t.byslot.push(frameId); t.ids.set(frameId, s); }
  return s;
}

/* Rewrite a frame's refs ("ref": N and [ref=N]) to their page-wide numbers. */
function frameRefs(v: unknown, slot: number): PageResult {
  var convert = function (n: unknown): number { return slot * FRAME_REF + Number(n); };
  var lines = function (text: string): string { return text.replace(/(^|\n)([ ]*)\[ref=(\d+)\]/g, function (_: string, lead: string, pad: string, ref: string): string { return lead + pad + '[ref=' + convert(ref) + ']'; }); };
  var walk = function (value: unknown, key: string, parent: { nodes?: unknown } | null): unknown {
    if (typeof value === 'number' && key === 'ref') return convert(value);
    if (typeof value === 'string') {
      // Only protocol-owned outline fields carry refs. Names, page text, HTML and URLs are data.
      if (key === 'line' || key === 'within' || (key === 'text' && parent && Array.isArray(parent.nodes))) return lines(value);
      return value;
    }
    if (Array.isArray(value)) return value.map(function (item) { return walk(item, '', null); });
    if (value && typeof value === 'object') {
      var copy: Record<string, unknown> = {};
      Object.keys(value).forEach(function (name) { copy[name] = walk((value as Record<string, unknown>)[name], name, value as Record<string, unknown>); });
      return copy;
    }
    return value;
  };
  return walk(v, '', null) as PageResult;
}

function frameErr(e: unknown, slot: number): unknown {
  if (!e || !(e as ErrObj).code) return e;
  var m = String((e as ErrObj).message || '').replace(/\[ref=(\d+)\]|\bref[ =](\d+)/g, function (all: string, a: string | undefined, b: string | undefined): string {
    var n = slot * FRAME_REF + Number(a || b);
    return a ? '[ref=' + n + ']' : 'ref ' + n;
  });
  return be((e as CodedError).code as BridgeErrorCode, m);
}

/* Which frame a message's refs point into: {frameId, slot} with the refs made
   local, or null for the page itself. Refs from two frames can't mix. */
function routeRefs(tabId: number, msg: PageMsg): { frameId: number; slot: number } | null {
  var slots: number[] = [];
  var take = function (obj: Record<string, unknown> | null | undefined, key: string): void {
    if (!obj || obj[key] === undefined || obj[key] === null || obj[key] === '') return;
    var n = Number(obj[key]);
    if (!(n >= FRAME_REF)) { slots.push(0); return; }
    slots.push(Math.floor(n / FRAME_REF));
    obj[key] = n % FRAME_REF;
  };
  take(msg, 'ref'); take(msg, 'submitRef'); take(msg, 'toRef');
  if (msg.within && typeof msg.within === 'object') take(msg.within as Record<string, unknown>, 'ref');
  if (Array.isArray(msg.fields)) (msg.fields as Array<{ ref?: number }>).forEach(function (f) { take(f, 'ref'); });
  var uniq = slots.filter(function (s: number, i: number) { return slots.indexOf(s) === i; });
  if (uniq.length > 1) throw be('INVALID_PARAMS', 'These refs are in different frames of the page; one action works inside one frame.');
  if (!uniq.length || uniq[0] === 0) return null;
  var t = frameSlots.get(tabId);
  var frameId = t && t.byslot[uniq[0]];
  if (!frameId) throw be('REF_NOT_FOUND', 'That ref belongs to a frame from an earlier snapshot. Take a new page_snapshot.');
  delete msg.generation; // generations are per document
  return { frameId: frameId, slot: uniq[0] };
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  var timer: number | undefined;
  return Promise.race([promise, new Promise<never>(function (_, rej) { timer = setTimeout(function () { rej(be('TIMEOUT', what + ' did not answer in time')); }, ms); })]).finally(function () { clearTimeout(timer); });
}

/* Send to a frame. Its script is made sure of first (a cheap call that injects it
   if needed), so a failure after that means the action itself took the frame
   away, as a consent dialog does when it removes itself after "Accept": that is
   reported as done, not as "not found" (the agent would click again). */
var FRAME_ACTS = /^act-(click|type|fillForm|select|key|drag|upload|hover|scroll)$/;
async function frameSend(tabId: number, p: BridgeParams, msg: PageMsg, frameId: number): Promise<unknown> {
  await sendToTab(tabId, p, { kind: 'page-metrics' }, frameId);
  try {
    return await sendToTab(tabId, p, msg, frameId);
  } catch (e) {
    var gone = !e || !(e as ErrObj).code || (e as ErrObj).code === 'NO_CONTENT_SCRIPT' || (e as ErrObj).code === 'REF_STALE' || PAGE_GONE_RE.test(String(e && (e as ErrObj).message));
    if (gone && FRAME_ACTS.test(msg.kind)) {
      return { done: true, frameClosed: true, note: 'The frame went away as the action finished (a dialog closing itself after the click, most likely). Check the page before repeating it.' };
    }
    throw e;
  }
}

/* sendToPage, reaching into cross-origin frames: refs from a frame go to it; a
   name or selector not found on the page is looked for in its frames; a point
   over a frame is clicked inside it. */
async function pageCall(tabId: number, p: BridgeParams, msg: PageMsg): Promise<unknown> {
  var route = routeRefs(tabId, msg);
  if (route) {
    try {
      var rr = frameRefs(await frameSend(tabId, p, msg, route.frameId), route.slot);
      if (rr && typeof rr === 'object' && !Array.isArray(rr) && msg.kind !== 'ax-snapshot' && msg.kind !== 'page-text') rr.frame = 'Inside a cross-origin frame.';
      return rr;
    } catch (e) { throw frameErr(e, route.slot); }
  }
  var byName = (msg.name !== undefined && msg.name !== null && msg.name !== '') || (msg.selector !== undefined && msg.selector !== null && msg.selector !== '');
  var probe = byName && /^act-|^element-rect$/.test(msg.kind);
  try {
    return await sendToPage(tabId, p, probe ? Object.assign({}, msg, { frameProbe: true }) : msg);
  } catch (e) {
    if (e && (e as ErrObj).code === 'IN_FRAME') {
      var at = JSON.parse((e as ErrObj).message as string) as { frameId: number; x: number; y: number };
      var slot = frameSlot(tabId, at.frameId);
      var m2 = Object.assign({}, msg, { x: at.x, y: at.y });
      delete m2.generation;
      try {
        var r = frameRefs(await frameSend(tabId, p, m2, at.frameId), slot);
        if (r && typeof r === 'object') r.frame = 'Inside a cross-origin frame at that point.';
        return r;
      } catch (fe) { throw frameErr(fe, slot); }
    }
    if (!e || (e as ErrObj).code !== 'TRY_FRAMES') throw e;
    var ids = JSON.parse((e as ErrObj).message as string) as number[];
    for (var i = 0; i < ids.length; i++) {
      var s = frameSlot(tabId, ids[i]);
      var sensitive = /^act-(type|upload|drag|fillForm)$/.test(msg.kind);
      var m3 = Object.assign({}, msg, { waitMs: 0 });
      if (sensitive) { m3.kind = 'target-candidate'; delete m3.text; delete m3.files; delete m3.fields; }
      delete m3.generation;
      try {
        var res = frameRefs(await withTimeout(frameSend(tabId, p, m3, ids[i]), 15000, 'A frame'), s);
        if (sensitive) throw be('FRAME_TARGET_REQUIRED' as string as BridgeErrorCode, 'The target was found in a cross-origin frame. Inspect page_snapshot, then repeat with its explicit ref: ' + (res && res.line ? res.line : 'frame ' + ids[i]) + '. No action was taken.');
        if (res && typeof res === 'object') res.frame = 'Found inside a cross-origin frame (e.g. a cookie banner or embedded widget).';
        return res;
      } catch (fe2) {
        if (fe2 && (fe2 as ErrObj).code === 'FRAME_TARGET_REQUIRED') throw fe2;
        if (fe2 && (fe2 as ErrObj).code && (fe2 as ErrObj).code !== 'REF_NOT_FOUND' && (fe2 as ErrObj).code !== 'TIMEOUT' && (fe2 as ErrObj).code !== 'NO_CONTENT_SCRIPT' && (fe2 as ErrObj).code !== 'REF_STALE') throw frameErr(fe2, s);
      }
    }
    // In no frame either: wait on the page itself as usual.
    return await sendToPage(tabId, p, Object.assign({}, msg, { waitMs: 0 }));
  }
}

/* Splice each cross-origin frame's outline in under its [frame:N] line. */
async function withFrameOutlines(tabId: number, p: BridgeParams, snap: PageResult, base: { compact?: boolean; maxChars?: number; viewportOnly?: boolean }): Promise<PageResult> {
  if (!snap || typeof snap.text !== 'string') return snap;
  var frameLines = new Map<number, FrameLine>((snap.frameLines || []).map(function (f: FrameLine) { return [f.line, f] as [number, FrameLine]; }));
  delete snap.frameLines;
  if (!frameLines.size) return snap;
  var budget = Math.max(0, (base.maxChars || 50000) - snap.text.length);
  var out: string[] = [], read = 0;
  var lines = snap.text.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var meta = frameLines.get(i);
    if (!meta || !(meta.frameId > 0)) { out.push(line); continue; }
    var fid = meta.frameId;
    // The trusted content script identifies the actual frame line out of band.
    var at = line.lastIndexOf(meta.marker);
    if (at < 0) { out.push(line); continue; }
    var replaceMarker = function (replacement: string): string { return line.slice(0, at) + replacement + line.slice(at + meta!.marker.length); };
    // The first frame always gets room: it is often the consent dialog listed first.
    if (!read && budget < 8000) budget = 8000;
    if (budget < 200 || read >= 6) { out.push(replaceMarker(' [cross-origin frame: not read here; page_snapshot within:{ref} of this frame reads it]')); continue; }
    try {
      var sub = await withTimeout(sendToPage(tabId, p, { kind: 'ax-snapshot', compact: base.compact, maxChars: budget, viewportOnly: base.viewportOnly }, fid), 6000, 'The frame') as PageResult;
      var slot = frameSlot(tabId, fid);
      sub = frameRefs(sub, slot);
      read++;
      var pad = (/^ */.exec(line) || [''])[0] + '  ';
      var body = String(sub.text || '');
      out.push(replaceMarker(body ? ' [frame content follows]' : ' [frame: nothing interactive inside]'));
      if (body) body.split('\n').forEach(function (l) { out.push(pad + l); });
      budget -= body.length + 2 * (body.split('\n').length);
      if (Array.isArray(sub.nodes)) snap.nodes = (snap.nodes || []).concat(sub.nodes);
      if (sub.truncated) snap.truncated = true;
    } catch (e) {
      out.push(replaceMarker(' [cross-origin frame: could not be read]'));
    }
  }
  snap.text = out.join('\n');
  return snap;
}

/* page_text with the text of cross-origin frames after the page's own, chunked as one. */
async function withFrameText(tabId: number, p: BridgeParams, res: PageResult, off: number, mc: number): Promise<PageResult> {
  if (!res || !Array.isArray(res.frames) || !res.frames.length) { if (res) delete res.frames; return res; }
  var frames = res.frames as PageFrame[];
  delete res.frames;
  var suffix = '';
  for (var i = 0; i < frames.length; i++) {
    try {
      var t = await withTimeout(sendToPage(tabId, p, { kind: 'page-text', maxChars: 20000 }, frames[i].frameId), 6000, 'The frame') as PageResult;
      var slot = frameSlot(tabId, frames[i].frameId);
      if (t && t.text && t.text.trim()) {
        suffix += '\n\n--- frame ' + JSON.stringify(frames[i].name || frames[i].src || 'frame') + ' (ref=' + frames[i].ref + ', ' + (slot ? 'cross-origin' : '') + ') ---\n' + t.text.trim();
      }
    } catch (e) {}
  }
  if (!suffix) return res;
  var T = Number(res.totalChars) || 0;
  var end = off + mc - T;
  if (end > 0) res.text += suffix.slice(Math.max(0, off - T), end);
  res.totalChars = T + suffix.length;
  res.truncated = off + mc < res.totalChars;
  if (res.truncated) res.nextOffset = off + res.text!.length; else delete res.nextOffset;
  return res;
}

/* page_find in cross-origin frames too. */
async function withFrameFinds(tabId: number, p: BridgeParams, res: PageResult, query: string): Promise<PageResult> {
  if (!res || !Array.isArray(res.frames)) return res;
  var frames = res.frames as PageFrame[];
  delete res.frames;
  for (var i = 0; i < frames.length; i++) {
    try {
      var r = await withTimeout(sendToPage(tabId, p, { kind: 'act-find', query: query }, frames[i].frameId), 6000, 'The frame') as PageResult;
      r = frameRefs(r, frameSlot(tabId, frames[i].frameId));
      if (r && r.count) {
        (r.matches || []).forEach(function (m) { m.frame = frames[i].name || frames[i].src || 'cross-origin frame'; });
        res.matches = (res.matches || []).concat(r.matches || []).slice(0, 30);
        res.count = (res.count || 0) + r.count;
        res.truncated = res.count > res.matches.length;
      }
    } catch (e) {}
  }
  return res;
}

/* sendToPage for an action, cancellable: a cancel from the helper (or Pause AI) reaches the page by opId. */
async function actOn(tabId: number, p: BridgeParams, ctx: Ctx, msg: PageMsg): Promise<PageResult> {
  if (ctx.signal.aborted) throw be('CANCELLED', 'The command was cancelled.');
  msg.opId = ctx.id;
  if (p.dialog === 'accept' || p.dialog === 'dismiss') msg.dialog = p.dialog;
  if (typeof p.promptText === 'string') msg.promptText = p.promptText.slice(0, 1000);
  // Tabs this action opens (target=_blank links, window.open) are reported, so the agent can follow them.
  var opened: number[] = [];
  var onCreated = function (t: browser.tabs.Tab) { if (t && t.openerTabId === tabId) opened.push(t.id!); };
  try { B.tabs.onCreated.addListener(onCreated); } catch (e) {}
  var stop = function () {
    // Every frame: the action may be running inside one.
    try { call(B.tabs, 'sendMessage', tabId, { kind: 'cancel', opId: ctx.id }).catch(function () {}); } catch (e) {}
  };
  ctx.signal.addEventListener('abort', stop);
  try {
    var result = await pageCall(tabId, p, msg) as PageResult;
    if (msg.kind === 'act-find') result = await withFrameFinds(tabId, p, result, msg.query as string);
    if (result && typeof result === 'object' && (result.navigating || result.pageChanged)) result = await afterNavigation(tabId, result, ctx.signal);
    if (OPENS_TABS.test(msg.kind)) {
      await sleep(250); // the new tab is created just after the click returns
      if (opened.length) result = await withOpenedTabs(result, opened);
    }
    return result;
  } finally {
    ctx.signal.removeEventListener('abort', stop);
    try { B.tabs.onCreated.removeListener(onCreated); } catch (e) {}
  }
}

/* The action started a navigation: wait (briefly) for the new page, then say where it landed. */
async function afterNavigation(tabId: number, result: PageResult, signal: AbortSignal | undefined): Promise<PageResult> {
  var until = Date.now() + 8000, tab: browser.tabs.Tab | null = null;
  await sleep(150);
  while (Date.now() < until && !(signal && signal.aborted)) {
    try { tab = await call(B.tabs, 'get', tabId); } catch (e) { return result; }
    if (tab.status === 'complete') break;
    await sleep(150);
  }
  if (!tab) return result;
  result.url = tab.url || '';
  result.title = tab.title || '';
  result.loaded = tab.status === 'complete';
  result.note = 'The page navigated' + (result.loaded ? ' and finished loading' : ' (still loading)') +
    '. Refs from before are gone: take page_snapshot before acting again.';
  delete result.pageChanged;
  return result;
}

var OPENS_TABS = /^act-(click|key|type|fillForm|drag)$/;

async function withOpenedTabs(result: PageResult, ids: number[]): Promise<PageResult> {
  var tabs: Array<{ tabId?: number; url: string; active: boolean }> = [];
  for (var i = 0; i < ids.length; i++) {
    try { var t = await call(B.tabs, 'get', ids[i]); tabs.push({ tabId: t.id, url: t.url || '', active: !!t.active }); } catch (e) {}
  }
  if (!tabs.length) return result;
  var out: PageResult = (result && typeof result === 'object' && !Array.isArray(result)) ? result : { result: result };
  out.openedTabs = tabs;
  out.openedNote = 'This opened ' + (tabs.length === 1 ? 'a new tab (tabId ' + tabs[0].tabId + ')' : tabs.length + ' new tabs') +
    '. Pass its tabId to act there; the original tab is unchanged.';
  return out;
}

/* One screenshot at a time: two that each switch tabs would otherwise hand
 * focus back in the wrong order. */
interface ShotResult { image: string; format: 'jpeg' | 'png'; tabId?: number; }
var shootChain: Promise<unknown> = Promise.resolve();
function shoot(tab: browser.tabs.Tab, p: ShotParams): Promise<ShotResult> {
  var run = shootChain.then(function () { return shootNow(tab, p); });
  shootChain = run.catch(function () {});
  return run;
}

async function shootNow(tab: browser.tabs.Tab, p: ShotParams): Promise<ShotResult> {
  var format: 'jpeg' | 'png' = p.format === 'jpeg' ? 'jpeg' : 'png';
  var opts: browser.extensionTypes.ImageDetails = format === 'jpeg' ? { format: format, quality: Math.max(10, Math.min(100, num(p.quality, 80))) } : { format: format };
  if (p.rect) opts.rect = p.rect as browser.extensionTypes.ImageDetails['rect'];
  if (p.scale !== undefined) opts.scale = p.scale as number;
  try { tab = await call(B.tabs, 'get', tab.id!); } catch (e) {} // may have changed while queued
  // Fast path (Firefox 125+): capture a background tab without switching to it.
  if (!tab.active && B.tabs && typeof B.tabs.captureTab === 'function') {
    try {
      return { image: await call(B.tabs as { captureTab(tabId: number, options?: browser.extensionTypes.ImageDetails): Promise<string> }, 'captureTab', tab.id!, opts), format: format, tabId: tab.id };
    } catch (e) { /* fall back to activate + captureVisibleTab */ }
  }
  var restoreId: number | null = null;
  if (!tab.active) {
    var prev = await call(B.tabs, 'query', { active: true, windowId: tab.windowId });
    if (prev && prev[0]) restoreId = prev[0].id!;
    await call(B.tabs, 'update', tab.id!, { active: true });
    await sleep(250); // let the compositor paint the newly active tab
  }
  try {
    var dataUrl = await call(B.tabs as { captureVisibleTab(windowId?: number, options?: browser.extensionTypes.ImageDetails): Promise<string> }, 'captureVisibleTab', tab.windowId, opts);
    return { image: dataUrl, format: format, tabId: tab.id };
  } finally {
    // Hand the user's tab back so screenshots don't hijack what they're looking at,
    // unless they've switched tabs themselves meanwhile.
    if (restoreId !== null && !p.keepActive) {
      try {
        var now = await call(B.tabs, 'query', { active: true, windowId: tab.windowId });
        if (now && now[0] && now[0].id === tab.id) await call(B.tabs, 'update', restoreId, { active: true });
      } catch (e) {}
    }
  }
}

/* Best-effort cursor op on a tab that may have no content script: never injects, never throws. */
async function cursorOp(tabId: number, op: 'say' | 'conceal' | 'reveal' | 'hide', note?: string): Promise<unknown> {
  try {
    return unwrapContentResponse(await call(B.tabs, 'sendMessage', tabId, { kind: 'cursor', op: op, note: note }));
  } catch (e) { return null; }
}

/* After a non-page method (tabs.list, history.search, ...), still show the model's thought. */
async function noteAfter(method: string, p: BridgeParams): Promise<void> {
  if (!CFG.showCursor || typeof p.thought !== 'string' || !p.thought.trim()) return;
  if (CONTENT_METHODS.test(method) || NO_NOTE_METHODS.test(method) || method === 'cursor.say') return;
  try {
    var tab = await resolveTab(p.tabId);
    if (RESTRICTED_RE.test(String(tab.url || '')) || AMO_RE.test(String(tab.url || ''))) return;
    await sendToTab(tab.id!, p, { kind: 'cursor', op: 'say', note: p.thought.slice(0, 300) });
  } catch (e) {}
}

/* Cursor turned off: clear it from every tab right away. */
async function hideCursors() {
  try {
    var tabs = await call(B.tabs, 'query', {});
    (tabs || []).forEach(function (t) { cursorOp(t.id!, 'hide'); });
  } catch (e) {}
}

/* Resolve true once a tab finishes loading, false on timeout or abort.
 * The listener goes on before the navigation starts (so no event is missed);
 * call start(tabId) once the tab id is known. Events seen before that are
 * buffered. With checkNow, a tab that is already complete counts (used for new
 * tabs, which have no previous page whose 'complete' could be mistaken). */
interface LoadInfo { status?: string; loading?: boolean; loadComplete?: boolean; ready?: boolean; note?: string; }
function loadResult(info: LoadInfo, ok: boolean | string): LoadInfo {
  info.loadComplete = ok === true || info.status === 'complete' || info.loading === false;
  if (ok === 'ready' && !info.loadComplete) {
    info.ready = true;
    info.note = 'The page is up and usable; it is still loading some resources in the background.';
  }
  return info;
}

function tabLoadWaiter(timeoutMs: number, signal: AbortSignal | undefined, wantUrl?: string) {
  var tabId: number | null = null, buffered: Array<[number, browser.tabs._OnUpdatedChangeInfo, browser.tabs.Tab]> = [], sawLoading = false, done = false, resolveFn!: (v: boolean | string) => void;
  var promise = new Promise<boolean | string>(function (r) { resolveFn = r; });
  var wantBlank = /^about:blank/i.test(String(wantUrl || ''));
  function finish(v: boolean | string): void {
    if (done) return;
    done = true;
    clearTimeout(timer);
    clearInterval(poll);
    try { B.tabs.onUpdated.removeListener(onUpd); } catch (e) {}
    if (signal) signal.removeEventListener('abort', onAbort);
    resolveFn(v);
  }
  // A new tab passes through about:blank; that 'complete' isn't the page we want.
  function placeholder(tab: browser.tabs.Tab | undefined): boolean | undefined {
    return !wantBlank && tab && /^about:blank/i.test(String(tab.url || ''));
  }
  function consider(info: browser.tabs._OnUpdatedChangeInfo, tab: browser.tabs.Tab | undefined): void {
    // Ignore the 'complete' of the page we're navigating away from: require a
    // 'loading' first, or a URL change, before accepting 'complete'.
    if (info.status === 'loading' || info.url) sawLoading = true;
    if (info.status === 'complete' && sawLoading && !placeholder(tab)) finish(true);
  }
  function onUpd(id: number, info: browser.tabs._OnUpdatedChangeInfo, tab: browser.tabs.Tab): void {
    if (done || !info) return;
    if (tabId === null) { buffered.push([id, info, tab]); return; }
    if (id === tabId) consider(info, tab);
  }
  function onAbort() { finish(false); }
  var timer = setTimeout(function () { finish(false); }, Math.max(1000, timeoutMs));
  // Some pages never reach 'complete' (long-polling, endless trackers). Once the new page's
  // document is up and has been for a few seconds, it's usable: return 'ready' instead of waiting it out.
  var began = Date.now(), startUrl: string | null = null;
  var poll = setInterval(function () {
    if (done || tabId === null || !sawLoading || Date.now() - began < 3000) return;
    call(B.tabs, 'get', tabId).then(function (t) {
      if (done || !t || placeholder(t) || t.status === 'complete') return;
      return call(B.tabs, 'sendMessage', tabId!, { kind: 'page-metrics' }, { frameId: 0 }).then(function (res) {
        var r = res && res.__fxmcp ? res.result : res;
        // Only the new page counts: while a slow navigation is pending, the old one still answers.
        var bare = function (u: unknown): string { return String(u || '').split('#')[0].replace(/\/$/, ''); };
        var isNew = r && (bare(r.href) === bare(wantUrl) || (startUrl !== null && bare(r.href) !== bare(startUrl)));
        if (!done && r && r.ready && r.href === t.url && isNew) finish('ready');
      });
    }).catch(function () {});
  }, 1000);
  B.tabs.onUpdated.addListener(onUpd);
  if (signal) {
    if (signal.aborted) finish(false);
    else signal.addEventListener('abort', onAbort);
  }
  return {
    promise: promise,
    start: function (id: number, checkNow?: boolean): void {
      tabId = id;
      call(B.tabs, 'get', id).then(function (t) { startUrl = checkNow ? 'about:blank' : (t && t.url) || ''; }).catch(function () { startUrl = ''; });
      var early = buffered;
      buffered = [];
      early.forEach(function (e) { if (!done && e[0] === id) consider(e[1], e[2]); });
      if (checkNow && !done) {
        call(B.tabs, 'get', id).then(function (t) {
          if (t && t.status === 'complete' && !placeholder(t)) finish(true);
        }).catch(function () {});
      }
    },
    cancel: function () { finish(false); }
  };
}

/* A URL as people (and models) type it: "github.com/x" -> https://github.com/x, "localhost:3000" ->
 * http://localhost:3000. Without this Firefox resolves it against the add-on's own origin. */
var LOCAL_HOST_RE = /^(localhost|127(\.\d{1,3}){3}|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:.]+\]|[\w-]+\.(local|localhost|internal|lan|test))(:\d+)?([/?#]|$)/i;
function fixUrl(u: unknown): string {
  var s = String(u).trim();
  if (!s) return s;
  if (LOCAL_HOST_RE.test(s)) return 'http://' + s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^/:]+:\d+([/?#]|$)/.test(s)) return s; // has a scheme (about:, https:, ...)
  if (s.indexOf('//') === 0) return 'https:' + s;
  return 'https://' + s;
}

/* Same page apart from the #fragment, which navigates without loading. */
function sameDocument(from: unknown, to: unknown): boolean {
  var a = String(from || ''), b = String(to || '');
  if (b.indexOf('#') < 0) return false;
  try { b = new URL(b, a).href; } catch (e) { return false; }
  return a.split('#')[0] === b.split('#')[0] && a !== b;
}

/* tab.update with active:true also brings its window forward. */
async function focusWindow(props: { active?: boolean }, tab: { windowId?: number } | null | undefined): Promise<void> {
  if (!props.active || !tab) return;
  try { await call(B.windows, 'update', tab.windowId!, { focused: true }); } catch (e) {}
}

/* A user regex that can't backtrack catastrophically: JS regexes can't be
 * timed out, and a hung match would freeze the whole add-on. Rejects
 * backreferences and a quantified group with a quantifier inside, e.g. (a+)+. */
function safeRegExp(src: string | null | undefined): RegExp | null {
  if (src === undefined || src === null || src === '') return null;
  src = String(src);
  if (src.length > 500) throw new Error('pattern longer than 500 characters');
  var stack: boolean[] = [], inClass = false, prevQuant = false;
  for (var i = 0; i < src.length; i++) {
    var c = src[i];
    if (c === '\\') {
      if (/[1-9k]/.test(src[i + 1] || '') && !inClass) throw new Error('backreferences are not supported');
      i++; prevQuant = false; continue;
    }
    if (inClass) { if (c === ']') inClass = false; continue; }
    var quant = c === '*' || c === '+' || (c === '?' && src[i - 1] !== '(') || (c === '{' && /^\{\d+(,\d*)?\}/.test(src.slice(i)));
    if (c === '[') inClass = true;
    else if (c === '(') stack.push(false);
    else if (c === ')') {
      var inner = stack.pop();
      var after = src.slice(i + 1);
      if (inner && /^(?:[*+]|\{\d+,)/.test(after)) throw new Error('nested quantifiers are not supported');
      if (inner && stack.length) stack[stack.length - 1] = true;
      // The group as a whole becomes the quantified atom.
      if (/^(?:[*+?]|\{\d+(,\d*)?\})/.test(after) && stack.length) stack[stack.length - 1] = true;
    } else if (quant && !prevQuant && stack.length) stack[stack.length - 1] = true;
    prevQuant = quant;
  }
  return new RegExp(src);
}

/* Run every actual regex match away from the background event loop. */
async function patternMatches(tabs: browser.tabs.Tab[], urlRe: RegExp | null | undefined, titleRe: RegExp | null | undefined): Promise<boolean[]> {
  if (!urlRe && !titleRe) return tabs.map(function () { return true; });
  if (typeof Worker === 'undefined') throw be('INVALID_PARAMS', 'Regex matching is unavailable without a Worker; use query instead.');
  return new Promise<boolean[]>(function (resolve, reject) {
    var worker = new Worker(B.runtime.getURL('regex-worker.js'));
    var finish = function (error: string | undefined, matches?: boolean[]): void { clearTimeout(timer); worker.terminate(); if (error) reject(be('INVALID_PARAMS', error)); else resolve(matches as boolean[]); };
    var timer = setTimeout(function () { finish('Regex matching exceeded 250ms; use query or a simpler pattern.'); }, 250);
    worker.onmessage = function (event: MessageEvent) { finish(event.data.error, event.data.matches); };
    worker.onerror = function () { finish('Regex worker failed; use query or a simpler pattern.'); };
    worker.postMessage({ urlPattern: urlRe && urlRe.source, titlePattern: titleRe && titleRe.source, tabs: tabs.map(function (tab: browser.tabs.Tab) { return { url: String(tab.url || '').slice(0, 2048), title: String(tab.title || '').slice(0, 512) }; }) });
  });
}

/* Copy the params that were given (not undefined/null) onto msg. */
function pick(p: BridgeParams, keys: string[], msg?: PageMsg): PageMsg;
function pick<M extends object>(p: BridgeParams, keys: string[], msg: M): M;
function pick(p: BridgeParams, keys: string[], msg?: object): object {
  msg = msg || {};
  keys.forEach(function (k) { if (p[k] !== undefined && p[k] !== null) (msg as Record<string, unknown>)[k] = p[k]; });
  return msg;
}

/* How an action names its element: a snapshot ref, a CSS selector, an accessible
 * name (+ role, nth), or a point. The content script resolves them (see locate in ax.js). */
var TARGET_KEYS = ['ref', 'selector', 'name', 'role', 'nth', 'x', 'y', 'generation', 'waitMs'];

function hasTargetParams(p: BridgeParams): boolean {
  return ['ref', 'selector', 'name', 'role', 'x'].some(function (k) { return p[k] !== undefined && p[k] !== null && p[k] !== ''; });
}

/* A page action: resolve the tab, forward the target and the action's own fields. */
async function act(p: BridgeParams, ctx: Ctx, kind: ContentMessage['kind'], keys: string[], base?: { [k: string]: unknown }): Promise<PageResult> {
  var tab = await resolveTab(p.tabId);
  assertContentAllowed(tab);
  var msg = pick(p, TARGET_KEYS.concat(['changes'], keys), Object.assign({ kind: kind }, base || {}) as PageMsg);
  return await actOn(tab.id!, p, ctx, msg);
}

/* Agent storage: a small key-value store in the add-on that outlives tabs, pages
 * and restarts. Page storage: the page's own localStorage/sessionStorage. */
var AGENT_STORE = 'agentStore';
var AGENT_MAX_KEYS = 1000, AGENT_MAX_VALUE = 100000;
interface AgentEntry { v?: unknown; at?: string; }
var storeQueue: Promise<unknown> = Promise.resolve();
function storageOp(op: 'get' | 'set' | 'remove', p: BridgeParams): Promise<unknown> {
  if ((p.area || 'agent') !== 'agent') return storageOpNow(op, p);
  var result = storeQueue.then(function () { return storageOpNow(op, p); });
  storeQueue = result.catch(function () {});
  return result;
}

async function storageOpNow(op: 'get' | 'set' | 'remove', p: BridgeParams): Promise<unknown> {
  var area = p.area || 'agent';
  if (area === 'local' || area === 'session') {
    var tab = await resolveTab(p.tabId);
    assertContentAllowed(tab);
    return await sendToPage(tab.id!, p, pick(p, ['key', 'value'], { kind: 'page-storage', op: op, area: area }));
  }
  if (area !== 'agent') throw be('INVALID_PARAMS', 'area must be "agent", "local" or "session"');
  var got = await call(B.storage.local, 'get', AGENT_STORE);
  var store: Record<string, AgentEntry> = Object.assign(Object.create(null), (got && got[AGENT_STORE] && typeof got[AGENT_STORE] === 'object') ? got[AGENT_STORE] : {});
  var key = (p.key === undefined || p.key === null || p.key === '') ? null : String(p.key).slice(0, 200);
  if (op === 'get') {
    if (key === null) {
      var prefix = p.prefix ? String(p.prefix) : '';
      var keys = Object.keys(store).filter(function (k) { return k.indexOf(prefix) === 0; }).sort();
      return { area: 'agent', count: keys.length, keys: keys.map(function (k) { return { key: k, updated: store[k].at }; }) };
    }
    if (!(Object.prototype.hasOwnProperty.call(store, key))) return { area: 'agent', key: key, found: false };
    return { area: 'agent', key: key, found: true, value: store[key].v, updated: store[key].at };
  }
  if (key === null) throw be('INVALID_PARAMS', 'storage_' + op + ' needs a key');
  if (op === 'set') {
    var size = JSON.stringify(p.value === undefined ? null : p.value).length;
    if (size > AGENT_MAX_VALUE) throw be('PAYLOAD_TOO_LARGE', 'Values are limited to ' + AGENT_MAX_VALUE + ' characters of JSON (this one is ' + size + ').');
    if (!(Object.prototype.hasOwnProperty.call(store, key)) && Object.keys(store).length >= AGENT_MAX_KEYS) throw be('PAYLOAD_TOO_LARGE', 'The agent store is full (' + AGENT_MAX_KEYS + ' keys). Remove some first.');
    store[key] = { v: p.value === undefined ? null : p.value, at: new Date().toISOString() };
    var put: Record<string, unknown> = {}; put[AGENT_STORE] = store; await call(B.storage.local, 'set', put);
    return { area: 'agent', key: key, saved: true };
  }
  var had = Object.prototype.hasOwnProperty.call(store, key);
  delete store[key];
  if (had) { var put: Record<string, unknown> = {}; put[AGENT_STORE] = store; await call(B.storage.local, 'set', put); }
  return { area: 'agent', key: key, removed: had };
}

/* The cookie jar a tab sees: its container / private store, across first-party
 * isolation, including cookies partitioned under its site (CHIPS / Total Cookie
 * Protection). Older Firefox lacks some keys; drop them and retry. */
interface CookieQuery { url: string; firstPartyDomain?: string | null; partitionKey?: object; storeId?: string; }
async function jarCookies(tab: browser.tabs.Tab | null | undefined, url: string, extra?: { [k: string]: unknown } | null): Promise<browser.cookies.Cookie[]> {
  var q: CookieQuery = Object.assign({ url: url.split('#')[0], firstPartyDomain: null, partitionKey: {} }, extra || {}) as CookieQuery;
  if (tab && tab.cookieStoreId) q.storeId = tab.cookieStoreId;
  var cookies: browser.cookies.Cookie[] | undefined;
  for (var attempt = 0; ; attempt++) {
    try {
      cookies = await call(B.cookies, 'getAll', q as browser.cookies._GetAllDetails);
      break;
    } catch (e) {
      if (attempt === 0 && 'partitionKey' in q) { delete q.partitionKey; continue; }
      if (attempt <= 1 && 'firstPartyDomain' in q) { delete q.firstPartyDomain; continue; }
      throw e;
    }
  }
  var host = '', scheme = '';
  try { var u = new URL(url); host = u.hostname; scheme = u.protocol; } catch (e) {}
  var under = function (d: string): boolean { return host === d || host.endsWith('.' + d); };
  return (cookies || []).filter(function (c: browser.cookies.Cookie) {
    // First-party isolation: keep only the jar of this site, not cookies it set as a third party elsewhere.
    var fpd = c.firstPartyDomain;
    if (fpd) {
      var m = /^\((\w+),([^,)]+)/.exec(fpd); // "(https,example.com[,port])" when isolating by scheme too
      if (m ? (m[1] + ':' !== scheme || !under(m[2])) : !under(fpd)) return false;
    }
    var site = c.partitionKey && c.partitionKey.topLevelSite;
    if (!site) return true;
    try {
      var su = new URL(site);
      return su.protocol === scheme && under(su.hostname);
    } catch (e) {
      return false;
    }
  });
}

/* The URL cookies are read or written for: the one given, else the tab's page. */
async function cookieTarget(p: BridgeParams): Promise<{ tab: browser.tabs.Tab; url: string }> {
  var tab = await resolveTab(p.tabId);
  var url = p.url !== undefined && p.url !== null && p.url !== '' ? fixUrl(p.url) : String(tab.url || '');
  if (!/^https?:/i.test(url)) throw be('INVALID_PARAMS', 'Cookies need an http(s) page; this tab shows ' + (url || 'nothing') + '. Pass url.');
  return { tab: tab, url: url };
}

interface CookieInfo { name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean; sameSite: string; session: boolean; expires?: string; partitionedUnder?: string; }
function cookieInfo(c: browser.cookies.Cookie): CookieInfo {
  var o: CookieInfo = {
    name: c.name, value: c.value, domain: c.domain, path: c.path,
    secure: !!c.secure, httpOnly: !!c.httpOnly, sameSite: c.sameSite || 'no_restriction',
    session: !!c.session
  };
  if (!c.session && c.expirationDate) o.expires = new Date(c.expirationDate * 1000).toISOString();
  if (c.partitionKey && c.partitionKey.topLevelSite) o.partitionedUnder = c.partitionKey.topLevelSite;
  return o;
}

/* A download as the agent needs it: where the file is, whether it's done, and why not. */
interface DownloadInfo { id: number; url: string; path: string; file?: string; state: string; bytesReceived: number; totalBytes: number | null; mime: string; startTime: string; exists: boolean; endTime?: string; error?: string; danger?: string; paused?: boolean; }
async function downloadInfo(d: browser.downloads.DownloadItem): Promise<DownloadInfo> {
  var o: DownloadInfo = {
    id: d.id, url: d.url, path: d.filename || '', file: String(d.filename || '').split(/[\\/]/).pop(),
    state: d.state, bytesReceived: d.bytesReceived, totalBytes: d.totalBytes >= 0 ? d.totalBytes : null,
    mime: d.mime || '', startTime: d.startTime, exists: !!d.exists
  };
  if (d.endTime) o.endTime = d.endTime;
  if (d.error) o.error = d.error;
  if (d.danger && d.danger !== 'safe' && d.danger !== 'accepted') o.danger = d.danger;
  if (d.paused) o.paused = true;
  return o;
}

/* ---------------------------------------------------------------- handlers */

interface ListPage<T> {
  items: T[];
  total: number;
  offset: number;
  returned: number;
  truncated: boolean;
  nextOffset?: number;
}

/* Additive pagination: small unpaged results retain their array shape. Large
 * lists get a valid, resumable envelope instead of being cut in the middle of JSON. */
function listPage<T>(items: T[], p: BridgeParams): T[] | ListPage<T> {
  var offset = Math.max(0, Math.floor(Number(p.offset) || 0));
  var limit = Math.max(1, Math.min(1000, Math.floor(Number(p.limit) || items.length || 1)));
  var selected = items.slice(offset, offset + limit);
  var explicit = p.offset !== undefined || p.limit !== undefined;
  if (!explicit && JSON.stringify(selected).length <= 18000) return selected;
  var kept: T[] = [], size = 0;
  for (var i = 0; i < selected.length; i++) {
    var length = JSON.stringify(selected[i]).length + 1;
    if (kept.length && size + length > 18000) break;
    kept.push(selected[i]); size += length;
  }
  var next = offset + kept.length;
  var result: ListPage<T> = { items: kept, total: items.length, offset: offset, returned: kept.length, truncated: next < items.length };
  if (next < items.length) result.nextOffset = next;
  return result;
}

interface TabsReloadApi {
  reload(tabId: number, props?: { bypassCache?: boolean }): Promise<void>;
}

interface TabsMuteApi {
  updateMutedInfo?(tabId: number, info: { muted: boolean }): Promise<unknown>;
  update(tabId: number, props: { muted: boolean }): Promise<unknown>;
}

interface ShotRect { x: number; y: number; width: number; height: number; }

interface ShotParams {
  format?: unknown;
  quality?: unknown;
  keepActive?: unknown;
  rect?: ShotRect;
  scale?: number;
}

type TabReport = ReturnType<typeof toTabInfo> & { loadComplete?: boolean; status?: string; note?: string };

var handlers: { [M in BridgeMethod]: (p: BridgeParams, ctx: Ctx) => Promise<unknown> } = {
  /* ---- inventory ---- */
  'tabs.list': async function (p) {
    var tabs = await call(B.tabs, 'query', {});
    if (p && p.includeDiscarded === false) tabs = tabs.filter(function (t) { return !t.discarded; });
    return tabs.map(toTabInfo);
  },
  'tabs.query': async function (p) {
    var tabs = await call(B.tabs, 'query', {});
    var urlRe: RegExp | null = null, titleRe: RegExp | null = null;
    var text = (p.query === undefined || p.query === null || p.query === '*') ? '' : String(p.query).trim().toLowerCase();
    try {
      urlRe = p.urlPattern === '*' ? null : safeRegExp(p.urlPattern as string | undefined);
      titleRe = p.titlePattern === '*' ? null : safeRegExp(p.titlePattern as string | undefined);
    } catch (e) {
      throw be('INVALID_PARAMS', 'Bad regex in tabs.query: ' + (e as Error).message);
    }
    var matches = await patternMatches(tabs, urlRe, titleRe);
    return listPage(tabs.filter(function (t, index) {
      if (!matches[index]) return false;
      if (p.audible !== undefined && !!t.audible !== !!p.audible) return false;
      if (p.pinned !== undefined && !!t.pinned !== !!p.pinned) return false;
      if (p.active !== undefined && !!t.active !== !!p.active) return false;
      if (p.windowId !== undefined && t.windowId !== Number(p.windowId)) return false;
      if (p.includeDiscarded === false && t.discarded) return false;
      if (text && (String(t.url || '') + ' ' + String(t.title || '')).toLowerCase().indexOf(text) < 0) return false;
      return true;
    }).map(toTabInfo), p);
  },
  'windows.list': async function () {
    var wins = await call(B.windows, 'getAll', { populate: true });
    return wins.map(toWindowInfo);
  },
  'active.tab': async function () {
    return toTabInfo(await resolveTab(undefined));
  },

  /* ---- tab management ---- */
  'tab.create': async function (p, ctx) {
    if (p.duplicateOf !== undefined && p.duplicateOf !== null) {
      var src = await resolveTab(p.duplicateOf);
      var dup = await call(B.tabs, 'duplicate', src.id!, p.active === false ? { active: false } : undefined);
      return toTabInfo(dup);
    }
    var details: browser.tabs._CreateCreateProperties = {};
    if (p.windowId !== undefined) details.windowId = Number(p.windowId);
    if (p.url !== undefined) details.url = fixUrl(p.url);
    if (p.active !== undefined) details.active = !!p.active;
    var waiter = details.url && p.waitForLoad ? tabLoadWaiter(num(p.timeoutMs, 20000), ctx.signal, details.url) : null;
    var created: browser.tabs.Tab;
    try {
      created = await call(B.tabs, 'create', details);
    } catch (e) {
      if (waiter) waiter.cancel();
      throw e;
    }
    if (waiter) {
      waiter.start(created.id!, true);
      var ok = await waiter.promise;
      var info = toTabInfo(await call(B.tabs, 'get', created.id!));
      return loadResult(info, ok);
    }
    return toTabInfo(created);
  },
  'tab.update': async function (p, ctx) {
    var tab = await resolveTab(p.tabId);
    var props: browser.tabs._UpdateUpdateProperties = {};
    if (p.url !== undefined) props.url = fixUrl(p.url);
    if (p.active !== undefined) props.active = !!p.active;
    if (p.pinned !== undefined) props.pinned = !!p.pinned;
    var updated = tab;
    if (props.url !== undefined && p.waitForLoad && sameDocument(tab.url, props.url)) {
      // A #fragment change doesn't load anything, so there is nothing to wait for.
      updated = await call(B.tabs, 'update', tab.id!, props);
      await focusWindow(props, updated);
      var same: TabReport = toTabInfo(await call(B.tabs, 'get', tab.id!));
      same.loadComplete = true;
      return same;
    }
    if (props.url !== undefined && p.waitForLoad) {
      var loaded = tabLoadWaiter(num(p.timeoutMs, 20000), ctx.signal, props.url);
      loaded.start(tab.id!, false);
      try {
        await call(B.tabs, 'update', tab.id!, props);
      } catch (e) {
        loaded.cancel();
        throw e;
      }
      var ok = await loaded.promise;
      var info = toTabInfo(await call(B.tabs, 'get', tab.id!));
      await focusWindow(props, info);
      return loadResult(info, ok);
    }
    if (Object.keys(props).length) updated = await call(B.tabs, 'update', tab.id!, props);
    await focusWindow(props, updated);
    return toTabInfo(updated || tab);
  },
  'tab.navigate': async function (p, ctx) {
    if (p.url !== undefined && p.url !== null && p.url !== '') return await handlers['tab.update'](pick(p, ['tabId', 'url', 'waitForLoad', 'timeoutMs']), ctx);
    var go = p.go;
    if (go !== 'back' && go !== 'forward' && go !== 'reload') throw be('INVALID_PARAMS', 'tab_navigate needs url, or go: "back", "forward" or "reload"');
    var tab = await resolveTab(p.tabId);
    var wait = p.waitForLoad !== false ? tabLoadWaiter(num(p.timeoutMs, 20000), ctx.signal) : null;
    if (wait) wait.start(tab.id!, false);
    try {
      if (go === 'back') await call(B.tabs, 'goBack', tab.id!);
      else if (go === 'forward') await call(B.tabs, 'goForward', tab.id!);
      else await call(B.tabs as TabsReloadApi, 'reload', tab.id!, { bypassCache: !!p.bypassCache });
    } catch (e) {
      if (wait) wait.cancel();
      if (go !== 'reload') throw be('NAVIGATION_FAILED', 'Cannot go ' + go + ': ' + ((e as Error).message || e) + ' (no history that way?)');
      throw e;
    }
    // Back/forward within one page (#fragments, pushState) fires no load; don't wait the full timeout.
    var fallbackTimer;
    var ok: boolean | null;
    try {
      ok = (!wait ? null : go === 'reload' ? await wait.promise : await Promise.race([wait.promise, new Promise(function (resolve) { fallbackTimer = setTimeout(function () { resolve(null); }, 3000); })]) ) as boolean | null;
    } finally { if (fallbackTimer) clearTimeout(fallbackTimer); }
    if (wait) wait.cancel();
    var info: TabReport = toTabInfo(await call(B.tabs, 'get', tab.id!));
    if (wait) info.loadComplete = ok === null ? info.status === 'complete' : ok;
    if (go !== 'reload' && info.url === tab.url) info.note = 'The URL did not change: there may be no history ' + go + ', or the page changed in place.';
    return info;
  },
  'tab.close': async function (p) {
    var ids: number[];
    if (Array.isArray(p.tabIds)) ids = p.tabIds.map(Number);
    else if (p.tabId !== undefined) ids = [Number(p.tabId)];
    else ids = [(await resolveTab(undefined)).id!];
    try {
      await call(B.tabs, 'remove', ids);
    } catch (e) {
      throw be('TAB_NOT_FOUND', 'Could not close tab(s): ' + ((e as Error).message || e));
    }
    return { closed: ids };
  },
  'tab.duplicate': async function (p) {
    var tab = await resolveTab(p.tabId);
    return toTabInfo(await call(B.tabs, 'duplicate', tab.id!));
  },
  'tab.move': async function (p) {
    if (p.index === undefined) throw be('INVALID_PARAMS', 'tab.move requires index');
    var tab = await resolveTab(p.tabId);
    var props: { index: number; windowId?: number } = { index: Number(p.index) };
    if (p.windowId !== undefined) props.windowId = Number(p.windowId);
    var moved = await call(B.tabs, 'move', tab.id!, props);
    var t = Array.isArray(moved) ? moved[0] : moved;
    return toTabInfo(t || tab);
  },
  'tab.pin': async function (p) {
    var tab = await resolveTab(p.tabId);
    return toTabInfo(await call(B.tabs, 'update', tab.id!, { pinned: p.pinned !== undefined ? !!p.pinned : true }));
  },
  'tab.unpin': async function (p) {
    var tab = await resolveTab(p.tabId);
    return toTabInfo(await call(B.tabs, 'update', tab.id!, { pinned: false }));
  },
  'tab.mute': async function (p) {
    var tab = await resolveTab(p.tabId);
    var muted = p.muted !== undefined ? !!p.muted : true;
    // NOTE: Firefox tabs.update does NOT support `muted` (Chrome-only).
    // Correct API: browser.tabs.updateMutedInfo(tabId, { muted }).
    if (B.tabs && typeof (B.tabs as TabsMuteApi).updateMutedInfo === 'function') {
      await call(B.tabs as TabsMuteApi, 'updateMutedInfo', tab.id!, { muted: muted });
    } else {
      // chrome fallback: chrome.tabs.update supports `muted`.
      await call(B.tabs as TabsMuteApi, 'update', tab.id!, { muted: muted });
    }
    try {
      return toTabInfo(await call(B.tabs, 'get', tab.id!));
    } catch (e) {
      return { muted: muted, tabId: tab.id };
    }
  },

  /* ---- windows ---- */
  'window.create': async function (p) {
    var w = await call(B.windows, 'create', p.url ? { url: fixUrl(p.url) } : {});
    return {
      id: w.id,
      focused: !!w.focused,
      incognito: !!w.incognito,
      type: w.type || 'normal',
      tabCount: Array.isArray(w.tabs) ? w.tabs.length : 1
    };
  },
  'window.focus': async function (p) {
    if (p.windowId === undefined) throw be('INVALID_PARAMS', 'window.focus requires windowId');
    await call(B.windows, 'update', Number(p.windowId), { focused: true });
    return { focused: true, windowId: Number(p.windowId) };
  },
  'window.remove': async function (p) {
    if (p.windowId === undefined) throw be('INVALID_PARAMS', 'window.remove requires windowId');
    await call(B.windows, 'remove', Number(p.windowId));
    return { removed: true, windowId: Number(p.windowId) };
  },

  /* ---- navigation ---- */
  'nav.back': async function (p) {
    var tab = await resolveTab(p.tabId);
    await call(B.tabs, 'goBack', tab.id!);
    return { navigated: true, tabId: tab.id };
  },
  'nav.forward': async function (p) {
    var tab = await resolveTab(p.tabId);
    await call(B.tabs, 'goForward', tab.id!);
    return { navigated: true, tabId: tab.id };
  },
  'nav.reload': async function (p) {
    var tab = await resolveTab(p.tabId);
    if (p.bypassCache !== undefined) await call(B.tabs as TabsReloadApi, 'reload', tab.id!, { bypassCache: !!p.bypassCache });
    else await call(B.tabs as TabsReloadApi, 'reload', tab.id!);
    return { reloaded: true, tabId: tab.id };
  },

  /* ---- understanding ---- */
  'page.snapshot': async function (p) {
    var tab = await resolveTab(p.tabId);
    assertContentAllowed(tab);
    var base = pick(p, ['within', 'viewportOnly'], {
      kind: 'ax-snapshot',
      compact: p.compact !== undefined ? !!p.compact : true,
      maxChars: num(p.maxChars, 50000)
    });
    if (base.within) base.within = Object.assign({}, base.within);
    var snap = await pageCall(tab.id!, p, Object.assign({}, base)) as PageResult;
    return await withFrameOutlines(tab.id!, p, snap, base as Extract<ContentMessage, { kind: 'ax-snapshot' }>);
  },
  'page.text': async function (p) {
    var tab = await resolveTab(p.tabId);
    assertContentAllowed(tab);
    var tm = pick(p, ['within', 'offset', 'format'], { kind: 'page-text', maxChars: num(p.maxChars, 20000), withFrames: true });
    if (tm.within) tm.within = Object.assign({}, tm.within);
    var res = await pageCall(tab.id!, p, tm) as PageResult;
    return await withFrameText(tab.id!, p, res, Math.max(0, Math.floor(Number(p.offset) || 0)), tm.maxChars as number);
  },
  'page.html': async function (p) {
    var tab = await resolveTab(p.tabId);
    assertContentAllowed(tab);
    return await pageCall(tab.id!, p, pick(p, ['within'], {
      kind: 'page-html',
      selector: p.selector as string | undefined,
      maxChars: num(p.maxChars, 50000)
    }));
  },
  'page.shot': async function (p) {
    var tab = await resolveTab(p.tabId);
    var shotP: ShotParams = { format: p.format, quality: p.quality, keepActive: p.keepActive };
    var scale = p.scale !== undefined ? Math.max(0.1, Math.min(2, Number(p.scale) || 1)) : null;
    var extra: { cutOff?: string; element?: unknown; region?: ShotRect } = {};
    var element = hasTargetParams(p);
    if (element || p.fullPage) {
      assertContentAllowed(tab);
      var m = await pageCall(tab.id!, p, element
        ? pick(p, TARGET_KEYS, { kind: 'element-rect' })
        : { kind: 'page-metrics' }) as PageResult;
      if (element && m.frame) throw be('NOT_SUPPORTED', 'That element is inside a cross-origin frame, which can\'t be captured on its own. Capture the frame itself (its ref from page_snapshot) or the visible area.');
      var r = (element ? m.rect : { x: 0, y: 0, width: m.width, height: m.height }) as ShotRect;
      if (element && (r.width < 1 || r.height < 1)) throw be('NOT_INTERACTABLE', 'That element has no size on screen (' + (m.line || 'hidden') + ').');
      var maxH = 16000;
      if (r.height > maxH) { extra.cutOff = 'Only the top ' + maxH + 'px of ' + Math.round(r.height) + 'px were captured.'; r.height = maxH; }
      shotP.rect = { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) };
      // A tall page at full size is a huge image: shrink it unless a scale was asked for.
      if (scale === null) scale = Math.min(1, 4000 / Math.max(r.width, r.height));
      if (element) extra.element = m.line;
      extra.region = shotP.rect;
    }
    if (scale !== null) shotP.scale = scale;
    // Keep the AI cursor out of the picture.
    var concealed = !!(await cursorOp(tab.id!, 'conceal'));
    try {
      var out: ShotResult & { scale?: number } = await shoot(tab, shotP);
      if (scale !== null) out.scale = Math.round(scale * 100) / 100;
      return Object.assign(out, extra);
    } finally {
      if (concealed) cursorOp(tab.id!, 'reveal');
    }
  },
  'cursor.say': async function (p) {
    var tab = await resolveTab(p.tabId);
    var note = String(p.note || p.thought || '').trim();
    if (!note) throw be('INVALID_PARAMS', 'cursor.say requires note');
    if (!CFG.showCursor) return { shown: false, reason: 'The user turned the AI cursor off' };
    assertContentAllowed(tab);
    return await sendToTab(tab.id!, p, { kind: 'cursor', op: 'say', note: note.slice(0, 300) });
  },
  'page.info': async function (p) {
    var tab = await resolveTab(p.tabId);
    return {
      id: tab.id,
      url: tab.url || '',
      title: tab.title || '',
      status: tab.status || '',
      windowId: tab.windowId,
      active: !!tab.active,
      pinned: !!tab.pinned,
      audible: !!tab.audible,
      muted: !!(tab.mutedInfo && tab.mutedInfo.muted),
      discarded: !!tab.discarded,
      index: tab.index
    };
  },

  /* ---- acting (content script does the DOM work) ---- */
  'act.click': async function (p, ctx) {
    return await act(p, ctx, 'act-click', ['double', 'modifiers'], { button: p.button || 'left' });
  },
  'act.type': async function (p, ctx) {
    return await act(p, ctx, 'act-type', ['append', 'submitRef', 'submitSelector', 'submitName'], {
      text: (p.text === undefined || p.text === null) ? '' : String(p.text),
      submit: !!p.submit
    });
  },
  'act.fillForm': async function (p, ctx) {
    if (!Array.isArray(p.fields)) throw be('INVALID_PARAMS', 'act.fillForm requires fields[]');
    var tab = await resolveTab(p.tabId);
    assertContentAllowed(tab);
    return await actOn(tab.id!, p, ctx, pick(p, ['generation', 'changes', 'submitRef', 'submitSelector', 'submitName'], {
      kind: 'act-fillForm', fields: p.fields, submit: !!p.submit
    }));
  },
  'act.select': async function (p, ctx) {
    if (!Array.isArray(p.values)) throw be('INVALID_PARAMS', 'act.select requires values[]');
    return await act(p, ctx, 'act-select', [], { values: p.values.map(String) });
  },
  'act.hover': async function (p, ctx) {
    return await act(p, ctx, 'act-hover', []);
  },
  'act.scroll': async function (p, ctx) {
    return await act(p, ctx, 'act-scroll', ['direction', 'pixels', 'to']);
  },
  'act.key': async function (p, ctx) {
    if (p.key === undefined || p.key === null || p.key === '') {
      throw be('INVALID_PARAMS', 'act.key requires key');
    }
    return await act(p, ctx, 'act-key', ['modifiers', 'times'], { key: String(p.key) });
  },
  'act.wait': async function (p, ctx) {
    if (typeof p.urlContains === 'string' && p.urlContains) {
      // Navigation replaces the page's script, so this wait runs here.
      var wt = await resolveTab(p.tabId);
      var until = Date.now() + Math.min(num(p.timeoutMs, 10000), 60000), start = Date.now(), cur = wt;
      while (Date.now() < until) {
        if (ctx.signal.aborted) throw be('CANCELLED', 'The command was cancelled.');
        try { cur = await call(B.tabs, 'get', wt.id!); } catch (e) { throw be('TAB_NOT_FOUND', 'The tab was closed while waiting.'); }
        if (String(cur.url || '').indexOf(p.urlContains) >= 0 && cur.status === 'complete') {
          return { found: true, url: cur.url, title: cur.title || '', elapsedMs: Date.now() - start };
        }
        await sleep(200);
      }
      return { found: false, timedOut: true, url: cur.url || '', loading: cur.status !== 'complete', elapsedMs: Date.now() - start,
        note: 'The address didn\'t contain ' + JSON.stringify(p.urlContains) + (cur.status !== 'complete' ? ' (still loading)' : '') + ' before the wait ran out.' };
    }
    return await act(p, ctx, 'act-wait', ['text', 'gone'], { timeoutMs: num(p.timeoutMs, 10000) });
  },
  'act.find': async function (p, ctx) {
    if (p.query === undefined || p.query === null || String(p.query) === '') {
      throw be('INVALID_PARAMS', 'act.find requires query');
    }
    return await act(p, ctx, 'act-find', [], { query: String(p.query), withFrames: true });
  },
  'act.drag': async function (p, ctx) {
    var to = ['toRef', 'toSelector', 'toName', 'toRole', 'toX', 'toY'];
    if (!to.some(function (k) { return p[k] !== undefined && p[k] !== null && p[k] !== ''; })) {
      throw be('INVALID_PARAMS', 'act.drag needs a drop target: toRef, toSelector, toName or toX+toY');
    }
    return await act(p, ctx, 'act-drag', to);
  },
  'act.upload': async function (p, ctx) {
    if (!Array.isArray(p.files) || !p.files.length) throw be('INVALID_PARAMS', 'act.upload requires files[]');
    var total = 0;
    p.files.forEach(function (f) {
      if (!f || !f.name) throw be('INVALID_PARAMS', 'Each file needs a name');
      total += String(f.base64 || '').length + String(f.text || '').length;
    });
    if (total > 700000) throw be('PAYLOAD_TOO_LARGE', 'Files are limited to about 500KB in total.');
    return await act(p, ctx, 'act-upload', [], { files: p.files });
  },

  /* ---- storage ---- */
  'storage.get': async function (p) { return await storageOp('get', p); },
  'storage.set': async function (p) { return await storageOp('set', p); },
  'storage.remove': async function (p) { return await storageOp('remove', p); },

  /* ---- browser data ---- */
  'bookmarks.search': async function (p) {
    var q = (p.query !== undefined ? p.query : '') as string | { query?: string };
    return listPage(await call(B.bookmarks, 'search', q), p);
  },
  'bookmarks.create': async function (p) {
    var d: { title?: string; url?: string; parentId?: string } = {};
    if (p.title !== undefined) d.title = String(p.title);
    if (p.url !== undefined) d.url = String(p.url);
    if (p.parentId !== undefined) d.parentId = String(p.parentId);
    return await call(B.bookmarks, 'create', d);
  },
  'bookmarks.remove': async function (p) {
    if (p.id === undefined) throw be('INVALID_PARAMS', 'bookmarks.remove requires id');
    await call(B.bookmarks, 'remove', String(p.id));
    return { removed: true, id: String(p.id) };
  },
  'history.search': async function (p) {
    var h: { text: string; maxResults: number; startTime?: number } = { text: p.query !== undefined ? String(p.query) : '', maxResults: num(p.maxResults, 20) };
    // Firefox searches only the last 24 hours unless told otherwise; "that page from last week" needs all of it.
    h.startTime = p.startTime !== undefined ? Number(p.startTime) : 0;
    return listPage(await call(B.history, 'search', h), p);
  },
  'downloads.list': async function (p) {
    var limit = num(p.limit, 20);
    try {
      return await call(B.downloads, 'search', { orderBy: ['-startTime'], limit: limit });
    } catch (e) {
      var all = await call(B.downloads, 'search', {});
      return (all || []).slice(0, limit);
    }
  },
  'downloads.query': async function (p) {
    var q: { orderBy: string[]; limit: number; id?: number; query?: string[]; state?: string } = { orderBy: ['-startTime'], limit: Math.max(1, Math.min(200, num(p.limit, 20))) };
    if (p.id !== undefined) q.id = Number(p.id);
    if (p.query) q.query = String(p.query).split(/\s+/).filter(Boolean);
    if (p.state) q.state = String(p.state);
    var list = await call(B.downloads, 'search', q as browser.downloads.DownloadQuery);
    var out = [];
    for (var i = 0; i < (list || []).length; i++) out.push(await downloadInfo(list[i]));
    return out;
  },
  'downloads.start': async function (p, ctx) {
    if (!p.url) throw be('INVALID_PARAMS', 'download_start needs url');
    var opts: browser.downloads._DownloadOptions = { url: fixUrl(p.url), conflictAction: 'uniquify', saveAs: false };
    if (p.filename) {
      var name = String(p.filename).replace(/^[\\/]+/, '');
      if (/(^|[\\/])\.\.([\\/]|$)/.test(name)) throw be('INVALID_PARAMS', 'filename can\'t contain ".."; it is relative to the downloads folder');
      opts.filename = name;
    }
    var id: number;
    try { id = await call(B.downloads, 'download', opts); } catch (e) {
      throw be('DOWNLOAD_FAILED', 'Download refused: ' + ((e as Error).message || e));
    }
    var until = Date.now() + (p.wait === false ? 0 : num(p.timeoutMs, 60000));
    var d: browser.downloads.DownloadItem | null = null;
    for (;;) {
      d = ((await call(B.downloads, 'search', { id: id })) || [])[0];
      if (!d || d.state !== 'in_progress' || Date.now() >= until || ctx.signal.aborted) break;
      await sleep(250);
    }
    var info: { id?: unknown; state?: unknown; note?: string } = d ? await downloadInfo(d) : { id: id };
    if (info.state === 'in_progress') info.note = 'Still downloading; check later with download_query {id: ' + id + '}.';
    return info;
  },
  'cookies.forTab': async function (p) {
    var tab = await resolveTab(p.tabId);
    var url = String(tab.url || '');
    if (!/^https?:/i.test(url)) return [];
    return await jarCookies(tab, url);
  },
  'cookies.query': async function (p) {
    var t = await cookieTarget(p);
    var list = await jarCookies(t.tab, t.url, p.name ? { name: String(p.name) } : null);
    return { url: t.url, count: list.length, cookies: list.map(cookieInfo) };
  },
  'cookies.set': async function (p) {
    if (!p.name) throw be('INVALID_PARAMS', 'cookie_set needs name');
    var t = await cookieTarget(p);
    var d: browser.cookies._SetDetails = { url: t.url.split('#')[0], name: String(p.name), value: p.value === undefined || p.value === null ? '' : String(p.value) };
    if (t.tab.cookieStoreId) d.storeId = t.tab.cookieStoreId;
    pick(p, ['domain', 'path', 'secure', 'httpOnly', 'sameSite'], d);
    if (p.expiresInSeconds !== undefined) d.expirationDate = Math.floor(Date.now() / 1000) + Number(p.expiresInSeconds);
    else if (p.expires !== undefined) {
      var at = typeof p.expires === 'number' ? p.expires : Date.parse(p.expires as string) / 1000;
      if (!isFinite(at)) throw be('INVALID_PARAMS', 'expires must be an ISO date or unix seconds');
      d.expirationDate = Math.floor(at);
    }
    var c: browser.cookies.Cookie | null | undefined;
    try {
      c = await call(B.cookies, 'set', d);
    } catch (e) {
      // First-party isolation needs the jar named explicitly.
      if (!/firstPartyDomain/i.test(String((e as Error).message || e))) throw be('COOKIE_REFUSED', 'Firefox refused the cookie: ' + ((e as Error).message || e));
      var jar: browser.cookies.Cookie[];
      try { jar = await jarCookies(t.tab, t.url); } catch (jarError) { throw be('COOKIE_REFUSED', 'Could not determine the Firefox first-party cookie jar: ' + ((jarError as Error).message || jarError)); }
      var domains = Array.from(new Set(jar.map(function (item) { return item.firstPartyDomain; }).filter(Boolean)));
      if (domains.length !== 1) throw be('COOKIE_REFUSED', 'Firefox requires a firstPartyDomain, but its existing cookie jar does not identify one unambiguously. No cookie was written.');
      d.firstPartyDomain = domains[0];
      try { c = await call(B.cookies, 'set', d); } catch (retryError) { throw be('COOKIE_REFUSED', 'Firefox refused the cookie: ' + ((retryError as Error).message || retryError)); }
    }
    if (!c) throw be('COOKIE_REFUSED', 'Firefox refused the cookie (check domain, secure and sameSite against the URL).');
    return { set: true, url: d.url, cookie: cookieInfo(c) };
  },
  'cookies.remove': async function (p) {
    if (!p.name) throw be('INVALID_PARAMS', 'cookie_remove needs name');
    var t = await cookieTarget(p);
    var list = await jarCookies(t.tab, t.url, { name: String(p.name) });
    var removed = 0;
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      var d: browser.cookies._RemoveDetails = { url: (c.secure ? 'https://' : 'http://') + c.domain.replace(/^\./, '') + c.path, name: c.name };
      if (c.storeId) d.storeId = c.storeId;
      if (c.firstPartyDomain) d.firstPartyDomain = c.firstPartyDomain;
      if (c.partitionKey) d.partitionKey = c.partitionKey;
      try { if (await call(B.cookies, 'remove', d)) removed++; } catch (e) {}
    }
    return { url: t.url, name: String(p.name), removed: removed };
  },
  'sessions.recentlyClosed': async function (p) {
    return listPage(await call(B.sessions, 'getRecentlyClosed', { maxResults: Math.min(25, num(p.limit, 10) + Math.max(0, Number(p.offset) || 0)) }), p.offset === undefined ? {} : p);
  },
  'sessions.restore': async function (p) {
    if (p.sessionId === undefined) throw be('INVALID_PARAMS', 'sessions.restore requires sessionId');
    return await call(B.sessions, 'restore', String(p.sessionId));
  }
};

/* What each method looks like to the user: [while running, in the activity log]. */
var LABELS: { [M in BridgeMethod]: [string, string] } = {
  'tabs.list': ['Listing tabs', 'Listed tabs'], 'tabs.query': ['Looking through tabs', 'Looked through tabs'],
  'windows.list': ['Listing windows', 'Listed windows'], 'active.tab': ['Checking the current tab', 'Checked the current tab'],
  'tab.create': ['Opening a tab', 'Opened a tab'], 'tab.update': ['Opening a page', 'Opened a page'],
  'tab.close': ['Closing a tab', 'Closed a tab'], 'tab.duplicate': ['Duplicating a tab', 'Duplicated a tab'],
  'tab.move': ['Moving a tab', 'Moved a tab'], 'tab.pin': ['Pinning a tab', 'Pinned a tab'],
  'tab.unpin': ['Unpinning a tab', 'Unpinned a tab'], 'tab.mute': ['Muting a tab', 'Changed a tab’s sound'],
  'window.create': ['Opening a window', 'Opened a window'], 'window.focus': ['Switching windows', 'Switched windows'],
  'window.remove': ['Closing a window', 'Closed a window'],
  'nav.back': ['Going back', 'Went back'], 'nav.forward': ['Going forward', 'Went forward'], 'nav.reload': ['Reloading', 'Reloaded'],
  'page.snapshot': ['Reading the page', 'Read the page'], 'page.text': ['Reading the page', 'Read the page'],
  'page.html': ['Reading the page source', 'Read the page source'], 'page.shot': ['Taking a screenshot', 'Took a screenshot'],
  'page.info': ['Checking the page', 'Checked the page'],
  'act.click': ['Clicking', 'Clicked'], 'act.type': ['Typing', 'Typed'], 'act.fillForm': ['Filling in a form', 'Filled in a form'],
  'act.select': ['Choosing an option', 'Chose an option'], 'act.hover': ['Pointing at something', 'Pointed at something'],
  'act.scroll': ['Scrolling', 'Scrolled'], 'act.key': ['Pressing a key', 'Pressed a key'], 'act.wait': ['Waiting for the page', 'Waited for the page'],
  'act.find': ['Searching the page', 'Searched the page'],
  'bookmarks.search': ['Searching bookmarks', 'Searched bookmarks'], 'bookmarks.create': ['Adding a bookmark', 'Added a bookmark'],
  'bookmarks.remove': ['Removing a bookmark', 'Removed a bookmark'], 'history.search': ['Searching history', 'Searched history'],
  'downloads.list': ['Checking downloads', 'Checked downloads'], 'cookies.forTab': ['Reading cookies', 'Read cookies'],
  'sessions.recentlyClosed': ['Checking closed tabs', 'Checked closed tabs'], 'sessions.restore': ['Reopening a tab', 'Reopened a tab'],
  'cursor.say': ['Talking', 'Said something'],
  'tab.navigate': ['Opening a page', 'Opened a page'], 'act.drag': ['Dragging', 'Dragged'],
  'act.upload': ['Attaching a file', 'Attached a file'],
  'cookies.query': ['Reading cookies', 'Read cookies'], 'cookies.set': ['Setting a cookie', 'Set a cookie'],
  'cookies.remove': ['Deleting a cookie', 'Deleted a cookie'],
  'downloads.query': ['Checking downloads', 'Checked downloads'], 'downloads.start': ['Downloading a file', 'Downloaded a file'],
  'storage.get': ['Reading saved data', 'Read saved data'], 'storage.set': ['Saving data', 'Saved data'],
  'storage.remove': ['Deleting saved data', 'Deleted saved data']
};
/* "tabs.list" -> i18n keys "lblTabsListNow" / "lblTabsListPast". */
function labelsFor(method: BridgeMethod): [string, string] {
  var base = 'lbl' + method.split('.').map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join('');
  var en = LABELS[method] || [method, method];
  var now0 = t(base + 'Now'), past = t(base + 'Past');
  return [now0 === base + 'Now' ? en[0] : now0, past === base + 'Past' ? en[1] : past];
}

/* Methods that act on one tab, so "Now" can say which. */
var TAB_METHODS = /^(page\.|act\.|nav\.|cookies\.|tab\.(update|navigate|close|duplicate|move|pin|unpin|mute)$|cursor\.say$)/;
interface NowEntry {
  text: string;
  past: string;
  site: string;
  tabId: number | null | undefined;
  at: number;
  done: boolean;
}
var now: NowEntry | null = null; // { text, past, site, tabId, at, done }

function siteOf(url: string | undefined): string {
  try { var u = new URL(url as string); return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, '') : ''; } catch (e) { return ''; }
}

async function onCommand(cmd: { id: string; method: BridgeMethod; params: BridgeParams }, ctx: Ctx) {
  var handler = handlers[cmd.method];
  if (!handler) throw be('UNKNOWN_METHOD', 'Unknown method: ' + cmd.method);
  var params = (cmd.params && typeof cmd.params === 'object') ? cmd.params : {};
  cmdCount += 1;
  var label = labelsFor(cmd.method);
  var cur: NowEntry = now = { text: label[0], past: label[1], site: '', tabId: null, at: Date.now(), done: false };
  if (TAB_METHODS.test(cmd.method)) {
    resolveTab(params.tabId).then(function (t) { cur.site = siteOf(t.url); cur.tabId = t.id; }).catch(function () {});
  }
  updateBadge();
  try {
    var result = await handler(params, ctx);
  } catch (e) {
    var be0 = toBridgeError(e as ErrLike);
    if (be0.code !== 'CANCELLED') note(t('evFailed', [label[0], be0.message]), 'bad', cur.site);
    throw e;
  } finally {
    cur.done = true;
    cur.at = Date.now();
    updateBadge();
  }
  if (!/^(tabs\.(list|query)|windows\.list|active\.tab|page\.info|cursor\.say|storage\.get)$/.test(cmd.method)) note(label[1], 'act', cur.site);
  noteAfter(cmd.method, params);
  return result;
}

/* ------------------------------------------------------------ native port */

function send(obj: unknown): void {
  if (!port) return;
  try { port.postMessage(obj); } catch (e) { log('postMessage failed: ' + ((e as ErrObj).message || e)); }
}

/* Shapes of the unsolicited events and of the command the helper hands us (protocol.ts). */
type BridgeEventMsg = import('../../shared/src/protocol').BridgeEvent;
type BridgeCommandMsg = import('../../shared/src/protocol').BridgeCommand;

function sendEvent(evt: BridgeEventMsg): void { if (!paused) send(evt); }

/* Everything the helper may send us; each field is one of its message kinds. */
interface IncomingMessage {
  hostStatus?: HostStatus;
  hostExit?: { reason: 'updated' | 'shutdown'; version?: string };
  cancel?: string;
  id?: string;
  method?: string;
  params?: BridgeParams;
}

async function handleIncoming(msg: IncomingMessage): Promise<void> {
  if (!msg || typeof msg !== 'object') return;
  if (msg.hostStatus && typeof msg.hostStatus === 'object') {
    var prev = hostStatus;
    hostStatus = msg.hostStatus;
    if (!prev) note(t('evHelperRunning', hostStatus.version || '?'));
    if (hostStatus.error && (!prev || prev.error !== hostStatus.error)) note(hostStatus.error, 'bad');
    else if (hostStatus.listening && (!prev || !prev.listening || prev.url !== hostStatus.url)) note(t('evListening', hostStatus.url), 'ok');
    lastError = hostStatus.error || '';
    var c = compat();
    if (c.state === 'helper-old') lastError = t('errHelperOld', c.helper);
    if (c.state === 'addon-old') lastError = t('errAddonOld', c.helper);
    updateBadge();
    return;
  }
  if (msg.hostExit && typeof msg.hostExit === 'object') {
    // Expected exit (e.g. its binary was just updated): relaunch quickly, no error.
    hostRestarting = true;
    log('helper exiting: ' + (msg.hostExit.reason || '?'));
    note(msg.hostExit.reason === 'updated' ? t('evHelperUpdated', msg.hostExit.version || '?') : t('evHelperShuttingDown'));
    return;
  }
  if (typeof msg.cancel === 'string') {
    // The helper gave up on a command (client cancelled or disconnected).
    var ctl = inflight.get(msg.cancel);
    if (ctl) ctl.abort();
    return;
  }
  if (msg.id !== undefined && typeof msg.method === 'string') {
    var cs = compat().state;
    if (cs === 'helper-old' || cs === 'addon-old') {
      send({ id: msg.id, ok: false, error: { code: 'PROTOCOL_MISMATCH', message: lastError } });
      return;
    }
    if (paused) {
      send({ id: msg.id, ok: false, error: { code: 'PAUSED', message: 'The user paused AI control in Foxhand. Ask them to resume it (toolbar button → Resume AI), then try again.' } });
      return;
    }
    var ac = new AbortController();
    var from = port; // a reply belongs to the helper that asked, not to one started since
    inflight.set(msg.id, ac);
    try {
      var result = await onCommand(msg as BridgeCommandMsg, { id: String(msg.id), signal: ac.signal });
      if (port === from) send({ id: msg.id, ok: true, result: result === undefined ? null : result });
    } catch (e) {
      if (port === from) send({ id: msg.id, ok: false, error: toBridgeError(e as ErrLike) });
    } finally {
      if (inflight.get(msg.id) === ac) inflight.delete(msg.id);
      updateBadge(); // the busy dot goes when the last command does
    }
  }
}

function scheduleReconnect() {
  if (connectTimer) return;
  var delay = hostRestarting ? 500
    : hostMissing ? MISSING_BACKOFF_MS
    : BACKOFFS[Math.min(backoffIdx, BACKOFFS.length - 1)];
  backoffIdx += 1;
  log('reconnect in ' + delay + 'ms');
  connectTimer = setTimeout(function () {
    connectTimer = null;
    connect();
  }, delay);
}

/* The helper is gone: stop whatever it asked for, nobody is waiting for the answer. */
function abortInflight() {
  inflight.forEach(function (ac) { try { ac.abort(); } catch (e) {} });
  inflight.clear();
}

function clearStartTimer() {
  if (startTimer) { clearTimeout(startTimer); startTimer = null; }
}

/* Drop the current helper (if any) and launch it again right away. */
function reconnectNow() {
  backoffIdx = 0;
  if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
  clearStartTimer();
  var old = port;
  port = null;
  connectedAt = 0;
  abortInflight();
  if (old) { try { old.disconnect(); } catch (e) {} }
  connect();
}

type HelloMsg = import('../../shared/src/protocol').HelloMessage;

async function buildHello(): Promise<HelloMsg> {
  var ffVersion = 'unknown';
  try {
    if (B.runtime && typeof B.runtime.getBrowserInfo === 'function') {
      var info = await call(B.runtime, 'getBrowserInfo');
      if (info && info.version) ffVersion = String(info.version);
    }
  } catch (e) {}
  var extId = EXT_ID_FALLBACK;
  try { if (B.runtime && B.runtime.id) extId = String(B.runtime.id); } catch (e) {}
  return {
    hello: {
      extensionId: extId,
      version: EXT_VERSION,
      protocol: PROTOCOL,
      profile: 'unknown',
      firefoxVersion: ffVersion,
      capabilities: CAPABILITIES.slice()
    }
  };
}

type HostConfigMsg = import('../../shared/src/protocol').HostConfigMessage;

function hostConfigMessage(): HostConfigMsg {
  return {
    hostConfig: {
      token: CFG.token,
      port: CFG.port,
      bind: CFG.bind,
      allowWsl: CFG.allowWsl,
      paused: paused,
      confirmDestructive: CFG.confirmDestructive
    }
  };
}

function isMissingHostError(text: string): boolean {
  return /no such native application|not found|manifest|does not exist|access to the specified native/i.test(text || '');
}

function connect() {
  if (port) return;
  var p: browser.runtime.Port;
  try {
    p = B.runtime.connectNative(NATIVE_HOST);
  } catch (e) {
    hostMissing = true;
    lastError = t('errCouldNotStart', (e as ErrObj).message || e);
    note(lastError, 'bad');
    updateBadge();
    scheduleReconnect();
    return;
  }
  port = p;
  connectedAt = 0;
  hostStatus = null;
  lastError = '';
  clearStartTimer();
  startTimer = setTimeout(function () {
    startTimer = null;
    if (p !== port || connectedAt) return;
    note(t('evNoAnswer', START_TIMEOUT_MS / 1000), 'bad');
    port = null;
    try { p.disconnect(); } catch (e) {}
    lastError = t('errDidntStart');
    updateBadge();
    scheduleReconnect();
  }, START_TIMEOUT_MS);
  p.onMessage.addListener(function (msg: IncomingMessage) {
    if (p !== port) return;
    if (!connectedAt) clearStartTimer();
    if (hostMissing || !connectedAt) {
      // First message proves the helper really launched.
      hostMissing = false;
      backoffIdx = 0;
      connectedAt = Date.now();
    }
    handleIncoming(msg);
  });
  p.onDisconnect.addListener(function (dp: browser.runtime.Port) {
    if (p !== port) return; // superseded by reconnectNow()
    var err = (dp && dp.error && dp.error.message) || (B.runtime.lastError && B.runtime.lastError.message) || '';
    log('helper disconnected: ' + (err || 'exited'));
    port = null;
    clearStartTimer();
    abortInflight();
    var wasUp = !!connectedAt;
    connectedAt = 0;
    hostStatus = null;
    if (hostRestarting) {
      hostMissing = false;
      lastError = '';
    } else if (!wasUp && (isMissingHostError(err) || !err)) {
      if (!hostMissing) note(t('evNotFound'), 'bad');
      hostMissing = true;
      lastError = t('stNoHelper');
    } else {
      hostMissing = false;
      lastError = err ? t('errStoppedWhy', err) : t('errStopped');
      note(wasUp ? lastError : t('evStoppedStarting', lastError), 'bad');
    }
    updateBadge();
    scheduleReconnect();
    hostRestarting = false;
  });
  buildHello().then(function (hello) {
    if (p !== port) return;
    send(hello);
    send(hostConfigMessage());
    sendEvent({ event: 'extension.ready', data: { version: EXT_VERSION } });
  }).catch(function (e) {
    log('hello failed: ' + (e.message || e));
  });
  updateBadge();
}

function isConnected() {
  return !!(port && connectedAt);
}

function isCompatible() {
  var s = compat().state;
  return s === 'ok' || s === 'helper-update';
}

function isListening() {
  return !!(isConnected() && hostStatus && hostStatus.listening && isCompatible());
}

/* What the status snapshot reports as the current action (the background's "now"). */
interface NowState { text: string; past: string; site: string; tabId: number | null; at: number; done: boolean; }

/* Toolbar badge: orange dot while the AI is acting, "II" when paused, "!" when not serving, "↑" for a helper update. */
function updateBadge() {
  var ba = B.browserAction;
  if (!ba) return;
  var on = isListening();
  var update = on && compat().state === 'helper-update';
  var busy = on && inflight.size > 0;
  var why = paused ? t('stPaused')
    : on ? (busy && now ? now.text : t('badgeServing', hostStatus!.url)) + (update ? ' · ' + t('softUpdate') : '')
    : (lastError || (port ? t('stStarting') : t('stNotRunning')));
  var text = paused ? 'II' : !on ? '!' : busy ? '●' : update ? '↑' : '';
  var bg = paused ? '#f5f5f5' : !on ? (hostMissing ? '#8a8a8a' : '#c50042') : '#FF7139';
  try {
    ba.setBadgeText({ text: text });
    ba.setBadgeBackgroundColor({ color: bg });
    if (ba.setBadgeTextColor) ba.setBadgeTextColor({ color: !on && !paused ? '#ffffff' : '#0a0a0a' });
    ba.setTitle({ title: 'Foxhand — ' + why });
  } catch (e) {}
}

/* ------------------------------------------------------------------ events */

function wireTabEvents() {
  try {
    if (B.tabs && B.tabs.onUpdated) {
      B.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
        if (changeInfo && (changeInfo.status === 'complete' || changeInfo.url)) {
          sendEvent({
            event: 'tab.updated',
            data: {
              tabId: tabId,
              windowId: tab ? tab.windowId : undefined,
              status: changeInfo.status || (tab && tab.status),
              url: changeInfo.url || (tab && tab.url)
            }
          });
        }
      });
    }
    if (B.tabs && B.tabs.onRemoved) {
      B.tabs.onRemoved.addListener(function (tabId, removeInfo) {
        sendEvent({
          event: 'tab.removed',
          data: {
            tabId: tabId,
            windowId: removeInfo && removeInfo.windowId,
            isWindowClosing: !!(removeInfo && removeInfo.isWindowClosing)
          }
        });
      });
    }
    if (B.tabs && B.tabs.onActivated) {
      B.tabs.onActivated.addListener(function (activeInfo) {
        sendEvent({
          event: 'tab.activated',
          data: { tabId: activeInfo.tabId, windowId: activeInfo.windowId }
        });
      });
    }
    if (B.downloads && B.downloads.onChanged) {
      B.downloads.onChanged.addListener(function (delta) {
        if (!paused && delta && delta.state && delta.state.current === 'complete') {
          var epoch = pauseEpoch;
          call(B.downloads, 'search', { id: delta.id }).then(function (found) {
            if (epoch !== pauseEpoch) return;
            var extra: Record<string, unknown> = {};
            if (found && found[0]) {
              extra = { filename: found[0].filename, url: found[0].url, bytesReceived: found[0].bytesReceived };
            }
            var data: Record<string, unknown> = { id: delta.id };
            for (var k in extra) data[k] = extra[k];
            sendEvent({ event: 'download.done', data: data });
          }).catch(function () {
            if (epoch !== pauseEpoch) return;
            sendEvent({ event: 'download.done', data: { id: delta.id } });
          });
        }
      });
    }
  } catch (e) {
    log('event wiring failed: ' + ((e as ErrObj).message || e));
  }
}

/* ---------------------------------------------------------- config + boot */

function randomToken() {
  var bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
}

function validPort(v: unknown): number {
  var n = Number(v);
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : 0;
}

function validBind(v: unknown): string {
  var s = String(v || '').trim();
  if (s === 'localhost') return '127.0.0.1';
  if (s === '::' || s === '::1') return s;
  var parts = s.split('.');
  return parts.length === 4 && parts.every(function (o) { return /^\d{1,3}$/.test(o) && Number(o) <= 255; }) ? s : '';
}

/* The settings this add-on keeps in storage.local (all optional: a fresh profile has none). */
interface StoredConfig {
  mcpToken?: unknown;
  mcpPort?: unknown;
  mcpBind?: unknown;
  mcpAllowWsl?: unknown;
  mcpConfirm?: unknown;
  mcpShowCursor?: unknown;
  mcpPaused?: unknown;
}

async function loadConfig() {
  var got: StoredConfig = {};
  try {
    got = (await call(B.storage.local, 'get', ['mcpToken', 'mcpPort', 'mcpBind', 'mcpAllowWsl', 'mcpConfirm', 'mcpShowCursor', 'mcpPaused'])) || {};
  } catch (e) {}
  CFG.token = (typeof got.mcpToken === 'string' && got.mcpToken.length >= 16) ? got.mcpToken : '';
  CFG.port = validPort(got.mcpPort) || DEFAULT_PORT;
  CFG.bind = validBind(got.mcpBind) || DEFAULT_BIND;
  CFG.allowWsl = got.mcpAllowWsl === true;
  CFG.confirmDestructive = got.mcpConfirm !== false;
  CFG.showCursor = got.mcpShowCursor !== false;
  paused = got.mcpPaused === true;
  if (!CFG.token) {
    CFG.token = randomToken();
    try { await call(B.storage.local, 'set', { mcpToken: CFG.token }); } catch (e) {}
  }
  try {
    var pi = await call(B.runtime, 'getPlatformInfo');
    if (pi) platform = { os: pi.os || '', arch: pi.arch || '' };
  } catch (e) {}
}

function statusSnapshot(): Status {
  return {
    version: EXT_VERSION,
    protocol: PROTOCOL,
    compat: compat(),
    platform: platform,
    hostMissing: hostMissing,
    connected: isConnected(),
    starting: !!(port && !connectedAt),
    listening: isListening(),
    host: hostStatus,
    url: hostStatus && hostStatus.url ? hostStatus.url : '',
    token: CFG.token,
    port: CFG.port,
    bind: CFG.bind,
    allowWsl: CFG.allowWsl,
    confirmDestructive: CFG.confirmDestructive,
    showCursor: CFG.showCursor,
    paused: paused,
    now: now && { text: now.done ? now.past : now.text, site: now.site, tabId: now.tabId as number, at: now.at, active: !now.done },
    defaults: { port: DEFAULT_PORT, bind: DEFAULT_BIND },
    lastError: lastError,
    connectedAt: connectedAt,
    commands: cmdCount,
    events: events.slice()
  };
}

/* Push settings to a running helper without relaunching it. */
function applyConfig() {
  if (isConnected()) send(hostConfigMessage());
  else reconnectNow();
}

/* Only our own extension pages may reconfigure the bridge — never content scripts. Checked by the
 * sender's URL, not by sender.tab: the settings page opens in a tab too. */
function fromOwnPage(sender: browser.runtime.MessageSender | undefined): boolean {
  var base = B.runtime.getURL('');
  return !!(sender && sender.id === B.runtime.id && typeof sender.url === 'string' && sender.url.indexOf(base) === 0);
}

/* Settings writes run one at a time, and each is saved before it takes effect, so a failed save
 * leaves the running config and storage in agreement. */
var cfgQueue: Promise<unknown> = Promise.resolve();
function queued<T>(fn: () => Promise<T>): Promise<T | SetConfigError> {
  var r = cfgQueue.then(fn);
  cfgQueue = r.catch(function () {});
  return r.catch(function (e) { return { error: t('couldntSave', (e && e.message) || e) }; });
}

function setPaused(v: boolean): Promise<Status | SetConfigError> {
  return queued(async function () {
    await call(B.storage.local, 'set', { mcpPaused: v });
    if (paused === v) return statusSnapshot();
    paused = v;
    pauseEpoch++;
    send(hostConfigMessage());
    note(v ? t('evYouPaused') : t('evYouResumed'), v ? 'bad' : 'ok');
    if (v) { abortInflight(); hideCursors(); }
    updateBadge();
    return statusSnapshot();
  });
}

if (B.commands && B.commands.onCommand) {
  B.commands.onCommand.addListener(function (name: string) {
    if (name === 'toggle-pause') setPaused(!paused);
  });
}

/* The add-on's own settings page messages that carry extra fields. */
interface SetConfigData {
  mcpPort?: number;
  mcpBind?: string;
  mcpAllowWsl?: boolean;
  mcpConfirm?: boolean;
  mcpShowCursor?: boolean;
}
type SetConfigRequest = Extract<UiMessage, { type: 'set-config' }>;
type SetPausedRequest = Extract<UiMessage, { type: 'set-paused' }>;

if (B.runtime && B.runtime.onMessage) {
  B.runtime.onMessage.addListener(function (msg: UiMessage, sender: browser.runtime.MessageSender) {
    if (!fromOwnPage(sender)) return undefined;
    var type = msg && msg.type;
    if (type === 'get-status') return Promise.resolve(statusSnapshot());
    if (type === 'probe') {
      // Quiet re-check from an open popup/settings page while the helper is missing.
      if (!port) {
        if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
        connect();
      }
      return sleep(300).then(statusSnapshot);
    }
    if (type === 'reconnect') {
      hostMissing = false;
      reconnectNow();
      return sleep(400).then(statusSnapshot);
    }
    if (type === 'set-config') {
      // Validate everything before changing anything, so a bad field can't leave half a config applied.
      var data: SetConfigData = {};
      var p = (msg as SetConfigRequest).port !== undefined ? validPort((msg as SetConfigRequest).port) : 0;
      if ((msg as SetConfigRequest).port !== undefined && !p) return Promise.resolve({ error: t('errPort'), field: 'port' });
      var b = (msg as SetConfigRequest).bind !== undefined ? validBind((msg as SetConfigRequest).bind) : '';
      if ((msg as SetConfigRequest).bind !== undefined && !b) return Promise.resolve({ error: t('errBind'), field: 'bind' });
      if (p) data.mcpPort = p;
      if (b) data.mcpBind = b;
      if (typeof (msg as SetConfigRequest).allowWsl === 'boolean') data.mcpAllowWsl = (msg as SetConfigRequest).allowWsl;
      if (typeof (msg as SetConfigRequest).confirmDestructive === 'boolean') data.mcpConfirm = (msg as SetConfigRequest).confirmDestructive;
      if (typeof (msg as SetConfigRequest).showCursor === 'boolean') data.mcpShowCursor = (msg as SetConfigRequest).showCursor;
      return queued(async function () {
        await call(B.storage.local, 'set', data);
        if ('mcpPort' in data) CFG.port = data.mcpPort!;
        if ('mcpBind' in data) CFG.bind = data.mcpBind!;
        if ('mcpAllowWsl' in data) CFG.allowWsl = data.mcpAllowWsl!;
        if ('mcpConfirm' in data) CFG.confirmDestructive = data.mcpConfirm!;
        if ('mcpShowCursor' in data) {
          CFG.showCursor = data.mcpShowCursor!;
          if (!CFG.showCursor) hideCursors();
        }
        // The cursor is extension-only: no need to touch the helper for it.
        if (Object.keys(data).some(function (k) { return k !== 'mcpShowCursor'; })) {
          applyConfig();
          await sleep(400);
        }
        return statusSnapshot();
      });
    }
    if (type === 'regenerate-token') {
      return queued(async function () {
        var t = randomToken();
        await call(B.storage.local, 'set', { mcpToken: t });
        CFG.token = t;
        applyConfig();
        await sleep(200);
        return statusSnapshot();
      });
    }
    if (type === 'set-paused') return setPaused((msg as SetPausedRequest).paused === true);
    return undefined;
  });
}

/* First install: walk through setup. Updating from WebMCP Controller (< 0.5): say it's Foxhand now. */
if (B.runtime && B.runtime.onInstalled) {
  B.runtime.onInstalled.addListener(function (d) {
    if (!d || d.temporary) return;
    var page = d.reason === 'install' ? 'onboarding.html'
      : d.reason === 'update' && cmpVersion(d.previousVersion, '0.5.0') < 0 ? 'onboarding.html#renamed' : '';
    if (page) { try { B.tabs.create({ url: B.runtime.getURL(page) }); } catch (e) {} }
  });
}

wireTabEvents();
updateBadge();
loadConfig().then(connect);

})();

