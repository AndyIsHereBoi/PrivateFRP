import { createServer } from "bun:tls";
import type { TLSSocket } from "bun:tls";

/**
 * AgentServer handles connections from PrivateFRP agents
 */
export class AgentServer {
  private port: number;
  private server: any;
  private agents: Map<string, AgentConnection> = new Map();

  constructor(port: number) {
    this.port = port;
  }

  /**
   * Start the agent server
   */
  async start(): Promise<void> {
    console.log(`Agent server starting on port ${this.port}...`);

    // Generate self-signed certificate if not found
    const { generateCert } = await import("../utils/cert-generator.js");
    const { cert, key } = generateCert();

    this.server = createServer({ cert, key }, (socket) => {
      this.handleAgentConnection(socket);
    });

    return new Promise((resolve, reject) => {
      this.server.listen(this.port, () => {
        console.log(`Agent server listening on port ${this.port}`);
        resolve();
      });
      this.server.onerror = (err: Error) => {
        console.error(`Agent server error: ${err.message}`);
        reject(err);
      };
    });
  }

  /**
   * Stop the agent server
   */
  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err?: Error) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Handle a new agent connection
   */
  private handleAgentConnection(socket: TLSSocket): void {
    const agentId = socket.remoteAddress + ":" + socket.remotePort;
    console.log(`New agent connection from ${agentId}`);

    const connection = new AgentConnection(agentId, socket);
    this.agents.set(agentId, connection);

    socket.onclose = () => {
      console.log(`Agent disconnected: ${agentId}`);
      this.agents.delete(agentId);
    };
  }

  /**
   * Get all connected agents
   */
  getAgents(): Map<string, AgentConnection> {
    return this.agents;
  }
}

/**
 * Represents a connection to an agent
 */
export class AgentConnection {
  public id: string;
  public socket: TLSSocket;
  private lastHeartbeat: number = Date.now();

  constructor(id: string, socket: TLSSocket) {
    this.id = id;
    this.socket = socket;
  }

  /**
   * Update the last heartbeat time
   */
  updateHeartbeat(): void {
    this.lastHeartbeat = Date.now();
  }

  /**
   * Get the latency in milliseconds
   */
  getLatency(): number {
    return Date.now() - this.lastHeartbeat;
  }

  /**
   * Check if the agent is healthy (heartbeat within last 30 seconds)
   */
  isHealthy(): boolean {
    return Date.now() - this.lastHeartbeat < 30000;
  }
}
