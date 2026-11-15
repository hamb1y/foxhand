-- AAU (actual active users): the day's report said at least one AI command ran. Added after 0001 was applied.
ALTER TABLE activity ADD COLUMN used INTEGER NOT NULL DEFAULT 0;
