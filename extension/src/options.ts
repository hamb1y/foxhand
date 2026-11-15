/* Foxhand — settings page logic (plain classic script). */
import type { Status, UiMessage } from './messages';
(function () {
'use strict';

/* What this page reads from a status snapshot or a settings reply. */
type Reply = Status & { error?: string; field?: 'port' | 'bind' };

var B = ((typeof browser !== 'undefined') ? browser : chrome) as typeof browser;
var F = window.FxMcp;
var t = F.t;
F.localize();

var $ = function <T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; };
var tokenEl = $<HTMLInputElement>('token'), portEl = $<HTMLInputElement>('port'), bindEl = $<HTMLInputElement>('bind'), saveEl = $<HTMLButtonElement>('save'), formErr = $('formErr');
var cfgEl = $('cfg');
var kindEls = Array.prototype.slice.call(document.querySelectorAll('input[name=kind]')) as HTMLInputElement[];
var inWslEl = $<HTMLInputElement>('inWsl');
var toggles = { allowWsl: $<HTMLInputElement>('allowWsl'), showCursor: $<HTMLInputElement>('showCursor'), confirmDestructive: $<HTMLInputElement>('confirmDestructive') };
var pending: Record<string, boolean> = {};      // toggles with a save in flight: don't let a poll flip them back
var last: Reply | null = null;
var setupFor = '';

function send(msg: UiMessage): Promise<Reply> { return Promise.resolve(B.runtime.sendMessage(msg)); }

/* Only touch the DOM when something changed, so polling never resets selections or focus. */
function setText(el: HTMLElement, text: string) { if (el.textContent !== text) el.textContent = text; }
function setHidden(el: HTMLElement, hidden: boolean) { if (el.hidden !== hidden) el.hidden = hidden; }

var toastTimer = 0;
function toast(text: string, isErr?: boolean) {
  var t = $('toast');
  t.textContent = text;
  t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.className = isErr ? 'err' : ''; }, isErr ? 4000 : 1600);
}
function errText(e: unknown): string { return ((e as Error) && (e as Error).message) || String(e); }

/* ---- which AI, and where it runs ---- */
function kind() {
  var el = kindEls.filter(function (x) { return x.checked; })[0];
  return el ? el.value : 'json';
}
function pickKind(value: string) {
  kindEls.forEach(function (x) { x.checked = x.value === value; });
}
function where() { return inWslEl.checked ? 'wsl' : 'local'; }

function since(ts: number) {
  var m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1) return t('justNow');
  if (m < 60) return t('minutesShort', m);
  var h = Math.floor(m / 60);
  return m % 60 ? t('hoursMinutes', [h, m % 60]) : t('hoursShort', h);
}

/* ---- rendering ---- */
var pausing = false;
function renderStatus(st: Reply) {
  var sum = F.summarize(st);
  $('dot').className = 'dot ' + sum.cls;
  setText($('stateTxt'), sum.text);
  setText($('stateHint'), F.hint(st));
  setText($('stateErr'), st.listening ? '' : ((st.host && st.host.error) || (st.hostMissing ? '' : st.lastError) || ''));
  F.reportProblem($<HTMLAnchorElement>('report'), st, $('stateErr').textContent || '');
  setText($('factHelper'), st.host && st.host.version ? 'v' + st.host.version : st.hostMissing ? t('notInstalled') : '—');
  setText($('factUp'), st.listening && st.connectedAt ? since(st.connectedAt) + ' · ' + t('nCommands', st.commands || 0) : '—');
  setText($('factAddr'), st.listening ? F.mcpUrl(st).replace(/^http:\/\//, '').replace(/\/mcp$/, '') : '—');
  setText($('addonVer'), t('addonV', st.version || '?'));
  setHidden($('retry'), !!st.listening);
  if (!pausing) {
    setHidden($('pause'), !st.listening && !st.paused);
    setText($('pause'), st.paused ? t('resumeAI') : t('pauseAI'));
  }
}

function renderInstall(st: Reply) {
  var need = F.setupNeed(st);
  var s = F.hostSetup(st.platform);
  var installed = st.host && st.host.version;
  setText($('installTitle'), need ? need.title : t('helperApp'));
  setText($('helperInfo'), (installed ? t('helperInstalledOn', [st.host!.version, s.os]) : t('helperFor', s.os)) +
    (st.host && st.host.extraUrls && st.host.extraUrls.length ? ' · ' + t('alsoWsl', st.host.extraUrls.join(', ')) : ''));
  setText($('uninstallCmd'), s.uninstall);
  // Missing or too old: steps up front. An optional update sits further down. Otherwise tucked away.
  setHidden($('install'), !need);
  $('install').classList.toggle('attention', !!(need && !need.soft));
  var key = JSON.stringify(st.platform) + '|' + (need ? need.title + need.intro : '');
  if (setupFor !== key) {
    setupFor = key;
    var now = $('setupNow'), later = $('setupLaterBody');
    now.textContent = '';
    later.textContent = '';
    if (need) F.renderSetup(now, st.platform, need.intro, !st.hostMissing);
    else F.renderSetup(later, st.platform, '', true);
    setHidden($('setupLater'), !!need);
  }
  // Re-check while missing so the page goes green right after the install command.
  if (st.hostMissing && Date.now() - lastProbe > 3000) {
    lastProbe = Date.now();
    send({ type: 'probe' }).catch(function () {});
  }
}
var lastProbe = 0;

function renderConnect(st: Reply) {
  var k = kind();
  var win = F.canWsl(st) && k !== 'claude-app'; // the Claude app runs on Windows itself
  setHidden($('whereRow'), !win);
  var w = win ? where() : 'local';
  setText($('kindHint'), F.configHint(st, k, w));
  setText(cfgEl, F.mcpConfig(st, k, w));
  // Did the AI ever call in? The first command proves the pasted config works.
  var used = st.listening && (st.commands || 0) > 0;
  $('connState').className = 'state' + (used ? ' ok' : '');
  $('connDot').className = 'dot ' + (used ? 'on' : st.listening ? 'wait' : 'warn');
  setText($('connTxt'), used ? t('connDone', st.commands) : st.listening ? t('ob2Waiting') : t('connNeedsHelper'));
  setHidden($('wsl'), w !== 'wsl');
  var extra = (st.host && st.host.extraUrls) || [];
  var ws = $('wslState');
  if (!st.allowWsl) {
    ws.className = 'warn';
    setText(ws, t('wslOff'));
  } else if (extra.length) {
    ws.className = 'ok';
    setText(ws, t('wslOk', extra.join(', ')));
  } else {
    ws.className = 'warn';
    setText(ws, st.listening ? t('wslNoAdapter') : t('starting'));
  }
}

function dirty() {
  return !!last && (portEl.value.trim() !== String(last.port) || bindEl.value.trim() !== last.bind);
}

function renderSettings(st: Reply) {
  (Object.keys(toggles) as Array<keyof typeof toggles>).forEach(function (k) {
    if (!pending[k] && typeof st[k] === 'boolean') toggles[k].checked = st[k];
  });
  if (tokenEl.value !== (st.token || '')) tokenEl.value = st.token || '';
  // Keep what the user is typing; otherwise follow the saved values.
  var editing = document.activeElement === portEl || document.activeElement === bindEl;
  if (!editing && !saveEl.dataset.dirty) {
    if (portEl.value !== String(st.port)) portEl.value = st.port as unknown as string;
    if (bindEl.value !== st.bind) bindEl.value = st.bind;
  }
  updateSave();
}

function updateSave() {
  var d = dirty();
  saveEl.disabled = !d;
  if (d) saveEl.dataset.dirty = '1'; else delete saveEl.dataset.dirty;
}

var eventsKey = '';
function clock(ms: number) {
  var d = new Date(ms), now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function span(cls: string, text: string) {
  var el = document.createElement('span');
  el.className = cls;
  el.textContent = text;
  return el;
}
function renderActivity(st: Reply) {
  var evs = st.events || [];
  var key = JSON.stringify(evs);
  if (key !== eventsKey) {
    eventsKey = key;
    var ul = $('events');
    ul.textContent = '';
    if (!evs.length) {
      var li0 = document.createElement('li');
      li0.className = 'empty';
      li0.appendChild(document.createTextNode(t('nothingYet') + ' '));
      var jump = document.createElement('a');
      jump.href = '#connect';
      jump.textContent = t('activityEmptyLink');
      li0.appendChild(jump);
      ul.appendChild(li0);
    }
    evs.slice().reverse().forEach(function (e) {
      var li = document.createElement('li');
      var tm = document.createElement('time');
      tm.dateTime = new Date(e.at).toISOString();
      tm.title = new Date(e.at).toLocaleString();
      tm.textContent = clock(e.at);
      var tx = span(e.level === 'bad' ? 'bad' : '', e.text);
      if (e.site) tx.appendChild(span('site', ' · ' + e.site));
      if (e.count! > 1) tx.appendChild(span('count', ' ×' + e.count));
      li.appendChild(tm);
      li.appendChild(tx);
      ul.appendChild(li);
    });
  }
  var lf = (st.host && st.host.logFile) || '';
  setText($('logFile'), lf);
  setHidden($('logLine'), !lf);
}

function render(st: Reply | null | undefined) {
  if (!st) {
    $('dot').className = 'dot off';
    setText($('stateTxt'), t('noAnswer'));
    setText($('stateErr'), t('reloadHint'));
    setHidden($('retry'), false);
    return;
  }
  if (st.error) return;
  last = st;
  renderStatus(st);
  renderInstall(st);
  renderConnect(st);
  renderSettings(st);
  renderActivity(st);
}

function refresh() {
  return send({ type: 'get-status' }).then(render).catch(function (e) {
    $('dot').className = 'dot off';
    setText($('stateTxt'), t('cantReach'));
    setText($('stateErr'), errText(e));
  });
}

/* ---- actions ---- */
$('retry').addEventListener('click', function () { send({ type: 'reconnect' }).then(render).catch(function () {}); });

$('pause').addEventListener('click', function () {
  if (!last || pausing) return;
  pausing = true;
  send({ type: 'set-paused', paused: !last.paused }).then(function (st) {
    pausing = false;
    render(st);
  }).catch(function (e) {
    pausing = false;
    toast(t('couldntPause', errText(e)), true);
  });
});

function copyFrom(text: string, btn: HTMLElement) {
  F.copy(text, btn).catch(function (e) { toast(errText(e), true); });
}
$('copyCfg').addEventListener('click', function () { copyFrom(cfgEl.textContent!, this); });
$('copyToken').addEventListener('click', function () { copyFrom(tokenEl.value, this); });

$('reveal').addEventListener('click', function () {
  var show = tokenEl.type === 'password';
  tokenEl.type = show ? 'text' : 'password';
  this.textContent = show ? t('hide') : t('show');
});

pickKind(F.configKind());
inWslEl.checked = F.configWhere() === 'wsl';
kindEls.forEach(function (el) {
  el.addEventListener('change', function () {
    F.configKind(el.value);
    send({ type: 'picked-harness', kind: el.value }).catch(function () {});
    if (last) renderConnect(last);
  });
});
inWslEl.addEventListener('change', function () {
  F.configWhere(where());
  if (last) renderConnect(last);
  // Saying the AI is in WSL means you want WSL to connect: switch it on rather than leave a dead config.
  if (inWslEl.checked && last && !last.allowWsl) {
    toggles.allowWsl.checked = true;
    toggles.allowWsl.dispatchEvent(new Event('change'));
  }
});

/* Toggles apply right away. */
(Object.keys(toggles) as Array<keyof typeof toggles>).forEach(function (k) {
  toggles[k].addEventListener('change', function () {
    var msg: { type: 'set-config'; allowWsl?: boolean; showCursor?: boolean; confirmDestructive?: boolean } = { type: 'set-config' };
    msg[k] = toggles[k].checked;
    pending[k] = true;
    send(msg).then(function (res) {
      if (res && res.error) throw new Error(res.error);
      pending[k] = false;
      render(res);
      toast(k === 'allowWsl' && res.allowWsl ? t('wslOn') : t('saved'));
    }).catch(function (e) {
      pending[k] = false;
      if (last) toggles[k].checked = last[k];
      toast(t('couldntSave', errText(e)), true);
    });
  });
});

/* "New token" asks once more on the button itself. */
var regenTimer = 0;
$('regen').addEventListener('click', function () {
  var btn = this;
  if (!btn.classList.contains('danger')) {
    btn.classList.add('danger');
    btn.textContent = t('clickAgain');
    regenTimer = setTimeout(function () { btn.classList.remove('danger'); btn.textContent = t('newToken'); }, 4000);
    return;
  }
  clearTimeout(regenTimer);
  btn.classList.remove('danger');
  btn.textContent = t('newToken');
  send({ type: 'regenerate-token' }).then(function (st) {
    render(st);
    toast(t('newTokenActive'));
  }).catch(function (e) { toast(t('couldntToken', errText(e)), true); });
});

[portEl, bindEl].forEach(function (el) {
  el.addEventListener('input', function () {
    el.removeAttribute('aria-invalid');
    formErr.textContent = '';
    updateSave();
  });
});

$('reset').addEventListener('click', function () {
  if (!last) return;
  portEl.value = last.defaults.port as unknown as string;
  bindEl.value = last.defaults.bind;
  portEl.removeAttribute('aria-invalid');
  bindEl.removeAttribute('aria-invalid');
  formErr.textContent = '';
  updateSave();
  if (dirty()) saveEl.focus();
});

$('form').addEventListener('submit', function (ev) {
  ev.preventDefault();
  if (!dirty()) return;
  saveEl.disabled = true;
  formErr.textContent = '';
  send({ type: 'set-config', port: portEl.value.trim(), bind: bindEl.value.trim() }).then(function (res) {
    if (res && res.error) {
      formErr.textContent = res.error;
      (res.field === 'bind' ? bindEl : portEl).setAttribute('aria-invalid', 'true');
      updateSave();
      return;
    }
    delete saveEl.dataset.dirty;
    portEl.value = res.port as unknown as string;
    bindEl.value = res.bind;
    render(res);
    toast(t('savedPort'));
  }).catch(function (e) {
    formErr.textContent = t('couldntSave', errText(e));
    updateSave();
  });
});

/* ---- anonymous usage counts: this switch is Firefox's own data permission, not a copy of it ---- */
var USAGE = 'technicalAndInteraction' as const;
var usageEl = $<HTMLInputElement>('usageCounts');
var usagePending = false;
function usagePermission(): Promise<boolean> {
  if (!B.permissions) return Promise.reject(new Error('no permissions API'));
  return Promise.resolve(B.permissions.getAll()).then(function (all) { return !!all.data_collection && all.data_collection.indexOf(USAGE) >= 0; });
}
function refreshUsage(): void {
  if (usagePending) return;
  usagePermission().then(function (on) { usageEl.checked = on; }).catch(function () { setHidden($('statsRow'), true); });
}
usageEl.addEventListener('change', function () {
  var want = usageEl.checked;
  usagePending = true;
  // request() must run straight from this click; Firefox shows its own prompt if it needs one.
  var done = want ? B.permissions.request({ data_collection: [USAGE] }) : B.permissions.remove({ data_collection: [USAGE] });
  Promise.resolve(done).then(function (ok) {
    usagePending = false;
    if (want && !ok) toast(t('statsRefused'), true); else toast(t('saved'));
    refreshUsage();
  }).catch(function (e) {
    usagePending = false;
    toast(t('couldntSave', errText(e)), true);
    refreshUsage();
  });
});
if (B.permissions && B.permissions.onAdded) B.permissions.onAdded.addListener(refreshUsage);
if (B.permissions && B.permissions.onRemoved) B.permissions.onRemoved.addListener(refreshUsage);

/* Highlight the section in view in the side/top navigation. */
(function () {
  var links = Array.prototype.slice.call(document.querySelectorAll('#toc a')) as HTMLAnchorElement[];
  function mark(id: string) { links.forEach(function (a) { a.setAttribute('aria-current', String(a.getAttribute('href') === '#' + id)); }); }
  mark('status');
  if (!window.IntersectionObserver) return;
  var visible: Record<string, number | undefined> = {};
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { visible[e.target.id] = e.isIntersecting ? e.boundingClientRect.top : undefined; });
    var best: string | null = null;
    Object.keys(visible).forEach(function (id) {
      if (visible[id] !== undefined && (best === null || visible[id] < visible[best]!)) best = id;
    });
    if (best) mark(best);
  }, { rootMargin: '-10% 0px -70% 0px' });
  links.forEach(function (a) {
    var sec = document.getElementById(a.getAttribute('href')!.slice(1));
    if (sec) io.observe(sec);
  });
  // Opening a section from the popup (options.html#safety) lands on it.
  if (location.hash) mark(location.hash.slice(1));
})();

/* The real pause shortcut, which the user may have changed in about:addons. */
F.pauseShortcut().then(function (k) {
  var box = $('pauseKeys');
  box.textContent = '';
  (k || 'Ctrl+Shift+.').split('+').forEach(function (part, i) {
    if (i) box.appendChild(document.createTextNode(' + '));
    var kbd = document.createElement('kbd');
    kbd.textContent = part;
    box.appendChild(kbd);
  });
});

refresh();
refreshUsage();
setInterval(refresh, 1500);
setInterval(refreshUsage, 1500);
})();
