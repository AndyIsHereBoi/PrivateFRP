import tls from "tls";
import net from "net";
import fs from "fs";
import {
  FrameDecoder,
  encodeFrame,
  MsgType,
  type AgentHelloBody,
  type DataConnHelloBody,
  type PoolHelloBody,
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
  publicIp: string;
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
      publicIp: this.config.publicIp,
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
   * (AgentHello) or a data connection (DataConnHello).
   */
  private handleIncomingConnection(socket: tls.TLSSocket): void {
    const decoder = new FrameDecoder();
    let classified = false;

    // Keep a named reference so the listener can be removed for non-control
    // connections before the socket transitions to raw-pipe mode.
    const onData = (chunk: Buffer) => decoder.push(chunk);

    const onFirstFrame = (frame: { msgType: number; body: unknown }) => {
      classified = true;
      decoder.onFrame = null;

      if (frame.msgType === MsgType.AgentHello) {
        // Control connections reuse the same decoder and keep the data listener;
        // handleControlConnection just swaps decoder.onFrame for subsequent frames.
        this.handleControlConnection(socket, decoder, frame.body as AgentHelloBody);
      } else if (frame.msgType === MsgType.DataConnHello) {
        // Stop the classification decoder and remove its listener before handing
        // the socket off as a raw data pipe. Without this, tunnel response data
        // (e.g. "HTTP/1.1 200 OK...") would be fed back through the decoder and
        // trigger a spurious "Invalid frame length" error.
        const leftover = decoder.detach();
        socket.removeListener("data", onData);
        // Re-inject any bytes that arrived in the same segment as DataConnHello
        // so that the pipe picks them up as the first data.
        if (leftover.length > 0) socket.unshift(leftover);
        this.handleDataConnection(socket, frame.body as DataConnHelloBody);
      } else if (frame.msgType === MsgType.PoolHello) {
        // Pre-warmed pool connection from the agent — hand off to the pool.
        // Switch to raw mode exactly as with DataConnHello; the socket will
        // be written to directly when a client connects (DialAssign + pipe).
        const leftover = decoder.detach();
        socket.removeListener("data", onData);
        if (leftover.length > 0) socket.unshift(leftover);
        const body = frame.body as PoolHelloBody;
        this.agentManager.addToPool(body.agentId, socket);
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

    socket.on("data", onData);

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
}
