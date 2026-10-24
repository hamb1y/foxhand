/* Foxhand — first-run setup: install the helper, connect an AI, try it. Each step turns green by itself. */
(function () {
'use strict';

var B = (typeof browser !== 'undefined') ? browser : chrome;
var F = window.FxMcp;
var t = F.t;
var $ = function (id) { return document.getElementById(id); };
var kindEls = Array.prototype.slice.call(document.querySelectorAll('input[name=kind]'));
var last = null, setupFor = '', lastProbe = 0;
// Commands the AI had run when this page opened: the next one proves the connection works.
var baseline = null;

F.localize();
$('renamed').hidden = location.hash !== '#renamed';

function send(msg) { return Promise.resolve(B.runtime.sendMessage(msg)); }
function setText(el, text) { if (el.textContent !== text) el.textContent = text; }

function kind() {
  var el = kindEls.filter(function (x) { return x.checked; })[0];
  return el ? el.value : 'claude';
}
// Most people arrive with Claude Code; a choice made before (here or in Settings) wins.
var picked = '';
try { picked = localStorage.getItem('fxmcp.kind') || ''; } catch (e) {}
var start = picked ? F.configKind() : 'claude';
kindEls.forEach(function (x) { x.checked = x.value === start; });
kindEls.forEach(function (x) {
  x.addEventListener('change', function () { F.configKind(x.value); if (last) renderConnect(last); });
});

function stepState(id, cls) {
  ['done', 'current', 'later'].forEach(function (c) { $(id).classList.toggle(c, c === cls); });
}

function renderHelper(st) {
  var ok = !!st.listening;
  var need = F.setupNeed(st);
  var key = JSON.stringify(st.platform) + '|' + (need ? need.title + need.intro : 'ok');
  if (setupFor !== key) {
    setupFor = key;
    if (need || !ok) F.renderSetup($('setup'), st.platform, need && need.intro, !st.hostMissing);
    else $('setup').textContent = '';
  }
  $('s1state').className = 'state' + (ok ? ' ok' : '');
  $('s1state').firstChild.className = 'dot ' + (ok ? 'on' : st.hostMissing ? 'warn' : 'wait');
  setText($('s1text'), ok ? t('ob1Done', st.host && st.host.version ? st.host.version : '') : F.summarize(st).text);
  if (st.hostMissing && Date.now() - lastProbe > 3000) {
    lastProbe = Date.now();
    send({ type: 'probe' }).catch(function () {});
  }
  return ok;
}

function renderConnect(st) {
  var k = kind();
  setText($('hint'), F.configHint(st, k, 'local'));
  // The config holds the helper's address, so it appears once the helper is running.
  $('cfg').hidden = $('copyCfg').hidden = !st.listening;
  if (st.listening) setText($('cfg'), F.mcpConfig(st, k, 'local'));
  $('wslNote').hidden = !F.canWsl(st);
}

function renderConnected(st) {
  if (baseline === null && st.listening) baseline = st.commands || 0;
  var used = st.listening && (st.commands || 0) > (baseline || 0);
  $('s2state').className = 'state' + (used ? ' ok' : '');
  $('s2state').firstChild.className = 'dot ' + (used ? 'on' : 'wait');
  setText($('s2text'), used ? t('ob2Done', (st.now && st.now.text) || '') : t('ob2Waiting'));
  return used;
}

function render(st) {
  if (!st || st.error) return;
  last = st;
  var h = renderHelper(st);
  renderConnect(st);
  var c = renderConnected(st);
  stepState('s1', h ? 'done' : 'current');
  stepState('s2', !h ? 'later' : c ? 'done' : 'current');
  stepState('s3', c ? 'current' : 'later');
}

$('copyCfg').addEventListener('click', function () {
  F.copy($('cfg').textContent, this).catch(function () {});
});
Array.prototype.forEach.call(document.querySelectorAll('[data-copy]'), function (b) {
  b.addEventListener('click', function () { F.copy(t(b.getAttribute('data-copy')), b).catch(function () {}); });
});
F.pauseShortcut().then(function (k) { setText($('tipPause'), t('obTipPause', k || 'Ctrl+Shift+.')); });

function refresh() { send({ type: 'get-status' }).then(render).catch(function () {}); }
refresh();
setInterval(refresh, 1000);
})();
