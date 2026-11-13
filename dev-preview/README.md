# Local UX review

This isolated worktree (`ux/sonnet-refresh`) contains Claude Sonnet's UX changes, made through Claude Code using `claude --model sonnet` (resolved model `claude-sonnet-5-5`). Sonnet used Haiku agents for translations. Claude Code reached its five-hour usage limit after implementation. Codex finished the gallery, restored centered announcement text, removed a CSP-blocked decorative image, fixed Left Arrow tab wrapping, and ran verification.

The user approved this UX pass for release as 0.5.9. The original checkout's unrelated audit changes remain separate. This gallery is local tooling, excluded from the production site and extension.

## View

```sh
node dev-preview/serve.mjs
```

Open http://localhost:8840/_review/ for interactive before/after views. The website is at http://localhost:8840/ . The server binds only to localhost. The extension pages run with fake browser APIs, fixture activity and a clearly fake token; they do not read your Firefox profile or helper. The announcement content comes unchanged from the approved repository JSON.

The current preview is running as the transient user service `foxhand-ux-preview`. Stop it with `systemctl --user stop foxhand-ux-preview` before starting another server on port 8840.

Use the Screen, State, Language, Mobile width and Before + after controls. The website itself remains English. Onboarding's Connected fixture makes a first command after two seconds to demonstrate live progress. Screenshots are English captures; mobile captures use their named state (idle onboarding, ready settings).

Before views are pinned to released 0.5.8 (`00aa3ed`). `PREVIEW_BASE_REF` can select another baseline when rebuilding with `node dev-preview/prepare.mjs --refresh`.

## Changes

- Popup: prominent status with a next-step hint, Pause before secondary actions, actionable empty activity, and direct access to the confirm guard settings.
- Settings: section navigation, grouped safety controls with accurate explanations, connection feedback, recovery links and collapsed advanced settings.
- Onboarding: progress strip, live completion feedback, clearer install/connect/try steps and troubleshooting.
- Announcement: centered approved text, full-card links, keyboard focus and a Done button.
- Website: sticky navigation, setup checkpoints, How it works, tool summaries with expandable names, keyboard tabs, copy fallback and responsive layouts.
- Shared styles: consistent controls, higher text contrast, focus indicators and reduced-motion support. Updated English, German, Spanish, French and Chinese UI strings.

## Verification

```sh
node test/options.mjs
node test/announcements.mjs
node scripts/i18n.mjs --check
node test/cloudflare.mjs
npx --no-install web-ext lint -s extension
node dev-preview/verify.mjs
node dev-preview/capture.mjs
git diff --check
```

These cover settings behavior, announcement sanitization/deduplication, translations, domain/build behavior, extension lint, and disposable Firefox checks for pause/resume, onboarding progression, announcement rendering, clipboard failure, keyboard tabs, mobile layout and gallery loading. This pass has not been installed into the user's real Firefox or tested as a new signed extension. Backend code is unchanged. Existing website product screenshots remain labeled with their original 0.5.4 version.

Generated baseline files and screenshots are ignored under this directory and excluded from extension packaging and the production site build.
