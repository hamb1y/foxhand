# Foxhand (formerly WebMCP Controller)

A Firefox add-on plus a native helper. The helper serves MCP on `localhost:8901`, so an AI agent can drive the user's real Firefox profile.
GitHub: `hamb1y/foxhand`. Site: https://hamb1y.github.io/foxhand/ (from `site/`).

## Layout

- `extension/`: the WebExtension (MV2, plain JS, no build step).
  - `background.js` holds every bridge method in `handlers[method](p, ctx)`.
  - `CAPABILITIES` lists the methods the add-on advertises in `hello`.
  - `LABELS` holds the activity-log labels.
  - `content/ax.js` is the content script that does the page work. It reads and acts on pages through `{kind: ...}` messages (`ax-snapshot`, `page-text`, `act-click`, ...).
  - `_locales/` is generated. Don't edit it by hand.
- `mcp-server/`: TypeScript (zod, `@modelcontextprotocol/sdk`). It runs as the native messaging host and as the HTTP MCP server.
  - `src/tools/*.ts` registers the MCP tools.
  - `src/tools/helpers.ts` has `callBridge`, `requireConfirm`, `text` and `refusal`.
  - `src/bridge/` is the native-messaging bridge plus the cursor "thought" state.
- `shared/`: `protocol.ts` (the `BridgeMethod` union and `BRIDGE_ERRORS`). `version.ts` is generated.
- `i18n/<locale>.json`: the source of every UI string (en, de, es, fr, zh_CN).
- `test/`: `e2e.mjs`, `host.mjs` (helper), `content.mjs` (ax.js in Playwright Firefox), `options.mjs`, `live.mjs` (real Firefox and add-on).
- `scripts/`: version, i18n, packing, release, AMO signing and installers.
- `site/`: the GitHub Pages site. `docs/`: AMO listing text and notes.

How a tool call flows: MCP tool, then `callBridge(bridge, "method", params)`, then native messaging (the host→extension limit is 1MB), then `handlers[method]` in background.js, then (for page work) `actOn`/`sendToTab`, then ax.js.

When you add a bridge method, add it to:

- `BridgeMethod` in `shared/src/protocol.ts`
- the handler and `CAPABILITIES` in background.js
- a `LABELS` entry
- the i18n `lbl*Now`/`lbl*Past` keys

The confirm guard for destructive tools lives on the MCP side (`requireConfirm`).

## Commands

```sh
npm ci
npm run build && npm run typecheck
node test/e2e.mjs && MISSING=1 node test/e2e.mjs && node test/host.mjs && node test/content.mjs && node test/options.mjs
node test/live.mjs                    # needs Firefox; CI runs it
npx -y web-ext@8 lint -s extension
node scripts/i18n.mjs                 # regenerate extension/_locales from i18n/
node scripts/i18n.mjs --check         # fails on missing/stale translations
node scripts/set-version.mjs X.Y.Z    # bump the version everywhere (--check verifies)
```

CI (`.github/workflows/ci.yml`) runs all of the above. Run it locally before you commit.

## Translations

- Add or change the English string in `i18n/en.json` yourself.
- The de/es/fr/zh_CN strings are written or reviewed by a **Haiku subagent** (Agent tool, `model: "haiku"`), not the main model. The user asked for this.
- Then run `node scripts/i18n.mjs && node scripts/i18n.mjs --check`.
- Keep the placeholders (`$1`) and match the neighbouring strings' tone (e.g. French activity labels are noun phrases).

## Releases

- One version for the add-on and the helper: `node scripts/set-version.mjs X.Y.Z`.
- Every version needs a `## X.Y.Z` section in CHANGELOG.md. `release.sh` uses it for the GitHub release, and `scripts/amo-notes.mjs` turns it into the AMO release notes.
- Merging to `main` with a version that has no GitHub release yet runs `.github/workflows/release.yml`. It:
  1. runs the CI checks,
  2. builds every helper binary,
  3. publishes the GitHub release (which creates the tag),
  4. submits the add-on to AMO (`scripts/amo-sign.sh`, `AMO_CHANNEL=listed`).
- The AMO secrets are already set as repo secrets (`gh secret set ... -R hamb1y/foxhand`). Never look for API keys locally.
- The AMO listing text (name, summaries, descriptions in every language, privacy policy) comes from `docs/amo-listing.md`. The "AMO listing" workflow (`gh workflow run amo-listing.yml -R hamb1y/foxhand`, needs the owner's OK) pushes it with `scripts/amo-listing.mjs`. `node scripts/amo-listing.mjs --dry-run` shows what it would send.

## Rules (the owner set these)

- **Never change** the add-on ID `webmcp-controller@hamb1y.github.io` or the native host name `webmcp_controller`. Keep publishing the legacy `webmcp-host-*` release assets.
- Never create a repo named `webmcp-controller`.
- Get explicit OK from the user before:
  - pushing a tag by hand,
  - deleting tags or releases,
  - editing the AMO listing.
- Never commit these untracked files: `audit-results.md`, `docs/debug-audit-2026-10-09.md`, `docs/launch.md`, `piss.md`, `foxhand.zip`, `webmcp-controller.zip`. Stage files by name, never with `git add -A`.
- Chain test and commit with `&&`, never `;`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- User-facing text says "localhost", never `127.0.0.1`.
- The only accent color is Firefox orange `#FF7139`.
- No AI slop and no fake content: no made-up screenshots, quotes, testimonials or numbers.
- Use `qw-root` instead of `sudo` on this machine.
- Don't add JS eval or anything that runs page-supplied code in the extension's privileged context.
- Give the user short progress updates of a few words. Don't spawn subagents unless asked; translations are the standing exception.
