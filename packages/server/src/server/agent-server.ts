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

    const server = this;
    this.server = Bun.listen({
      hostname: "0.0.0.0",
      port: this.port,
      tls: {
        key: Bun.file(key),
        cert: Bun.file(cert)
      },
      socket: {
        open(socket) {
          console.log(`New agent connection from ${socket.remoteAddress}:${socket.remotePort}`);
          const connection = new AgentConnection(socket.remoteAddress || "unknown", socket);
          server.agents.set(connection.id, connection);

          socket.close = () => {
            console.log(`Agent disconnected: ${connection.id}`);
            server.agents.delete(connection.id);
          };
        }
      }
    });

    console.log(`Agent server listening on 0.0.0.0:${this.port}`);
  }

  /**
   * Stop the agent server
   */
  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close(() => {
        resolve();
      });
    });
  }
}

/**
 * Represents a connected agent
 */
export class AgentConnection {
  public id: string;
  private socket: any;

  constructor(id: string, socket: any) {
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
