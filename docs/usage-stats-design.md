# Design: usage statistics

Status: design only. Nothing here ships until the owner approves it, and the
privacy text in the last section has to change first.

## The four numbers

| Number | Meaning | Source |
| - | - | - |
| Total downloads | Add-on installs from AMO, and helper downloads | AMO statistics; GitHub release asset counts |
| DAU | Profiles where Firefox ran with the add-on that day | AMO "daily users"; cross-checked by the ping |
| AAU (actual active users), per day, week and month | Profiles where an agent ran at least one command in the period | The ping |
| AAU ÷ downloads | Share of people who downloaded and went on to use it | The two above |

"Daily users" on AMO only means Firefox checked for an update with the
add-on installed. It can't tell a working setup from one where the helper
was never installed. That gap is what AAU is for.

Numbers on 2026-11-14, for reference: AMO's public API reports 31 average
daily users and 31 weekly downloads; the GitHub repo has 9 stars.

## Part 1: sources that need no code in the add-on

### AMO statistics

- The developer dashboard has daily users (by version, OS, language,
  country) and downloads by source.
- AMO records `utm_source`, `utm_medium`, `utm_campaign` and `utm_content`
  on listing links. No link to the listing carries them today. Tag every
  one, each with its own source:

| Where | Link today | `utm_source` |
| - | - | - |
| `README.md:18` | addons.mozilla.org/en-US/firefox/addon/foxhand/ | `github` |
| `site/index.html:201, 211, 252, 397` | addons.mozilla.org/firefox/addon/foxhand/ | `site` (with `utm_content` = nav, hero, setup, footer) |
| `scripts/cloudflare-pages.mjs:68` (downloads page) | same | `site`, `utm_content=downloads` |
| `GEMINI.md`, `claude-plugin/README.md` | same | `gemini-gallery`, `claude-plugin` |
| Catalogue entries (Glama, mcpservers.org, awesome-mcp-servers) | repo or listing | one each |
| Each launch post (docs/launch.md) | listing | `hn`, `reddit-mcp`, and so on |

  Not `popup-endpoint/public/popup.json`: it links to the reviews page, and
  its bytes must not change.

### GitHub release downloads

- `gh api repos/hamb1y/foxhand/releases` gives a cumulative
  `download_count` per asset. Downloads through
  `foxhand.pages.dev/download/...` redirect to those assets, so they are
  counted too.
- Helper downloads = the six `foxhand-host-*` assets (plus the legacy
  `webmcp-host-*` ones). `SHA256SUMS` is fetched once per installer run, so
  it counts completed script runs.
- The count is cumulative only. A daily scheduled GitHub Action records it
  so there is a history. It also counts updates, CI and bots, so it is an
  upper bound on people.

### Add-on to helper conversion, without the ping

Helper downloads in a period ÷ AMO downloads in the same period. Rough,
because one person may download the helper more than once.

## Part 2: the ping

### Consent

Mozilla's add-on policy treats any data the add-on sends off the machine as
data collection, including anonymous counts. Version, OS and usage flags
fall in its "technical and interaction data" category, which can only be
declared as optional.

- `extension/manifest.json` has declared `technicalAndInteraction` as
  optional since 0.3.0, so every install has already been shown the choice
  by Firefox, and no new prompt appears.
- According to a Mozilla staff reply on the add-ons blog (5 November 2025),
  that choice is "enabled by default" and the user can turn it off. I have
  not confirmed this in a running Firefox yet; do that before relying on it.
- The add-on sends the ping only if
  `browser.permissions.getAll()` lists `technicalAndInteraction` under
  `data_collection`, and a new toggle in Settings ("Send anonymous usage
  counts") is on. Turning off either stops it.

So this is not an extra consent screen. It is a check of a choice Firefox
already offers.

### When

At most one ping per UTC day per Firefox profile. On startup and then
hourly, the add-on compares today's date with the stored date of the last
ping and sends only if they differ.

### What

`POST https://foxhand.pages.dev/endpoint/ping`, JSON, no cookies, no
referrer:

| Field | Values | From the brief? |
| - | - | - |
| `v` | add-on version, `X.Y.Z` | yes |
| `os` | `win`, `mac`, `linux` | yes |
| `helper` | true if the helper was connected since the last ping | yes |
| `agent` | true if an agent ran a command since the last ping | yes |
| `week1` | true if this is the profile's first ping this ISO week | yes |
| `month1` | true if this is its first ping this calendar month | yes |
| `aweek1` | true if this is its first ping this week with `agent` true | **added** |
| `amonth1` | true if this is its first ping this month with `agent` true | **added** |

The two added flags are what make weekly and monthly AAU countable without
an install ID. Without them, `week1` and `month1` only count installed
profiles per week and month. They need the owner's OK because they go
beyond the brief.

There is no install ID, no random ID, no URL, no tab count, no client name.
The add-on stores four dates locally to compute the flags: last ping, last
ping week, last ping month, and the same for active pings.

### How the numbers come out

- DAU = pings that day.
- Daily AAU = pings that day with `agent` true.
- WAU, MAU = sum of `week1`, `month1` over the period.
- Weekly, monthly AAU = sum of `aweek1`, `amonth1`.
- Add-on to helper conversion = share of pings with `helper` true.
- AAU ÷ downloads = monthly AAU ÷ AMO downloads (state which period).

Known error: a profile counts once, so one person with two profiles is two.
A day's `agent` flag describes the time since the previous ping, so it lags
by up to a day. Anyone can post a fake ping; see below.

### Receiving it

In `cloudflare/worker.mjs`, which today accepts only GET and HEAD:

- Accept `POST /endpoint/ping`. Reject anything that is not exactly the
  eight fields with the allowed values, or is larger than 256 bytes.
- Store counts only: one row per (date, version, os, and the six flags)
  with a counter, incremented in a single statement. A D1 database bound to
  the Pages project fits; KV does not, because read-then-write loses
  increments.
- Do not log or store the IP address or user agent. Cloudflare still sees
  the connection, exactly as it does for the announcement check.
- A Cloudflare rate-limit rule per IP blunts fake pings without storing
  anything. The numbers stay estimates.
- `test/cloudflare.mjs` gets cases for a valid ping, each kind of invalid
  one, and that GET still fails.

### The dashboard

- A daily scheduled GitHub Action reads the GitHub asset counts and the
  public AMO numbers and posts them to the worker with a secret.
- `GET /endpoint/stats`, protected by that secret, returns the four numbers
  and their history as JSON.
- `node scripts/stats.mjs` prints them. A private page can come later,
  behind Cloudflare Access; a script is enough to start.
- AMO's download-by-source table needs a login, so it stays a manual check
  in the developer dashboard unless its export accepts the API key (not
  verified).

## Part 3: text that must change before the ping ships

Line numbers are from the working tree on 2026-11-14.

| File and line | Text today | Why it must change |
| - | - | - |
| `docs/amo-listing.md:192` (privacy policy) | "…and contains no analytics or tracking." | It would be false. Replace with what is sent, when, and how to turn it off |
| `docs/amo-listing.md:196` (privacy policy) | "Firefox's data-collection labels… describe this exchange with programs on your computer, not collection by the developer." | True for the four required labels; "technical and interaction data" would now be real collection by the developer |
| `docs/amo-listing.md:200` (privacy policy) | Paragraph on the announcement request | Still true. Add a paragraph beside it for the ping: endpoint, fields, once a day, no identifier, Cloudflare |
| `docs/amo-listing.md:204` (privacy policy) | "Settings… and the IDs of announcements already displayed are stored locally" | Add the stored ping dates |
| `docs/amo-listing.md:206` on (notes to reviewer) | No mention | Describe the ping and the permission check, so the reviewer can match it to the manifest |
| `i18n/en.json:273` (`obIntro`) | "Everything stays on your computer." | Too absolute once a ping exists. Also the four translations |
| `README.md:32` | "Nothing leaves your machine unless the AI tool you connect sends it somewhere" | Same |
| `site/index.html:241` and `:370` | "Nothing leaves your computer / machine unless…" | Same |
| `README.md:395` on | Section on the announcement check | Add the ping next to it |
| `CHANGELOG.md` | (new entry) | The release that adds the ping must say so first, not last |

Not changing: `docs/amo-listing.md:44`, "Browsing data is not sent to the
developer or any third party by the add-on." The ping carries no browsing
data, so it stays true.

The privacy policy on the site is built from `docs/amo-listing.md`, so it
follows automatically; the AMO copy needs the "AMO listing" workflow, which
needs the owner's OK.

## Order of work, if approved

1. Tag the links (no privacy impact; can go now).
2. Daily GitHub and AMO snapshot.
3. Privacy text, reviewed by the owner.
4. Worker endpoint and storage, with tests.
5. The ping in the add-on, with its Settings toggle, in a release whose
   changelog leads with it.

## Decisions I need from the owner

1. OK to add `aweek1` and `amonth1`?
2. OK to tag the links now, ahead of everything else?
3. D1 on the existing Pages project, or somewhere else?
