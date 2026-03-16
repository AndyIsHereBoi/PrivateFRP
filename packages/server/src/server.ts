import tls from "tls";
import net from "net";
import fs from "fs";
import {
  FrameDecoder,
  encodeFrame,
  MsgType,
  type AgentHelloBody,
  type DataConnHelloBody,
  type StandbyHelloBody,
  type TunnelConfig,
} from "@privatefrp/shared";
import type { DB } from "./db";
import { AgentManager } from "./agentManager";
import { TunnelManager } from "./tunnelManager";
import { startDashboard } from "./dashboard";

export interface ServerConfig {
  agentPort: number;
  dashboardPort: number;
  tlsCert: string;
  tlsKey: string;
  dashboardSecret: string; // "user:pass"
  dataDir: string;
}

export class Server {
  private config: ServerConfig;
  private db: DB;
  private agentManager: AgentManager;
  private tunnelManager: TunnelManager;
  private tlsServer!: tls.Server;

  constructor(config: ServerConfig, db: DB) {
    this.config = config;
    this.db = db;
    this.agentManager = new AgentManager();
    this.tunnelManager = new TunnelManager(this.agentManager);
  }

  async start(): Promise<void> {
    // Load initial tunnels into the TunnelManager
    await this.reloadTunnels();

    // Start the TLS server for agent connections
    await this.startTlsServer();

    // Start dashboard
    const [dashUser, dashPass] = this.config.dashboardSecret.split(":", 2);
    startDashboard({
      port: this.config.dashboardPort,
      credentials: { user: dashUser, pass: dashPass },
      db: this.db,
      agentManager: this.agentManager,
      onTunnelsChanged: () => this.reloadTunnels(),
    });
  }

  private async reloadTunnels(): Promise<void> {
    const rows = this.db.listTunnels();
    const tunnels: TunnelConfig[] = rows.map((r) => this.db.rowToTunnelConfig(r));
    await this.tunnelManager.syncTunnels(tunnels);

    // Push updated config to all connected agents
    for (const agent of this.agentManager.getAll()) {
      const agentTunnels = tunnels.filter((t) => t.agentId === agent.agentId);
      try {
        agent.socket.write(encodeFrame(MsgType.ConfigPush, { tunnels: agentTunnels }));
        this.agentManager.updateTunnels(agent.agentId, agentTunnels);
      } catch {
        // Socket may be dead; ignore
      }
    }
  }

  private startTlsServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Server presents its own cert; agents authenticate via AgentHello (no mTLS).
      const tlsOptions: tls.TlsOptions = {
        cert: fs.readFileSync(this.config.tlsCert),
        key: fs.readFileSync(this.config.tlsKey),
      };

      this.tlsServer = tls.createServer(tlsOptions, (socket) => {
        this.handleIncomingConnection(socket);
      });

      this.tlsServer.on("error", (err) => {
        console.error("[Server] TLS server error:", err);
      });

      this.tlsServer.listen(this.config.agentPort, () => {
        console.log(`[Server] TLS server listening on port ${this.config.agentPort}`);
        resolve();
      });

      this.tlsServer.once("error", reject);
    });
  }

  /**
   * Peek at the first frame to determine if this is a control connection
   * (AgentHello), a data connection (DataConnHello), or a pre-warmed standby
   * connection (StandbyHello).
   */
  private handleIncomingConnection(socket: tls.TLSSocket): void {
    const decoder = new FrameDecoder();
    let classified = false;

    const onFirstFrame = (frame: { msgType: number; body: unknown }) => {
      classified = true;
      decoder.onFrame = null;

      if (frame.msgType === MsgType.AgentHello) {
        this.handleControlConnection(socket, decoder, frame.body as AgentHelloBody);
      } else if (frame.msgType === MsgType.DataConnHello) {
        this.handleDataConnection(socket, frame.body as DataConnHelloBody);
      } else if (frame.msgType === MsgType.StandbyHello) {
        this.handleStandbyConnection(socket, frame.body as StandbyHelloBody);
      } else {
        console.warn("[Server] Unknown first frame type:", frame.msgType);
        socket.destroy();
      }
    };

    decoder.onFrame = onFirstFrame;
    decoder.onError = (err) => {
      console.error("[Server] Frame decoder error on new connection:", err);
      socket.destroy();
    };

    socket.on("data", (chunk) => decoder.push(chunk));

    socket.on("error", (err) => {
      if (!classified) {
        console.warn("[Server] Connection error before classification:", err.message);
      }
    });

    // Timeout unclassified connections after 10s
    const classifyTimeout = setTimeout(() => {
      if (!classified) {
        console.warn("[Server] Connection timed out before classification");
        socket.destroy();
      }
    }, 10_000);

    socket.on("close", () => clearTimeout(classifyTimeout));
  }

  private handleControlConnection(
    socket: tls.TLSSocket,
    decoder: FrameDecoder,
    hello: AgentHelloBody,
  ): void {
    const { agentId, agentSecret } = hello;
    const agentRow = this.db.getAgent(agentId);

    if (!agentRow || agentRow.secret !== agentSecret) {
      console.warn(`[Server] Agent auth failed for id=${agentId}`);
      socket.write(
        encodeFrame(MsgType.ServerHello, {
          ok: false,
          message: "Authentication failed",
          tunnels: [],
        }),
      );
      socket.end();
      return;
    }

    console.log(`[Server] Agent connected: ${agentId} (${agentRow.name})`);

    // Send ServerHello with current tunnel config for this agent
    const tunnelRows = this.db.listTunnelsForAgent(agentId);
    const tunnels: TunnelConfig[] = tunnelRows.map((r) => this.db.rowToTunnelConfig(r));

    socket.write(
      encodeFrame(MsgType.ServerHello, {
        ok: true,
        message: "Welcome",
        tunnels,
      }),
    );

    const remoteAddress = socket.remoteAddress ?? "unknown";
    this.agentManager.register(agentId, socket, tunnels, remoteAddress);

    // Send a keepalive heartbeat every 5 seconds to prevent NAT/firewall timeouts.
    const heartbeatInterval = setInterval(() => {
      if (socket.destroyed) {
        clearInterval(heartbeatInterval);
        return;
      }
      try {
        socket.write(encodeFrame(MsgType.Heartbeat, { timestamp: Date.now() }));
      } catch {
        clearInterval(heartbeatInterval);
      }
    }, 5_000);

    // Handle frames from this control connection.
    // NOTE: the data listener from handleIncomingConnection() is still active and
    // pushes chunks to this same decoder, so we must NOT add another one here.
    decoder.onFrame = (frame) => {
      if (frame.msgType === MsgType.Heartbeat) {
        // Just record liveness — do NOT echo back, to avoid an infinite ping-pong loop.
        this.agentManager.updateHeartbeat(agentId);
      } else {
        console.warn(`[Server] Unexpected frame on control connection: type=0x${frame.msgType.toString(16)}`);
      }
    };

    decoder.onError = (err) => {
      console.error(`[Server] Control connection decoder error for agent ${agentId}:`, err);
      socket.destroy();
    };

    socket.on("close", () => {
      clearInterval(heartbeatInterval);
      this.agentManager.unregister(agentId);
      console.log(`[Server] Agent disconnected: ${agentId}`);
    });

    socket.on("error", (err) => {
      console.error(`[Server] Control socket error for agent ${agentId}:`, err.message);
    });
  }

  private handleDataConnection(socket: tls.TLSSocket, hello: DataConnHelloBody): void {
    const { requestId, agentId } = hello;
    const fulfilled = this.agentManager.fulfillDial(agentId, requestId, socket);
    if (!fulfilled) {
      console.warn(
        `[Server] No pending dial for agentId=${agentId} requestId=${requestId}; closing data conn`,
      );
      socket.destroy();
    }
  }

  private handleStandbyConnection(socket: tls.TLSSocket, hello: StandbyHelloBody): void {
    const { agentId } = hello;
    const added = this.agentManager.addStandby(agentId, socket);
    if (!added) {
      console.warn(`[Server] StandbyHello from unknown agent ${agentId}; closing`);
      socket.destroy();
    }
  }
}
