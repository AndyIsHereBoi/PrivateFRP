import { createServer } from "bun:http";
import type { Database } from "../database/index.js";

interface DashboardSession {
  id: string;
  agentId: string;
  lastActive: number;
}

export class DashboardServer {
  private server: HTTPServer | null = null;
  private database: Database;
  private sessions: Map<string, DashboardSession> = new Map();
  private port: number;

  constructor(database: Database, port: number = 8089) {
    this.database = database;
    this.port = port;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = createServer(async (req, res) => {
          const url = new URL(req.url || "/", `http://${req.headers.host}`);
          
          // Set CORS headers
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
          res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

          if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
          }

          // Route handling
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

        this.server.listen(this.port, "0.0.0.0", () => {
          console.log(`Dashboard server listening on 0.0.0.0:${this.port}`);
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

  stop(): Promise<void> {
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

  private async handleGetAgents(req: HTTPRequest, res: HTTPResponse): Promise<void> {
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

  private async handleGetTunnels(req: HTTPRequest, res: HTTPResponse): Promise<void> {
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

  private async handleCreateTunnel(req: HTTPRequest, res: HTTPResponse): Promise<void> {
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
        type: tunnelType as "tcp" | "udp" | "tcp+udp",
        listenPort: publicPort,
        targetHost: localAddress.split(":")[0],
        targetPort: parseInt(localAddress.split(":")[1] || "80"),
        agentId,
      });

      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, data: tunnel }));
    } catch (error) {
      console.error("Error creating tunnel:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Failed to create tunnel" }));
    }
  }

  private async handleDeleteTunnel(tunnelId: string, res: HTTPResponse): Promise<void> {
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

  private async handleLogin(req: HTTPRequest, res: HTTPResponse): Promise<void> {
    try {
      const body = await this.readRequestBody(req);
      const { username, password } = JSON.parse(body);

      // Simple authentication - in production, use proper password hashing
      if (username === "admin" && password === "password") {
        const sessionId = crypto.randomUUID();
        this.sessions.set(sessionId, {
          id: sessionId,
          agentId: "admin",
          lastActive: Date.now(),
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

  private async handleLogout(req: HTTPRequest, res: HTTPResponse): Promise<void> {
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

  private async handleGetSession(req: HTTPRequest, res: HTTPResponse): Promise<void> {
    try {
      const sessionId = this.getSessionIdFromCookie(req);
      const session = sessionId ? this.sessions.get(sessionId) : null;

      if (session) {
        // Update last active
        session.lastActive = Date.now();
        this.sessions.set(sessionId!, session);

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

  private async readRequestBody(req: HTTPRequest): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });
  }

  private getSessionIdFromCookie(req: HTTPRequest): string | null {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) return null;

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
