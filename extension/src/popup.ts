/* Foxhand — toolbar popup logic (plain classic script). */
import type { Status, UiMessage } from './messages';

(function () {
'use strict';

var B = ((typeof browser !== 'undefined') ? browser : chrome) as typeof browser;
var F = window.FxMcp;

/* The reply of a popup message: a status snapshot, or {error} when a settings write was refused. */
type Snap = Status & { error?: string };

var $ = function <T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; };
var dotEl = $('dot'), stateEl = $('state'), detailEl = $('detail'), errEl = $('err'), setupEl = $('setup');
var copyBtn = $('copy'), pauseBtn = $('pause'), cursorEl = $<HTMLInputElement>('cursor');
var last: Snap | null = null;
var stepsFor = '';
var busy = false; // a pause/resume is in flight

function send<T = Snap>(msg: UiMessage): Promise<T> { return Promise.resolve(B.runtime.sendMessage(msg)); }
function setText(el: HTMLElement, text: string): void { if (el.textContent !== text) el.textContent = text; }

var t = F.t, ago = F.ago;
F.localize();

function renderSteps(st: Snap, need: { intro: string }): void {
  var key = JSON.stringify(st.platform) + need.intro;
  if (stepsFor === key) return;
  stepsFor = key;
  F.renderSetup(setupEl, st.platform, need.intro);
}

/* While the helper is missing, re-check every few seconds so the popup goes
 * green as soon as the install command finishes. */
var lastRetry = 0;
function autoRetry(st: Snap): void {
  if (!st.hostMissing || Date.now() - lastRetry < 3000) return;
  lastRetry = Date.now();
  send({ type: 'probe' }).catch(function () {});
}

/* While serving, this card is either what the AI is doing or an empty state that says what to do. */
function renderNow(st: Snap): void {
  var n = st.now;
  $('now').hidden = !st.listening;
  if (!st.listening) return;
  if (!n) {
    $('nowLbl').className = '';
    setText($('nowLbl'), t('activity'));
    $('nowText').className = 'empty';
    setText($('nowText'), t('nowEmpty'));
    setText($('nowSite'), '');
    return;
  }
  $('nowLbl').className = n.active ? 'live' : '';
  setText($('nowLbl'), n.active ? t('now') : t('lastAgo', ago(n.at)));
  $('nowText').className = '';
  setText($('nowText'), n.text);
  setText($('nowSite'), n.site || '');
}

function renderPause(st: Snap): void {
  pauseBtn.hidden = !st.listening && !st.paused;
  setText($('pauseTxt'), st.paused ? t('resumeAI') : t('pauseAI'));
  $('pauseIcon').style.display = st.paused ? 'none' : '';
  $('playIcon').style.display = st.paused ? '' : 'none';
}

function render(st: Snap | null | undefined): void {
  if (!st || st.error) return;
  last = st;
  var sum = F.summarize(st);
  dotEl.className = 'dot ' + sum.cls;
  $('hero').setAttribute('data-state', sum.cls);
  setText(stateEl, sum.text);
  setText($('hint'), F.hint(st));
  setText(errEl, st.listening ? '' : ((st.host && st.host.error) || (st.hostMissing ? '' : st.lastError) || ''));
  var need = F.setupNeed(st);
  setupEl.hidden = !need;
  if (need) renderSteps(st, need);
  autoRetry(st);
  copyBtn.hidden = !st.listening;
  // Retry is the main action when the helper should be running but isn't; with no helper the install steps are.
  $('retry').hidden = !!st.listening;
  $('retry').className = st.hostMissing ? '' : 'orange';
  $('guide').hidden = !!st.listening && (st.commands || 0) > 0;
  var guard = st.confirmDestructive !== false;
  setText($('guardState'), guard ? t('on') : t('off'));
  $('guardVal').className = 'value' + (guard ? ' ok' : '');
  if (!busy) renderPause(st);
  renderNow(st);
  if (document.activeElement !== cursorEl) cursorEl.checked = st.showCursor !== false;
  var bits: string[] = [];
  if (st.host && st.host.version) bits.push(t('helperV', st.host.version));
  if (st.listening) bits.push(t('upFor', ago(st.connectedAt)), t('nCommands', st.commands || 0));
  setText(detailEl, bits.join(' · '));
}

function poll(): void {
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

function openSettings(ev: Event): void {
  ev.preventDefault();
  B.runtime.openOptionsPage();
  window.close();
}
$('guardLink').addEventListener('click', function (ev) {
  ev.preventDefault();
  B.tabs.create({ url: B.runtime.getURL('options.html#safety') });
  window.close();
});
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
