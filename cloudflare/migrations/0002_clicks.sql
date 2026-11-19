-- Clicks on outbound links that go through /go/<target>: a count per day, target and where the link was.
CREATE TABLE IF NOT EXISTS clicks (
  day TEXT NOT NULL,
  target TEXT NOT NULL,
  src TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, target, src)
) WITHOUT ROWID;
