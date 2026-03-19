import { Database } from "bun:sqlite";
import fs from "fs";
import path from "path";
import type { TunnelConfig } from "@privatefrp/shared";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  secret TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
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
  enabled INTEGER NOT NULL DEFAULT 1,
  traffic_in_bytes INTEGER NOT NULL DEFAULT 0,
  traffic_out_bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE TABLE IF NOT EXISTS ip_traffic (
  tunnel_id TEXT NOT NULL,
  remote_ip TEXT NOT NULL,
  traffic_in_bytes INTEGER NOT NULL DEFAULT 0,
  traffic_out_bytes INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER DEFAULT (unixepoch()),
  last_seen INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (tunnel_id, remote_ip),
  FOREIGN KEY (tunnel_id) REFERENCES tunnels(id)
);

CREATE TABLE IF NOT EXISTS traffic_rollups (
  bucket_start INTEGER NOT NULL,
  tunnel_id TEXT NOT NULL,
  remote_ip TEXT NOT NULL,
  traffic_in_bytes INTEGER NOT NULL DEFAULT 0,
  traffic_out_bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_start, tunnel_id, remote_ip),
  FOREIGN KEY (tunnel_id) REFERENCES tunnels(id)
);

CREATE INDEX IF NOT EXISTS idx_traffic_rollups_tunnel_bucket
  ON traffic_rollups (tunnel_id, bucket_start);

CREATE INDEX IF NOT EXISTS idx_traffic_rollups_bucket
  ON traffic_rollups (bucket_start);
`;

export interface AgentRow {
  id: string;
  name: string;
  secret: string;
  enabled: number;
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
  enabled: number;
  traffic_in_bytes: number;
  traffic_out_bytes: number;
  created_at: number;
}

export interface IpTrafficRow {
  tunnel_id: string;
  remote_ip: string;
  traffic_in_bytes: number;
  traffic_out_bytes: number;
  first_seen: number;
  last_seen: number;
}

export interface TunnelTrafficWindowRow {
  tunnel_id: string;
  traffic_in_bytes: number;
  traffic_out_bytes: number;
}

export interface IpTrafficWindowRow {
  tunnel_id: string;
  remote_ip: string;
  traffic_in_bytes: number;
  traffic_out_bytes: number;
  last_bucket_start: number;
}

export class DB {
  private db: Database;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, "privatefrp.db");
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec(SCHEMA);
    this.applyMigrations();
  }

  private applyMigrations(): void {
    type TableInfoRow = { name: string };
    const agentColumns = this.db
      .query<TableInfoRow, []>("PRAGMA table_info(agents)")
      .all()
      .map((c: TableInfoRow) => c.name);

    if (!agentColumns.includes("enabled")) {
      this.db.exec("ALTER TABLE agents ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;");
    }

    const columns = this.db
      .query<TableInfoRow, []>("PRAGMA table_info(tunnels)")
      .all()
      .map((c: TableInfoRow) => c.name);

    if (!columns.includes("traffic_in_bytes")) {
      this.db.exec("ALTER TABLE tunnels ADD COLUMN traffic_in_bytes INTEGER NOT NULL DEFAULT 0;");
    }
    if (!columns.includes("traffic_out_bytes")) {
      this.db.exec("ALTER TABLE tunnels ADD COLUMN traffic_out_bytes INTEGER NOT NULL DEFAULT 0;");
    }
    if (!columns.includes("enabled")) {
      this.db.exec("ALTER TABLE tunnels ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;");
    }
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

  setAgentEnabled(id: string, enabled: boolean): AgentRow | null {
    this.db.query("UPDATE agents SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
    return this.getAgent(id);
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
    type: "tcp" | "udp" | "tcp+udp",
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

  updateTunnel(
    id: string,
    name: string,
    type: "tcp" | "udp" | "tcp+udp",
    listenPort: number,
    targetHost: string,
    targetPort: number,
    agentId: string,
  ): TunnelRow | null {
    this.db
      .query(
        "UPDATE tunnels SET name = ?, type = ?, listen_port = ?, target_host = ?, target_port = ?, agent_id = ? WHERE id = ?",
      )
      .run(name, type, listenPort, targetHost, targetPort, agentId, id);
    return this.getTunnel(id);
  }

  deleteTunnel(id: string): void {
    this.db.query("DELETE FROM traffic_rollups WHERE tunnel_id = ?").run(id);
    this.db.query("DELETE FROM ip_traffic WHERE tunnel_id = ?").run(id);
    this.db.query("DELETE FROM tunnels WHERE id = ?").run(id);
  }

  unassignTunnelsForAgent(agentId: string): void {
    this.db.query("UPDATE tunnels SET agent_id = '' WHERE agent_id = ?").run(agentId);
  }

  setTunnelEnabled(id: string, enabled: boolean): TunnelRow | null {
    this.db.query("UPDATE tunnels SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
    return this.getTunnel(id);
  }

  updateTunnelTrafficTotals(id: string, inBytes: number, outBytes: number): void {
    this.db
      .query("UPDATE tunnels SET traffic_in_bytes = ?, traffic_out_bytes = ? WHERE id = ?")
      .run(inBytes, outBytes, id);
  }

  getTunnelTrafficTotals(id: string): { inBytes: number; outBytes: number } | null {
    const row = this.db
      .query<{ traffic_in_bytes: number; traffic_out_bytes: number }, [string]>(
        "SELECT traffic_in_bytes, traffic_out_bytes FROM tunnels WHERE id = ?",
      )
      .get(id);
    if (!row) return null;
    return { inBytes: row.traffic_in_bytes ?? 0, outBytes: row.traffic_out_bytes ?? 0 };
  }

  upsertIpTrafficTotals(
    tunnelId: string,
    remoteIp: string,
    inBytes: number,
    outBytes: number,
    lastSeen: number,
  ): void {
    this.db
      .query(
        `INSERT INTO ip_traffic (tunnel_id, remote_ip, traffic_in_bytes, traffic_out_bytes, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(tunnel_id, remote_ip) DO UPDATE SET
           traffic_in_bytes = excluded.traffic_in_bytes,
           traffic_out_bytes = excluded.traffic_out_bytes,
           last_seen = excluded.last_seen`,
      )
      .run(tunnelId, remoteIp, inBytes, outBytes, lastSeen, lastSeen);
  }

  getIpTrafficTotals(tunnelId: string, remoteIp: string): { inBytes: number; outBytes: number; lastSeen: number } | null {
    const row = this.db
      .query<{ traffic_in_bytes: number; traffic_out_bytes: number; last_seen: number }, [string, string]>(
        "SELECT traffic_in_bytes, traffic_out_bytes, last_seen FROM ip_traffic WHERE tunnel_id = ? AND remote_ip = ?",
      )
      .get(tunnelId, remoteIp);
    if (!row) return null;
    return {
      inBytes: row.traffic_in_bytes ?? 0,
      outBytes: row.traffic_out_bytes ?? 0,
      lastSeen: row.last_seen ?? 0,
    };
  }

  listIpTraffic(): IpTrafficRow[] {
    return this.db
      .query<IpTrafficRow, []>(
        "SELECT tunnel_id, remote_ip, traffic_in_bytes, traffic_out_bytes, first_seen, last_seen FROM ip_traffic ORDER BY (traffic_in_bytes + traffic_out_bytes) DESC",
      )
      .all();
  }

  addTrafficRollupBucket(
    bucketStart: number,
    tunnelId: string,
    remoteIp: string,
    inBytesDelta: number,
    outBytesDelta: number,
  ): void {
    this.db
      .query(
        `INSERT INTO traffic_rollups (bucket_start, tunnel_id, remote_ip, traffic_in_bytes, traffic_out_bytes)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(bucket_start, tunnel_id, remote_ip) DO UPDATE SET
           traffic_in_bytes = traffic_rollups.traffic_in_bytes + excluded.traffic_in_bytes,
           traffic_out_bytes = traffic_rollups.traffic_out_bytes + excluded.traffic_out_bytes`,
      )
      .run(bucketStart, tunnelId, remoteIp, inBytesDelta, outBytesDelta);
  }

  listTunnelTrafficWindow(sinceEpochSec: number): TunnelTrafficWindowRow[] {
    return this.db
      .query<TunnelTrafficWindowRow, [number]>(
        `SELECT
           tunnel_id,
           SUM(traffic_in_bytes) AS traffic_in_bytes,
           SUM(traffic_out_bytes) AS traffic_out_bytes
         FROM traffic_rollups
         WHERE bucket_start >= ? AND remote_ip = ''
         GROUP BY tunnel_id`,
      )
      .all(sinceEpochSec);
  }

  listIpTrafficWindow(sinceEpochSec: number): IpTrafficWindowRow[] {
    return this.db
      .query<IpTrafficWindowRow, [number]>(
        `SELECT
           tunnel_id,
           remote_ip,
           SUM(traffic_in_bytes) AS traffic_in_bytes,
           SUM(traffic_out_bytes) AS traffic_out_bytes,
           MAX(bucket_start) AS last_bucket_start
         FROM traffic_rollups
         WHERE bucket_start >= ? AND remote_ip <> ''
         GROUP BY tunnel_id, remote_ip`,
      )
      .all(sinceEpochSec);
  }

  pruneTrafficRollups(beforeEpochSec: number): void {
    this.db.query("DELETE FROM traffic_rollups WHERE bucket_start < ?").run(beforeEpochSec);
  }

  clearTrafficData(): void {
    this.db.exec("BEGIN");
    try {
      this.db.query("UPDATE tunnels SET traffic_in_bytes = 0, traffic_out_bytes = 0").run();
      this.db.query("DELETE FROM ip_traffic").run();
      this.db.query("DELETE FROM traffic_rollups").run();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  rowToTunnelConfig(row: TunnelRow): TunnelConfig {
    return {
      id: row.id,
      name: row.name,
      type: row.type as "tcp" | "udp" | "tcp+udp",
      listenPort: row.listen_port,
      targetHost: row.target_host,
      targetPort: row.target_port,
      agentId: row.agent_id,
    };
  }
}
