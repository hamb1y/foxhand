/* Foxhand — helpers shared by the popup, settings and onboarding pages (built to a classic script). */
import type { Status } from './messages';

/** Where the AI runs: 'local' (this computer) or 'wsl'. */
export type Where = 'local' | 'wsl';
type Platform = { os?: string; arch?: string } | null | undefined;
type Setup = { os: string; open: string; cmd: string; file: string; uninstall: string; manual: string };

export interface FxMcpApi {
  t(key: string, subs?: unknown): string;
  localize(root?: ParentNode): void;
  ago(ts: number): string;
  hostSetup(platform: Platform): Setup;
  renderSetup(container: HTMLElement, platform: Platform, intro?: string, installed?: boolean): Setup;
  setupNeed(st: St): { title: string; intro: string; soft?: boolean } | null;
  mcpUrl(st: St): string;
  mcpConfig(st: St, harness: string, where?: string): string;
  setupPrompt(st: St, harness: string, where?: string): string;
  configHint(st: St, harness: string, where?: string): string;
  configKind(set?: string): string;
  configWhere(set?: string): string;
  canWsl(st: St): boolean;
  copy(text: string, btn?: HTMLElement | null): Promise<void>;
  summarize(st: St): { cls: string; text: string };
  hint(st: St): string;
  pauseShortcut(): Promise<string>;
  reportProblem(link: HTMLAnchorElement, st: St, shown?: string): void;
  HARNESSES: string[];
}
/** The parts of a status snapshot these helpers read (the pages may pass a partial one). */
type St = Partial<Status> | null | undefined;

(function () {
'use strict';

var B = ((typeof browser !== 'undefined') ? browser : (typeof chrome !== 'undefined' ? chrome : {})) as typeof browser;
var BIN = 'foxhand-host';
var SITE = 'https://foxhand.pages.dev/';
var DOWNLOAD = SITE + 'download/latest/';

/* ------------------------------------------------------------ i18n */

/* A UI string in the browser's language (falls back to English, then to the key). */
function t(key: string, subs?: unknown): string {
  var m = '';
  try { m = B.i18n.getMessage(key, subs === undefined ? undefined : ([] as unknown[]).concat(subs).map(String)); } catch (e) {}
  return m || key;
}

/* Fill [data-i18n] text and [data-i18n-attr="attr:key;attr:key"] attributes. */
function localize(root?: ParentNode): void {
  root = root || document;
  try { document.documentElement.lang = B.i18n.getUILanguage(); } catch (e) {}
  Array.prototype.forEach.call((root as ParentNode).querySelectorAll<HTMLElement>('[data-i18n]'), function (el) {
    el.textContent = t(el.getAttribute('data-i18n') as string);
  });
  Array.prototype.forEach.call((root as ParentNode).querySelectorAll<HTMLElement>('[data-i18n-attr]'), function (el) {
    (el.getAttribute('data-i18n-attr') as string).split(';').forEach(function (pair) {
      var kv = pair.split(':');
      if (kv.length === 2) el.setAttribute(kv[0].trim(), t(kv[1].trim()));
    });
  });
}

/* "3 s" / "4 min" / "2 h" since a timestamp. */
function ago(ts: number): string {
  var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return t('secondsShort', s);
  if (s < 3600) return t('minutesShort', Math.round(s / 60));
  return t('hoursShort', Math.round(s / 3600));
}

/* ------------------------------------------------------------ helper install */

/* runtime.getPlatformInfo() -> download + one-line install for this computer. */
function hostSetup(platform: Platform): Setup {
  var os = (platform && platform.os) || '';
  var arch = (platform && platform.arch) || '';
  var a = /arm|aarch/.test(arch) ? 'arm64' : 'x64';
  if (os === 'win') {
    return {
      os: 'Windows',
      open: t('openPowerShell'),
      cmd: 'irm ' + SITE + 'download/ps | iex',
      file: BIN + '-windows-' + a + '.exe',
      uninstall: '& "$env:LOCALAPPDATA\\foxhand\\' + BIN + '.exe" uninstall',
      manual: t('manualWin')
    };
  }
  var mac = os === 'mac';
  var file = BIN + '-' + (mac ? 'darwin' : 'linux') + '-' + a;
  return {
    os: mac ? 'macOS' : 'Linux',
    open: mac ? t('openTerminalMac') : t('openTerminal'),
    cmd: 'curl -fsSL ' + SITE + 'download/sh | sh',
    file: file,
    uninstall: (mac ? '~/Library/Application\\ Support' : '~/.local/share') + '/foxhand/' + BIN + ' uninstall',
    // A browser download is quarantined on macOS: clear that first, or Gatekeeper blocks it.
    manual: t('manualUnix', (mac ? 'xattr -c ' + file + ' && ' : '') + 'chmod +x ' + file + ' && ./' + file + ' install')
  };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function installMethods(platform: Platform, s: Setup): Array<{ name: string; cmd: string }> {
  var win = platform?.os === 'win';
  var methods = [
    { name: win ? 'PowerShell' : 'curl', cmd: s.cmd },
    { name: 'npm (Node.js 22+)', cmd: win
      ? 'npm.cmd install -g @foxhand/helper; if ($LASTEXITCODE -eq 0) { foxhand-helper.cmd install }'
      : 'npm install -g @foxhand/helper && foxhand-helper install' }
  ];
  if (platform?.os === 'mac' || platform?.os === 'linux') {
    methods.splice(platform.os === 'mac' ? 0 : 1, 0, {
      name: 'Homebrew',
      cmd: 'brew install hamb1y/tap/foxhand-helper && foxhand-helper install'
    });
  }
  return methods;
}

/* Install instructions as DOM: install method, command + Copy, direct download link.
 * intro: optional sentence shown first (e.g. why an update is needed).
 * installed: the helper already runs, so don't promise the page will turn green. */
function renderSetup(container: HTMLElement, platform: Platform, intro?: string, installed?: boolean): Setup {
  var s = hostSetup(platform);
  container.textContent = '';
  if (intro) container.appendChild(el('div', 'intro', intro));
  var methods = installMethods(platform, s);
  var pre = el('pre', 'cmd');
  var choices = el('div', 'row install-methods');
  choices.setAttribute('role', 'group');
  choices.setAttribute('aria-label', t('needInstall'));
  var methodButtons = methods.map(function (method) {
    var button = el('button', 'small', method.name);
    button.type = 'button';
    choices.appendChild(button);
    return button;
  });
  function pick(index: number): void {
    pre.textContent = methods[index]!.cmd;
    methodButtons.forEach(function (button, i) { button.setAttribute('aria-pressed', String(i === index)); });
  }
  methodButtons.forEach(function (button, i) { button.addEventListener('click', function () { pick(i); }); });
  pick(0);
  var row = el('div', 'row');
  var btn = el('button', 'orange', t('copyCommand'));
  btn.type = 'button';
  btn.addEventListener('click', function () { copy(pre.textContent || '', btn).catch(function () {}); });
  var dl = el('a', 'button', t('downloadApp'));
  dl.href = DOWNLOAD + s.file;
  dl.target = '_blank';
  dl.rel = 'noopener';
  row.appendChild(btn);
  row.appendChild(dl);
  var parts: HTMLElement[] = [choices, el('div', '', s.open), pre, row, el('div', 'sub', t('helperRunWhole')), el('div', 'sub', s.manual)];
  if (!installed) {
    // The add-on can't see how Firefox was packaged, so every Linux user without a helper gets the line.
    if (platform && platform.os === 'linux') parts.push(el('div', 'sub', t('linuxSandbox')));
    parts.push(el('div', 'sub live', t('updatesItself')));
  }
  parts.forEach(function (x) { container.appendChild(x); });
  return s;
}

/* ------------------------------------------------------------ MCP config */

function mcpUrl(st: St): string {
  if (st && st.url) return st.url;
  var host = !st?.bind || st.bind === '0.0.0.0' || st.bind === '::' ? '127.0.0.1' : st.bind;
  if (host.indexOf(':') >= 0) host = '[' + host + ']'; // IPv6 literal
  return 'http://' + host + ':' + ((st && st.port) || 8901) + '/mcp';
}

/* `claude mcp add` refuses a name that already exists, so the first line drops any
 * old "firefox" entry (e.g. one holding a token from before a reinstall). User scope: works in every folder. */
function cliAdd(cli: string, url: string, auth: string, shell: string, replace: boolean): string {
  var quiet = shell === 'powershell' ? ' 2>$null' : ' 2>/dev/null';
  if (cli === 'claude') {
    return (replace ? 'claude mcp remove -s user firefox' + quiet + '\n' : '') +
      'claude mcp add -s user -t http firefox "' + url + '" -H "Authorization: ' + auth + '"';
  }
  return cli + ' mcp remove --scope user firefox' + quiet + '\n' +
    cli + ' mcp add --scope user --transport http firefox "' + url + '" --header "Authorization: ' + auth + '"';
}

var HARNESSES: string[] = ['claude', 'codex', 'antigravity', 'opencode', 'claude-app', 'json'];
var SHELL_HARNESSES: { [harness: string]: string } = { claude: 'claude' };

/* Where the AI runs: 'local' (this computer) or 'wsl' (Linux under WSL, Firefox on Windows). */
function canWsl(st: St): boolean { return !!(st && st.platform && st.platform.os === 'win'); }

/* The MCP URL as seen from where the AI runs. inShell: may use shell substitution. */
function urlFrom(st: St, where: string | undefined, inShell: boolean): string {
  if (where !== 'wsl' || !canWsl(st)) return mcpUrl(st);
  var port = (st && st.port) || 8901;
  // WSL's default gateway is Windows' WSL adapter, which the helper listens on when "Allow WSL" is on.
  // A command looks it up when it runs (it changes when Windows restarts); a config file gets today's address.
  if (inShell) return 'http://$(ip route show default | awk \'{print $3}\'):' + port + '/mcp';
  var addr = (st!.host && st!.host.wslAddress) || 'WINDOWS-IP';
  return 'http://' + addr + ':' + port + '/mcp';
}

/* Config snippet for a harness. harness: one of HARNESSES ('wsl' = old name for Claude Code in WSL). */
function mcpConfig(st: St, harness: string, where?: string, replace = true): string {
  if (harness === 'wsl') { harness = 'claude'; where = 'wsl'; }
  if (HARNESSES.indexOf(harness) < 0) harness = 'json';
  if (harness === 'claude-app') where = 'local'; // the Claude app runs on the computer itself
  var wsl = where === 'wsl' && canWsl(st);
  var auth = 'Bearer ' + ((st && st.token) || '');
  var cli = SHELL_HARNESSES[harness];
  if (cli) return cliAdd(cli, urlFrom(st, where, true), auth, !wsl && st && st.platform && st.platform.os === 'win' ? 'powershell' : 'sh', replace);
  var url = urlFrom(st, where, false);
  if (harness === 'codex') {
    return '[mcp_servers.firefox]\nurl = ' + JSON.stringify(url) + '\nhttp_headers = { Authorization = ' + JSON.stringify(auth) + ' }';
  }
  if (harness === 'claude-app') {
    // The Claude app only launches local servers, so mcp-remote bridges it to the HTTP endpoint.
    return JSON.stringify({ mcpServers: { firefox: {
      command: 'npx', args: ['-y', 'mcp-remote', url, '--header', 'Authorization:${AUTH}'], env: { AUTH: auth }
    } } }, null, 2);
  }
  if (harness === 'antigravity') {
    return JSON.stringify({ mcpServers: { firefox: { serverUrl: url, headers: { Authorization: auth } } } }, null, 2);
  }
  if (harness === 'opencode') {
    return JSON.stringify({ mcp: { servers: { firefox: { type: 'remote', url: url, oauth: false, headers: { Authorization: auth } } } } }, null, 2);
  }
  return JSON.stringify({ mcpServers: { firefox: { type: 'http', url: url, headers: { Authorization: auth } } } }, null, 2);
}

/* Copy a handoff, not a blind install command. The agent must identify its own
 * client and tell the user when local access or permissions are missing. */
function setupPrompt(st: St, harness: string, where?: string): string {
  var app = ({ claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity', opencode: 'OpenCode', 'claude-app': 'Claude Desktop' } as Record<string, string>)[harness] || 'Other';
  var machine = hostSetup(st?.platform);
  var wsl = where === 'wsl' && canWsl(st) && harness !== 'claude-app';
  var local = { ...st, token: 'YOUR_FOXHAND_TOKEN' };
  var endpoint = urlFrom(local, wsl ? 'wsl' : 'local', false);
  return [
    'Help me connect this AI client to Foxhand, the Firefox add-on at https://foxhand.pages.dev/. Reply in my language.',
    '',
    'My Foxhand setup:',
    '- Firefox runs on ' + machine.os + '. Selected AI: ' + app + '. AI location: ' + (wsl ? 'WSL' : 'same computer as Firefox') + '.',
    '- Firefox helper: ' + (st?.listening ? 'Ready' : 'not ready yet') + '. MCP: ' + endpoint + ' (Streamable HTTP with a Bearer token, not OAuth).',
    wsl ? '- Enable WSL access in Foxhand Settings. If the config says WINDOWS-IP, get the current Windows address from Foxhand Settings before connecting.' : '',
    '- The token is intentionally omitted. Show me where to enter the token from Foxhand Settings locally. Do not ask me to paste it into chat.',
    '',
    'First, identify the actual AI client and check whether you have shell and file access on the computer running Firefox. If you are in hosted chat or an unrelated remote shell, do not install there; give me local steps instead.',
    'If the helper is not ready:',
    'Check which helper and package managers are already installed on the system running Firefox (not inside WSL if Firefox runs on Windows). Reuse an installed helper if compatible. With my confirmation, run it with the install subcommand (for example foxhand-helper install or foxhand-helper.cmd install for npm on Windows). This tells Firefox where to find it; do not download it again just for this step.',
    'Otherwise, pick one supported path: Homebrew if it is already available, npm if Node.js 22+ and npm are available, or the official script. Tell me which path you picked and ask before downloading or running an installer. If you use the script, fetch and review it before executing it. Don’t use admin rights or change security settings. If you cannot run it here, give me the exact local command.',
    ...installMethods(st?.platform, machine).map(function (method) { return '- ' + method.name + ': ' + method.cmd; }),
    'For a manual binary download use ' + DOWNLOAD + machine.file + ' and verify it against ' + DOWNLOAD + 'SHA256SUMS. Downloading alone is not enough: run the helper’s install command to tell Firefox where to find it.',
    'Keep Firefox open and check for Ready in the Foxhand popup (ask me to check if you cannot see it). If it does not pick up the helper, click Retry or reopen Firefox. Do not assume the helper is ready just because the installer finished.',
    '',
    'Suggested config or command for the selected AI. Use it only if it matches the client you are actually in:',
    mcpConfig(local, harness, wsl ? 'wsl' : 'local', false),
    '',
    'Once the helper is ready, use the actual client’s supported MCP setup. Preserve unrelated settings. Ask before replacing an existing server or launching an installer. Do not replace a working credential with the placeholder, write it into a tracked project file, or try to bypass any restriction. If you cannot safely update the config, give me manual steps.',
    'For Claude Desktop in particular, if you are not allowed to change your own config, do not try to bypass it. Tell me to open Claude Settings → Developer → Edit Config, merge the firefox entry into mcpServers, save claude_desktop_config.json, and fully quit and reopen Claude. This config uses Node.js and mcp-remote.',
    'When the config and token are in place, verify that the client lists Foxhand tools and call extension_status. Otherwise explain which step is blocked and what I should do next. Do not claim the connection works unless you verified it.'
  ].join('\n');
}

/* What to do with the snippet. */
function configHint(st: St, harness: string, where?: string): string {
  if (harness === 'claude-app') return t('hintClaudeApp');
  var wsl = where === 'wsl' && canWsl(st);
  var win = !!(st && st.platform && st.platform.os === 'win');
  var name = ({ claude: 'Claude Code' } as { [harness: string]: string })[harness];
  var h = name ? t('hintRunIn', [wsl ? t('termWsl') : win ? t('termPowerShell') : t('termTerminal'), name])
    : harness === 'codex' ? t(wsl ? 'hintCodexWsl' : 'hintCodex')
    : harness === 'antigravity' ? t(wsl ? 'hintAntigravityWsl' : 'hintAntigravity')
    : harness === 'opencode' ? t(wsl ? 'hintOpencodeWsl' : 'hintOpencode')
    : t(wsl ? 'hintOtherWsl' : 'hintOther');
  if (wsl && !name) {
    h += ' ' + ((st!.host && st!.host.wslAddress) ? t('wslAddrChanges') : t('wslReplaceIp', 'ip route show default | awk \'{print $3}\''));
  }
  return h;
}

function copy(text: string, btn?: HTMLElement | null): Promise<void> {
  var write = navigator.clipboard && navigator.clipboard.writeText
    ? navigator.clipboard.writeText(text)
    : Promise.reject(new Error('no clipboard'));
  return write.catch(function () {
    // Fallback for when the async clipboard is unavailable.
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    if (!ok) throw new Error(t('copyFailed'));
  }).then(function () {
    if (!btn) return;
    var old = btn.textContent;
    btn.textContent = t('copied');
    btn.classList.add('copied');
    setTimeout(function () { btn.textContent = old; btn.classList.remove('copied'); }, 1200);
  });
}

/* What the install section should say, or null when nothing needs installing. */
function setupNeed(st: St): { title: string; intro: string; soft?: boolean } | null {
  st = st || {};
  var c: { state?: string; helper?: string; addon?: string } = st.compat || {};
  if (st.hostMissing) return { title: t('needInstall'), intro: '' };
  if (c.state === 'helper-old') return { title: t('needUpdate'), intro: t('needUpdateIntro', [c.helper, c.addon]) };
  if (c.state === 'helper-update') return { title: t('softUpdate'), intro: t('softUpdateIntro', [c.helper, c.addon]), soft: true };
  // Installed but it won't start or keeps stopping (lastError is empty while it restarts for an update).
  if (!st.listening && !st.starting && !st.connected && st.lastError && c.state !== 'addon-old') return { title: t('needReinstall'), intro: '' };
  return null;
}

/* One status line for the dot + headline. */
function summarize(st: St): { cls: string; text: string } {
  st = st || {};
  var c = (st.compat && st.compat.state) || '';
  if (st.listening && st.paused) return { cls: 'paused', text: t('stPaused') };
  if (st.listening) return { cls: 'on', text: c === 'helper-update' ? t('stReadyUpdate') : t('stReady') };
  if (st.hostMissing) return { cls: 'warn', text: t('stNoHelper') };
  if (c === 'helper-old') return { cls: 'warn', text: t('stHelperOld') };
  if (c === 'addon-old') return { cls: 'warn', text: t('stAddonOld') };
  if (st.starting) return { cls: 'wait', text: t('stStarting') };
  if (st.connected && st.host && st.host.error) return { cls: 'off', text: t('stPortProblem') };
  if (st.connected) return { cls: 'wait', text: t('stStartingMcp') };
  return { cls: 'off', text: t('stNotRunning') };
}

/* One sentence under the status headline: what it means and what to do next. */
function hint(st: St): string {
  st = st || {};
  var c = (st.compat && st.compat.state) || '';
  if (st.listening && st.paused) return t('hintPaused');
  if (st.listening) {
    if (c === 'helper-update') return t('hintReadyUpdate');
    return (st.commands || 0) > 0 ? t('hintReady') : t('hintReadyIdle');
  }
  if (st.hostMissing) return t('hintNoHelper');
  if (c === 'helper-old') return t('hintHelperOld');
  if (c === 'addon-old') return t('hintAddonOld');
  if (st.starting) return t('hintStarting');
  if (st.connected && st.host && st.host.error) return t('hintPort');
  if (st.connected) return t('hintStarting');
  return t('hintNotRunning');
}

/* ------------------------------------------------------------ report a problem */

/* Keep the token, ports, addresses and home folders out of text that goes into a public issue. */
function scrub(text: string): string {
  return String(text || '')
    .replace(/Bearer\s+\S+/gi, 'Bearer …')
    .replace(/\b[0-9a-f]{24,}\b/gi, '…')
    .replace(/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1?\]?|\b\d{1,3}(?:\.\d{1,3}){3}):\d{2,5}/gi, '$1')
    .replace(/\bport\s*:?\s*\d{2,5}\b/gi, 'port')
    .replace(/(?:[A-Za-z]:\\Users\\|\/Users\/|\/home\/)[^\\/\s]+/g, '~')
    .replace(/\s+/g, ' ').trim().slice(0, 400);
}

/* A pre-filled GitHub issue: versions, system and the error text on screen. Nothing about browsing. */
function reportUrl(st: St, shown: string): string {
  st = st || {};
  var osn = st.platform && st.platform.os ? ({ win: 'Windows', mac: 'macOS', linux: 'Linux' } as { [os: string]: string })[st.platform.os] || st.platform.os : 'unknown';
  var arch = st.platform && st.platform.arch ? ' ' + st.platform.arch : '';
  var what = scrub(shown);
  var body = '**What happened?**\n\n\n---\nAdd-on: ' + (st.version || 'unknown') + '\nHelper: ' + ((st.host && st.host.version) || 'unknown') +
    '\nOS: ' + osn + arch + '\nShown: ' + (what || 'nothing') + '\n';
  return 'https://foxhand.pages.dev/go/issue?from=addon&title=' + encodeURIComponent('Problem: ' + what.slice(0, 60)) + '&body=' + encodeURIComponent(body);
}

/* Show the link only while the page is showing an error state. */
function reportProblem(link: HTMLAnchorElement, st: St, shown?: string): void {
  var sum = summarize(st);
  var bad = sum.cls === 'warn' || sum.cls === 'off';
  if (link.hidden === bad) link.hidden = !bad;
  if (!bad) return;
  var href = reportUrl(st, [sum.text, shown || ''].filter(Boolean).join(': '));
  if (link.getAttribute('href') !== href) link.setAttribute('href', href);
}

/* Last harness and place picked; the popup's Copy button and onboarding use them too. */
function pref(key: string, set: string | undefined, fallback: string, allowed: string[]): string {
  try {
    if (set) localStorage.setItem(key, set);
    var v = localStorage.getItem(key);
    return allowed.indexOf(v as string) >= 0 ? v as string : fallback;
  } catch (e) { return allowed.indexOf(set as string) >= 0 ? set as string : fallback; }
}
function migrateKind(): void {
  try {
    if (localStorage.getItem('fxmcp.kind') === 'wsl') {
      localStorage.setItem('fxmcp.kind', 'claude');
      localStorage.setItem('fxmcp.where', 'wsl');
    }
    // Gemini CLI is gone; its users are on Antigravity now.
    if (localStorage.getItem('fxmcp.kind') === 'gemini') localStorage.setItem('fxmcp.kind', 'antigravity');
  } catch (e) {}
}
function configKind(set?: string): string { migrateKind(); return pref('fxmcp.kind', set, 'json', HARNESSES); }
function configWhere(set?: string): string { migrateKind(); return pref('fxmcp.where', set, 'local', ['local', 'wsl']); }

/* The pause shortcut as the user set it (about:addons can change it), e.g. "Ctrl+Shift+.". */
function pauseShortcut(): Promise<string> {
  return Promise.resolve(B.commands && B.commands.getAll ? B.commands.getAll() : [])
    .then(function (cmds) {
      var c = ((cmds || []) as browser.commands.Command[]).filter(function (x) { return x.name === 'toggle-pause'; })[0];
      if (!c || !c.shortcut) return '';
      var k = c.shortcut.replace(/Period$/, '.');
      // On macOS Firefox maps Ctrl to Command: show the keys as a Mac shows them.
      if (/Mac/i.test(navigator.platform || '')) {
        k = k.replace(/MacCtrl\+/g, '⌃').replace(/Ctrl\+|Command\+/g, '⌘').replace(/Shift\+/g, '⇧').replace(/Alt\+/g, '⌥');
      }
      return k;
    })
    .catch(function () { return ''; });
}

window.FxMcp = {
  t: t, localize: localize, ago: ago,
  hostSetup: hostSetup, renderSetup: renderSetup, setupNeed: setupNeed, mcpUrl: mcpUrl,
  mcpConfig: mcpConfig, setupPrompt: setupPrompt, configHint: configHint, configKind: configKind, configWhere: configWhere, canWsl: canWsl,
  copy: copy, summarize: summarize, hint: hint, pauseShortcut: pauseShortcut, reportProblem: reportProblem, HARNESSES: HARNESSES
};
})();
