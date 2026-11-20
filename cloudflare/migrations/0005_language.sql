ALTER TABLE users ADD COLUMN language TEXT
  CHECK (language IS NULL OR language = 'other' OR language GLOB '[a-z][a-z]');
