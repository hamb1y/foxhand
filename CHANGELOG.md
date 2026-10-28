# Changelog

## 0.5.5

Small release, all of it about clicking the right thing and then saying so
when it can't.

### Sending a message

- **A field's own Send button is the one that gets clicked.** The search for
  it stops at the next landmark, so a form can no longer pick up "Send
  feedback" in a footer or a Search button further up the page, and a button
  has to come after the field it belongs to. "Post" and "Reply" count as
  send buttons; "Submit query" and "Subscribe" no longer do.

### Stale refs

- **Acting on an element that was removed says so.** Instead of re-finding
  whatever now has the same role and name and clicking that, the tool fails
  with "ref N was removed from the page. Take a new page_snapshot before
  acting on it again." Both have regression tests now.

### Everything else

- Install links in the README and on the website use the `foxhand` address
  the add-on now lives at.
- Dependencies updated (`zod` 4.6.7, MCP SDK 1.32.2, `express` 5.3.0);
  nothing the helper ships has a known vulnerability.

## 0.5.4

The tools are reworked so agents can read and act on real pages on the first
try, without working around them. Every change below was checked on live
sites (Spiegel, GitHub, YouTube, Wikipedia, TodoMVC, react-select, MUI,
Lexical, ProseMirror, Slate, CKEditor) as well as in the tests. The names now
follow one pattern, `<thing>_<verb>`. **Agents and prompts that call tools by
their old names need updating.**

### Buttons the snapshot used to miss

- **Buttons built from plain elements.** A `<div>` the page made clickable
  with script shows as role `clickable`, from a pointer cursor, a click
  attribute, Google's `jsaction`, or a React or Vue click handler.
- **Icon-only buttons have names**, from their tooltip, SVG title, the icon's
  own name (`fa-trash` becomes "icon: trash"), a test id or a class.
- **Closed shadow roots** are read and acted on, not only open ones.
- **Controls that only show on hover**, like the ✕ on a to-do item, are listed
  (marked `[on hover]`) and can be clicked, although an add-on can't produce
  CSS `:hover`.
- **Styled checkboxes and radios** (a hidden input under a styled label) show
  as the checkbox, with its state.
- **Unlabeled fields** are named by the text beside them or, for a custom
  dropdown, the value it shows.

### iframes from other sites

- **Cookie banners, sign-in buttons, payment fields and embeds in cross-origin
  iframes** are part of the snapshot. Their refs work like any other; a name or
  selector that isn't on the page is looked for in its frames; a click at a
  point over a frame lands inside it. `page_text` and `page_find` include their
  text.
- **A consent dialog that closes itself after "Accept"** is reported as done,
  not as a failure the agent would retry.

### Snapshots with a shape

- **Controls are nested under what they belong to**: the landmark, dialog,
  form, list item, table row or card. The agent can tell which "Delete" goes
  with which row. Lines that add nothing are folded away.
- **An open modal, or an overlay covering the screen, is listed first** and
  flagged in the header, so a long page can't push it out of the snapshot.
- **Repeated buttons say which card they're in**: each "Add to cart" on a shop
  page is labeled with its product, each "More actions" with its video, even
  when the cards are plain `<div>`s.

### Typing like a person

- **Every character is a key press**: keydown, keypress, beforeinput, the edit,
  input and keyup. Autocomplete boxes open, input masks (phone numbers, cards)
  format, and one-box-per-digit code fields follow the focus the page moves.
- **Rich editors keep the text**: Lexical, Slate, ProseMirror, CKEditor and
  editors in same-origin frames. If an editor rejects the text, the result says
  so instead of forcing text in and corrupting it.
- **Clicks land on the element under the pointer**, such as the icon inside a
  button, which is often where the page listens.
- **Submitting a form presses its real submit button.** A "Cancel" or "Back"
  button placed first in the form is skipped (before, a checkout form could be
  cancelled instead of continued).

### Renamed and merged

| Before | Now |
|---|---|
| `tabs_list`, `tabs_query` | `tab_query` (`query: "*"` lists every tab) |
| `active_tab` | `tab_check_active` |
| `nav_back`, `nav_forward`, `nav_reload` | `tab_navigate` with `go: "back"`, `"forward"` or `"reload"` |
| `tab_duplicate` | `tab_create` with `duplicateOf` |
| `tab_pin`, `tab_unpin` | `tab_pin` with `pinned: false` to unpin |
| `focus_tab` | `tab_focus` |
| `window_list` | `window_query` |
| `snapshot_ax` | `page_snapshot` |
| `screenshot` | `page_screenshot` |
| `act_click`, `act_type`, `act_select`, `act_hover`, `act_scroll`, `act_key`, `act_wait` | `page_click`, `page_type`, `page_select`, `page_hover`, `page_scroll`, `page_key`, `page_wait` |
| `act_fill_form` | `page_fill` |
| `act_find` | `page_find` |
| `bookmarks_search`, `bookmarks_create`, `bookmarks_remove` | `bookmark_query`, `bookmark_create`, `bookmark_remove` |
| `history_search` | `history_query` |
| `downloads_list` | `download_query` |
| `cookies_for_tab` | `cookie_query` |
| `sessions_recently_closed`, `sessions_restore` | `session_query`, `session_restore` |
| `wait_for_tab_event` | `event_wait` |
| `cursor_note` | `thought` |

`tab_move` is removed. The `thought` argument on every tool is gone too: the
`thought` tool shows a note, and it stays on the next page action within
30 seconds. Otherwise the cursor describes each action itself.

### Acting on pages

- **Find elements by what they say.** Every page tool takes `name` (visible
  text or label), with optional `role` and `nth`, as well as `ref` and
  `selector`. When several elements match, the error lists them.
- **Refs last longer.** A ref keeps pointing at its element until the page
  navigates, so one snapshot serves several actions.
- **Results say what changed.** Every action reports the elements that
  appeared, text that appeared or went away (an error under a field, "Added to
  cart"), what opened, closed, got checked or selected, new alert and status
  messages, and the new URL or title. The agent rarely needs a new snapshot
  after each step. After typing into a search box it waits briefly for the
  suggestions.
- **A name that isn't found lists the closest ones**, including common
  synonyms ("Sign in" finds "Log in"). The name written exactly as given wins
  over looser matches.
- **Clicks at a point.** `page_click` takes `x`,`y`, for maps, editors and games
  drawn on a canvas.
- **`page_type` finds fields by label or placeholder** and handles rich editors,
  checkboxes and selects.
- **`page_select` opens custom dropdowns** (comboboxes and listboxes) as well as
  `<select>`.
- **`page_key` performs the default action** when the page doesn't: Tab moves
  focus, Enter submits, and text keys edit.
- **`page_scroll` finds the inner scroller** of chat apps and can scroll an
  element into view.
- **`page_wait` waits for things to go** (`gone: true`, for spinners), for the
  page to settle, or for the address to change (`urlContains`, after a login
  or checkout redirect).
- **Pages that never finish loading** (long-polling, endless trackers) no
  longer cost the full wait: `tab_create` and `tab_navigate` return once the
  new page is up, with `ready: true`.
- **Modifier keys in any spelling**: `ctrl`, `Control`, `cmd`, `Option`.
- **New: `page_drag`** for sortable lists, sliders and map panning, and
  **`page_upload`** to attach files the agent supplies.

### Reading pages

- **`page_text` comes in chunks.** Long pages no longer flood the agent's
  context: follow `nextOffset` for more. `within` reads one region.
- **`page_text` with `format: "markdown"`** keeps headings, lists, tables,
  emphasis and link URLs, and shows form fields.
- **`page_snapshot` can read one region** (`within`) or only what's on screen
  (`viewportOnly`), and includes shadow DOM.
- **`page_screenshot` captures one element or the whole page**, as PNG or
  smaller JPEG, at any scale.
- **`page_find` returns the ref to click** for each match and whether it's off
  screen, and finds phrases split across elements ("Add to **cart**").

### Browser data

- **`download_query` says where files landed**: path on disk, size, progress,
  whether the file still exists and why a download failed.
- **New: `download_start`** downloads a URL with the browser's cookies and
  returns the path.
- **Cookies can be written.** New `cookie_set` and `cookie_remove` (needs
  `confirm:true`).
- **New: a notebook for the agent.** `storage_get`, `storage_set` and
  `storage_remove` keep JSON values in the add-on across pages and restarts.
  With `area: "local"` or `"session"` they read and write the page's own
  storage.

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
