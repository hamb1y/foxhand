# Foxhand announcements

Production: https://foxhand-popup-endpoint.pages.dev/popup.json

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

Deploy from the repository root using authenticated Wrangler:

```sh
wrangler pages deploy --cwd popup-endpoint --branch main --commit-dirty=true
```

The deployed feed is intentionally empty until the first announcement is ready.
