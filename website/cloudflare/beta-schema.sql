CREATE TABLE IF NOT EXISTS beta_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  google_email TEXT NOT NULL UNIQUE,
  android INTEGER NOT NULL,
  outlook INTEGER NOT NULL,
  commitment INTEGER NOT NULL,
  qualified INTEGER NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | declined | not_qualified
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_beta_status ON beta_applications (status, created_at);
