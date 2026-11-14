# Proposal: an `npx` install path for the helper

Status: proposal, no code written. Needs the owner's OK. Measured on 2026-11-14
against 0.5.9.

## The problem

Setup has two steps: install the add-on, then paste a one-liner that pipes a
script into a shell and downloads the helper. The helper binaries are 0.08 to
0.11 GiB each (86 to 111 MiB). Almost all of that is the Bun runtime that
`bun build --compile` embeds. The helper's own code, bundled into one
JavaScript file with `bun build --target=node --minify`, is 0.001 GiB
(1.03 MiB; 0.35 MiB gzipped), and that bundle runs under Node as is
(`--version` checked).

Many of the people Foxhand is for already have Node, because their coding
agent needed it.

## What I propose

Publish one small npm package, `foxhand` (the name was free on 2026-11-14),
that contains the single bundled file and has no dependencies and no install
scripts.

| Command | What it does |
| - | - |
| `npx -y foxhand install` | Copies the bundle into the normal install folder, writes a launcher that runs it with the user's Node, and registers it with Firefox. Same end state as the current installer. |
| `npx -y foxhand mcp` | A stdio-to-HTTP relay to the running helper, for clients that only speak stdio and for the official MCP Registry (see docs/catalogues.md). |
| `npx -y foxhand status` / `uninstall` | As today. |

The current installer stays the default. The site, README and the add-on's
setup page keep showing the `curl` / `irm` line first, and gain a second tab,
"Have Node?", with the `npx` line. Both paths write to the same folder and the
same Firefox registration, so a user can switch between them without cleanup.

## What it takes

1. **Bundle in the release.** One more build step and an `npm publish` job in
   `release.yml`, using npm trusted publishing (OIDC) so no npm token is
   stored. By hand, once: create the npm package and add the repo as its
   trusted publisher.
2. **Install from a script, not a binary.** `host.ts` already has a
   non-compiled install path, but it points the launcher at wherever the
   script happens to be. Under `npx` that is npm's cache, which npm may
   delete. The install must copy the bundle into the install folder first.
3. **A subcommand for the relay.** With no arguments and a piped stdin the
   helper assumes Firefox started it. The relay therefore needs its own word
   (`mcp`) and a small module that forwards stdio to `localhost:8901`.
4. **A way for the relay to find the token.** Today the token lives in the
   add-on and reaches the helper in memory. Either the user passes it
   (`FOXHAND_TOKEN`), or the helper writes the port and token to a file only
   the user can read, so the relay needs no setup at all. See trade-offs.
5. **Tests.** `test/host.mjs` gains an install-from-bundle case and a relay
   case; `test/live.mjs` runs once against the bundle.
6. **Docs and strings.** One new setup tab. Its strings go through the usual
   translation step.

Nothing here touches the add-on ID, the native host name or the legacy
`webmcp-host-*` assets.

## Trade-offs

| | Current installer (binary) | `npx` path |
| - | - | - |
| Download | 0.08 to 0.11 GiB | 0.001 GiB |
| Needs | `curl` or PowerShell | Node already installed |
| Trust step | Pipe a script into a shell | Run a package from npm |
| Integrity | SHA256SUMS checked by the script | npm's own checks plus a provenance attestation |
| Keeps working when | Always; the binary is self-contained | Only while the Node it was installed with still exists |
| Update | Re-run the one-liner | Re-run `npx -y foxhand@latest install` |

Risks that are specific to the `npx` path:

- **Node goes away.** A version manager (nvm, fnm, volta) can remove or move
  the Node the launcher points at. Firefox then can't start the helper, and
  Firefox started from the desktop does not see a shell's PATH, so a "try
  `node` on PATH" fallback only partly helps. The add-on already shows
  "Helper app not installed" in this state; the message would need to say
  "run the install command again".
- **A second channel to keep honest.** npm becomes another place a bad
  release could ship from. Trusted publishing and a package with no
  dependencies and no install scripts keep that surface small.
- **Token on disk** (only if we choose the zero-setup relay). Any program
  running as the same user could read it. Such a program can already read
  the add-on's stored settings in the Firefox profile, so this does not
  cross a new boundary, but it is a change and should be stated in the
  README's security section.
- **Two paths to support.** Bug reports now need "which install path?".
  `foxhand status` already prints "binary" or "node".

## Recommendation

Do it, with the binary installer still the default, and decide later
whether to swap the order once there are numbers on which path people pick
(docs/usage-stats-design.md). Build the relay in the same change: it is small,
and it is what unlocks the official MCP Registry listing and stdio-only
clients.

Decisions I need from the owner:

1. OK to publish an npm package named `foxhand`?
2. Relay token: environment variable only, or the zero-setup file?
