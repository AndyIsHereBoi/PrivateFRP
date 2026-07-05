import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { hashSecret, nowMs, randomId, randomSecret, secretsMatch } from '@privatefrp/shared';
import type { AgentRecord, TunnelRecord, TunnelType } from '@privatefrp/shared';

export class ServerStore {
  private readonly db: Database;

  constructor(private readonly databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_heartbeat INTEGER,
        latency_ms INTEGER,
        remote_address TEXT,
        active_connections INTEGER NOT NULL DEFAULT 0,
        version TEXT
      );
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
    `);
  }

  listAgents(): AgentRecord[] {
    return this.db.query(`
      SELECT id, name, secret_hash as secretHash, enabled, created_at as createdAt,
             last_heartbeat as lastHeartbeat, latency_ms as latencyMs,
             remote_address as remoteAddress, active_connections as activeConnections,
             version
      FROM agents
      ORDER BY created_at DESC
    `).all().map((row: any) => ({
      id: String(row.id),
      name: String(row.name),
      secretHash: String(row.secretHash),
      enabled: Boolean(row.enabled),
      createdAt: Number(row.createdAt),
      lastHeartbeat: row.lastHeartbeat === null || row.lastHeartbeat === undefined ? null : Number(row.lastHeartbeat),
      latencyMs: row.latencyMs === null || row.latencyMs === undefined ? null : Number(row.latencyMs),
      remoteAddress: row.remoteAddress === null || row.remoteAddress === undefined ? null : String(row.remoteAddress),
      activeConnections: Number(row.activeConnections || 0),
      version: row.version === null || row.version === undefined ? null : String(row.version)
    }));
  }

  getAgent(agentId: string): AgentRecord | null {
    const row = this.db.query(`
      SELECT id, name, secret_hash as secretHash, enabled, created_at as createdAt,
             last_heartbeat as lastHeartbeat, latency_ms as latencyMs,
             remote_address as remoteAddress, active_connections as activeConnections,
             version
      FROM agents
      WHERE id = ?
    `).get(agentId) as any;
    return row ? {
      id: String(row.id),
      name: String(row.name),
      secretHash: String(row.secretHash),
      enabled: Boolean(row.enabled),
      createdAt: Number(row.createdAt),
      lastHeartbeat: row.lastHeartbeat === null || row.lastHeartbeat === undefined ? null : Number(row.lastHeartbeat),
      latencyMs: row.latencyMs === null || row.latencyMs === undefined ? null : Number(row.latencyMs),
      remoteAddress: row.remoteAddress === null || row.remoteAddress === undefined ? null : String(row.remoteAddress),
      activeConnections: Number(row.activeConnections || 0),
      version: row.version === null || row.version === undefined ? null : String(row.version)
    } : null;
  }

  createAgent(name = 'New Agent'): { agentId: string; agentSecret: string } {
    const agentId = randomId('agt_');
    const agentSecret = randomSecret();
    this.db.query(`
      INSERT INTO agents (id, name, secret_hash, enabled, created_at, active_connections)
      VALUES (?, ?, ?, 1, ?, 0)
    `).run(agentId, name, hashSecret(agentSecret), nowMs());
    return { agentId, agentSecret };
  }

  updateAgent(agentId: string, patch: Partial<Pick<AgentRecord, 'name' | 'enabled'>>): void {
    const current = this.getAgent(agentId);
    if (!current) return;
    const nextName = patch.name ?? current.name;
    const nextEnabled = patch.enabled ?? current.enabled;
    this.db.query(`UPDATE agents SET name = ?, enabled = ? WHERE id = ?`).run(nextName, nextEnabled ? 1 : 0, agentId);
  }

  deleteAgent(agentId: string): void {
    this.db.query(`DELETE FROM agents WHERE id = ?`).run(agentId);
    this.db.query(`UPDATE tunnels SET agent_id = NULL WHERE agent_id = ?`).run(agentId);
  }

  authenticateAgent(agentId: string, secret: string): AgentRecord | null {
    const agent = this.getAgent(agentId);
    if (!agent || !agent.enabled) return null;
    return secretsMatch(agent.secretHash, secret) ? agent : null;
  }

  touchAgent(agentId: string, heartbeatAt: number, latencyMs: number | null, remoteAddress: string | null): void {
    this.db.query(`
      UPDATE agents
      SET last_heartbeat = ?, latency_ms = ?, remote_address = ?
      WHERE id = ?
    `).run(heartbeatAt, latencyMs, remoteAddress, agentId);
  }

  updateAgentVersion(agentId: string, version: string): void {
    this.db.query(`UPDATE agents SET version = ? WHERE id = ?`).run(version, agentId);
  }

  setAgentConnections(agentId: string, activeConnections: number): void {
    this.db.query(`UPDATE agents SET active_connections = ? WHERE id = ?`).run(activeConnections, agentId);
  }

  listTunnels(): TunnelRecord[] {
    return this.db.query(`
      SELECT id, name, type, listen_port as listenPort, target_host as targetHost,
             target_port as targetPort, agent_id as agentId, enabled, created_at as createdAt
      FROM tunnels
      ORDER BY created_at DESC
    `).all().map((row: any) => ({
      id: String(row.id),
      name: String(row.name),
      type: row.type as TunnelType,
      listenPort: Number(row.listenPort),
      targetHost: String(row.targetHost),
      targetPort: Number(row.targetPort),
      agentId: row.agentId === null || row.agentId === undefined ? null : String(row.agentId),
      enabled: Boolean(row.enabled),
      createdAt: Number(row.createdAt)
    }));
  }

  getTunnel(tunnelId: string): TunnelRecord | null {
    const row = this.db.query(`
      SELECT id, name, type, listen_port as listenPort, target_host as targetHost,
             target_port as targetPort, agent_id as agentId, enabled, created_at as createdAt
      FROM tunnels WHERE id = ?
    `).get(tunnelId) as any;
    return row ? {
      id: String(row.id),
      name: String(row.name),
      type: row.type as TunnelType,
      listenPort: Number(row.listenPort),
      targetHost: String(row.targetHost),
      targetPort: Number(row.targetPort),
      agentId: row.agentId === null || row.agentId === undefined ? null : String(row.agentId),
      enabled: Boolean(row.enabled),
      createdAt: Number(row.createdAt)
    } : null;
  }

  createTunnel(input: Omit<TunnelRecord, 'id' | 'createdAt'>): TunnelRecord {
    const tunnel: TunnelRecord = {
      id: randomId('tun_'),
      createdAt: nowMs(),
      ...input
    };
    this.db.query(`
      INSERT INTO tunnels (id, name, type, listen_port, target_host, target_port, agent_id, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tunnel.id,
      tunnel.name,
      tunnel.type,
      tunnel.listenPort,
      tunnel.targetHost,
      tunnel.targetPort,
      tunnel.agentId,
      tunnel.enabled ? 1 : 0,
      tunnel.createdAt
    );
    return tunnel;
  }

  updateTunnel(tunnelId: string, patch: Partial<Omit<TunnelRecord, 'id' | 'createdAt'>>): TunnelRecord | null {
    const current = this.getTunnel(tunnelId);
    if (!current) return null;
    const next: TunnelRecord = {
      ...current,
      ...patch,
      agentId: patch.agentId === undefined ? current.agentId : patch.agentId,
      enabled: patch.enabled === undefined ? current.enabled : patch.enabled
    };
    this.db.query(`
      UPDATE tunnels
      SET name = ?, type = ?, listen_port = ?, target_host = ?, target_port = ?, agent_id = ?, enabled = ?
      WHERE id = ?
    `).run(next.name, next.type, next.listenPort, next.targetHost, next.targetPort, next.agentId, next.enabled ? 1 : 0, tunnelId);
    return next;
  }

  deleteTunnel(tunnelId: string): void {
    this.db.query(`DELETE FROM tunnels WHERE id = ?`).run(tunnelId);
  }

  setTunnelEnabled(tunnelId: string, enabled: boolean): TunnelRecord | null {
    return this.updateTunnel(tunnelId, { enabled });
  }

  listTunnelsForAgent(agentId: string): TunnelRecord[] {
    return this.listTunnels().filter(tunnel => tunnel.enabled && tunnel.agentId === agentId);
  }
}