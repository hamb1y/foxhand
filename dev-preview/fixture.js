/* DEV PREVIEW ONLY: a local fake of the WebExtension APIs, so the REAL extension pages
 * (popup.html, options.html, onboarding.html, announcement.html) render outside Firefox.
 *
 * Everything here is a made-up placeholder: no token, history, tabs or settings are read from
 * any real Firefox profile or helper. Injected by dev-preview/serve.mjs; never shipped (the
 * add-on is packed from an allow-list in scripts/pack-extension.sh, and this folder is not in it).
 *
 * URL parameters:  ?state=<name>  ?lang=en|de|es|fr|zh_CN  ?os=linux|win|mac  ?badge=0
 */
(function () {
'use strict';
var q = new URLSearchParams(location.search);
var STATE = q.get('state') || 'ready';
var LANG = q.get('lang') || 'en';
var OS = q.get('os') || (STATE === 'wsl' ? 'win' : 'linux');
var ROOT = '/' + location.pathname.split('/')[1] + '/';          // /_ext/ or /_ext-before/

var FX = window.__FX || { messages: {}, announcement: null };   // from /_review/fixture-data.js: the real locale file + the approved announcement

/* ---- i18n: the extension's real messages.json, resolved like Firefox does ---- */
var MESSAGES = FX.messages;
function getMessage(key, subs) {
  var m = MESSAGES[key];
  if (!m) return '';
  var args = subs === undefined ? [] : [].concat(subs).map(String);
  return m.message.replace(/\$([A-Za-z0-9_]+)\$/g, function (_, name) {
    var ph = m.placeholders && m.placeholders[name.toLowerCase()];
    return ph ? ph.content.replace(/\$(\d)/g, function (__, n) { return args[Number(n) - 1] || ''; }) : '';
  }).replace(/\$\$/g, '$');
}

/* ---- a stateful fake background ---- */
var now = Date.now();
var st = {
  version: '0.5.8', protocol: 1, compat: { state: 'ok' },
  platform: { os: OS, arch: 'x86-64' }, hostMissing: false,
  connected: true, starting: false, listening: true,
  host: { version: '0.5.8', logFile: '~/.local/share/foxhand/foxhand-host.log', url: 'http://localhost:8901/mcp', extraUrls: [] },
  url: 'http://localhost:8901/mcp',
  token: 'FIXTURE-TOKEN-NOT-A-REAL-SECRET-0000000000000000000000',
  port: 8901, bind: '127.0.0.1', allowWsl: false, confirmDestructive: true, showCursor: true, paused: false,
  defaults: { port: 8901, bind: '127.0.0.1' }, lastError: '',
  commands: 14, connectedAt: now - 18 * 60000,
  now: { text: 'Clicked “Sign in”', site: 'example.org', at: now - 4000, active: false },
  events: [
    { at: now - 18 * 60000, text: 'Helper v0.5.8 running', level: 'ok' },
    { at: now - 17 * 60000, text: 'Listening on http://localhost:8901/mcp', level: 'ok' },
    { at: now - 9 * 60000, text: 'Looked through tabs', level: 'info' },
    { at: now - 8 * 60000, text: 'Read the page', level: 'info', site: 'example.org' },
    { at: now - 7 * 60000, text: 'Filled in a form', level: 'info', site: 'example.org' },
    { at: now - 4000, text: 'Clicked “Sign in”', level: 'info', site: 'example.org', count: 1 }
  ]
};
var down = { hostMissing: true, connected: false, listening: false, host: null, url: '', commands: 0, connectedAt: 0, now: null, events: [] };
var STATES = {
  ready: {},
  active: { now: { text: 'Typing “red panda”', site: 'wikipedia.org', at: now, active: true } },
  idle: { commands: 0, now: null, events: [{ at: now - 60000, text: 'Helper v0.5.8 running', level: 'ok' }, { at: now - 59000, text: 'Listening on http://localhost:8901/mcp', level: 'ok' }] },
  paused: { paused: true, events: st.events.concat([{ at: now - 1500, text: 'You paused the AI', level: 'info' }]) },
  missing: down,
  disconnected: { connected: false, listening: false, host: { version: '0.5.8', logFile: '' }, url: '', commands: 0, connectedAt: 0, now: null,
    lastError: 'Helper stopped: the pipe closed.', events: [{ at: now - 30000, text: 'Helper stopped: the pipe closed.', level: 'bad' }] },
  port: { listening: false, host: { version: '0.5.8', error: 'Port 8901 is already in use.' }, url: '', commands: 0, now: null,
    events: [{ at: now - 20000, text: 'Port 8901 is already in use.', level: 'bad' }] },
  starting: { connected: false, listening: false, starting: true, host: null, url: '', commands: 0, now: null, events: [] },
  update: { compat: { state: 'helper-update', helper: '0.5.6', addon: '0.5.8' }, host: { version: '0.5.6', logFile: '', url: 'http://localhost:8901/mcp', extraUrls: [] } },
  old: Object.assign({}, down, { hostMissing: false, host: { version: '0.4.0' }, compat: { state: 'helper-old', helper: '0.4.0', addon: '0.5.8' } }),
  empty: { events: [] },
  wsl: { allowWsl: true, host: { version: '0.5.8', logFile: 'C:\\Users\\you\\AppData\\Local\\foxhand\\foxhand-host.log', url: 'http://localhost:8901/mcp', extraUrls: ['http://172.20.0.1:8901/mcp'], wslAddress: '172.20.0.1' } },
  // Starts with no commands, then the "AI" makes its first one two seconds in (onboarding's live ticks).
  connected: { commands: 0, now: null, events: [] }
};
Object.assign(st, STATES[STATE] || {});
st.platform = { os: OS, arch: 'x86-64' };
if (STATE === 'connected') {
  setTimeout(function () {
    st.commands = 1;
    st.now = { text: 'Looked through tabs', site: '', at: Date.now(), active: false };
    st.events = [{ at: Date.now(), text: 'Looked through tabs', level: 'info' }];
  }, 2200);
}

function snap() { return JSON.parse(JSON.stringify(st)); }
function onMessage(m) {
  switch (m && m.type) {
    case 'get-status': case 'probe': case 'reconnect': return snap();
    case 'set-paused': st.paused = m.paused === true; return snap();
    case 'regenerate-token': st.token = 'FIXTURE-TOKEN-REGENERATED-NOT-A-REAL-SECRET-0000000000'; return snap();
    case 'set-config':
      if (m.port !== undefined) {
        var p = Number(m.port);
        if (!Number.isInteger(p) || p < 1024 || p > 65535) return { error: 'Port must be a number between 1024 and 65535', field: 'port' };
        st.port = p; st.url = 'http://localhost:' + p + '/mcp';
      }
      if (m.bind !== undefined) {
        if (!/^\d+\.\d+\.\d+\.\d+$/.test(m.bind)) return { error: 'Listen on must be an IP address like 127.0.0.1 or 0.0.0.0', field: 'bind' };
        st.bind = m.bind;
      }
      ['allowWsl', 'showCursor', 'confirmDestructive'].forEach(function (k) { if (typeof m[k] === 'boolean') st[k] = m[k]; });
      if (st.host) st.host.extraUrls = st.allowWsl ? ['http://172.20.0.1:' + st.port + '/mcp'] : [];
      return snap();
    case 'announcement-get': {
      return FX.announcement;   // the repo's real, approved announcement (popup-endpoint/public/popup.json)
    }
    case 'announcement-shown': return { ok: true };
  }
  return snap();
}

window.browser = {
  i18n: { getMessage: getMessage, getUILanguage: function () { return LANG.replace('_', '-'); } },
  runtime: {
    id: 'fixture',
    sendMessage: function (m) { return Promise.resolve(onMessage(m)); },
    getURL: function (p) { return ROOT + p; },
    openOptionsPage: function () { window.open(ROOT + 'options.html' + location.search, '_blank'); }
  },
  tabs: { create: function (o) { window.open(o.url, '_blank'); return Promise.resolve({}); } },
  commands: { getAll: function () { return Promise.resolve([{ name: 'toggle-pause', shortcut: OS === 'mac' ? 'MacCtrl+Shift+Period' : 'Ctrl+Shift+Period' }]); } }
};

/* ---- a small label so a screenshot can never be mistaken for a real run ---- */
if (q.get('badge') !== '0') {
  window.addEventListener('DOMContentLoaded', function () {
    var b = document.createElement('div');
    b.textContent = 'Dev preview · fixture state: ' + STATE;
    var s = b.style;
    s.setProperty('position', 'fixed'); s.setProperty('right', '6px'); s.setProperty('bottom', '6px'); s.setProperty('z-index', '99999');
    s.setProperty('font', '10px/1.2 ui-monospace, monospace'); s.setProperty('padding', '3px 6px'); s.setProperty('border-radius', '4px');
    s.setProperty('background', '#222'); s.setProperty('color', '#bbb'); s.setProperty('pointer-events', 'none'); s.setProperty('opacity', '.85');
    document.body.appendChild(b);
  });
}
})();
