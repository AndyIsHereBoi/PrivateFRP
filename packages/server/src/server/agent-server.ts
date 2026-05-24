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

    // Load or generate self-signed certificate
    const { loadOrCreateCertificate, getDefaultCertPaths } = await import("../utils/cert-generator.js");
    const paths = getDefaultCertPaths();
    const { cert, key } = await loadOrCreateCertificate(paths.cert, paths.key);

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
    console.log(`New agent connection from ${socket.remoteAddress}:${socket.remotePort}`);

    const connection = new AgentConnection(socket.remoteAddress || "unknown", socket);
    this.agents.set(connection.id, connection);

    socket.onclose = () => {
      console.log(`Agent disconnected: ${connection.id}`);
      this.agents.delete(connection.id);
    };
  }
}

/**
 * Represents a connected agent
 */
export class AgentConnection {
  public id: string;
  private socket: TLSSocket;

  constructor(id: string, socket: TLSSocket) {
    this.id = id;
    this.socket = socket;
  }

  /**
   * Send data to the agent
   */
  send(data: Uint8Array): void {
    if (this.socket.writable) {
      this.socket.write(data);
    }
  }

  /**
   * Close the connection
   */
  close(): void {
    this.socket.end();
  }
}
