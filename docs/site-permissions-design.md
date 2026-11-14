# Design: sharing only some sites or tabs with the AI

Status: design, not implemented. Needs the owner's OK before any code.

## What exists today (0.5.9)

There is no per-site or per-tab scoping. Checked in `extension/background.js`
and `mcp-server/src/tools/`:

- `resolveTab` returns any tab by id, or the active tab.
- `tabs.list`, `tabs.query`, `windows.list` and `active.tab` return every tab
  with its URL and title.
- `tab.updated`, `tab.activated` and `tab.removed` events are sent for every
  tab.
- History, bookmarks, downloads, cookies and recently closed tabs are not
  filtered by site.

The controls that do exist are all-or-nothing:

- the bearer token and the localhost-only bind,
- Pause (toolbar button or Ctrl+Shift+.), which refuses every command,
- `confirm:true` for destructive tools,
- pages Firefox itself forbids (`about:`, addons.mozilla.org, the PDF viewer),
- private windows, which Firefox keeps from the add-on unless the user ticks
  "Run in Private Windows".

So the objection from Reddit is accurate: once connected, an agent can see
every open tab.

## Goal

A tab the user hasn't shared does not exist as far as the agent can tell. It
is absent from listings, events and read results, not merely refused when
the agent tries to act on it.

## Model

One setting, `shareMode`:

- `all`: today's behaviour. Every tab is shared.
- `approved`: only shared sites and shared tabs are visible.

Three lists, all kept in the add-on's local storage:

- **Shared sites**: host patterns, exact (`github.com`) or with subdomains
  (`*.github.com`). Used in `approved` mode.
- **Shared tabs**: tab ids the user shared one by one. Kept in memory only,
  and dropped when the tab closes or Firefox restarts. A shared tab stays
  shared when it navigates, because the user pointed at that tab.
- **Never share**: host patterns that are hidden in both modes (a bank, a
  mail client). This gives current users something useful without changing
  their default.

A tab is visible when it is not on the never list and either the mode is
`all`, its id is a shared tab, or its host matches a shared site.

### Default

- **Existing installs keep `all`.** The update changes nothing for them. A
  one-time note in the popup says site sharing exists and where to turn it on.
- **New installs choose on the setup page**, between "Only sites I share"
  and "All my tabs". I recommend preselecting "Only sites I share", since it
  is the answer to the main objection and what the rival leads with. The
  cost is one more decision during setup; the owner should pick.

## Where it is enforced

In the add-on, in one predicate (`isShared(tab)`), so it holds for every MCP
client and for an old helper too. The helper needs no logic of its own.

| Place | Behaviour for a tab that isn't shared |
| - | - |
| `resolveTab` with an explicit id | `TAB_NOT_FOUND`, with the same message as for an id that never existed, so the agent can't probe for hidden tabs |
| `resolveTab` with no id (active tab) | New error `NOT_SHARED`: "The tab in front isn't shared with the AI. Ask the user to share it from the Foxhand toolbar button." No URL or title |
| `tabs.list`, `tabs.query`, `active.tab` | Left out |
| `windows.list` | `tabCount` counts shared tabs only; a window with none is left out |
| `tab.updated`, `tab.activated`, `tab.removed` events | Not sent |
| `sessions.recentlyClosed`, `sessions.restore` | Entries filtered by URL |
| `history.search`, `bookmarks.search`, `downloads.*` | In `approved` mode, only results whose URL matches a shared site; the never list always applies |
| `cookies.*` | Only for hosts that are shared |
| `page.shot` | Only of a shared tab; never a capture of the visible window when the front tab isn't shared |

### Navigation

- `tab.create` and `tab.navigate` to a host that isn't shared: refused with
  `NOT_SHARED`, naming the host (the agent supplied it, so nothing leaks).
  The popup shows the request with **Allow once**, **Always share this
  site** and **No**. "Allow once" shares that tab.
- A shared-site tab that navigates to a host that isn't shared (a link, a
  redirect) becomes hidden. The action that caused it returns "the tab left
  the shared sites", without the new URL.
- Tabs a page opens by itself follow the same rule by URL.

### Frames

A page's frames follow the page. If the user shared `example.com`, its
embedded cookie banner or payment frame is readable as today. Filtering
frames by their own host would break common pages and protects little,
because the user is already looking at that content on a page they chose
to share.

## What the user sees

- **Popup:** a line for the current tab, "Shared with the AI" or "Not
  shared", with **Share this site**, **Share this tab only** and **Never
  share this site**. Pending requests from the agent appear here.
- **Toolbar badge:** unchanged while acting; no new state.
- **Settings:** the mode, and the three lists with remove buttons.
- New strings go in `i18n/en.json`; the other four languages through the
  usual Haiku step.

## What the agent sees

- `hello` gains `shareMode`, so the helper can add one sentence to its MCP
  instructions: "Some tabs may not be shared with you. If you need one,
  ask the user to share it."
- `NOT_SHARED` is added to `BRIDGE_ERRORS` in `shared/src/protocol.ts`. An
  older helper passes an unknown code through as a message, so mixed
  versions still work; `test/e2e.mjs` should prove that.

## Tests

- `test/live.mjs`, in `approved` mode with one shared site:
  a hidden tab is absent from `tab_query`; reading it by id gives
  `TAB_NOT_FOUND`; no event arrives when it loads; navigating to an
  unshared host is refused; history results are filtered; "Share this tab
  only" survives a navigation and ends when the tab closes.
- The whole existing suite again in `all` mode with empty lists, to show
  nothing changed for current users.
- `test/options.mjs` for the lists and the mode switch.

## Limits to state plainly

- Sharing is per host, not per path.
- An agent on a shared page can still follow a link elsewhere; it loses
  sight of the tab when it does.
- A shared page can show content from other places (embeds, previews), and
  the agent can read what the page shows.
- This scopes what Foxhand hands to a connected client. It is not a
  sandbox for the client itself.

## Size of the change

- `extension/background.js`: the predicate, the handlers in the table, the
  event filter, pending requests.
- `extension/popup.*`, `options.*`, the setup page: the controls above.
- `shared/src/protocol.ts`, one line in the helper's instructions.
- `i18n/`: the new popup, settings and setup strings.
- No new manifest permission, no change to the add-on ID or host name.

## Decisions I need from the owner

1. Default for new installs: preselect "Only sites I share", or "All my tabs"?
2. Should "Share this tab only" survive navigation (as designed) or end when
   the tab leaves the site it was shared on?
3. Ship the never list in the same release, or first on its own as a small
   change?
