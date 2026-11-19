-- Usage minutes: clock minutes in which an AI command was handled, summed over a day's reports (at most 1440).
-- Added after 0001 to 0003 were applied.
ALTER TABLE activity ADD COLUMN minutes INTEGER NOT NULL DEFAULT 0;
