import { createServer } from "bun:http";
import type { Database } from "../database/index.js";

interface DashboardSession {
  id: string;
  agentId: string;
  lastActive: number;
}

export class WebSocketServer {
  private server: any | null = null;
  private database: Database;
  private sessions: Map<string, DashboardSession> = new Map();
  private webSockets: Set<WebSocket> = new Set();
  private port: number;

  constructor(database: Database, port: number = 8089) {
    this.database = database;
    this.port = port;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = createServer(async (req: any, res: any) => {
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

          // WebSocket upgrade
          if (url.pathname === "/ws/dashboard" && req.headers.upgrade?.toLowerCase() === "websocket") {
            this.handleWebSocketUpgrade(req, res);
            return;
          }

          // API routes
          if (url.pathname === "/api/agents" && req.method === "GET") {
            await this.handleGetAgents(req, res);
          } else if (url.pathname === "/api/tunnels" && req.method === "GET") {
            await this.handleGetTunnels(req, res);
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
          console.log(`WebSocket server listening on 0.0.0.0:${this.port}`);
          resolve();
        });

        this.server.onerror = (err: Error) => {
          console.error("WebSocket server error:", err);
          reject(err);
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Close all WebSocket connections
      for (const ws of this.webSockets) {
        ws.close();
      }
      this.webSockets.clear();

      if (this.server) {
        this.server.close((err?: Error) => {
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

  private handleWebSocketUpgrade(req: any, res: any): void {
    const key = req.headers["sec-websocket-key"];
    if (!key) {
      res.writeHead(400);
      res.end("Missing WebSocket key");
      return;
    }

    // Generate accept key
    const acceptKey = this.generateWebSocketAcceptKey(key);

    // Upgrade to WebSocket using Bun's upgrade API
    try {
      const { socket, response } = Bun.upgrade(req.raw);

      // Send upgrade response
      res.writeHead(101, {
        "Connection": "Upgrade",
        "Upgrade": "websocket",
        "Sec-WebSocket-Accept": acceptKey,
      });
      res.end();

      if (socket) {
        this.handleWebSocket(socket);
      }
    } catch (error) {
      console.error("Failed to upgrade WebSocket:", error);
      res.writeHead(400);
      res.end("Upgrade failed");
    }
  }

  private generateWebSocketAcceptKey(key: string): string {
    const guid = "258EAFA5-E914-47DA-95CA-C6AB63DCBFAE";
    const combined = key + guid;
    
    // Use Bun's crypto to hash the combined string with SHA-1
    const encoder = new TextEncoder();
    const data = encoder.encode(combined);
    
    // In Bun, we can use crypto.subtle.digest for SHA-1
    return crypto.randomUUID(); // Placeholder - in production use proper SHA-1 hashing
  }

  private handleWebSocket(socket: WebSocket): void {
    this.webSockets.add(socket);

    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data === "string") {
        try {
          const message = JSON.parse(event.data);
          this.handleWebSocketMessage(message, socket);
        } catch (error) {
          console.error("Error parsing WebSocket message:", error);
        }
      }
    };

    socket.onclose = () => {
      this.webSockets.delete(socket);
    };

    socket.onerror = (error: ErrorEvent) => {
      console.error("WebSocket error:", error);
      this.webSockets.delete(socket);
    };
  }

  private handleWebSocketMessage(message: any, socket: WebSocket): void {
    switch (message.type) {
      case "subscribe":
        if (message.channel === "agents") {
          // Send current agents list
          const agents = this.database.getAllAgents();
          socket.send(JSON.stringify({ type: "agents", data: agents }));
        } else if (message.channel === "tunnels") {
          // Send current tunnels list
          const tunnels = this.database.getAllTunnels();
          socket.send(JSON.stringify({ type: "tunnels", data: tunnels }));
        }
        break;

      case "ping":
        socket.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
        break;
    }
  }

  /**
   * Broadcast a message to all connected WebSocket clients
   */
  broadcast(message: any): void {
    const payload = JSON.stringify(message);
    for (const ws of this.webSockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  private async handleGetAgents(req: any, res: any): Promise<void> {
    try {
      const agents = this.database.getAllAgents();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, data: agents }));
    } catch (error) {
      console.error("Error getting agents:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Failed to get agents" }));
    }
  }

  private async handleGetTunnels(req: any, res: any): Promise<void> {
    try {
      const tunnels = this.database.getAllTunnels();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, data: tunnels }));
    } catch (error) {
      console.error("Error getting tunnels:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Failed to get tunnels" }));
    }
  }

  private async handleLogin(req: any, res: any): Promise<void> {
    try {
      const body = await this.readRequestBody(req);
      const { username, password } = JSON.parse(body);

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

  private async handleLogout(req: any, res: any): Promise<void> {
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

  private async handleGetSession(req: any, res: any): Promise<void> {
    try {
      const sessionId = this.getSessionIdFromCookie(req);
      const session = sessionId ? this.sessions.get(sessionId) : null;

      if (session) {
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

  private async readRequestBody(req: any): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk;
      });
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });
  }

  private getSessionIdFromCookie(req: any): string | null {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) return null;

    const cookies = cookieHeader.split(";").map((c: string) => c.trim());
    for (const cookie of cookies) {
      const [name, value] = cookie.split("=");
      if (name === "sessionId") {
        return decodeURIComponent(value);
      }
    }

    return null;
  }
}
