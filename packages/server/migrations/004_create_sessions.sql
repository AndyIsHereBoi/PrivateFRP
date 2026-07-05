CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  ip_address TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
