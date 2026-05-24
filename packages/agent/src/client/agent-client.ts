import { connect } from "bun";
import type { AgentConfigPayload } from "@privatefrp/shared";
import { loadTrustedCertificates, saveTrustedCertificates, validateServerCertificate } from "../utils/cert-validator.js";

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
  private socket: any | null = null;
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
    // Get TLS socket info to extract certificate
    const tlsSocket = await connect({
      hostname: this.config.serverHost,
      port: this.config.serverPort,
      tls: true,
      socket: {
        open: (socket: any) => {
          this.socket = socket;
        },
        data: (_socket: any, chunk: Buffer) => {
          console.log("Received data:", chunk);
        },
        error: (_socket: any, err: Error) => {
          console.error(`Socket error: ${err.message}`);
        },
        close: () => {
          console.log("Connection closed");
          this.connected = false;
        },
      },
    });

    // Get the server certificate from TLS socket
    const certInfo = tlsSocket.getPeerCertificate();
    const serverCert = certInfo.raw ? certInfo.raw.toString('base64') : '';

    if (!serverCert) {
      console.error("Failed to retrieve server certificate");
      throw new Error("No certificate received from server");
    }

    // Validate the certificate
    const isValid = await validateServerCertificate(serverCert);

    if (!isValid) {
      console.error("Server certificate does not match trusted certificate");
      console.log("This could indicate a man-in-the-middle attack or server certificate change");
      process.exit(1);
    }

    // If no trusted cert was stored, save this one
    const existingTrusted = await loadTrustedCertificates();
    if (!existingTrusted) {
      await saveTrustedCertificates(serverCert);
      console.log(`Server certificate saved to trusted certificates`);
    }
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
