# Plan

Updated 2026-11-15. Branch `ts-extension`, version 0.6.0, not released.
Tick things off here. Keep it short.

## Done

- [x] Pull main, keep the audit fixes
- [x] Addon in TypeScript, built to `build/extension`
- [x] New homepage
- [x] New privacy policy
- [x] README rewrite (uncommitted)

## 1. Analytics and feedback (built, uncommitted)

Needed first. Everything in 2 gets judged by these numbers.

- [x] Daily report from the addon, no ID, only while Firefox's data permission is on
- [x] Funnel: installed -> helper connected -> first AI command
- [x] "Stuck at the helper" with a reason and days since install
- [x] `/stats` panel: DAU, MAU, AAU, installs, funnel, helper downloads
- [x] Uninstall page, "Report a problem" links, `/feedback` form
- [x] Which harnesses connect, and which one was picked on the setup page
- [x] Usage minutes
- [x] AAU = actual active users (an AI command ran), daily / 7 / 30 days
- [x] Review, commit
- [ ] Connect each harness once and record its real client name (5 of the mappings are guesses)
- [ ] Test what a real 0.5.9 -> 0.6.0 update does to the data permission
- [x] Privacy policy: keep the owner's text as is
- [x] Per-install random ID: real distinct users, rolling 30/365 days, retention
- [x] D1 database created, migration applied, panel token set (`~/.config/foxhand/stats-token`)
- [x] Outbound links go through `/go/<target>?from=<where>` and are counted (github, amo, issues, issue, releases, source)
- [ ] Use `/go/...?from=hn|ph|reddit|post|npm|brew|registry` in every post and listing
- [x] Site deployed 2026-11-15 from `ts-extension`, pinned to 0.5.9 downloads. `/stats`, the report endpoint, feedback pages and `/go` are live; the D1 binding works

## 2. Installed -> properly installed

Today: add the addon, paste a line in a terminal, paste a config into the harness. Two pastes, a 105 MiB download, and a terminal.

Quick, no decisions needed:
- [x] Setup page shows only the line for this OS, with one Copy button (already did)
- [x] Flatpak/Snap: the addon can't see how Firefox was packaged, so every Linux user without a helper gets one line; the helper's installer detects both and says so
- [ ] Check the Snap line on a real Snap Firefox (it is from Mozilla's docs)
- [x] Every stuck state names the fix in one line; a helper that won't start shows the install command again
- [x] Installer prints one clear last line: "Installed." or "Not installed: why"
- [x] Windows: say what to do about the SmartScreen warning (was already there)

Bigger:
- [ ] **One-click connect.** Once the helper is up, the setup page has a "Connect Claude Code" button and the helper writes the harness config itself. Removes the second paste. NEEDS OK: the helper would edit other tools' config files.
- [ ] **npm path** (section 4). 1 MiB instead of 105 for anyone with Node.
- [ ] **brew path** (section 4).
- [ ] Setup page offers npm / brew / curl, best one first for this machine
- [ ] Smaller helper binary (Go rewrite, about 8 MiB). Parked. Reopen if the funnel shows the download is the leak.

Done when: the funnel shows where people drop, and the worst step is fixed and measured again.

## 3. Desloppify the addon

Code:
- [ ] Remove Chrome compatibility (`browser`/`chrome` switch in 6 files, `call`/`pcall` wrapper around 88 calls, mute fallback, dual responder in `ax.ts`)
- [ ] Remove the `WeakRef` fallback
- [ ] Derive `CAPABILITIES` and the `LABELS` fallback instead of repeating 52 entries
- [ ] Check for bridge methods nothing calls, remove them
- [ ] Modern syntax file by file (`var`, `function` callbacks, `arguments`)
- [ ] Bugs the port found (list in the port report): fix or drop each

Text:
- [ ] Addon strings in the short style, then Haiku for de/es/fr/zh_CN
- [x] Gemini CLI -> Antigravity in the setup page and options
- [ ] Site copy in the short style
- [ ] `docs/amo-listing.md`: copy in the summary and description now live on AMO, Haiku for the 4 translations

Report LOC before and after each step. Full tests after each.

## 4. Packages

npm (`packaging/npm`):
- [ ] One file, no dependencies, no install scripts
- [ ] `install` copies the bundle into the normal folder and registers it
- [ ] `mcp`: stdio relay, for stdio-only clients and the MCP Registry
- [ ] Publish from the release workflow with npm trusted publishing
- [x] Name: `@foxhand/helper`, in the owner's `foxhand` npm org
- [ ] `npx -y @foxhand/helper install` (and `mcp` for the relay)
- [ ] OWNER: add the repo as trusted publisher for the package
- [ ] OWNER: relay token from an env var, or a file the helper writes

brew (`packaging/brew`):
- [x] Formula name: `foxhand-helper`
- [ ] Official Homebrew (homebrew-core), no tap. `brew install foxhand-helper`
- [ ] Blocked on notability: 9 stars today, Homebrew wants about 75 (more for self-submitted). Reopen after the launch
- [ ] Formula must build from source: install the JS bundle with `depends_on "node"`, not the Bun binary
- [ ] After install the user runs `foxhand-helper install` once to register with Firefox (a formula can't write to the home folder)
- [ ] Release workflow updates the version and checksums

Both write to the same folder and registration as the curl installer.

## 5. Finish the move to foxhand.pages.dev

Still pointing at the old places:
- [x] `scripts/install.sh`, `install.ps1`: default download base is GitHub `releases/latest`, comments say `hamb1y.github.io`
- [x] `site/index.html` source has the old URLs and the build rewrites them. Flip it: source uses the new URLs, nothing to rewrite
- [x] `extension/options.html` "all downloads" link, `extension/README-INSTALL.md`
- [ ] `platforms.yml` and `public-install.yml` (default version still 0.5.7)
- [x] GitHub Pages stays as a redirect only
- [ ] Old announcement endpoint stays until 0.5.6 and 0.5.7 are gone. The per-version numbers say when
- [x] Binaries stay on GitHub Releases behind the `/download` redirect

## 6. Repo layout

Last, moves only.

- [ ] `packaging/{npm,brew,amo,installers}`
- [ ] `harnesses/{claude-code,claude-desktop,codex,chatgpt-desktop,opencode,pi,omp,openclaw,antigravity}`, same shape in each
- [ ] `web/` (site, worker, announcement, wrangler)
- [ ] `AGENTS.md` replaces `CLAUDE.md`; Gemini files go
- [ ] Fix every path in workflows, scripts and tests

## Release 0.6.0

Merging `ts-extension` into `main` publishes to GitHub and submits to AMO.

- [ ] Sections 1 and 5 in, and the quick items of 2
- [ ] Read the `## 0.6.0` changelog section
- [ ] First release with an AMO source upload; that script has never run
- [ ] Decide: commit `docs/audit-remediation.md` or not

Sections 3, 4 and 6 can ship after.

## Soft launch 2

Before:
- [ ] 0.6.0 out and a week of funnel numbers
- [ ] Quick install fixes (section 2)
- [ ] npm and brew live
- [ ] One-click connect, if approved
- [ ] MCP registries cleaned up, Antigravity instead of Gemini CLI
- [ ] Site move finished (section 5)
- [ ] 20 second real screen recording
- [ ] Short security page to link in comments

Order: Reddit (r/firefox, r/ClaudeAI, r/LocalLLaMA, r/mcp) and harness Discords first, fix what they hit, then Show HN, then Product Hunt. Not HN and PH in the same week.
Also: Lobsters, MCP Registry and community lists, Mozilla add-ons Discourse.

## Waiting on the owner

- One-click connect: OK for the helper to write harness configs?
- npm relay token: env var or a file the helper writes
- README links through `/go` or direct
- `docs/audit-remediation.md`
