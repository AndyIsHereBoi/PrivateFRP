import { Database } from "bun:sqlite";
import fs from "fs";
import path from "path";
import type { TunnelConfig } from "@privatefrp/shared";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  secret TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS tunnels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  listen_port INTEGER NOT NULL,
  target_host TEXT NOT NULL,
  target_port INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);
`;

export interface AgentRow {
  id: string;
  name: string;
  secret: string;
  created_at: number;
}

export interface TunnelRow {
  id: string;
  name: string;
  type: string;
  listen_port: number;
  target_host: string;
  target_port: number;
  agent_id: string;
  created_at: number;
}

export class DB {
  private db: Database;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, "privatefrp.db");
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec(SCHEMA);
  }

  // ─── Agents ──────────────────────────────────────────────────────────────────

  getAgent(id: string): AgentRow | null {
    return this.db
      .query<AgentRow, [string]>("SELECT * FROM agents WHERE id = ?")
      .get(id);
  }

  listAgents(): AgentRow[] {
    return this.db.query<AgentRow, []>("SELECT * FROM agents ORDER BY created_at DESC").all();
  }

  createAgent(id: string, name: string, secret: string): AgentRow {
    this.db
      .query("INSERT INTO agents (id, name, secret) VALUES (?, ?, ?)")
      .run(id, name, secret);
    return this.getAgent(id)!;
  }

  deleteAgent(id: string): void {
    this.db.query("DELETE FROM agents WHERE id = ?").run(id);
  }

  // ─── Tunnels ─────────────────────────────────────────────────────────────────

  getTunnel(id: string): TunnelRow | null {
    return this.db
      .query<TunnelRow, [string]>("SELECT * FROM tunnels WHERE id = ?")
      .get(id);
  }

  listTunnels(): TunnelRow[] {
    return this.db
      .query<TunnelRow, []>("SELECT * FROM tunnels ORDER BY created_at DESC")
      .all();
  }

  listTunnelsForAgent(agentId: string): TunnelRow[] {
    return this.db
      .query<TunnelRow, [string]>("SELECT * FROM tunnels WHERE agent_id = ? ORDER BY created_at DESC")
      .all(agentId);
  }

  createTunnel(
    id: string,
    name: string,
    type: "tcp" | "udp",
    listenPort: number,
    targetHost: string,
    targetPort: number,
    agentId: string,
  ): TunnelRow {
    this.db
      .query(
        "INSERT INTO tunnels (id, name, type, listen_port, target_host, target_port, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, name, type, listenPort, targetHost, targetPort, agentId);
    return this.getTunnel(id)!;
  }

  deleteTunnel(id: string): void {
    this.db.query("DELETE FROM tunnels WHERE id = ?").run(id);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  rowToTunnelConfig(row: TunnelRow): TunnelConfig {
    return {
      id: row.id,
      name: row.name,
      type: row.type as "tcp" | "udp",
      listenPort: row.listen_port,
      targetHost: row.target_host,
      targetPort: row.target_port,
      agentId: row.agent_id,
    };
  }
}
