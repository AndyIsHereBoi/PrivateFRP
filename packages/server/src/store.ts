import { Database } from 'bun:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hashSecret, nowMs, randomId, randomSecret, secretsMatch } from '@privatefrp/shared';
import type { AgentRecord, TunnelRecord, TunnelType } from '@privatefrp/shared';

export class ServerStore {
  private readonly db: Database;

  constructor(private readonly databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS _migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        applied_at INTEGER NOT NULL
      );
    `);

    this.runMigrations();
  }

  private runMigrations(): void {
    const applied = new Set(
      this.db.query(`SELECT name FROM _migrations`).all().map((r: any) => String(r.name))
    );

    const migrationsDir = join(dirname(import.meta.dir ?? __dirname), 'migrations');
    const files = readdirSync(migrationsDir).sort();
    for (const file of files) {
      if (!file.endsWith('.sql')) continue;
      const name = file.replace(/\.sql$/, '');
      if (applied.has(name)) continue;
      const sql = readFileSync(join(migrationsDir, file), 'utf-8').trim();
      if (!sql) continue;
      try {
        this.db.exec(sql);
        this.db.query(`INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`).run(name, nowMs());
        console.log(`[migration] applied ${name}`);
      } catch (err) {
        const msg = String(err);
        // "duplicate column" means the column already exists (fresh DB has it in base schema)
        // still mark migration as applied so we don't retry on every restart
        if (msg.includes('duplicate column')) {
          this.db.query(`INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, ?)`).run(name, nowMs());
          console.log(`[migration] applied ${name} (column already existed)`);
        } else {
          console.log(`[migration] skipped ${name} (${err})`);
        }
      }
    }
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

  // ---- Sessions ----

  private readonly SESSION_TTL_MS = 120 * 24 * 60 * 60 * 1000; // 120 days

  createSession(ipAddress: string | null, userAgent: string | null): string {
    const token = randomSecret(32);
    const tokenHash = hashSecret(token);
    const now = nowMs();
    const id = randomId('sess_');
    this.db.query(`
      INSERT INTO sessions (id, token_hash, ip_address, user_agent, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, tokenHash, ipAddress, userAgent, now, now);
    return token;
  }

  validateSession(token: string): { id: string; ipAddress: string | null; userAgent: string | null; createdAt: number; lastUsedAt: number } | null {
    const tokenHash = hashSecret(token);
    const row = this.db.query(`
      SELECT id, ip_address as ipAddress, user_agent as userAgent,
             created_at as createdAt, last_used_at as lastUsedAt
      FROM sessions WHERE token_hash = ?
    `).get(tokenHash) as any;
    if (!row) return null;

    const age = nowMs() - Number(row.lastUsedAt);
    if (age > this.SESSION_TTL_MS) {
      this.db.query(`DELETE FROM sessions WHERE id = ?`).run(row.id);
      return null;
    }

    this.db.query(`UPDATE sessions SET last_used_at = ? WHERE id = ?`).run(nowMs(), row.id);
    return {
      id: String(row.id),
      ipAddress: row.ipAddress === null || row.ipAddress === undefined ? null : String(row.ipAddress),
      userAgent: row.userAgent === null || row.userAgent === undefined ? null : String(row.userAgent),
      createdAt: Number(row.createdAt),
      lastUsedAt: Number(row.lastUsedAt)
    };
  }

  deleteSession(id: string): void {
    this.db.query(`DELETE FROM sessions WHERE id = ?`).run(id);
  }

  deleteSessionByToken(token: string): void {
    const tokenHash = hashSecret(token);
    this.db.query(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash);
  }

  listSessions(): Array<{ id: string; ipAddress: string | null; userAgent: string | null; createdAt: number; lastUsedAt: number }> {
    return this.db.query(`
      SELECT id, ip_address as ipAddress, user_agent as userAgent,
             created_at as createdAt, last_used_at as lastUsedAt
      FROM sessions ORDER BY last_used_at DESC
    `).all().map((row: any) => ({
      id: String(row.id),
      ipAddress: row.ipAddress === null || row.ipAddress === undefined ? null : String(row.ipAddress),
      userAgent: row.userAgent === null || row.userAgent === undefined ? null : String(row.userAgent),
      createdAt: Number(row.createdAt),
      lastUsedAt: Number(row.lastUsedAt)
    }));
  }
}