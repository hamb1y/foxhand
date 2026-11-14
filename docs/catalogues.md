# Catalogue listings

Where Foxhand is (or can be) listed besides AMO, GitHub, the site, Glama and
mcpservers.org, what each catalogue reads from this repo, and what the owner
has to do by hand. Checked against each catalogue's docs on 2026-11-14.

Every client needs the same two things from the user: the helper address
(`http://localhost:8901/mcp` by default) and the token from the add-on. No
catalogue file contains a token.

## Gemini CLI extension gallery

- Files: `gemini-extension.json` and `GEMINI.md` at the repo root.
- The manifest declares the `firefox` MCP server and one sensitive setting,
  `FOXHAND_TOKEN`, which Gemini CLI asks for at install and keeps in the
  system keychain.
- `scripts/set-version.mjs` keeps its `version` equal to the release tag, as
  the gallery docs ask.
- Checked with `gemini extensions validate .` (passes). Not yet installed
  end to end, because the gallery and `gemini extensions install` read the
  default branch.
- Install, once this is on `main`:
  `gemini extensions install https://github.com/hamb1y/foxhand`
- By hand: add the `gemini-cli-extension` topic to the repo's About section.
  The crawler runs daily. If the listing hasn't appeared after 48 hours:
  `gh api 'search/code?q=repo:hamb1y/foxhand+filename:gemini-extension.json' --jq .total_count`
  (0 means GitHub Code Search hasn't indexed the file yet).

## Claude plugin directory

- Files: `claude-plugin/` (`.claude-plugin/plugin.json`, `.claude-plugin/icon.png`,
  `.mcp.json`, `README.md`).
- The plugin asks for two values through `userConfig`: the token (sensitive)
  and the helper address (default `http://localhost:8901/mcp`). `.mcp.json`
  refers to both as `${user_config.*}`.
- Checked with `claude plugin validate ./claude-plugin --strict` (passes, no
  directory warnings).
- Known risk: the directory blocks a remote MCP `url` that is a literal
  non-https address. Ours is a `${user_config.KEY}` reference, which the
  checklist allows, but the default value is an `http://localhost` address, so
  a reviewer may still hold it. If they do, the fallback is a small stdio
  bridge inside the plugin (see docs/install-npx-proposal.md).
- The icon is `extension/icons/icon.svg` rendered at 512 px. The directory
  takes the listing icon only once, at first save or submit.
- By hand: submit at https://claude.ai/directory/manage → Submit new →
  Plugin bundle → repository `hamb1y/foxhand`, plugin path `claude-plugin`.
  The portal's Validate step runs more checks than the local command.

## Official MCP Registry

Not publishable yet. Needs the owner's OK on a new package first.

- A `remotes` entry is out: the registry requires a remote to be publicly
  reachable, and Foxhand only listens on localhost.
- A `packages` entry must name a package of a supported type: npm, PyPI,
  NuGet, Cargo, OCI, or an MCPB bundle on GitHub/GitLab Releases. A bare
  release binary is none of these.
- The helper is also started by Firefox, not by the MCP client, so whatever
  the registry points at has to be something a client can launch itself.
- Smallest fit: the npm package proposed in docs/install-npx-proposal.md,
  which a client runs as `npx -y foxhand mcp` and which relays stdio to the
  helper. The `server.json` would then be:

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "io.github.hamb1y/foxhand",
  "title": "Foxhand",
  "description": "Let an AI agent drive the Firefox you already use: your profile, open tabs and logins.",
  "repository": { "url": "https://github.com/hamb1y/foxhand", "source": "github" },
  "websiteUrl": "https://foxhand.pages.dev/",
  "version": "X.Y.Z",
  "packages": [
    {
      "registryType": "npm",
      "identifier": "foxhand",
      "version": "X.Y.Z",
      "runtimeHint": "npx",
      "packageArguments": [{ "type": "positional", "value": "mcp" }],
      "transport": { "type": "stdio" }
    }
  ]
}
```

- The npm package's `package.json` needs `"mcpName": "io.github.hamb1y/foxhand"`
  (the registry's ownership check). The npm name `foxhand` was free on
  2026-11-14.
- The alternative without npm is an `.mcpb` bundle attached to each GitHub
  release, with `fileSha256` in `server.json`. It carries the same bridge
  code, so it is not less work, and fewer clients install MCPB.
- By hand, after the package exists: `mcp-publisher login github`, then
  `mcp-publisher publish`. The `io.github.hamb1y/` namespace is granted by
  the GitHub login.

## awesome-mcp-servers (punkpeye)

Draft only. The owner opens the PR.

- Section: **Browser Automation**. Alphabetical by `owner/repo`, so the line
  goes after `hahahahahahahahah6/browser-buddy` and before `hanzili/comet-mcp`.
- Entry line:

```markdown
- [hamb1y/foxhand](https://github.com/hamb1y/foxhand) [![hamb1y/foxhand MCP server](https://glama.ai/mcp/servers/hamb1y/foxhand/badges/score.svg)](https://glama.ai/mcp/servers/hamb1y/foxhand) 📇 🏠 🍎 🪟 🐧 - Firefox add-on plus a local helper that lets any MCP client drive the Firefox you already use: your profile, open tabs and logins. Shows an on-page AI cursor, can be paused from the toolbar, and serves MCP on localhost behind a bearer token.
```

- PR title: `Add hamb1y/foxhand (Browser Automation)`
- PR body:

```markdown
Adds Foxhand to Browser Automation, in alphabetical order.

- Repo: https://github.com/hamb1y/foxhand (MPL-2.0, TypeScript)
- What it is: a Firefox add-on and a native helper. The helper serves MCP
  over Streamable HTTP on localhost, so an agent works in the user's own
  Firefox profile instead of a separate headless browser.
- Local only (🏠), runs on macOS, Windows and Linux.
- Glama listing: https://glama.ai/mcp/servers/hamb1y/foxhand

I am the author.
```

- CONTRIBUTING.md asks for one server per line, the existing format, and
  alphabetical order. It also offers a fast track for PRs opened by automated
  agents (a marker in the title). That doesn't apply to a PR the owner opens.
