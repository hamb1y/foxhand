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

var B = (typeof browser !== 'undefined') ? browser : chrome;
var HAS_PROMISES = (typeof browser !== 'undefined');
var EXT_VERSION = (function () { try { return B.runtime.getManifest().version; } catch (e) { return '0.0.0'; } })();
// The ID predates the rename to Foxhand; changing it would make AMO treat this as a new add-on.
var EXT_ID_FALLBACK = 'webmcp-controller@hamb1y.github.io';
// Breaking wire-protocol version; keep in sync with PROTOCOL in shared/src/protocol.ts.
var PROTOCOL = 1;

var NATIVE_HOST = 'webmcp_controller';
var DEFAULT_PORT = 8901;
var DEFAULT_BIND = '127.0.0.1';
var BACKOFFS = [1000, 2000, 5000, 10000, 30000]; // ms, last value repeats
var MISSING_BACKOFF_MS = 60000; // helper not installed: retry slowly (Retry button is instant)
var START_TIMEOUT_MS = 20000;   // a helper that launched but never spoke is stuck: start it again

var CAPABILITIES = [
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
var paused = false;        // the user paused AI control: every command is refused until they resume
var port = null;           // runtime.Port to the native helper
var backoffIdx = 0;
var connectTimer = null;
var startTimer = null;     // fires if a just-launched helper never says anything
var hostMissing = false;   // Firefox couldn't find/launch the helper
var hostStatus = null;     // last { hostStatus } from the helper
var hostRestarting = false; // helper said it's exiting to make way for an updated binary
var lastError = '';        // human-readable reason for the popup/options page
var connectedAt = 0;
var events = [];          // recent helper ups and downs, newest last, for the settings page
var EVENTS_MAX = 60;

/* Remember what happened to the helper, so "it stopped working" can be traced afterwards. */
function note(text, level, site) {
  var lastEv = events[events.length - 1];
  if (lastEv && lastEv.text === text && (lastEv.site || '') === (site || '')) {
    lastEv.at = Date.now(); lastEv.count = (lastEv.count || 1) + 1; return;
  }
  events.push({ at: Date.now(), text: text, level: level || 'info', site: site || '' });
  if (events.length > EVENTS_MAX) events.splice(0, events.length - EVENTS_MAX);
}
var inflight = new Map();  // command id -> AbortController, for { cancel: id }
var cmdCount = 0;
var platform = { os: '', arch: '' };

/* ---------------------------------------------------------------- helpers */

/* Compare dotted versions numerically: <0 if a<b, 0 if equal, >0 if a>b. */
function cmpVersion(a, b) {
  var x = String(a || '0').split(/[.+-]/), y = String(b || '0').split(/[.+-]/);
  for (var i = 0; i < 3; i++) {
    var d = (parseInt(x[i], 10) || 0) - (parseInt(y[i], 10) || 0);
    if (d) return d;
  }
  return 0;
}

/* Is the running helper compatible with this add-on? */
function compat() {
  if (!hostStatus) return { state: 'unknown' };
  var hv = String(hostStatus.version || '0.0.0');
  var hp = Number(hostStatus.protocol) || 1; // helpers before 0.3.0 didn't send it; they speak 1
  if (hp < PROTOCOL) return { state: 'helper-old', helper: hv, addon: EXT_VERSION };
  if (hp > PROTOCOL) return { state: 'addon-old', helper: hv, addon: EXT_VERSION };
  if (cmpVersion(hv, EXT_VERSION) < 0) return { state: 'helper-update', helper: hv, addon: EXT_VERSION };
  return { state: 'ok', helper: hv, addon: EXT_VERSION };
}

/* A UI string in the browser's language. Messages for the AI itself stay in English. */
function t(key, subs) {
  var m = '';
  try { m = B.i18n.getMessage(key, subs === undefined ? undefined : [].concat(subs).map(String)); } catch (e) {}
  return m || key;
}

function log() {
  try { console.log.apply(console, ['[fxmcp]'].concat([].slice.call(arguments))); } catch (e) {}
}

/* Promise adapter: browser.* returns promises; chrome.* needs callbacks. */
function pcall(fn) {
  var args = [].slice.call(arguments, 1);
  if (HAS_PROMISES) return fn.apply(null, args);
  return new Promise(function (resolve, reject) {
    args.push(function (res) {
      var err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(res);
    });
    try { fn.apply(null, args); } catch (e) { reject(e); }
  });
}

/* call(B.tabs, 'query', {...}) — late-bound so missing APIs throw cleanly. */
function call(obj, method) {
  var args = [].slice.call(arguments, 2);
  if (!obj || typeof obj[method] !== 'function') {
    throw be('NOT_SUPPORTED', 'API not available: ' + method);
  }
  return pcall.apply(null, [obj[method].bind(obj)].concat(args));
}

function num(v, dflt) {
  var n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function be(code, message) {
  var e = new Error(String(message));
  e.code = code;
  return e;
}

function toBridgeError(e) {
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

function toTabInfo(t) {
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

function toWindowInfo(w) {
  return {
    id: w.id,
    focused: !!w.focused,
    incognito: !!w.incognito,
    type: w.type || 'normal',
    tabCount: Array.isArray(w.tabs) ? w.tabs.length : 0
  };
}

/* Resolve a tab id, defaulting to the active tab of the focused window. */
async function resolveTab(tabId) {
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

function assertContentAllowed(tab) {
  var url = String((tab && tab.url) || '');
  if (/\.pdf([?#]|$)/i.test(url) || /\.pdf$/i.test(String((tab && tab.title) || ''))) {
    throw be('RESTRICTED_PAGE', 'This tab shows a PDF in Firefox\'s built-in viewer, which add-ons can\'t read or click in. ' +
      'Use screenshot to look at it, or open the PDF in another app.');
  }
  if (RESTRICTED_RE.test(url)) {
    throw be('RESTRICTED_PAGE', 'Content scripting is forbidden on this page: ' + (url || '(no url yet)'));
  }
  if (AMO_RE.test(url)) {
    throw be('RESTRICTED_PAGE', 'Content scripting is forbidden on addons.mozilla.org');
  }
}

var CONTENT_FILES = ['content/cursor.js', 'content/ax.js'];

async function injectAx(tabId) {
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

function unwrapContentResponse(res) {
  if (res && res.__fxmcp === true) {
    if (res.ok) return res.result;
    var err = res.error || {};
    throw be(err.code || 'INTERNAL', err.message || 'Content script error');
  }
  return res;
}

/* Send a message to a tab's content script, re-injecting once on failure.
 * p is the command's params: when the AI cursor is on, the model's `thought`
 * rides along so the page can show it next to the cursor. */
/* A discarded (sleeping) tab has no page loaded: load it before talking to its content script. */
async function wake(tabId) {
  var tab;
  try { tab = await call(B.tabs, 'get', tabId); } catch (e) { return; }
  if (!tab || !tab.discarded) return;
  try { await call(B.tabs, 'reload', tabId); } catch (e) { return; }
  // A waking tab doesn't always report 'loading' first, so watch its state rather than events.
  for (var end = Date.now() + 20000; Date.now() < end;) {
    await sleep(150);
    try { tab = await call(B.tabs, 'get', tabId); } catch (e) { return; }
    if (!tab.discarded && tab.status === 'complete') return;
  }
}

async function sendToTab(tabId, p, msg) {
  await wake(tabId);
  if (CFG.showCursor && msg.kind !== 'cursor') {
    msg.cursor = { note: typeof p.thought === 'string' ? p.thought.slice(0, 300) : '' };
  }
  var firstErr = null;
  try {
    return unwrapContentResponse(await call(B.tabs, 'sendMessage', tabId, msg));
  } catch (e) {
    firstErr = e;
  }
  var m = String((firstErr && firstErr.message) || firstErr);
  if (/receiving end does not exist|could not establish connection|could not send|no response/i.test(m)) {
    try {
      await injectAx(tabId);
    } catch (inj) {
      throw be('NO_CONTENT_SCRIPT', 'No content script in tab ' + tabId + ' (restricted page?)');
    }
    try {
      return unwrapContentResponse(await call(B.tabs, 'sendMessage', tabId, msg));
    } catch (e2) {
      // An answer from the page (e.g. REF_STALE) or a page that navigated isn't a missing script.
      if ((e2 && e2.code) || PAGE_GONE_RE.test(String((e2 && e2.message) || e2))) throw e2;
      throw be('NO_CONTENT_SCRIPT', 'No content script in tab ' + tabId + ' (restricted page?)');
    }
  }
  throw firstErr;
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* The page went away (navigated, reloaded, closed) before its content script replied. */
var PAGE_GONE_RE = /destroyed before|message manager disconnected|context is inactive|page (was )?unloaded/i;
var READ_KINDS = /^(ax-snapshot|page-text|page-html|act-find|page-storage|page-metrics|element-rect)$/;

/* sendToTab, but an action that navigated the page before replying isn't reported as a failure
 * (the AI would repeat a click that worked), and a read retries once on the page that replaced it. */
async function sendToPage(tabId, p, msg) {
  try {
    return await sendToTab(tabId, p, msg);
  } catch (e) {
    if (!PAGE_GONE_RE.test(String((e && e.message) || e))) throw e;
    if (READ_KINDS.test(msg.kind)) {
      await sleep(500);
      return await sendToTab(tabId, p, msg);
    }
    if (msg.kind === 'act-wait') throw be('NAVIGATED', 'The page navigated away while waiting; take a new snapshot');
    return { done: true, pageChanged: true, note: 'The page navigated or reloaded as a result; take a new snapshot before using refs' };
  }
}

/* sendToPage for an action, cancellable: a cancel from the helper (or Pause AI) reaches the page by opId. */
async function actOn(tabId, p, ctx, msg) {
  if (ctx.signal.aborted) throw be('CANCELLED', 'The command was cancelled.');
  msg.opId = ctx.id;
  if (p.dialog === 'accept' || p.dialog === 'dismiss') msg.dialog = p.dialog;
  if (typeof p.promptText === 'string') msg.promptText = p.promptText.slice(0, 1000);
  // Tabs this action opens (target=_blank links, window.open) are reported, so the agent can follow them.
  var opened = [];
  var onCreated = function (t) { if (t && t.openerTabId === tabId) opened.push(t.id); };
  try { B.tabs.onCreated.addListener(onCreated); } catch (e) {}
  var stop = function () {
    try { call(B.tabs, 'sendMessage', tabId, { kind: 'cancel', opId: ctx.id }).catch(function () {}); } catch (e) {}
  };
  ctx.signal.addEventListener('abort', stop);
  try {
    var result = await sendToPage(tabId, p, msg);
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
async function afterNavigation(tabId, result, signal) {
  var until = Date.now() + 8000, tab = null;
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

async function withOpenedTabs(result, ids) {
  var tabs = [];
  for (var i = 0; i < ids.length; i++) {
    try { var t = await call(B.tabs, 'get', ids[i]); tabs.push({ tabId: t.id, url: t.url || '', active: !!t.active }); } catch (e) {}
  }
  if (!tabs.length) return result;
  var out = (result && typeof result === 'object' && !Array.isArray(result)) ? result : { result: result };
  out.openedTabs = tabs;
  out.openedNote = 'This opened ' + (tabs.length === 1 ? 'a new tab (tabId ' + tabs[0].tabId + ')' : tabs.length + ' new tabs') +
    '. Pass its tabId to act there; the original tab is unchanged.';
  return out;
}

/* One screenshot at a time: two that each switch tabs would otherwise hand
 * focus back in the wrong order. */
var shootChain = Promise.resolve();
function shoot(tab, p) {
  var run = shootChain.then(function () { return shootNow(tab, p); });
  shootChain = run.catch(function () {});
  return run;
}

async function shootNow(tab, p) {
  var format = p.format === 'jpeg' ? 'jpeg' : 'png';
  var opts = format === 'jpeg' ? { format: format, quality: Math.max(10, Math.min(100, num(p.quality, 80))) } : { format: format };
  if (p.rect) opts.rect = p.rect;
  if (p.scale !== undefined) opts.scale = p.scale;
  try { tab = await call(B.tabs, 'get', tab.id); } catch (e) {} // may have changed while queued
  // Fast path (Firefox 125+): capture a background tab without switching to it.
  if (!tab.active && B.tabs && typeof B.tabs.captureTab === 'function') {
    try {
      return { image: await call(B.tabs, 'captureTab', tab.id, opts), format: format, tabId: tab.id };
    } catch (e) { /* fall back to activate + captureVisibleTab */ }
  }
  var restoreId = null;
  if (!tab.active) {
    var prev = await call(B.tabs, 'query', { active: true, windowId: tab.windowId });
    if (prev && prev[0]) restoreId = prev[0].id;
    await call(B.tabs, 'update', tab.id, { active: true });
    await sleep(250); // let the compositor paint the newly active tab
  }
  try {
    var dataUrl = await call(B.tabs, 'captureVisibleTab', tab.windowId, opts);
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
async function cursorOp(tabId, op, note) {
  try {
    return unwrapContentResponse(await call(B.tabs, 'sendMessage', tabId, { kind: 'cursor', op: op, note: note }));
  } catch (e) { return null; }
}

/* After a non-page method (tabs.list, history.search, ...), still show the model's thought. */
async function noteAfter(method, p) {
  if (!CFG.showCursor || typeof p.thought !== 'string' || !p.thought.trim()) return;
  if (CONTENT_METHODS.test(method) || NO_NOTE_METHODS.test(method) || method === 'cursor.say') return;
  try {
    var tab = await resolveTab(p.tabId);
    if (RESTRICTED_RE.test(String(tab.url || '')) || AMO_RE.test(String(tab.url || ''))) return;
    await sendToTab(tab.id, p, { kind: 'cursor', op: 'say', note: p.thought.slice(0, 300) });
  } catch (e) {}
}

/* Cursor turned off: clear it from every tab right away. */
async function hideCursors() {
  try {
    var tabs = await call(B.tabs, 'query', {});
    (tabs || []).forEach(function (t) { cursorOp(t.id, 'hide'); });
  } catch (e) {}
}

/* Resolve true once a tab finishes loading, false on timeout or abort.
 * The listener goes on before the navigation starts (so no event is missed);
 * call start(tabId) once the tab id is known. Events seen before that are
 * buffered. With checkNow, a tab that is already complete counts (used for new
 * tabs, which have no previous page whose 'complete' could be mistaken). */
function tabLoadWaiter(timeoutMs, signal, wantUrl) {
  var tabId = null, buffered = [], sawLoading = false, done = false, resolveFn;
  var promise = new Promise(function (r) { resolveFn = r; });
  var wantBlank = /^about:blank/i.test(String(wantUrl || ''));
  function finish(v) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try { B.tabs.onUpdated.removeListener(onUpd); } catch (e) {}
    if (signal) signal.removeEventListener('abort', onAbort);
    resolveFn(v);
  }
  // A new tab passes through about:blank; that 'complete' isn't the page we want.
  function placeholder(tab) {
    return !wantBlank && tab && /^about:blank/i.test(String(tab.url || ''));
  }
  function consider(info, tab) {
    // Ignore the 'complete' of the page we're navigating away from: require a
    // 'loading' first, or a URL change, before accepting 'complete'.
    if (info.status === 'loading' || info.url) sawLoading = true;
    if (info.status === 'complete' && sawLoading && !placeholder(tab)) finish(true);
  }
  function onUpd(id, info, tab) {
    if (done || !info) return;
    if (tabId === null) { buffered.push([id, info, tab]); return; }
    if (id === tabId) consider(info, tab);
  }
  function onAbort() { finish(false); }
  var timer = setTimeout(function () { finish(false); }, Math.max(1000, timeoutMs));
  B.tabs.onUpdated.addListener(onUpd);
  if (signal) {
    if (signal.aborted) finish(false);
    else signal.addEventListener('abort', onAbort);
  }
  return {
    promise: promise,
    start: function (id, checkNow) {
      tabId = id;
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
function fixUrl(u) {
  var s = String(u).trim();
  if (!s) return s;
  if (LOCAL_HOST_RE.test(s)) return 'http://' + s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^/:]+:\d+([/?#]|$)/.test(s)) return s; // has a scheme (about:, https:, ...)
  if (s.indexOf('//') === 0) return 'https:' + s;
  return 'https://' + s;
}

/* Same page apart from the #fragment, which navigates without loading. */
function sameDocument(from, to) {
  var a = String(from || ''), b = String(to || '');
  if (b.indexOf('#') < 0) return false;
  try { b = new URL(b, a).href; } catch (e) { return false; }
  return a.split('#')[0] === b.split('#')[0] && a !== b;
}

/* tab.update with active:true also brings its window forward. */
async function focusWindow(props, tab) {
  if (!props.active || !tab) return;
  try { await call(B.windows, 'update', tab.windowId, { focused: true }); } catch (e) {}
}

/* A user regex that can't backtrack catastrophically: JS regexes can't be
 * timed out, and a hung match would freeze the whole add-on. Rejects
 * backreferences and a quantified group with a quantifier inside, e.g. (a+)+. */
function safeRegExp(src) {
  if (src === undefined || src === null || src === '') return null;
  src = String(src);
  if (src.length > 500) throw new Error('pattern longer than 500 characters');
  var stack = [], inClass = false, prevQuant = false;
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

/* Copy the params that were given (not undefined/null) onto msg. */
function pick(p, keys, msg) {
  msg = msg || {};
  keys.forEach(function (k) { if (p[k] !== undefined && p[k] !== null) msg[k] = p[k]; });
  return msg;
}

/* How an action names its element: a snapshot ref, a CSS selector, an accessible
 * name (+ role, nth), or a point. The content script resolves them (see locate in ax.js). */
var TARGET_KEYS = ['ref', 'selector', 'name', 'role', 'nth', 'x', 'y', 'generation', 'waitMs'];

function hasTargetParams(p) {
  return ['ref', 'selector', 'name', 'x'].some(function (k) { return p[k] !== undefined && p[k] !== null && p[k] !== ''; });
}

/* A page action: resolve the tab, forward the target and the action's own fields. */
async function act(p, ctx, kind, keys, base) {
  var tab = await resolveTab(p.tabId);
  assertContentAllowed(tab);
  var msg = pick(p, TARGET_KEYS.concat(['changes'], keys), Object.assign({ kind: kind }, base || {}));
  return await actOn(tab.id, p, ctx, msg);
}

/* Agent storage: a small key-value store in the add-on that outlives tabs, pages
 * and restarts. Page storage: the page's own localStorage/sessionStorage. */
var AGENT_STORE = 'agentStore';
var AGENT_MAX_KEYS = 1000, AGENT_MAX_VALUE = 100000;

async function storageOp(op, p) {
  var area = p.area || 'agent';
  if (area === 'local' || area === 'session') {
    var tab = await resolveTab(p.tabId);
    assertContentAllowed(tab);
    return await sendToPage(tab.id, p, pick(p, ['key', 'value'], { kind: 'page-storage', op: op, area: area }));
  }
  if (area !== 'agent') throw be('INVALID_PARAMS', 'area must be "agent", "local" or "session"');
  var got = await call(B.storage.local, 'get', AGENT_STORE);
  var store = (got && got[AGENT_STORE] && typeof got[AGENT_STORE] === 'object') ? got[AGENT_STORE] : {};
  var key = (p.key === undefined || p.key === null || p.key === '') ? null : String(p.key).slice(0, 200);
  if (op === 'get') {
    if (key === null) {
      var prefix = p.prefix ? String(p.prefix) : '';
      var keys = Object.keys(store).filter(function (k) { return k.indexOf(prefix) === 0; }).sort();
      return { area: 'agent', count: keys.length, keys: keys.map(function (k) { return { key: k, updated: store[k].at }; }) };
    }
    if (!(key in store)) return { area: 'agent', key: key, found: false };
    return { area: 'agent', key: key, found: true, value: store[key].v, updated: store[key].at };
  }
  if (key === null) throw be('INVALID_PARAMS', 'storage_' + op + ' needs a key');
  if (op === 'set') {
    var size = JSON.stringify(p.value === undefined ? null : p.value).length;
    if (size > AGENT_MAX_VALUE) throw be('PAYLOAD_TOO_LARGE', 'Values are limited to ' + AGENT_MAX_VALUE + ' characters of JSON (this one is ' + size + ').');
    if (!(key in store) && Object.keys(store).length >= AGENT_MAX_KEYS) throw be('PAYLOAD_TOO_LARGE', 'The agent store is full (' + AGENT_MAX_KEYS + ' keys). Remove some first.');
    store[key] = { v: p.value === undefined ? null : p.value, at: new Date().toISOString() };
    var put = {}; put[AGENT_STORE] = store; await call(B.storage.local, 'set', put);
    return { area: 'agent', key: key, saved: true };
  }
  var had = key in store;
  delete store[key];
  if (had) var put = {}; put[AGENT_STORE] = store; await call(B.storage.local, 'set', put);
  return { area: 'agent', key: key, removed: had };
}

/* The cookie jar a tab sees: its container / private store, across first-party
 * isolation, including cookies partitioned under its site (CHIPS / Total Cookie
 * Protection). Older Firefox lacks some keys; drop them and retry. */
async function jarCookies(tab, url, extra) {
  var q = Object.assign({ url: url.split('#')[0], firstPartyDomain: null, partitionKey: {} }, extra || {});
  if (tab && tab.cookieStoreId) q.storeId = tab.cookieStoreId;
  var cookies;
  for (var attempt = 0; ; attempt++) {
    try {
      cookies = await call(B.cookies, 'getAll', q);
      break;
    } catch (e) {
      if (attempt === 0 && 'partitionKey' in q) { delete q.partitionKey; continue; }
      if (attempt <= 1 && 'firstPartyDomain' in q) { delete q.firstPartyDomain; continue; }
      throw e;
    }
  }
  var host = '', scheme = '';
  try { var u = new URL(url); host = u.hostname; scheme = u.protocol; } catch (e) {}
  var under = function (d) { return host === d || host.endsWith('.' + d); };
  return (cookies || []).filter(function (c) {
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
async function cookieTarget(p) {
  var tab = await resolveTab(p.tabId);
  var url = p.url !== undefined && p.url !== null && p.url !== '' ? fixUrl(p.url) : String(tab.url || '');
  if (!/^https?:/i.test(url)) throw be('INVALID_PARAMS', 'Cookies need an http(s) page; this tab shows ' + (url || 'nothing') + '. Pass url.');
  return { tab: tab, url: url };
}

function cookieInfo(c) {
  var o = {
    name: c.name, value: c.value, domain: c.domain, path: c.path,
    secure: !!c.secure, httpOnly: !!c.httpOnly, sameSite: c.sameSite || 'no_restriction',
    session: !!c.session
  };
  if (!c.session && c.expirationDate) o.expires = new Date(c.expirationDate * 1000).toISOString();
  if (c.partitionKey && c.partitionKey.topLevelSite) o.partitionedUnder = c.partitionKey.topLevelSite;
  return o;
}

/* A download as the agent needs it: where the file is, whether it's done, and why not. */
async function downloadInfo(d) {
  var o = {
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

var handlers = {
  /* ---- inventory ---- */
  'tabs.list': async function (p) {
    var tabs = await call(B.tabs, 'query', {});
    if (p && p.includeDiscarded === false) tabs = tabs.filter(function (t) { return !t.discarded; });
    return tabs.map(toTabInfo);
  },
  'tabs.query': async function (p) {
    var tabs = await call(B.tabs, 'query', {});
    var urlRe = null, titleRe = null;
    var text = (p.query === undefined || p.query === null || p.query === '*') ? '' : String(p.query).trim().toLowerCase();
    try {
      urlRe = p.urlPattern === '*' ? null : safeRegExp(p.urlPattern);
      titleRe = p.titlePattern === '*' ? null : safeRegExp(p.titlePattern);
    } catch (e) {
      throw be('INVALID_PARAMS', 'Bad regex in tabs.query: ' + e.message);
    }
    return tabs.filter(function (t) {
      // Bounded input keeps even a slow pattern from freezing the add-on.
      if (urlRe && !urlRe.test(String(t.url || '').slice(0, 2048))) return false;
      if (titleRe && !titleRe.test(String(t.title || '').slice(0, 512))) return false;
      if (p.audible !== undefined && !!t.audible !== !!p.audible) return false;
      if (p.pinned !== undefined && !!t.pinned !== !!p.pinned) return false;
      if (p.active !== undefined && !!t.active !== !!p.active) return false;
      if (p.windowId !== undefined && t.windowId !== Number(p.windowId)) return false;
      if (p.includeDiscarded === false && t.discarded) return false;
      if (text && (String(t.url || '') + ' ' + String(t.title || '')).toLowerCase().indexOf(text) < 0) return false;
      return true;
    }).map(toTabInfo);
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
      var dup = await call(B.tabs, 'duplicate', src.id, p.active === false ? { active: false } : undefined);
      return toTabInfo(dup);
    }
    var details = {};
    if (p.windowId !== undefined) details.windowId = Number(p.windowId);
    if (p.url !== undefined) details.url = fixUrl(p.url);
    if (p.active !== undefined) details.active = !!p.active;
    var waiter = details.url && p.waitForLoad ? tabLoadWaiter(num(p.timeoutMs, 20000), ctx.signal, details.url) : null;
    var created;
    try {
      created = await call(B.tabs, 'create', details);
    } catch (e) {
      if (waiter) waiter.cancel();
      throw e;
    }
    if (waiter) {
      waiter.start(created.id, true);
      var ok = await waiter.promise;
      var info = toTabInfo(await call(B.tabs, 'get', created.id));
      info.loadComplete = ok;
      return info;
    }
    return toTabInfo(created);
  },
  'tab.update': async function (p, ctx) {
    var tab = await resolveTab(p.tabId);
    var props = {};
    if (p.url !== undefined) props.url = fixUrl(p.url);
    if (p.active !== undefined) props.active = !!p.active;
    if (p.pinned !== undefined) props.pinned = !!p.pinned;
    var updated = tab;
    if (props.url !== undefined && p.waitForLoad && sameDocument(tab.url, props.url)) {
      // A #fragment change doesn't load anything, so there is nothing to wait for.
      updated = await call(B.tabs, 'update', tab.id, props);
      await focusWindow(props, updated);
      var same = toTabInfo(await call(B.tabs, 'get', tab.id));
      same.loadComplete = true;
      return same;
    }
    if (props.url !== undefined && p.waitForLoad) {
      var loaded = tabLoadWaiter(num(p.timeoutMs, 20000), ctx.signal, props.url);
      loaded.start(tab.id, false);
      try {
        await call(B.tabs, 'update', tab.id, props);
      } catch (e) {
        loaded.cancel();
        throw e;
      }
      var ok = await loaded.promise;
      var info = toTabInfo(await call(B.tabs, 'get', tab.id));
      await focusWindow(props, info);
      info.loadComplete = ok;
      return info;
    }
    if (Object.keys(props).length) updated = await call(B.tabs, 'update', tab.id, props);
    await focusWindow(props, updated);
    return toTabInfo(updated || tab);
  },
  'tab.navigate': async function (p, ctx) {
    if (p.url !== undefined && p.url !== null && p.url !== '') return await handlers['tab.update'](pick(p, ['tabId', 'url', 'waitForLoad', 'timeoutMs']), ctx);
    var go = p.go;
    if (go !== 'back' && go !== 'forward' && go !== 'reload') throw be('INVALID_PARAMS', 'tab_navigate needs url, or go: "back", "forward" or "reload"');
    var tab = await resolveTab(p.tabId);
    var wait = p.waitForLoad !== false ? tabLoadWaiter(num(p.timeoutMs, 20000), ctx.signal) : null;
    if (wait) wait.start(tab.id, false);
    try {
      if (go === 'back') await call(B.tabs, 'goBack', tab.id);
      else if (go === 'forward') await call(B.tabs, 'goForward', tab.id);
      else await call(B.tabs, 'reload', tab.id, { bypassCache: !!p.bypassCache });
    } catch (e) {
      if (wait) wait.cancel();
      if (go !== 'reload') throw be('NAVIGATION_FAILED', 'Cannot go ' + go + ': ' + (e.message || e) + ' (no history that way?)');
      throw e;
    }
    // Back/forward within one page (#fragments, pushState) fires no load; don't wait the full timeout.
    var ok = wait ? await Promise.race([wait.promise, sleep(go === 'reload' ? 1e9 : 3000).then(function () { return null; })]) : null;
    if (wait) wait.cancel();
    var info = toTabInfo(await call(B.tabs, 'get', tab.id));
    if (wait) info.loadComplete = ok === null ? info.status === 'complete' : ok;
    if (go !== 'reload' && info.url === tab.url) info.note = 'The URL did not change: there may be no history ' + go + ', or the page changed in place.';
    return info;
  },
  'tab.close': async function (p) {
    var ids;
    if (Array.isArray(p.tabIds)) ids = p.tabIds.map(Number);
    else if (p.tabId !== undefined) ids = [Number(p.tabId)];
    else ids = [(await resolveTab(undefined)).id];
    try {
      await call(B.tabs, 'remove', ids);
    } catch (e) {
      throw be('TAB_NOT_FOUND', 'Could not close tab(s): ' + (e.message || e));
    }
    return { closed: ids };
  },
  'tab.duplicate': async function (p) {
    var tab = await resolveTab(p.tabId);
    return toTabInfo(await call(B.tabs, 'duplicate', tab.id));
  },
  'tab.move': async function (p) {
    if (p.index === undefined) throw be('INVALID_PARAMS', 'tab.move requires index');
    var tab = await resolveTab(p.tabId);
    var props = { index: Number(p.index) };
    if (p.windowId !== undefined) props.windowId = Number(p.windowId);
    var moved = await call(B.tabs, 'move', tab.id, props);
    var t = Array.isArray(moved) ? moved[0] : moved;
    return toTabInfo(t || tab);
  },
  'tab.pin': async function (p) {
    var tab = await resolveTab(p.tabId);
    return toTabInfo(await call(B.tabs, 'update', tab.id, { pinned: p.pinned !== undefined ? !!p.pinned : true }));
  },
  'tab.unpin': async function (p) {
    var tab = await resolveTab(p.tabId);
    return toTabInfo(await call(B.tabs, 'update', tab.id, { pinned: false }));
  },
  'tab.mute': async function (p) {
    var tab = await resolveTab(p.tabId);
    var muted = p.muted !== undefined ? !!p.muted : true;
    // NOTE: Firefox tabs.update does NOT support `muted` (Chrome-only).
    // Correct API: browser.tabs.updateMutedInfo(tabId, { muted }).
    if (B.tabs && typeof B.tabs.updateMutedInfo === 'function') {
      await call(B.tabs, 'updateMutedInfo', tab.id, { muted: muted });
    } else {
      // chrome fallback: chrome.tabs.update supports `muted`.
      await call(B.tabs, 'update', tab.id, { muted: muted });
    }
    try {
      return toTabInfo(await call(B.tabs, 'get', tab.id));
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
    await call(B.tabs, 'goBack', tab.id);
    return { navigated: true, tabId: tab.id };
  },
  'nav.forward': async function (p) {
    var tab = await resolveTab(p.tabId);
    await call(B.tabs, 'goForward', tab.id);
    return { navigated: true, tabId: tab.id };
  },
  'nav.reload': async function (p) {
    var tab = await resolveTab(p.tabId);
    if (p.bypassCache !== undefined) await call(B.tabs, 'reload', tab.id, { bypassCache: !!p.bypassCache });
    else await call(B.tabs, 'reload', tab.id);
    return { reloaded: true, tabId: tab.id };
  },

  /* ---- understanding ---- */
  'page.snapshot': async function (p) {
    var tab = await resolveTab(p.tabId);
    assertContentAllowed(tab);
    return await sendToPage(tab.id, p, pick(p, ['within', 'viewportOnly'], {
      kind: 'ax-snapshot',
      compact: p.compact !== undefined ? !!p.compact : true,
      maxChars: num(p.maxChars, 50000)
    }));
  },
  'page.text': async function (p) {
    var tab = await resolveTab(p.tabId);
    assertContentAllowed(tab);
    return await sendToPage(tab.id, p, pick(p, ['within', 'offset'], { kind: 'page-text', maxChars: num(p.maxChars, 20000) }));
  },
  'page.html': async function (p) {
    var tab = await resolveTab(p.tabId);
    assertContentAllowed(tab);
    return await sendToPage(tab.id, p, pick(p, ['within'], {
      kind: 'page-html',
      selector: p.selector,
      maxChars: num(p.maxChars, 50000)
    }));
  },
  'page.shot': async function (p) {
    var tab = await resolveTab(p.tabId);
    var shotP = { format: p.format, quality: p.quality, keepActive: p.keepActive };
    var scale = p.scale !== undefined ? Math.max(0.1, Math.min(2, Number(p.scale) || 1)) : null;
    var extra = {};
    var element = hasTargetParams(p);
    if (element || p.fullPage) {
      assertContentAllowed(tab);
      var m = await sendToPage(tab.id, p, element
        ? pick(p, TARGET_KEYS, { kind: 'element-rect' })
        : { kind: 'page-metrics' });
      var r = element ? m.rect : { x: 0, y: 0, width: m.width, height: m.height };
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
    var concealed = !!(await cursorOp(tab.id, 'conceal'));
    try {
      var out = await shoot(tab, shotP);
      if (scale !== null) out.scale = Math.round(scale * 100) / 100;
      return Object.assign(out, extra);
    } finally {
      if (concealed) cursorOp(tab.id, 'reveal');
    }
  },
  'cursor.say': async function (p) {
    var tab = await resolveTab(p.tabId);
    var note = String(p.note || p.thought || '').trim();
    if (!note) throw be('INVALID_PARAMS', 'cursor.say requires note');
    if (!CFG.showCursor) return { shown: false, reason: 'The user turned the AI cursor off' };
    assertContentAllowed(tab);
    return await sendToTab(tab.id, p, { kind: 'cursor', op: 'say', note: note.slice(0, 300) });
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
    return await actOn(tab.id, p, ctx, pick(p, ['generation', 'changes', 'submitRef', 'submitSelector', 'submitName'], {
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
    return await act(p, ctx, 'act-wait', ['text', 'gone'], { timeoutMs: num(p.timeoutMs, 10000) });
  },
  'act.find': async function (p, ctx) {
    if (p.query === undefined || p.query === null || String(p.query) === '') {
      throw be('INVALID_PARAMS', 'act.find requires query');
    }
    return await act(p, ctx, 'act-find', [], { query: String(p.query) });
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
    var q = p.query !== undefined ? p.query : '';
    return await call(B.bookmarks, 'search', q);
  },
  'bookmarks.create': async function (p) {
    var d = {};
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
    var h = { text: p.query !== undefined ? String(p.query) : '', maxResults: num(p.maxResults, 20) };
    // Firefox searches only the last 24 hours unless told otherwise; "that page from last week" needs all of it.
    h.startTime = p.startTime !== undefined ? Number(p.startTime) : 0;
    return await call(B.history, 'search', h);
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
    var q = { orderBy: ['-startTime'], limit: Math.max(1, Math.min(200, num(p.limit, 20))) };
    if (p.id !== undefined) q.id = Number(p.id);
    if (p.query) q.query = String(p.query).split(/\s+/).filter(Boolean);
    if (p.state) q.state = String(p.state);
    var list = await call(B.downloads, 'search', q);
    var out = [];
    for (var i = 0; i < (list || []).length; i++) out.push(await downloadInfo(list[i]));
    return out;
  },
  'downloads.start': async function (p, ctx) {
    if (!p.url) throw be('INVALID_PARAMS', 'download_start needs url');
    var opts = { url: fixUrl(p.url), conflictAction: 'uniquify', saveAs: false };
    if (p.filename) {
      var name = String(p.filename).replace(/^[\\/]+/, '');
      if (/(^|[\\/])\.\.([\\/]|$)/.test(name)) throw be('INVALID_PARAMS', 'filename can\'t contain ".."; it is relative to the downloads folder');
      opts.filename = name;
    }
    var id;
    try { id = await call(B.downloads, 'download', opts); } catch (e) {
      throw be('DOWNLOAD_FAILED', 'Download refused: ' + (e.message || e));
    }
    var until = Date.now() + (p.wait === false ? 0 : num(p.timeoutMs, 60000));
    var d = null;
    for (;;) {
      d = ((await call(B.downloads, 'search', { id: id })) || [])[0];
      if (!d || d.state !== 'in_progress' || Date.now() >= until || ctx.signal.aborted) break;
      await sleep(250);
    }
    var info = d ? await downloadInfo(d) : { id: id };
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
    var d = { url: t.url.split('#')[0], name: String(p.name), value: p.value === undefined || p.value === null ? '' : String(p.value) };
    if (t.tab.cookieStoreId) d.storeId = t.tab.cookieStoreId;
    pick(p, ['domain', 'path', 'secure', 'httpOnly', 'sameSite'], d);
    if (p.expiresInSeconds !== undefined) d.expirationDate = Math.floor(Date.now() / 1000) + Number(p.expiresInSeconds);
    else if (p.expires !== undefined) {
      var at = typeof p.expires === 'number' ? p.expires : Date.parse(p.expires) / 1000;
      if (!isFinite(at)) throw be('INVALID_PARAMS', 'expires must be an ISO date or unix seconds');
      d.expirationDate = Math.floor(at);
    }
    var c;
    try {
      c = await call(B.cookies, 'set', d);
    } catch (e) {
      // First-party isolation needs the jar named explicitly.
      if (!/firstPartyDomain/i.test(String(e.message || e))) throw be('COOKIE_REFUSED', 'Firefox refused the cookie: ' + (e.message || e));
      d.firstPartyDomain = new URL(d.url).hostname.split('.').slice(-2).join('.');
      c = await call(B.cookies, 'set', d);
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
      var d = { url: (c.secure ? 'https://' : 'http://') + c.domain.replace(/^\./, '') + c.path, name: c.name };
      if (c.storeId) d.storeId = c.storeId;
      if (c.firstPartyDomain) d.firstPartyDomain = c.firstPartyDomain;
      if (c.partitionKey) d.partitionKey = c.partitionKey;
      try { if (await call(B.cookies, 'remove', d)) removed++; } catch (e) {}
    }
    return { url: t.url, name: String(p.name), removed: removed };
  },
  'sessions.recentlyClosed': async function (p) {
    return await call(B.sessions, 'getRecentlyClosed', { maxResults: num(p.limit, 10) });
  },
  'sessions.restore': async function (p) {
    if (p.sessionId === undefined) throw be('INVALID_PARAMS', 'sessions.restore requires sessionId');
    return await call(B.sessions, 'restore', String(p.sessionId));
  }
};

/* What each method looks like to the user: [while running, in the activity log]. */
var LABELS = {
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
function labelsFor(method) {
  var base = 'lbl' + method.split('.').map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join('');
  var en = LABELS[method] || [method, method];
  var now0 = t(base + 'Now'), past = t(base + 'Past');
  return [now0 === base + 'Now' ? en[0] : now0, past === base + 'Past' ? en[1] : past];
}

/* Methods that act on one tab, so "Now" can say which. */
var TAB_METHODS = /^(page\.|act\.|nav\.|cookies\.|tab\.(update|navigate|close|duplicate|move|pin|unpin|mute)$|cursor\.say$)/;
var now = null; // { text, past, site, tabId, at, done }

function siteOf(url) {
  try { var u = new URL(url); return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, '') : ''; } catch (e) { return ''; }
}

async function onCommand(cmd, ctx) {
  var handler = handlers[cmd.method];
  if (!handler) throw be('UNKNOWN_METHOD', 'Unknown method: ' + cmd.method);
  var params = (cmd.params && typeof cmd.params === 'object') ? cmd.params : {};
  cmdCount += 1;
  var label = labelsFor(cmd.method);
  var cur = now = { text: label[0], past: label[1], site: '', tabId: null, at: Date.now(), done: false };
  if (TAB_METHODS.test(cmd.method)) {
    resolveTab(params.tabId).then(function (t) { cur.site = siteOf(t.url); cur.tabId = t.id; }).catch(function () {});
  }
  updateBadge();
  try {
    var result = await handler(params, ctx);
  } catch (e) {
    var be0 = toBridgeError(e);
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

function send(obj) {
  if (!port) return;
  try { port.postMessage(obj); } catch (e) { log('postMessage failed: ' + (e.message || e)); }
}

function sendEvent(evt) { send(evt); }

async function handleIncoming(msg) {
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
      var result = await onCommand(msg, { id: String(msg.id), signal: ac.signal });
      if (port === from) send({ id: msg.id, ok: true, result: result === undefined ? null : result });
    } catch (e) {
      if (port === from) send({ id: msg.id, ok: false, error: toBridgeError(e) });
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

async function buildHello() {
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
      token: CFG.token,
      profile: 'default',
      firefoxVersion: ffVersion,
      capabilities: CAPABILITIES.slice()
    }
  };
}

function hostConfigMessage() {
  return {
    hostConfig: {
      token: CFG.token,
      port: CFG.port,
      bind: CFG.bind,
      allowWsl: CFG.allowWsl,
      confirmDestructive: CFG.confirmDestructive
    }
  };
}

function isMissingHostError(text) {
  return /no such native application|not found|manifest|does not exist|access to the specified native/i.test(text || '');
}

function connect() {
  if (port) return;
  var p;
  try {
    p = B.runtime.connectNative(NATIVE_HOST);
  } catch (e) {
    hostMissing = true;
    lastError = t('errCouldNotStart', e.message || e);
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
  p.onMessage.addListener(function (msg) {
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
  p.onDisconnect.addListener(function (dp) {
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

/* Toolbar badge: orange dot while the AI is acting, "II" when paused, "!" when not serving, "↑" for a helper update. */
function updateBadge() {
  var ba = B.browserAction;
  if (!ba) return;
  var on = isListening();
  var update = on && compat().state === 'helper-update';
  var busy = on && inflight.size > 0;
  var why = paused ? t('stPaused')
    : on ? (busy && now ? now.text : t('badgeServing', hostStatus.url)) + (update ? ' · ' + t('softUpdate') : '')
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
        if (delta && delta.state && delta.state.current === 'complete') {
          call(B.downloads, 'search', { id: delta.id }).then(function (found) {
            var extra = {};
            if (found && found[0]) {
              extra = { filename: found[0].filename, url: found[0].url, bytesReceived: found[0].bytesReceived };
            }
            var data = { id: delta.id };
            for (var k in extra) data[k] = extra[k];
            sendEvent({ event: 'download.done', data: data });
          }).catch(function () {
            sendEvent({ event: 'download.done', data: { id: delta.id } });
          });
        }
      });
    }
  } catch (e) {
    log('event wiring failed: ' + (e.message || e));
  }
}

/* ---------------------------------------------------------- config + boot */

function randomToken() {
  var bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
}

function validPort(v) {
  var n = Number(v);
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : 0;
}

function validBind(v) {
  var s = String(v || '').trim();
  if (s === 'localhost') return '127.0.0.1';
  if (s === '::' || s === '::1') return s;
  var parts = s.split('.');
  return parts.length === 4 && parts.every(function (o) { return /^\d{1,3}$/.test(o) && Number(o) <= 255; }) ? s : '';
}

async function loadConfig() {
  var got = {};
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

function statusSnapshot() {
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
    now: now && { text: now.done ? now.past : now.text, site: now.site, tabId: now.tabId, at: now.at, active: !now.done },
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
function fromOwnPage(sender) {
  var base = B.runtime.getURL('');
  return !!(sender && sender.id === B.runtime.id && typeof sender.url === 'string' && sender.url.indexOf(base) === 0);
}

/* Settings writes run one at a time, and each is saved before it takes effect, so a failed save
 * leaves the running config and storage in agreement. */
var cfgQueue = Promise.resolve();
function queued(fn) {
  var r = cfgQueue.then(fn);
  cfgQueue = r.catch(function () {});
  return r.catch(function (e) { return { error: t('couldntSave', (e && e.message) || e) }; });
}

function setPaused(v) {
  return queued(async function () {
    await call(B.storage.local, 'set', { mcpPaused: v });
    if (paused === v) return statusSnapshot();
    paused = v;
    note(v ? t('evYouPaused') : t('evYouResumed'), v ? 'bad' : 'ok');
    if (v) { abortInflight(); hideCursors(); }
    updateBadge();
    return statusSnapshot();
  });
}

if (B.commands && B.commands.onCommand) {
  B.commands.onCommand.addListener(function (name) {
    if (name === 'toggle-pause') setPaused(!paused);
  });
}

if (B.runtime && B.runtime.onMessage) {
  B.runtime.onMessage.addListener(function (msg, sender) {
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
      var data = {};
      var p = msg.port !== undefined ? validPort(msg.port) : 0;
      if (msg.port !== undefined && !p) return Promise.resolve({ error: t('errPort'), field: 'port' });
      var b = msg.bind !== undefined ? validBind(msg.bind) : '';
      if (msg.bind !== undefined && !b) return Promise.resolve({ error: t('errBind'), field: 'bind' });
      if (p) data.mcpPort = p;
      if (b) data.mcpBind = b;
      if (typeof msg.allowWsl === 'boolean') data.mcpAllowWsl = msg.allowWsl;
      if (typeof msg.confirmDestructive === 'boolean') data.mcpConfirm = msg.confirmDestructive;
      if (typeof msg.showCursor === 'boolean') data.mcpShowCursor = msg.showCursor;
      return queued(async function () {
        await call(B.storage.local, 'set', data);
        if ('mcpPort' in data) CFG.port = data.mcpPort;
        if ('mcpBind' in data) CFG.bind = data.mcpBind;
        if ('mcpAllowWsl' in data) CFG.allowWsl = data.mcpAllowWsl;
        if ('mcpConfirm' in data) CFG.confirmDestructive = data.mcpConfirm;
        if ('mcpShowCursor' in data) {
          CFG.showCursor = data.mcpShowCursor;
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
    if (type === 'set-paused') return setPaused(msg.paused === true);
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
