CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_heartbeat INTEGER,
  latency_ms INTEGER,
  remote_address TEXT,
  active_connections INTEGER NOT NULL DEFAULT 0
);
