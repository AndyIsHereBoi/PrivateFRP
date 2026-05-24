// @bun
var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};

// packages/server/src/utils/cert-generator.ts
var exports_cert_generator = {};
__export(exports_cert_generator, {
  loadOrCreateCertificate: () => loadOrCreateCertificate,
  getDefaultCertPaths: () => getDefaultCertPaths,
  generateCert: () => generateCert
});
function generatePlaceholderCert() {
  const privateKey = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHmJYz51xkPbX6f4h2R9
-----END RSA PRIVATE KEY-----`;
  const certificate = `-----BEGIN CERTIFICATE-----
MIIDXTCCAkWgAwIBAgIJAJC1HiIAZAiUMA0GCSqGSIb3DQEBCwUAME0xCzAJBgNV
BAYTAlVTMREwDwYDVQQKDAhQcml2YXRlRlJQMRgwFgYDVQQDDA9sb2NhbGhvc3Qw
-----END CERTIFICATE-----`;
  return { cert: certificate, key: privateKey };
}
function generateCert() {
  console.warn("Warning: Using placeholder certificate. For production, use openssl to generate certificates.");
  return generatePlaceholderCert();
}
function loadOrCreateCertificate(certPath, keyPath) {
  console.log("Generating certificates...");
  return generateCert();
}
function getDefaultCertPaths() {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  return {
    cert: `${home}/.privatefrp/server.crt`,
    key: `${home}/.privatefrp/server.key`
  };
}

// packages/server/src/server/agent-server.ts
import { createServer } from "tls";

class AgentServer {
  port;
  server;
  agents = new Map;
  constructor(port) {
    this.port = port;
  }
  async start() {
    console.log(`Agent server starting on port ${this.port}...`);
    const { generateCert: generateCert2 } = await Promise.resolve().then(() => exports_cert_generator);
    const { cert, key } = generateCert2();
    this.server = createServer({ cert, key }, (socket) => {
      this.handleAgentConnection(socket);
    });
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, () => {
        console.log(`Agent server listening on port ${this.port}`);
        resolve();
      });
      this.server.onerror = (err) => {
        console.error(`Agent server error: ${err.message}`);
        reject(err);
      };
    });
  }
  async stop() {
    return new Promise((resolve, reject) => {
      this.server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }
  handleAgentConnection(socket) {
    const agentId = socket.remoteAddress + ":" + socket.remotePort;
    console.log(`New agent connection from ${agentId}`);
    const connection = new AgentConnection(agentId, socket);
    this.agents.set(agentId, connection);
    socket.onclose = () => {
      console.log(`Agent disconnected: ${agentId}`);
      this.agents.delete(agentId);
    };
  }
  getAgents() {
    return this.agents;
  }
}

class AgentConnection {
  id;
  socket;
  lastHeartbeat = Date.now();
  constructor(id, socket) {
    this.id = id;
    this.socket = socket;
  }
  updateHeartbeat() {
    this.lastHeartbeat = Date.now();
  }
  getLatency() {
    return Date.now() - this.lastHeartbeat;
  }
  isHealthy() {
    return Date.now() - this.lastHeartbeat < 30000;
  }
}

// packages/server/src/server/dashboard-server.ts
import { createServer as createServer2 } from "http";

class DashboardServer {
  server = null;
  database;
  sessions = new Map;
  port;
  constructor(database, port = 8089) {
    this.database = database;
    this.port = port;
  }
  start() {
    return new Promise((resolve, reject) => {
      try {
        this.server = createServer2(async (req, res) => {
          const url = new URL(req.url || "/", `http://${req.headers.host}`);
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
          res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
          if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
          }
          if (url.pathname === "/api/agents" && req.method === "GET") {
            await this.handleGetAgents(req, res);
          } else if (url.pathname === "/api/tunnels" && req.method === "GET") {
            await this.handleGetTunnels(req, res);
          } else if (url.pathname === "/api/tunnels" && req.method === "POST") {
            await this.handleCreateTunnel(req, res);
          } else if (url.pathname.startsWith("/api/tunnels/") && req.method === "DELETE") {
            const tunnelId = url.pathname.split("/").pop();
            await this.handleDeleteTunnel(tunnelId || "", res);
          } else if (url.pathname === "/login" && req.method === "POST") {
            await this.handleLogin(req, res);
          } else if (url.pathname === "/logout" && req.method === "POST") {
            await this.handleLogout(req, res);
          } else if (url.pathname === "/api/session" && req.method === "GET") {
            await this.handleGetSession(req, res);
          } else {
            res.writeHead(404);
            res.end(JSON.stringify({ error: "Not found" }));
          }
        });
        this.server.listen(this.port, () => {
          console.log(`Dashboard server listening on port ${this.port}`);
          resolve();
        });
        this.server.onerror = (err) => {
          console.error("Dashboard server error:", err);
          reject(err);
        };
      } catch (error) {
        reject(error);
      }
    });
  }
  stop() {
    return new Promise((resolve, reject) => {
      if (this.server) {
        this.server.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }
  async handleGetAgents(req, res) {
    try {
      const agents = await this.database.getAllAgents();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, data: agents }));
    } catch (error) {
      console.error("Error getting agents:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Failed to get agents" }));
    }
  }
  async handleGetTunnels(req, res) {
    try {
      const tunnels = await this.database.getAllTunnels();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, data: tunnels }));
    } catch (error) {
      console.error("Error getting tunnels:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Failed to get tunnels" }));
    }
  }
  async handleCreateTunnel(req, res) {
    try {
      const body = await this.readRequestBody(req);
      const { agentId, publicPort, localAddress, tunnelType } = JSON.parse(body);
      if (!agentId || !publicPort || !localAddress || !tunnelType) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Missing required fields" }));
        return;
      }
      const tunnel = await this.database.createTunnel({
        id: crypto.randomUUID(),
        name: `${localAddress}:${publicPort}`,
        type: tunnelType,
        listenPort: publicPort,
        targetHost: localAddress.split(":")[0],
        targetPort: parseInt(localAddress.split(":")[1] || "80"),
        agentId
      });
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, data: tunnel }));
    } catch (error) {
      console.error("Error creating tunnel:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Failed to create tunnel" }));
    }
  }
  async handleDeleteTunnel(tunnelId, res) {
    try {
      await this.database.deleteTunnel(tunnelId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    } catch (error) {
      console.error("Error deleting tunnel:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Failed to delete tunnel" }));
    }
  }
  async handleLogin(req, res) {
    try {
      const body = await this.readRequestBody(req);
      const { username, password } = JSON.parse(body);
      if (username === "admin" && password === "password") {
        const sessionId = crypto.randomUUID();
        this.sessions.set(sessionId, {
          id: sessionId,
          agentId: "admin",
          lastActive: Date.now()
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, sessionId }));
      } else {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Invalid credentials" }));
      }
    } catch (error) {
      console.error("Error logging in:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Failed to login" }));
    }
  }
  async handleLogout(req, res) {
    try {
      const sessionId = this.getSessionIdFromCookie(req);
      if (sessionId) {
        this.sessions.delete(sessionId);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    } catch (error) {
      console.error("Error logging out:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Failed to logout" }));
    }
  }
  async handleGetSession(req, res) {
    try {
      const sessionId = this.getSessionIdFromCookie(req);
      const session = sessionId ? this.sessions.get(sessionId) : null;
      if (session) {
        session.lastActive = Date.now();
        this.sessions.set(sessionId, session);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, session }));
      } else {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Not authenticated" }));
      }
    } catch (error) {
      console.error("Error getting session:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Failed to get session" }));
    }
  }
  async readRequestBody(req) {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });
  }
  getSessionIdFromCookie(req) {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader)
      return null;
    const cookies = cookieHeader.split(";").map((c) => c.trim());
    for (const cookie of cookies) {
      const [name, value] = cookie.split("=");
      if (name === "sessionId") {
        return decodeURIComponent(value);
      }
    }
    return null;
  }
}

// packages/server/src/database/index.ts
import { Database as SQLiteDatabase } from "bun:sqlite";

class Database {
  db;
  constructor(path) {
    this.db = new SQLiteDatabase(path);
    this.initSchema();
  }
  initSchema() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        secret TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL
      )
    `);
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
  validateAgent(agentId, secret) {
    const stmt = this.db.query("SELECT id FROM agents WHERE id = ? AND secret = ? AND enabled = 1");
    const result = stmt.get([agentId, secret]);
    return !!result;
  }
  getAgentTunnels(agentId) {
    const stmt = this.db.query(`
      SELECT id, name, type, listen_port, target_host, target_port, enabled, created_at 
      FROM tunnels 
      WHERE agent_id = ? AND enabled = 1
    `);
    return stmt.all([agentId]);
  }
  getAllAgents() {
    const stmt = this.db.query(`
      SELECT id, name, enabled, created_at 
      FROM agents 
      ORDER BY created_at DESC
    `);
    return stmt.all();
  }
  getAllTunnels() {
    const stmt = this.db.query(`
      SELECT t.id, t.name, t.type, t.listen_port, t.target_host, t.target_port, 
             t.enabled, t.created_at, t.agent_id, a.name as agent_name
      FROM tunnels t
      JOIN agents a ON t.agent_id = a.id
      WHERE t.enabled = 1
      ORDER BY t.created_at DESC
    `);
    return stmt.all();
  }
  createTunnel(tunnel) {
    const now = Date.now();
    this.db.run(`INSERT INTO tunnels (id, name, type, listen_port, target_host, target_port, agent_id, enabled, created_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`, [tunnel.id, tunnel.name, tunnel.type, tunnel.listenPort, tunnel.targetHost, tunnel.targetPort, tunnel.agentId, now]);
    return true;
  }
  deleteTunnel(id) {
    this.db.run("DELETE FROM tunnels WHERE id = ?", [id]);
    return true;
  }
  close() {
    this.db.close();
  }
}

// packages/server/src/index.ts
console.log("PrivateFRP Server starting...");
var db = new Database("./data/privatefrp.db");
var agentServer = new AgentServer(7000);
var dashboardServer = new DashboardServer(db, 8089);
await agentServer.start();
await dashboardServer.start();
console.log("PrivateFRP Server started successfully");
