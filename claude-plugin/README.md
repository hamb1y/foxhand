# Foxhand for Claude

Foxhand lets Claude use the Firefox you already have open: your own profile, your tabs and your logged-in sessions. Claude can list and open tabs, read pages, click, type, and fill in forms, and you can watch it work and pause it from the toolbar.

This plugin only connects Claude to Foxhand. It adds one MCP server, `firefox`, that points at the Foxhand helper on your own computer. Nothing is sent to a remote server by the plugin.

## Before you install

The plugin needs two things on your machine:

1. The Foxhand add-on in Firefox: <https://addons.mozilla.org/firefox/addon/foxhand/>
2. The Foxhand helper. The add-on's setup page gives you a one-line install command. Details: <https://foxhand.pages.dev/>

Firefox starts the helper by itself. There is no server to run by hand.

## Setup

When you enable the plugin, Claude asks for two values:

- **Foxhand token**: in Firefox, click the Foxhand toolbar icon, open Settings and copy the token. It is stored in your system's secure storage.
- **Helper address**: leave the default, `http://localhost:8901/mcp`, unless you changed the port in the add-on.

Then ask Claude to do something in your browser, for example "list my open tabs".

## Troubleshooting

- **The server does not connect.** Check that Firefox is running and the add-on's popup says the helper is connected.
- **401 Unauthorized.** The token changed. Copy it again from the add-on and update the plugin's configuration.

## Source and license

Source code and issues: <https://github.com/hamb1y/foxhand>. Licensed under MPL-2.0.
