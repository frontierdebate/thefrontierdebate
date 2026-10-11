-- Ratings database (Cloudflare D1). Run once in the D1 console.
CREATE TABLE IF NOT EXISTS votes (
  essay TEXT NOT NULL,
  voter TEXT NOT NULL,      -- salted SHA-256 hash, never the raw IP
  score INTEGER NOT NULL CHECK (score IN (1, 2, 3)),
  at    TEXT NOT NULL,
  PRIMARY KEY (essay, voter)
);
