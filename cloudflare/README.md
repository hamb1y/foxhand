# Unified Foxhand hosting

The Direct Upload Pages project is **foxhand**, at https://foxhand.pages.dev.
GitHub remains the source, release binary host and CI provider, including Intel
and Apple Silicon macOS testing. This website migration does not require a new
extension version. R2 is not used or required.

## Public routes

| Route | Behavior |
| --- | --- |
| `/` | Existing `site/` template adapted at build time; visible selected release version and new-domain links |
| `/privacy` | Policy from the Privacy policy section of `docs/amo-listing.md` |
| `/changelog` | Full `CHANGELOG.md`, including historical tables |
| `/download` (also `/download/`) | Installer instructions and architecture-specific release download links |
| `/download/sh`, `/download/ps` | Generated installers pinned to the selected versioned Cloudflare base; no-store |
| `/download/latest.json` | Selected published `{ version, base, checksums, source }`; no-store |
| `/download/<version>/<asset>` | 302 to the exact GitHub Release asset, cached for five minutes |
| `/download/latest/<asset>` | No-store 302 to the version pinned by deployment metadata, then GitHub |
| `/endpoint/announcement` | Exact existing announcement bytes, no-store |

Versions are numeric `major.minor.patch` without `v`. The Worker accepts only
modern/legacy helper binaries for the six supported OS/architecture combinations,
`SHA256SUMS`, `install.sh`, `install.ps1`, and `foxhand.zip`. It cannot redirect to
arbitrary hosts or paths. GET and HEAD redirect alike; downloads/ranges and final
content types are served by GitHub. Unknown download/endpoint routes return 404.
`/sh`, `/ps`, and `/popup.json` remain aliases on the new hostname.

The actual v0.5.7 helpers are approximately 90–117 MB each, exceeding Pages'
[25 MiB per-file limit](https://developers.cloudflare.com/pages/platform/limits/#file-size).
Binaries are therefore never placed in Pages output. The build rejects any
static asset over 25 MiB. The public domain is the stable entry point; binary
traffic and availability still depend on GitHub, not Cloudflare storage.

The short installer copies use `/download/<version>` for binaries/checksums.
On WSL, the shell installer forwards that pinned base to the release's original
PowerShell installer. Published assets/checksums are never rewritten. Installers
continue verifying the downloaded binary against the published SHA256SUMS;
checksums are integrity checks, not an independent authenticity signature.

## Build and test

```sh
node test/cloudflare.mjs
RELEASE_VERSION=0.5.7 node scripts/build-cloudflare.mjs
npx --yes wrangler@4.159.0 pages dev --port 8799
```

Output: `dist/cloudflare/`. No Cloudflare credentials/resources are needed to
build/test. The tests cover allowlisted redirects, GET/HEAD, pinned latest
metadata, WSL, cache/content types, exact announcement preservation, rendered
policy/changelog/downloads, safe HTML escaping, selected visible version, intact
historical screenshot descriptions and unchanged GitHub source templates.

For pre-deploy release checks (metadata only, no binary downloads):

```sh
gh release view v0.5.7 --repo hamb1y/foxhand --json tagName,isDraft,assets > /tmp/foxhand-release.json
RELEASE_VERSION=0.5.7 node scripts/check-cloudflare-release.mjs /tmp/foxhand-release.json
```

This checks the existing published tag and 16 nonempty, uploaded required assets.
It does not claim to recheck binary checksums/signatures. The deployment workflow
performs this check before building the selected release output. Tests use local
fixtures; the command above checks GitHub itself.

## Authorized deployment

The Direct Upload project `foxhand` has been created. Do not enable Git-triggered
deployments. No R2 bucket, binding, AWS CLI or R2 secret is needed. Configure only
`CLOUDFLARE_ACCOUNT_ID` and a Pages-edit `CLOUDFLARE_API_TOKEN` for the workflow.

After changes are reviewed and available on GitHub, dispatch **Cloudflare** with the selected `version` and `publish=false` to prepare a reviewable
artifact. With deployment authorization, `publish=true` deploys that artifact in
one Pages promotion: website, pinned installers, metadata and announcement move
together. After a successful **Release** workflow on main, `workflow_run` checks out that
release run’s exact commit, verifies its published assets, and deploys its version
automatically. This also works for releases created with GITHUB_TOKEN. Failed
releases and runs from other repositories cannot deploy. The Pages workflow
never creates a GitHub release or bumps a version. It does not download gigabytes of assets.

An authorized operator can deploy the locally checked output directly:

```sh
RELEASE_VERSION=0.5.7 node scripts/build-cloudflare.mjs
npx --yes wrangler@4.159.0 pages deploy dist/cloudflare --project-name foxhand --branch main
```

Verify `/`, `/privacy`, `/changelog`, `/download`, both short installers,
metadata, version/latest redirects for all architectures, final GitHub downloads,
and the announcement's exact JSON/no-store headers. Test installation through
the new hostname on Intel and Apple Silicon macOS. Existing platform CI checks
installation/signatures/native messaging/real Firefox, but does not verify this
production hostname and redirect chain. Roll back by promoting an earlier Pages
deployment; retain its GitHub Release assets so pinned links keep working.

## Domain transition and compatibility

The release source now uses the new domain for extension installer/download links
and announcements. The exact live-test feed fixture, README, release instructions,
and AMO listing/privacy/reviewer text move together. Extension and native IDs,
announcement content and locally seen IDs remain unchanged. The AMO policy API
accepts policy text; that text includes the public `/privacy` URL.

The GitHub Pages workflow runs `build-legacy-pages.mjs`: only its generated
homepage redirects to the new domain. Its original `/sh` and `/ps` scripts and
other assets remain available. The Cloudflare build still renders the actual
website from `site/`, never the compatibility redirect. Keep the old announcement
project available for versions 0.5.6–0.5.7 and publish feed updates to both projects
as documented in `popup-endpoint/README.md`.

Before promoting a new unpublished version, use `RELEASE_VERSION=0.5.7` for any
local deployment intended to retain the existing live release. A bare local build
follows package.json; the automatic workflow selects that version only after the
Release workflow succeeds and all required published asset metadata validates.

Dispatch **Public installer** with the version currently pinned by the live
metadata (initially 0.5.7). It tests all six platform/architecture runners against
the actual public short installer URLs, with no base override or local server.
The test isolates HOME/user-profile/data directories on disposable runners,
checks helper status/version and binary architecture, and verifies macOS code
signatures. It does not launch a user Firefox profile. Existing Platforms tests
continue checking the release candidate with real Firefox; the public smoke test
intentionally does not mix the checkout’s add-on version with an older live helper.

Operational completion requires the new add-on’s normal AMO submission/review,
the AMO listing update, a successful Pages release deployment and the six public
installer jobs. Keep historical endpoints and GitHub Release assets indefinitely
for installed versions, old links and rollback. Binary delivery remains on GitHub;
a separate storage migration is not required for the domain transition.
