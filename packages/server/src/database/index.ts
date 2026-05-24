import { Database as SQLiteDatabase } from "bun:sqlite";

/**
 * Database class for managing SQLite connections
 */
export class Database {
  private db: SQLiteDatabase;

  constructor(path: string) {
    this.db = new SQLiteDatabase(path);
    this.initSchema();
  }

  /**
   * Initialize the database schema
   */
  private initSchema(): void {
    // Create agents table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        secret TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL
      )
    `);

    // Create tunnels table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS tunnels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('tcp', 'udp', 'tcp+udp')),
        listen_port INTEGER NOT NULL,
        target_host TEXT NOT NULL,
        target_port INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (agent_id) REFERENCES agents(id)
      )
    `);
  }

  /**
   * Check if an agent exists and is valid
   */
  validateAgent(agentId: string, secret: string): boolean {
    const stmt = this.db.query("SELECT id FROM agents WHERE id = ? AND secret = ? AND enabled = 1");
    const result = stmt.get([agentId, secret]);
    return !!result;
  }

  /**
   * Get all enabled tunnels for an agent
   */
  getAgentTunnels(agentId: string): Array<{
    id: string;
    name: string;
    type: "tcp" | "udp" | "tcp+udp";
    listenPort: number;
    targetHost: string;
    targetPort: number;
    enabled: boolean;
    createdAt: number;
  }> {
    const stmt = this.db.query(`
      SELECT id, name, type, listen_port, target_host, target_port, enabled, created_at 
      FROM tunnels 
      WHERE agent_id = ? AND enabled = 1
    `);
    
    return stmt.all([agentId]) as Array<any>;
  }

  /**
   * Get all agents
   */
  getAllAgents(): Array<{
    id: string;
    name: string;
    enabled: boolean;
    createdAt: number;
  }> {
    const stmt = this.db.query(`
      SELECT id, name, enabled, created_at 
      FROM agents 
      ORDER BY created_at DESC
    `);
    
    return stmt.all() as Array<any>;
  }

  /**
   * Get all tunnels with agent info
   */
  getAllTunnels(): Array<{
    id: string;
    name: string;
    type: "tcp" | "udp" | "tcp+udp";
    listenPort: number;
    targetHost: string;
    targetPort: number;
    enabled: boolean;
    createdAt: number;
    agentId: string;
    agentName: string;
  }> {
    const stmt = this.db.query(`
      SELECT t.id, t.name, t.type, t.listen_port, t.target_host, t.target_port, 
             t.enabled, t.created_at, t.agent_id, a.name as agent_name
      FROM tunnels t
      JOIN agents a ON t.agent_id = a.id
      WHERE t.enabled = 1
      ORDER BY t.created_at DESC
    `);
    
    return stmt.all() as Array<any>;
  }

  /**
   * Create a new tunnel
   */
  createTunnel(tunnel: {
    id: string;
    name: string;
    type: "tcp" | "udp" | "tcp+udp";
    listenPort: number;
    targetHost: string;
    targetPort: number;
    agentId: string;
  }): boolean {
    const now = Date.now();
    this.db.run(
      `INSERT INTO tunnels (id, name, type, listen_port, target_host, target_port, agent_id, enabled, created_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [tunnel.id, tunnel.name, tunnel.type, tunnel.listenPort, tunnel.targetHost, tunnel.targetPort, tunnel.agentId, now]
    );
    return true;
  }

  /**
   * Delete a tunnel
   */
  deleteTunnel(id: string): boolean {
    this.db.run("DELETE FROM tunnels WHERE id = ?", [id]);
    return true;
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }
}
