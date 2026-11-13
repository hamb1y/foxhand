# Foxhand announcements

Current endpoint: https://foxhand.pages.dev/endpoint/announcement

Legacy endpoint for versions 0.5.6–0.5.7: https://foxhand-popup-endpoint.pages.dev/popup.json

`public/popup.json` is `null` when no announcement is active. To publish one,
replace it with an object containing a unique `id` (up to 128 characters) and
`html` (up to 32 KiB). Use a new ID for each announcement. All previously shown
IDs are remembered per Firefox profile, including across add-on updates.

The extension checks 15 seconds after background startup and every four hours.
It opens a small window and records the ID only after content renders. Offline,
invalid, and failed responses are ignored until the next check. No credentials,
browsing data, or seen IDs are sent to the endpoint. Cloudflare receives standard
HTTPS connection metadata, including the client IP address.

The AMO privacy policy in `docs/amo-listing.md` discloses these periodic
requests and the connection metadata Cloudflare receives.

Allowed HTML: headings h1–h3, paragraphs, divs, spans, strong/b, em/i, br, hr,
lists, blockquotes, code/pre, and HTTPS links. All attributes except validated
link hrefs are discarded. Scripts, embedded content, images, forms, styles,
and event handlers are removed. Styling and window controls ship in the add-on.

For a feed update, deploy the unified project through the Cloudflare workflow
with the currently published version and publish=true. It copies this same
`public/popup.json` verbatim. Keep the announcement ID unchanged when only moving
domains; changing it would redisplay the message.

Also update the legacy endpoint for already-installed older add-ons. Deploy that
compatibility project from the repository root using authenticated Wrangler:

```sh
wrangler pages deploy --cwd popup-endpoint --branch main --commit-dirty=true
```

The first announcement, `foxhand-community-2026-11`, invites recommendations,
honest AMO reviews, GitHub stars, and suggestions or issue reports. Version
0.5.7 adds centered text and cards for its links; older 0.5.6 installations
can render the same content using their original layout.
