CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('babel', 'recipe')),
  payload TEXT NOT NULL,
  sha256 TEXT,
  created_at INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS shares_fingerprint_uq
  ON shares(fingerprint);

CREATE INDEX IF NOT EXISTS shares_created_at_idx
  ON shares(created_at DESC);
