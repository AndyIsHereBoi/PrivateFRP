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
const CONTROL_CONNECT_TIMEOUT_MS = 10_000;
const CONTROL_AUTH_TIMEOUT_MS = 10_000;
const CONTROL_HEARTBEAT_TIMEOUT_MS = 15_000;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * Number of pre-warmed TLS data connections to keep ready at all times.
 * When one is consumed by an incoming tunnel request the pool is immediately
 * replenished in the background, so the next request has zero handshake
 * overhead to pay.
 */
const POOL_SIZE = parsePositiveIntEnv("AGENT_POOL_SIZE", 32);

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
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  private stopping = false;
  private authRejected = false;
  private controlSocketGeneration = 0;
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
    this.connect();
  }

  stop(): void {
    this.stopping = true;
    this.poolEnabled = false;
    this.cleanupHeartbeat();
    this.cleanupReconnectTimer();
    this.destroyAllServerConnections();
  }

  private connect(): void {
    if (this.stopping || this.authRejected) return;

    this.cleanupReconnectTimer();

    // Avoid creating a second control connection while one is still alive.
    if (this.socket && !this.socket.destroyed) return;

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

    socket.on("data", (chunk: Buffer) => decoder.push(chunk));

    let authenticated = false;
    const authTimeout = setTimeout(() => {
      if (authenticated || !this.isActiveControlSocket(socket, generation)) return;
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
            this.authRejected = true;
            this.stop();
            console.error("[Agent] Reconnect disabled after unauthorized/auth-failed response");
            socket.destroy();
            return;
          }
          console.log("[Agent] Authenticated:", body.message);
          authenticated = true;
          socket.setTimeout(CONTROL_HEARTBEAT_TIMEOUT_MS);
          this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
          this.tunnels = body.tunnels;
          this.startHeartbeat(socket);
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
          if (!authenticated) return;
          this.handleDialTcp(body);
          break;
        }

        case MsgType.DialUdpSession: {
          const body = frame.body as DialUdpSessionBody;
          if (!authenticated) return;
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
      console.warn("[Agent] Control socket closed");
      this.handleControlDisconnect("control channel closed");
    });

    socket.on("error", (err) => {
      if (!this.isActiveControlSocket(socket, generation)) {
        return;
      }
      console.error("[Agent] Control socket error:", err.message);
      this.handleControlDisconnect("control socket error");
    });

    socket.on("end", () => {
      if (!this.isActiveControlSocket(socket, generation)) {
        return;
      }
      console.warn("[Agent] Control socket ended by server");
      this.handleControlDisconnect("control socket ended");
    });

    socket.on("timeout", () => {
      if (!this.isActiveControlSocket(socket, generation)) {
        return;
      }
      console.warn("[Agent] Control socket inactivity timeout; resetting all server connections");
      this.handleControlDisconnect("control socket timeout");
    });
  }

  private isActiveControlSocket(socket: tls.TLSSocket, generation: number): boolean {
    return this.socket === socket && this.controlSocketGeneration === generation;
  }

  private handleControlDisconnect(reason: string): void {
    if (this.stopping) return;
    this.destroyAllServerConnections();
    this.scheduleReconnect(reason);
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

  private destroyAllServerConnections(): void {
    this.poolEnabled = false;
    this.activePoolConnections = 0;
    this.cleanupHeartbeat();

    const sockets = Array.from(this.serverConnections);
    this.socket = null;

    for (const conn of sockets) {
      if (!conn.destroyed) conn.destroy();
    }
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
