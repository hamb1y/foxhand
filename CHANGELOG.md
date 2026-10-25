# Changelog

## 0.5.0

WebMCP Controller is now **Foxhand**. [WebMCP](https://webmachinelearning.github.io/webmcp/)
is the name of a proposed standard for websites to give agents their own tools,
and this add-on is a different thing.

### Upgrading

- The add-on updates in place from addons.mozilla.org. Your settings and token stay.
- Run the install command once more to get the renamed helper:
  - macOS and Linux: `curl -fsSL https://hamb1y.github.io/foxhand/sh | sh`
  - Windows (PowerShell): `irm https://hamb1y.github.io/foxhand/ps | iex`

  The running WebMCP Controller helper hands over to `foxhand-host` without a
  Firefox restart, and the old `webmcp-controller` folder is removed shortly after.
- Your AI's MCP config keeps working. Copying it again gives you the shorter
  `http://localhost:8901/mcp` URL.
- No new permissions. The wire protocol is unchanged, so a 0.4 add-on and a
  0.5 helper (or the reverse) still work together.

### Fixed

- **Page dialogs no longer hang actions.** A click that made the page show
  `alert()`, `confirm()` or `prompt()` waited 30 seconds, failed, and left the
  dialog up. While the AI acts, alerts are now acknowledged and confirms and
  prompts are cancelled. The result lists what the page asked. To answer OK,
  repeat the action with `dialog: "accept"` (and `promptText` for a prompt).
- **Links that open a tab say which tab.** `act_click` returns `openedTabs`
  for `target="_blank"` links and `window.open`.
- **Pages that render late are read in full.** `snapshot_ax`, `page_text` and
  `act_find` wait up to 1.5 seconds for the page to stop changing. Before,
  content drawn just after load was missing, such as GitHub's file list.
- **Iframes are visible.** Same-origin iframes are in snapshots and can be
  clicked and typed into. Cross-origin iframes are listed with a note.
- **URLs without `https://` work.** `tab_create`, `tab_navigate` and
  `window_create` with `github.com` opened a broken add-on page. They now add
  `https://` (`http://` for `localhost`, IP addresses and `.local`/`.test`
  hosts).
- **Sleeping tabs work.** Page tools on a tab Firefox had unloaded failed with
  "restricted page?". The tab is loaded first.
- **`history_search` searches all of history.** It only covered the last 24
  hours unless you passed `startTime`.
- **PDF tabs give a useful error.** They say the page is in Firefox's PDF
  viewer and suggest `screenshot`.
- **`tab_close` takes one tab.** Pass `tabId`, `tabIds`, or neither for the
  active tab.
- Snapshots mark elements disabled by an `aria-disabled` ancestor.

### New

- **Setup page.** It opens on install (and on the update from WebMCP
  Controller) and walks through three steps: install the helper, connect your
  AI, try it. Each step ticks itself off when it works.
- **Shorter install commands**, served from
  [hamb1y.github.io/foxhand](https://hamb1y.github.io/foxhand/). The old
  `releases/latest/download/install.*` links keep working.
- **`localhost` in configs.** The helper listens on both `127.0.0.1` and
  `[::1]`, so `localhost` connects whichever address a client tries first.
- **Five languages.** English, Spanish, French, German and Simplified
  Chinese, following Firefox's language. Messages meant for the AI stay in
  English.
- **Firefox orange.** The add-on's accent color is now Firefox orange instead
  of lime: buttons, the toolbar icon and badge, and the AI cursor's bubble and
  click ripple.
- **"Formerly WebMCP Controller"** shows under the name in the toolbar popup,
  so the renamed add-on is easy to recognize.

### macOS

- Apple silicon only runs signed code. The helper carries an ad-hoc
  signature, and the installer re-signs it if that signature doesn't verify.
  The installer never triggers a Gatekeeper prompt.

### Tested

Every release now installs the helper with the one-line installers on real
machines (Linux x64 and ARM, macOS Apple silicon and Intel, Windows x64 and
ARM), then drives real Firefox through all 44 tools over MCP. A release is
only published when all six pass.

## Earlier versions

See the [GitHub releases](https://github.com/hamb1y/foxhand/releases) for
0.4.0 and before.
