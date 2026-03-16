import tls from "tls";
import net from "net";
import dgram from "dgram";
import {
  FrameDecoder,
  encodeFrame,
  MsgType,
  type ServerHelloBody,
  type ConfigPushBody,
  type DialTcpBody,
  type DialUdpSessionBody,
  type DialAssignBody,
  type TunnelConfig,
  type UdpDataBody,
} from "@privatefrp/shared";

const HEARTBEAT_INTERVAL_MS = 5_000;
const CONTROL_STATUS_CHECK_INTERVAL_MS = 5_000;
const CONTROL_IDLE_TIMEOUT_MS = 20_000;
const CONTROL_CONNECT_TIMEOUT_MS = 10_000;
const CONTROL_AUTH_TIMEOUT_MS = 10_000;
const CONTROL_HEARTBEAT_TIMEOUT_MS = 15_000;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

/**
 * Number of pre-warmed TLS data connections to keep ready at all times.
 * When one is consumed by an incoming tunnel request the pool is immediately
 * replenished in the background, so the next request has zero handshake
 * overhead to pay.
 */
const POOL_SIZE = 5;

export interface AgentConfig {
  serverHost: string;
  serverPort: number;
  agentId: string;
  agentSecret: string;
  tlsRejectUnauthorized: boolean;
}

export class Agent {
  private config: AgentConfig;
  private tunnels: TunnelConfig[] = [];
  private socket: tls.TLSSocket | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private controlWatchdogInterval: ReturnType<typeof setInterval> | null = null;
  private controlHealthInterval: ReturnType<typeof setInterval> | null = null;
  private serverHeartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  private stopping = false;
  private controlSocketGeneration = 0;
  private controlConnectedAt = 0;
  private controlLastRxAt = 0;
  private controlLastHeartbeatAt = 0;
  private controlAuthenticated = false;
  private serverConnections: Set<tls.TLSSocket> = new Set();

  /**
   * Cached TLS session shared across all data/pool connections.
   * After the very first handshake, every subsequent connection
   * resumes it and skips the full RTT.
   */
  private dataConnSession: Buffer | null = null;

  /**
   * Number of pool connections currently open or being established.
   * Tracks whether we need to open more.
   */
  private activePoolConnections = 0;

  /**
   * True only while the control socket is authenticated.
   * Pool maintenance is suspended during reconnects.
   */
  private poolEnabled = false;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  start(): void {
    this.startControlHealthMonitor();
    this.connect();
  }

  stop(): void {
    this.stopping = true;
    this.poolEnabled = false;
    this.cleanupControlWatchdog();
    this.cleanupControlHealthMonitor();
    this.cleanupServerHeartbeatTimeout();
    this.cleanupReconnectTimer();
    this.socket?.destroy();
  }

  private connect(): void {
    if (this.stopping) return;

    this.cleanupReconnectTimer();

    // Avoid creating a second control connection while one is still alive.
    if (this.socket && !this.socket.destroyed) {
      const ageSinceHeartbeat = Date.now() - this.controlLastHeartbeatAt;
      if (!this.controlAuthenticated || ageSinceHeartbeat > CONTROL_HEARTBEAT_TIMEOUT_MS) {
        console.warn(
          `[Agent] Existing control socket is stale (heartbeat age=${ageSinceHeartbeat}ms); forcing close`,
        );
        this.socket.destroy();
      }
      this.scheduleReconnect("waiting for control socket reset");
      return;
    }

    // Reset pool state for the new session
    this.poolEnabled = false;
    this.activePoolConnections = 0;

    console.log(
      `[Agent] Connecting to ${this.config.serverHost}:${this.config.serverPort}...`,
    );

    const generation = ++this.controlSocketGeneration;

    const socket = tls.connect({
      host: this.config.serverHost,
      port: this.config.serverPort,
      rejectUnauthorized: this.config.tlsRejectUnauthorized,
    });
    socket.setKeepAlive(true, HEARTBEAT_INTERVAL_MS);
    socket.setTimeout(CONTROL_CONNECT_TIMEOUT_MS);

    this.socket = socket;
    this.controlConnectedAt = Date.now();
    this.controlLastRxAt = this.controlConnectedAt;
    this.controlLastHeartbeatAt = this.controlConnectedAt;
    this.controlAuthenticated = false;
    this.trackServerConnection(socket);

    const decoder = new FrameDecoder();
    decoder.onError = (err) => {
      console.error("[Agent] Frame decoder error:", err);
      socket.destroy();
    };

    socket.on("secureConnect", () => {
      if (!this.isActiveControlSocket(socket, generation)) {
        socket.destroy();
        return;
      }
      console.log("[Agent] TLS connected");
      socket.write(
        encodeFrame(MsgType.AgentHello, {
          agentId: this.config.agentId,
          agentSecret: this.config.agentSecret,
        }),
      );
    });

    socket.on("data", (chunk: Buffer) => {
      if (!this.isActiveControlSocket(socket, generation)) return;
      this.controlLastRxAt = Date.now();
      decoder.push(chunk);
    });

    const authTimeout = setTimeout(() => {
      if (this.controlAuthenticated || !this.isActiveControlSocket(socket, generation)) return;
      console.warn("[Agent] Control auth timed out; forcing reconnect");
      socket.destroy();
    }, CONTROL_AUTH_TIMEOUT_MS);

    decoder.onFrame = (frame) => {
      if (!this.isActiveControlSocket(socket, generation)) return;

      switch (frame.msgType) {
        case MsgType.ServerHello: {
          const body = frame.body as ServerHelloBody;
          clearTimeout(authTimeout);
          if (!body.ok) {
            console.error("[Agent] Server rejected auth:", body.message);
            socket.destroy();
            return;
          }
          console.log("[Agent] Authenticated:", body.message);
          this.controlAuthenticated = true;
          socket.setTimeout(0);
          this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
          this.tunnels = body.tunnels;
          this.markServerHeartbeatReceived();
          this.startHeartbeat(socket);
          this.startControlWatchdog(socket, () => this.controlLastRxAt);
          // Start pre-warming connections now that we are authenticated
          this.poolEnabled = true;
          this.maintainPool();
          break;
        }

        case MsgType.ConfigPush: {
          const body = frame.body as ConfigPushBody;
          console.log(`[Agent] Config pushed: ${body.tunnels.length} tunnel(s)`);
          this.tunnels = body.tunnels;
          break;
        }

        case MsgType.Heartbeat:
          this.markServerHeartbeatReceived();
          // Echo server timestamp so the server can measure RTT.
          socket.write(
            encodeFrame(
              MsgType.Heartbeat,
              (frame.body ?? {}) as Record<string, unknown>,
            ),
          );
          break;

        case MsgType.DialTcp: {
          const body = frame.body as DialTcpBody;
          if (!this.controlAuthenticated) return;
          this.handleDialTcp(body);
          break;
        }

        case MsgType.DialUdpSession: {
          const body = frame.body as DialUdpSessionBody;
          if (!this.controlAuthenticated) return;
          this.handleDialUdpSession(body);
          break;
        }

        default:
          console.warn(`[Agent] Unknown frame type: 0x${frame.msgType.toString(16)}`);
      }
    };

    socket.on("close", () => {
      clearTimeout(authTimeout);
      if (!this.isActiveControlSocket(socket, generation)) {
        return;
      }
      if (this.socket === socket) {
        this.socket = null;
      }
      this.controlAuthenticated = false;
      this.poolEnabled = false;
      this.activePoolConnections = 0;
      this.cleanupHeartbeat();
      this.cleanupControlWatchdog();
      this.cleanupServerHeartbeatTimeout();
      if (!this.stopping) {
        this.scheduleReconnect("control channel closed");
      }
    });

    socket.on("error", (err) => {
      if (!this.isActiveControlSocket(socket, generation)) {
        return;
      }
      console.error("[Agent] Socket error:", err.message);
      if (!socket.destroyed) socket.destroy();
    });

    socket.on("end", () => {
      if (!this.isActiveControlSocket(socket, generation)) {
        return;
      }
      if (!socket.destroyed) socket.destroy();
    });

    socket.on("timeout", () => {
      if (!this.isActiveControlSocket(socket, generation)) {
        return;
      }
      console.warn("[Agent] Control socket timeout; forcing reconnect");
      if (!socket.destroyed) socket.destroy();
    });
  }

  private isActiveControlSocket(socket: tls.TLSSocket, generation: number): boolean {
    return this.socket === socket && this.controlSocketGeneration === generation;
  }

  private startControlHealthMonitor(): void {
    this.cleanupControlHealthMonitor();
    this.controlHealthInterval = setInterval(() => {
      if (this.stopping) return;

      const socket = this.socket;
      if (!socket) {
        this.scheduleReconnect("control socket missing");
        return;
      }

      const readyState = (socket as unknown as { readyState?: string }).readyState;
      if (socket.destroyed || readyState === "closed") {
        if (this.socket === socket) {
          this.socket = null;
        }
        this.controlAuthenticated = false;
        this.poolEnabled = false;
        this.cleanupHeartbeat();
        this.cleanupControlWatchdog();
        this.cleanupServerHeartbeatTimeout();
        this.scheduleReconnect("control socket inactive");
        return;
      }

      const now = Date.now();
      if (!this.controlAuthenticated) {
        if (now - this.controlConnectedAt >= CONTROL_AUTH_TIMEOUT_MS) {
          console.warn("[Agent] Control connection never authenticated; forcing reconnect");
          this.destroyAllServerConnections("control auth timeout");
        }
        return;
      }

      const heartbeatAge = now - this.controlLastHeartbeatAt;
      if (heartbeatAge > CONTROL_HEARTBEAT_TIMEOUT_MS) {
        console.warn(
          `[Agent] No server heartbeat received for ${heartbeatAge}ms; resetting all server connections`,
        );
        this.destroyAllServerConnections("server heartbeat missed");
        return;
      }

      const idleFor = now - this.controlLastRxAt;
      if (idleFor >= CONTROL_IDLE_TIMEOUT_MS) {
        console.warn(
          `[Agent] Control connection inactive for ${idleFor}ms; resetting all server connections`,
        );
        this.destroyAllServerConnections("control connection inactive");
      }
    }, CONTROL_STATUS_CHECK_INTERVAL_MS);
  }

  private cleanupControlHealthMonitor(): void {
    if (this.controlHealthInterval) {
      clearInterval(this.controlHealthInterval);
      this.controlHealthInterval = null;
    }
  }

  private markServerHeartbeatReceived(): void {
    this.controlLastHeartbeatAt = Date.now();
    this.armServerHeartbeatTimeout();
  }

  private armServerHeartbeatTimeout(): void {
    this.cleanupServerHeartbeatTimeout();
    if (this.stopping || !this.controlAuthenticated) return;

    this.serverHeartbeatTimeout = setTimeout(() => {
      if (this.stopping || !this.controlAuthenticated) return;
      const heartbeatAge = Date.now() - this.controlLastHeartbeatAt;
      if (heartbeatAge < CONTROL_HEARTBEAT_TIMEOUT_MS) {
        this.armServerHeartbeatTimeout();
        return;
      }

      console.warn(
        `[Agent] No server heartbeat received for ${heartbeatAge}ms; resetting all server connections`,
      );
      this.destroyAllServerConnections("server heartbeat missed");
    }, CONTROL_HEARTBEAT_TIMEOUT_MS + 250);
  }

  private cleanupServerHeartbeatTimeout(): void {
    if (this.serverHeartbeatTimeout) {
      clearTimeout(this.serverHeartbeatTimeout);
      this.serverHeartbeatTimeout = null;
    }
  }

  private startHeartbeat(socket: tls.TLSSocket): void {
    this.cleanupHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (socket.destroyed) {
        this.cleanupHeartbeat();
        return;
      }
      try {
        socket.write(encodeFrame(MsgType.Heartbeat, { timestamp: Date.now() }));
      } catch {
        this.cleanupHeartbeat();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private cleanupHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private startControlWatchdog(
    socket: tls.TLSSocket,
    getLastControlRxAt: () => number,
  ): void {
    this.cleanupControlWatchdog();
    this.controlWatchdogInterval = setInterval(() => {
      if (socket.destroyed) {
        this.cleanupControlWatchdog();
        return;
      }
      const idleFor = Date.now() - getLastControlRxAt();
      if (idleFor > CONTROL_IDLE_TIMEOUT_MS) {
        console.warn(
          `[Agent] Control channel idle for ${idleFor}ms; forcing reconnect`,
        );
        socket.destroy();
      }
    }, 2_000);
  }

  private cleanupControlWatchdog(): void {
    if (this.controlWatchdogInterval) {
      clearInterval(this.controlWatchdogInterval);
      this.controlWatchdogInterval = null;
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopping) return;
    if (this.reconnectTimer) return;

    const delay = this.reconnectDelay;
    console.log(`[Agent] ${reason}. Reconnecting in ${delay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
      this.connect();
    }, delay);
  }

  private cleanupReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private trackServerConnection(conn: tls.TLSSocket): void {
    this.serverConnections.add(conn);
    conn.once("close", () => {
      this.serverConnections.delete(conn);
      if (conn === this.socket) {
        this.socket = null;
      }
    });
  }

  private destroyAllServerConnections(reason: string): void {
    this.poolEnabled = false;
    this.activePoolConnections = 0;
    this.controlAuthenticated = false;
    this.cleanupHeartbeat();
    this.cleanupControlWatchdog();
    this.cleanupServerHeartbeatTimeout();
    this.controlSocketGeneration += 1;
    this.socket = null;

    const sockets = Array.from(this.serverConnections);
    if (sockets.length === 0) {
      this.scheduleReconnect(reason);
      return;
    }

    for (const conn of sockets) {
      if (!conn.destroyed) conn.destroy();
    }

    this.scheduleReconnect(reason);
  }

  private findTunnel(tunnelId: string): TunnelConfig | undefined {
    return this.tunnels.find((t) => t.id === tunnelId);
  }

  // ─── Warm connection pool ───────────────────────────────────────────────────

  /**
   * Ensure we always have POOL_SIZE pre-warmed connections in the server's
   * pool.  Called after authentication and after each pool socket is consumed
   * or lost.
   */
  private maintainPool(): void {
    while (this.poolEnabled && this.activePoolConnections < POOL_SIZE) {
      this.activePoolConnections++;
      this.openPoolConnection();
    }
  }

  /**
   * Open one pre-warmed TLS connection to the server and register it in the
   * server's pool via a PoolHello message.  The connection then sits idle,
   * waiting for a DialAssign frame that tells it which tunnel to serve.
   */
  private openPoolConnection(): void {
    if (this.stopping || !this.socket || this.socket.destroyed) {
      this.activePoolConnections = Math.max(0, this.activePoolConnections - 1);
      return;
    }

    const conn = tls.connect({
      host: this.config.serverHost,
      port: this.config.serverPort,
      rejectUnauthorized: this.config.tlsRejectUnauthorized,
      session: this.dataConnSession ?? undefined,
    });
    this.trackServerConnection(conn);

    conn.once("session", (session) => {
      this.dataConnSession = session;
    });

    // Whether we have already decremented activePoolConnections for this conn.
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.activePoolConnections = Math.max(0, this.activePoolConnections - 1);
      // Immediately try to replenish so the pool stays at target size
      if (this.poolEnabled) this.maintainPool();
    };

    // If the connection dies before being assigned, release the slot
    conn.on("close", release);

    conn.on("error", (err) => {
      console.error("[Agent] Pool connection error:", err.message);
      // 'close' will fire after 'error' and call release()
    });

    conn.once("secureConnect", () => {
      conn.setNoDelay(true);
      conn.write(
        encodeFrame(MsgType.PoolHello, { agentId: this.config.agentId }),
      );

      // Wait for a single DialAssign frame telling us which tunnel to serve
      const decoder = new FrameDecoder();
      decoder.onError = (err) => {
        console.error("[Agent] Pool connection decoder error:", err);
        conn.destroy();
      };

      const onData = (chunk: Buffer) => decoder.push(chunk);
      conn.on("data", onData);

      decoder.onFrame = (frame) => {
        if (frame.msgType !== MsgType.DialAssign) {
          console.warn(
            `[Agent] Pool connection: unexpected frame 0x${frame.msgType.toString(16)}`,
          );
          conn.destroy();
          return;
        }

        const body = frame.body as DialAssignBody;

        // Switch from framed mode to raw pipe mode
        const leftover = decoder.detach();
        conn.removeListener("data", onData);
        // Pause immediately — removing the listener does NOT stop the stream
        // from flowing. Any bytes arriving before pipe() is called would be
        // silently dropped if we don't pause here.
        conn.pause();
        if (leftover.length > 0) conn.unshift(leftover);

        // Remove the 'close' release listener — we own this socket now
        conn.removeListener("close", release);
        released = true;
        // Replenish the pool immediately so the next request has a warm socket
        this.activePoolConnections = Math.max(0, this.activePoolConnections - 1);
        if (this.poolEnabled) this.maintainPool();

        const tunnel = this.findTunnel(body.tunnelId);
        if (!tunnel) {
          console.warn(`[Agent] DialAssign: unknown tunnel ${body.tunnelId}`);
          conn.destroy();
          return;
        }

        console.log(
          `[Agent] DialAssign requestId=${body.requestId} -> ${tunnel.targetHost}:${tunnel.targetPort}`,
        );

        this.connectToTarget(conn, tunnel.targetHost, tunnel.targetPort, body.requestId);
      };
    });
  }

  /**
   * Connect to the local target service and join the two sockets into a
   * bidirectional pipe.  Used by both the pool path (DialAssign) and the
   * on-demand fallback path (DialTcp → DataConnHello).
   */
  private connectToTarget(
    dataConn: tls.TLSSocket | net.Socket,
    targetHost: string,
    targetPort: number,
    requestId: string,
  ): void {
    const target = net.createConnection({ host: targetHost, port: targetPort });

    target.once("connect", () => {
      target.setNoDelay(true);
      dataConn.setNoDelay(true);

      // Transparent byte-for-byte pipe — pipes are established first so the
      // streams stay in paused/controlled mode until both sides are ready.
      dataConn.pipe(target);
      target.pipe(dataConn);

      dataConn.on("error", () => target.destroy());
      target.on("error", () => dataConn.destroy());
      dataConn.on("close", () => target.destroy());
      target.on("close", () => dataConn.destroy());
    });

    target.on("error", (err) => {
      console.error(
        `[Agent] Target connection error (requestId=${requestId}): ${err.message}`,
      );
      dataConn.destroy();
    });
  }

  // ─── On-demand TCP dial (slow-path fallback) ────────────────────────────────

  private handleDialTcp(body: DialTcpBody): void {
    const tunnel = this.findTunnel(body.tunnelId);
    if (!tunnel) {
      console.warn(`[Agent] DialTcp: unknown tunnel ${body.tunnelId}`);
      return;
    }

    console.log(
      `[Agent] DialTcp (fallback) requestId=${body.requestId} -> ${tunnel.targetHost}:${tunnel.targetPort}`,
    );

    const dataConn = tls.connect({
      host: this.config.serverHost,
      port: this.config.serverPort,
      rejectUnauthorized: this.config.tlsRejectUnauthorized,
      session: this.dataConnSession ?? undefined,
    });
    this.trackServerConnection(dataConn);

    dataConn.once("session", (session) => {
      this.dataConnSession = session;
    });

    dataConn.once("secureConnect", () => {
      dataConn.setNoDelay(true);
      dataConn.write(
        encodeFrame(MsgType.DataConnHello, {
          requestId: body.requestId,
          agentId: this.config.agentId,
        }),
      );
      this.connectToTarget(dataConn, tunnel.targetHost, tunnel.targetPort, body.requestId);
    });

    dataConn.on("error", (err) => {
      console.error(`[Agent] Fallback data connection error (requestId=${body.requestId}): ${err.message}`);
    });
  }

  // ─── UDP session handling ───────────────────────────────────────────────────

  private handleDialUdpSession(body: DialUdpSessionBody): void {
    const tunnel = this.findTunnel(body.tunnelId);
    if (!tunnel) {
      console.warn(`[Agent] DialUdpSession: unknown tunnel ${body.tunnelId}`);
      return;
    }

    console.log(
      `[Agent] DialUdpSession requestId=${body.requestId} peer=${body.peerAddr} -> ${tunnel.targetHost}:${tunnel.targetPort}`,
    );

    const udpSock = dgram.createSocket("udp4");
    udpSock.bind(() => {
      const dataConn = tls.connect({
        host: this.config.serverHost,
        port: this.config.serverPort,
        rejectUnauthorized: this.config.tlsRejectUnauthorized,
        session: this.dataConnSession ?? undefined,
      });
      this.trackServerConnection(dataConn);

      dataConn.once("session", (session) => {
        this.dataConnSession = session;
      });

      dataConn.once("secureConnect", () => {
        dataConn.write(
          encodeFrame(MsgType.DataConnHello, {
            requestId: body.requestId,
            agentId: this.config.agentId,
          }),
        );

        const decoder = new FrameDecoder();

        decoder.onFrame = (frame) => {
          if (frame.msgType !== MsgType.UdpData) return;
          const udpBody = frame.body as UdpDataBody;
          const payload = Buffer.from(udpBody.payload, "base64");
          udpSock.send(payload, tunnel.targetPort, tunnel.targetHost);
        };

        decoder.onError = (err) => {
          console.error("[Agent] UDP session decoder error:", err);
          dataConn.destroy();
        };

        dataConn.on("data", (chunk: Buffer) => decoder.push(chunk));

        udpSock.on("message", (msg) => {
          try {
            dataConn.write(
              encodeFrame(MsgType.UdpData, {
                peerAddr: body.peerAddr,
                payload: msg.toString("base64"),
              }),
            );
          } catch {
            // ignore write errors on a dying socket
          }
        });

        dataConn.on("close", () => udpSock.close());
        dataConn.on("error", (err) => {
          console.error(`[Agent] UDP data conn error:`, err.message);
          udpSock.close();
        });
      });

      dataConn.on("error", (err) => {
        console.error(
          `[Agent] UDP data connection error (requestId=${body.requestId}): ${err.message}`,
        );
        udpSock.close();
      });
    });

    udpSock.on("error", (err) => {
      console.error("[Agent] UDP socket error:", err.message);
    });
  }
}
