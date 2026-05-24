import { connect, type Socket } from "bun";
import type { AgentConfigPayload } from "@privatefrp/shared";

/**
 * Configuration for the agent client
 */
export interface AgentClientConfig {
  serverHost: string;
  serverPort: number;
  agentId: string;
  agentSecret: string;
}

/**
 * AgentClient handles connection to the PrivateFRP server
 */
export class AgentClient {
  private config: AgentClientConfig;
  private tunnelManager: any;
  private socket: Socket | null = null;
  private connected: boolean = false;

  constructor(config: AgentClientConfig, tunnelManager: any) {
    this.config = config;
    this.tunnelManager = tunnelManager;
  }

  /**
   * Start the agent client
   */
  async start(): Promise<void> {
    console.log(`Connecting to server ${this.config.serverHost}:${this.config.serverPort}...`);

    while (true) {
      try {
        await this.connect();
        this.connected = true;

        const helloPayload = JSON.stringify({
          version: "1.0",
          agentId: this.config.agentId,
          secret: this.config.agentSecret,
        });

        this.socket?.write(helloPayload);

        console.log("Agent connected successfully");
        break;
      } catch (err) {
        console.error(`Connection failed: ${(err as Error).message}`);
        console.log("Retrying in 5 seconds...");
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  /**
   * Connect to the server
   */
  private async connect(): Promise<void> {
    this.socket = await connect({
      hostname: this.config.serverHost,
      port: this.config.serverPort,
      tls: true,
      socket: {
        open: (socket) => {
          this.socket = socket;
        },
        data: (_socket, chunk) => {
          console.log("Received data:", chunk);
        },
        error: (_socket, err) => {
          console.error(`Socket error: ${err.message}`);
        },
        close: () => {
          console.log("Connection closed");
          this.connected = false;
        },
      },
    });
  }

  /**
   * Stop the agent client
   */
  async stop(): Promise<void> {
    if (this.socket) {
      this.socket.close();
    }
  }

  /**
   * Handle configuration push from server
   */
  handleConfigPush(payload: AgentConfigPayload): void {
    console.log(`Received config for ${payload.tunnels.length} tunnels`);
    this.tunnelManager.updateTunnels(payload.tunnels);
  }

  /**
   * Send heartbeat to server
   */
  sendHeartbeat(): void {
    if (!this.connected || !this.socket) return;

    const payload = JSON.stringify({
      timestamp: Date.now(),
    });

    this.socket.write(payload);

    console.log("Heartbeat sent");
  }
}
