/* Foxhand — toolbar popup logic (plain classic script). */
(function () {
'use strict';

var B = (typeof browser !== 'undefined') ? browser : chrome;
var F = window.FxMcp;

var $ = function (id) { return document.getElementById(id); };
var dotEl = $('dot'), stateEl = $('state'), detailEl = $('detail'), errEl = $('err'), setupEl = $('setup');
var copyBtn = $('copy'), pauseBtn = $('pause'), cursorEl = $('cursor');
var last = null;
var stepsFor = '';
var busy = false; // a pause/resume is in flight

function send(msg) { return Promise.resolve(B.runtime.sendMessage(msg)); }
function setText(el, text) { if (el.textContent !== text) el.textContent = text; }

var t = F.t, ago = F.ago;
F.localize();

function renderSteps(st, need) {
  var key = JSON.stringify(st.platform) + need.intro;
  if (stepsFor === key) return;
  stepsFor = key;
  F.renderSetup(setupEl, st.platform, need.intro);
}

/* While the helper is missing, re-check every few seconds so the popup goes
 * green as soon as the install command finishes. */
var lastRetry = 0;
function autoRetry(st) {
  if (!st.hostMissing || Date.now() - lastRetry < 3000) return;
  lastRetry = Date.now();
  send({ type: 'probe' }).catch(function () {});
}

function renderNow(st) {
  var n = st.now;
  $('now').hidden = !st.listening || !n;
  if (!n) return;
  $('nowLbl').className = n.active ? 'live' : '';
  setText($('nowLbl'), n.active ? t('now') : t('lastAgo', ago(n.at)));
  setText($('nowText'), n.text);
  setText($('nowSite'), n.site || '');
}

function renderPause(st) {
  pauseBtn.hidden = !st.listening && !st.paused;
  setText($('pauseTxt'), st.paused ? t('resumeAI') : t('pauseAI'));
  $('pauseIcon').style.display = st.paused ? 'none' : '';
  $('playIcon').style.display = st.paused ? '' : 'none';
}

function render(st) {
  if (!st || st.error) return;
  last = st;
  var sum = F.summarize(st);
  dotEl.className = 'dot ' + sum.cls;
  setText(stateEl, sum.text);
  setText(errEl, st.listening ? '' : ((st.host && st.host.error) || (st.hostMissing ? '' : st.lastError) || ''));
  var need = F.setupNeed(st);
  setupEl.hidden = !need;
  if (need) renderSteps(st, need);
  autoRetry(st);
  copyBtn.hidden = !st.listening;
  $('retry').hidden = !!st.listening;
  $('guide').hidden = !!st.listening;
  if (!busy) renderPause(st);
  renderNow(st);
  if (document.activeElement !== cursorEl) cursorEl.checked = st.showCursor !== false;
  var bits = [];
  if (st.host && st.host.version) bits.push(t('helperV', st.host.version));
  if (st.listening) bits.push(t('upFor', ago(st.connectedAt)), t('nCommands', st.commands || 0));
  setText(detailEl, bits.join(' · '));
}

function poll() {
  send({ type: 'get-status' })
    .then(render)
    .catch(function (e) {
      setText(stateEl, t('statusError'));
      setText(errEl, String((e && e.message) || e));
    });
}

copyBtn.addEventListener('click', function () {
  if (last) F.copy(F.mcpConfig(last, F.configKind(), F.configWhere()), copyBtn).catch(function () {});
});

pauseBtn.addEventListener('click', function () {
  if (!last || busy) return;
  busy = true;
  send({ type: 'set-paused', paused: !last.paused })
    .then(function (st) { busy = false; render(st); })
    .catch(function (e) { busy = false; setText(errEl, String((e && e.message) || e)); });
});

cursorEl.addEventListener('change', function () {
  send({ type: 'set-config', showCursor: cursorEl.checked }).then(render).catch(function () {});
});

$('retry').addEventListener('click', function () {
  setText(stateEl, t('retrying'));
  send({ type: 'reconnect' }).then(render).catch(function () {});
});

function openSettings(ev) {
  ev.preventDefault();
  B.runtime.openOptionsPage();
  window.close();
}
$('open').addEventListener('click', openSettings);
$('gear').addEventListener('click', openSettings);
$('guide').addEventListener('click', function (ev) {
  ev.preventDefault();
  B.tabs.create({ url: B.runtime.getURL('onboarding.html') });
  window.close();
});

/* Show the real pause shortcut, which the user may have changed in about:addons. */
F.pauseShortcut().then(function (k) { if (k) setText($('shortcut'), t('shortcutPauses', k)); });

poll();
setInterval(poll, 1000);
})();
