/* Foxhand — first-run setup: install the helper, connect an AI, try it. Each step ticks itself off. */
import type { Status, UiMessage } from './messages';
(function () {
'use strict';

var B = ((typeof browser !== 'undefined') ? browser : chrome) as typeof browser;
var F = window.FxMcp;
var t = F.t;
var $ = function (id: string): HTMLElement { return document.getElementById(id) as HTMLElement; };
var kindEls = Array.prototype.slice.call(document.querySelectorAll('input[name=kind]')) as HTMLInputElement[];
var last: Status | null = null, setupFor = '', lastProbe = 0;
// Commands the AI had run when this page opened: the next one proves the connection works.
var baseline: number | null = null;

F.localize();
$('renamed').hidden = location.hash !== '#renamed';

function send(msg: UiMessage): Promise<Status> { return Promise.resolve(B.runtime.sendMessage(msg)); }
function setText(el: HTMLElement, text: string) { if (el.textContent !== text) el.textContent = text; }

function kind(): string {
  var el = kindEls.filter(function (x) { return x.checked; })[0];
  return el ? el.value : 'claude';
}
// Most people arrive with Claude Code; a choice made before (here or in Settings) wins.
var picked = '';
try { picked = localStorage.getItem('fxmcp.kind') || ''; } catch (e) {}
var start = picked ? F.configKind() : 'claude';
kindEls.forEach(function (x) { x.checked = x.value === start; });
kindEls.forEach(function (x) {
  x.addEventListener('change', function () { F.configKind(x.value); send({ type: 'picked-harness', kind: x.value }).catch(function () {}); if (last) renderConnect(last); });
});

function stepState(id: string, cls: string) {
  ['done', 'current', 'later'].forEach(function (c) { $(id).classList.toggle(c, c === cls); });
}

function renderHelper(st: Status) {
  var ok = !!st.listening;
  var need = F.setupNeed(st);
  var key = JSON.stringify(st.platform) + '|' + (need ? need.title + need.intro : 'ok');
  if (setupFor !== key) {
    setupFor = key;
    if (need || !ok) F.renderSetup($('setup'), st.platform, (need && need.intro) as string, !st.hostMissing);
    else $('setup').textContent = '';
  }
  $('s1state').className = 'state' + (ok ? ' ok' : '');
  ($('s1state').firstChild as HTMLElement).className = 'dot ' + (ok ? 'on' : st.hostMissing ? 'warn' : 'wait');
  setText($('s1text'), ok ? t('ob1Done', st.host && st.host.version ? st.host.version : '') : F.summarize(st).text);
  F.reportProblem($('report') as HTMLAnchorElement, st, st.lastError || (st.host && st.host.error) || '');
  if (st.hostMissing && Date.now() - lastProbe > 3000) {
    lastProbe = Date.now();
    send({ type: 'probe' }).catch(function () {});
  }
  return ok;
}

function renderConnect(st: Status) {
  var k = kind();
  setText($('hint'), F.configHint(st, k, 'local'));
  // The config holds the helper's address, so it appears once the helper is running.
  $('cfg').hidden = $('copyCfg').hidden = !st.listening;
  if (st.listening) setText($('cfg'), F.mcpConfig(st, k, 'local'));
  $('wslNote').hidden = !F.canWsl(st);
}

function renderConnected(st: Status) {
  if (baseline === null && st.listening) baseline = st.commands || 0;
  var used = st.listening && (st.commands || 0) > (baseline || 0);
  $('s2state').className = 'state' + (used ? ' ok' : '');
  ($('s2state').firstChild as HTMLElement).className = 'dot ' + (used ? 'on' : 'wait');
  setText($('s2text'), used ? t('ob2Done', (st.now && st.now.text) || '') : t('ob2Waiting'));
  return used;
}

/* Three segments: finished steps are orange, the step you're on is white. */
function renderProgress(current: number) {
  [1, 2, 3].forEach(function (n) { $('p' + n).className = n < current ? 'on' : n === current ? 'cur' : ''; });
  setText($('progText'), t('obProgress', [current, 3, t('ob' + current)]));
}

function render(st: (Status & { error?: string }) | null | undefined) {
  if (!st || st.error) return;
  last = st;
  var h = renderHelper(st);
  renderConnect(st);
  var c = renderConnected(st);
  renderProgress(!h ? 1 : !c ? 2 : 3);
  stepState('s1', h ? 'done' : 'current');
  stepState('s2', !h ? 'later' : c ? 'done' : 'current');
  stepState('s3', c ? 'current' : 'later');
}

$('copyCfg').addEventListener('click', function (this: HTMLElement) {
  F.copy($('cfg').textContent as string, this).catch(function () {});
});
Array.prototype.forEach.call(document.querySelectorAll<HTMLElement>('[data-copy]'), function (b) {
  b.addEventListener('click', function () { F.copy(t(b.getAttribute('data-copy') as string), b).catch(function () {}); });
});
F.pauseShortcut().then(function (k) { setText($('tipPause'), t('obTipPause', k || 'Ctrl+Shift+.')); });

function refresh() { send({ type: 'get-status' }).then(render).catch(function () {}); }
refresh();
setInterval(refresh, 1000);
})();
