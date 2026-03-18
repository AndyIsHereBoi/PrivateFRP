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
  type StreamCloseBody,
  type StreamDataBody,
  type TunnelConfig,
} from "@privatefrp/shared";
import type { DB } from "./db";
import { AgentManager } from "./agentManager";
import { TunnelManager } from "./tunnelManager";
import { startDashboard } from "./dashboard";
import { tunnelLog } from "./logger";

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
  private probeNoiseCounters = new Map<string, { windowStart: number; count: number }>();

  constructor(config: ServerConfig, db: DB) {
    this.config = config;
    this.db = db;
    this.agentManager = new AgentManager();
    this.tunnelManager = new TunnelManager(this.agentManager, this.db);
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
      reservedPublicPorts: [this.config.agentPort, this.config.dashboardPort],
      onTunnelsChanged: () => this.reloadTunnels(),
    });
  }

  private async reloadTunnels(): Promise<void> {
    const rows = this.db.listTunnels();
    const enabledAgentIds = new Set(
      this.db
        .listAgents()
        .filter((a) => !!a.enabled)
        .map((a) => a.id),
    );
    const connectedAgentIds = new Set(this.agentManager.getAll().map((a) => a.agentId));
    const assignedTunnels: TunnelConfig[] = rows
      .filter((r) => !!r.agent_id && !!r.enabled && enabledAgentIds.has(r.agent_id) && connectedAgentIds.has(r.agent_id))
      .map((r) => this.db.rowToTunnelConfig(r));
    await this.tunnelManager.syncTunnels(assignedTunnels);

    // Push updated config to all connected agents
    for (const agent of this.agentManager.getAll()) {
      const agentTunnels = assignedTunnels.filter((t) => t.agentId === agent.agentId);
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
        tunnelLog.error("[Server] TLS server error:", err);
      });

      this.tlsServer.listen(this.config.agentPort, () => {
        tunnelLog.log(`[Server] TLS server listening on port ${this.config.agentPort}`);
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
        const leftover = decoder.detach();
        socket.removeListener("data", onData);
        socket.pause();
        if (leftover.length > 0) socket.unshift(leftover);
        this.handleDataConnection(socket, frame.body as DataConnHelloBody);
      } else if (frame.msgType === MsgType.PoolHello) {
        const leftover = decoder.detach();
        socket.removeListener("data", onData);
        socket.pause();
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
      const remote = socket.remoteAddress ?? "unknown";
      if (err.message.startsWith("Invalid frame length:")) {
        if (this.shouldLogProbeNoise(remote)) {
          tunnelLog.warn(`[Server] Dropped non-protocol TLS client from ${remote}: ${err.message}`);
        }
      } else {
        tunnelLog.warn(`[Server] Frame decoder error on new connection from ${remote}: ${err.message}`);
      }
      socket.destroy();
    };

    socket.on("data", onData);

    socket.on("error", (err) => {
      if (!classified) {
        tunnelLog.warn("[Server] Connection error before classification:", err.message);
      }
    });

    // Timeout unclassified connections after 10s
    const classifyTimeout = setTimeout(() => {
      if (!classified) {
        tunnelLog.warn("[Server] Connection timed out before classification");
        socket.destroy();
      }
    }, 10_000);

    socket.on("close", () => clearTimeout(classifyTimeout));
  }

  private shouldLogProbeNoise(remoteAddress: string): boolean {
    const now = Date.now();
    const key = remoteAddress;
    const existing = this.probeNoiseCounters.get(key);

    if (!existing || now - existing.windowStart >= 60_000) {
      this.probeNoiseCounters.set(key, { windowStart: now, count: 1 });
      return true;
    }

    existing.count += 1;

    // Keep logs useful but avoid spam from internet scanners.
    if (existing.count <= 3) return true;
    return existing.count % 25 === 0;
  }

  private handleControlConnection(
    socket: tls.TLSSocket,
    decoder: FrameDecoder,
    hello: AgentHelloBody,
  ): void {
    socket.setKeepAlive(true, 500);

    const { agentId, agentSecret } = hello;
    const agentRow = this.db.getAgent(agentId);
    const remoteAddress = socket.remoteAddress ?? "unknown";

    if (!agentRow || agentRow.secret !== agentSecret) {
      tunnelLog.warn(`[Server] Agent auth failed for id=${agentId} from ${remoteAddress}`);
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

    tunnelLog.log(`[Server] Agent connected: ${agentId} (${agentRow.name})`);

    // Send ServerHello with current tunnel config for this agent
    const tunnelRows = this.db.listTunnelsForAgent(agentId);
    const tunnels: TunnelConfig[] = agentRow.enabled
      ? tunnelRows
        .filter((r) => !!r.enabled)
        .map((r) => this.db.rowToTunnelConfig(r))
      : [];

    socket.write(
      encodeFrame(MsgType.ServerHello, {
        ok: true,
        message: "Welcome",
        tunnels,
      }),
    );

    this.agentManager.register(agentId, socket, tunnels, remoteAddress);
    void this.reloadTunnels().catch((err) => {
      tunnelLog.error(`[Server] Failed to reload tunnels after agent connect (${agentId}):`, err);
    });

    let lastPingTimestamp = 0;

    // Send a keepalive heartbeat every 0.5 seconds for faster liveness/latency updates.
    const heartbeatInterval = setInterval(() => {
      if (socket.destroyed) {
        clearInterval(heartbeatInterval);
        return;
      }
      try {
        lastPingTimestamp = Date.now();
        socket.write(encodeFrame(MsgType.Heartbeat, { timestamp: lastPingTimestamp }));
      } catch {
        clearInterval(heartbeatInterval);
      }
    }, 500);

    // Handle frames from this control connection.
    // NOTE: the data listener from handleIncomingConnection() is still active and
    // pushes chunks to this same decoder, so we must NOT add another one here.
    decoder.onFrame = (frame) => {
      if (frame.msgType === MsgType.Heartbeat) {
        const body = (frame.body ?? {}) as { timestamp?: unknown };
        if (typeof body.timestamp === "number" && body.timestamp === lastPingTimestamp) {
          this.agentManager.updateLatency(agentId, Date.now() - body.timestamp);
        }
        this.agentManager.updateHeartbeat(agentId);
      } else if (frame.msgType === MsgType.StreamData) {
        this.tunnelManager.handleAgentStreamData(agentId, frame.body as StreamDataBody);
      } else if (frame.msgType === MsgType.StreamClose) {
        this.tunnelManager.handleAgentStreamClose(agentId, frame.body as StreamCloseBody);
      } else {
        tunnelLog.warn(`[Server] Unexpected frame on control connection: type=0x${frame.msgType.toString(16)}`);
      }
    };

    decoder.onError = (err) => {
      tunnelLog.error(`[Server] Control connection decoder error for agent ${agentId}:`, err);
      socket.destroy();
    };

    socket.on("close", () => {
      clearInterval(heartbeatInterval);
      this.tunnelManager.closeAgentStreams(agentId);
      this.agentManager.unregister(agentId);
      tunnelLog.log(`[Server] Agent disconnected: ${agentId}`);
      void this.reloadTunnels().catch((err) => {
        tunnelLog.error(`[Server] Failed to reload tunnels after agent disconnect (${agentId}):`, err);
      });
    });

    socket.on("error", (err) => {
      tunnelLog.error(`[Server] Control socket error for agent ${agentId}:`, err.message);
    });
  }

  private handleDataConnection(socket: tls.TLSSocket, hello: DataConnHelloBody): void {
    const { requestId, agentId } = hello;
    const fulfilled = this.agentManager.fulfillDial(agentId, requestId, socket);
    if (!fulfilled) {
      tunnelLog.warn(
        `[Server] No pending dial for agentId=${agentId} requestId=${requestId}; closing data conn`,
      );
      socket.destroy();
    }
  }
}
