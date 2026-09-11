CREATE TABLE IF NOT EXISTS beta_applications (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  withdrawal_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consent_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','contacted','declined'))
);
CREATE INDEX IF NOT EXISTS beta_expiry ON beta_applications(expires_at);
CREATE TABLE IF NOT EXISTS beta_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS beta_limits_expiry ON beta_limits(expires_at);
