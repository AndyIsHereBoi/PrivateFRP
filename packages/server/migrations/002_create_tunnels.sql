CREATE TABLE IF NOT EXISTS tunnels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  listen_port INTEGER NOT NULL,
  target_host TEXT NOT NULL,
  target_port INTEGER NOT NULL,
  agent_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
