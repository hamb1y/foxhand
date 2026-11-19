-- Usage counts. Each install has a random UUID made by the add-on; it is stored only to count the
-- install once and is never returned or shown. No addresses, no user agents.

-- One row per install.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  first_day TEXT NOT NULL,        -- first report (UTC date)
  last_day TEXT NOT NULL,         -- latest report
  v TEXT NOT NULL,                -- add-on version
  os TEXT NOT NULL,
  stage INTEGER NOT NULL,         -- furthest setup stage: 0 installed, 1 helper connected, 2 first AI command
  reason TEXT,                    -- why the helper was not working at the last report (category), else NULL
  picked TEXT                     -- AI client picked on the setup page (fixed list)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS users_first_day ON users (first_day);
CREATE INDEX IF NOT EXISTS users_last_day ON users (last_day);

-- Which installs reported on which day (an install counts once per day).
CREATE TABLE IF NOT EXISTS activity (
  day TEXT NOT NULL,
  id TEXT NOT NULL,
  PRIMARY KEY (day, id)
) WITHOUT ROWID;

-- Which kinds of AI client an install used on a day (fixed list).
CREATE TABLE IF NOT EXISTS harness_use (
  day TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY (day, id, kind)
) WITHOUT ROWID;

-- Redirects to GitHub release assets: downloads, not people.
CREATE TABLE IF NOT EXISTS downloads (
  day TEXT NOT NULL,
  asset TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, asset)
) WITHOUT ROWID;

-- Messages people chose to send. The date has no time of day; no ID is attached.
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  v TEXT NOT NULL DEFAULT '',
  os TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL
);

-- Global requests per hour, to cap floods. Keyed by kind and hour only.
CREATE TABLE IF NOT EXISTS limits (
  kind TEXT NOT NULL,
  hour TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, hour)
) WITHOUT ROWID;
