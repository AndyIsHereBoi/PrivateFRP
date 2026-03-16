import net from "net";
import dgram from "dgram";
import type { TunnelConfig } from "@privatefrp/shared";
import { encodeFrame, MsgType, FrameDecoder } from "@privatefrp/shared";
import type { AgentManager } from "./agentManager";
import type { DB } from "./db";

/** Idle timeout for UDP sessions - matches typical NAT mapping lifetime */
const UDP_SESSION_IDLE_MS = 90_000; // 90 seconds
const TRAFFIC_FLUSH_INTERVAL_MS = 5_000;

/**
 * Returns true for errors that are expected when an agent goes offline
 * (e.g. "not connected", dial timeout, agent disconnected mid-dial).
 * These are logged as warnings rather than errors.
 */
function isExpectedDialError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("not connected") ||
    msg.includes("timeout") ||
    msg.includes("disconnected") ||
    msg.includes("Too many pending dials")
  );
}

interface TcpListener {
  type: "tcp";
  server: net.Server;
  tunnelId: string;
}

interface UdpSession {
  dataConn: net.Socket | import("tls").TLSSocket;
  lastActivity: number;
  idleTimer: ReturnType<typeof setTimeout>;
}

interface UdpListener {
  type: "udp";
  socket: dgram.Socket;
  tunnelId: string;
  sessions: Map<string, UdpSession>;
}

interface TunnelTrafficState {
  totalInBytes: number;
  totalOutBytes: number;
  lastFlushedInBytes: number;
  lastFlushedOutBytes: number;
  dirty: boolean;
}

type Listener = TcpListener | UdpListener;

export class TunnelManager {
  private listeners: Map<string, Listener> = new Map(); // tunnelId -> Listener
  private agentManager: AgentManager;
  private db: DB;
  private trafficByTunnel: Map<string, TunnelTrafficState> = new Map();
  private trafficFlushInterval: ReturnType<typeof setInterval>;

  constructor(agentManager: AgentManager, db: DB) {
    this.agentManager = agentManager;
    this.db = db;
    this.trafficFlushInterval = setInterval(() => {
      this.flushTrafficToDb();
    }, TRAFFIC_FLUSH_INTERVAL_MS);
  }

  private ensureTrafficState(tunnelId: string): TunnelTrafficState {
    const existing = this.trafficByTunnel.get(tunnelId);
    if (existing) return existing;

    const persisted = this.db.getTunnelTrafficTotals(tunnelId);
    const baselineIn = persisted?.inBytes ?? 0;
    const baselineOut = persisted?.outBytes ?? 0;
    const state: TunnelTrafficState = {
      totalInBytes: baselineIn,
      totalOutBytes: baselineOut,
      lastFlushedInBytes: baselineIn,
      lastFlushedOutBytes: baselineOut,
      dirty: false,
    };
    this.trafficByTunnel.set(tunnelId, state);
    return state;
  }

  private addTrafficIn(tunnelId: string, bytes: number): void {
    if (bytes <= 0) return;
    const state = this.ensureTrafficState(tunnelId);
    state.totalInBytes += bytes;
    state.dirty = true;
  }

  private addTrafficOut(tunnelId: string, bytes: number): void {
    if (bytes <= 0) return;
    const state = this.ensureTrafficState(tunnelId);
    state.totalOutBytes += bytes;
    state.dirty = true;
  }

  private flushTrafficToDb(): void {
    for (const [tunnelId, state] of this.trafficByTunnel) {
      if (!state.dirty) continue;
      if (
        state.totalInBytes === state.lastFlushedInBytes &&
        state.totalOutBytes === state.lastFlushedOutBytes
      ) {
        state.dirty = false;
        continue;
      }

      try {
        this.db.updateTunnelTrafficTotals(tunnelId, state.totalInBytes, state.totalOutBytes);
        state.lastFlushedInBytes = state.totalInBytes;
        state.lastFlushedOutBytes = state.totalOutBytes;
        state.dirty = false;
      } catch (err) {
        console.error(`[TunnelManager] Failed to flush traffic stats for tunnel ${tunnelId}:`, err);
      }
    }
  }

  /**
   * Sync active listeners with the given set of tunnel configs.
   * Starts new listeners, stops removed ones.
   */
  async syncTunnels(tunnels: TunnelConfig[]): Promise<void> {
    const desired = new Map(tunnels.map((t) => [t.id, t]));

    // Stop listeners that are no longer desired
    for (const [id, listener] of this.listeners) {
      if (!desired.has(id)) {
        await this.stopListener(id, listener);
      }
    }

    // Start new listeners
    for (const tunnel of tunnels) {
      if (!this.listeners.has(tunnel.id)) {
        await this.startListener(tunnel);
      }
    }
  }

  async startListener(tunnel: TunnelConfig): Promise<void> {
    if (this.listeners.has(tunnel.id)) return;

    try {
      if (tunnel.type === "tcp") {
        await this.startTcpListener(tunnel);
      } else {
        await this.startUdpListener(tunnel);
      }
    } catch (err) {
      console.error(`[TunnelManager] Failed to start listener for tunnel ${tunnel.id}:`, err);
    }
  }

  private startTcpListener(tunnel: TunnelConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer({ allowHalfOpen: false });

      server.on("connection", (clientSocket) => {
        clientSocket.setNoDelay(true);
        this.handleTcpConnection(tunnel, clientSocket);
      });

      server.on("error", (err) => {
        console.error(`[TunnelManager] TCP listener error on port ${tunnel.listenPort}:`, err);
      });

      server.listen(tunnel.listenPort, () => {
        console.log(
          `[TunnelManager] TCP listener started for tunnel "${tunnel.name}" on port ${tunnel.listenPort}`,
        );
        this.listeners.set(tunnel.id, { type: "tcp", server, tunnelId: tunnel.id });
        resolve();
      });

      server.once("error", reject);
    });
  }

  private async handleTcpConnection(tunnel: TunnelConfig, clientSocket: net.Socket): Promise<void> {
    const requestId = crypto.randomUUID();
    console.log(
      `[TunnelManager] Inbound TCP on tunnel "${tunnel.name}", requestId=${requestId}`,
    );

    // Track early client disconnect so we can bail after the async dial and
    // avoid leaking the data socket. Also absorb any early errors.
    let clientGone = false;
    const onEarlyClose = () => {
      clientGone = true;
    };
    const onEarlyError = () => {
      clientGone = true;
    };
    clientSocket.once("close", onEarlyClose);
    clientSocket.once("error", onEarlyError);

    try {
      const dataSocket = await this.agentManager.dialTcp(
        tunnel.agentId,
        requestId,
        tunnel.id,
      );

      clientSocket.removeListener("close", onEarlyClose);
      clientSocket.removeListener("error", onEarlyError);

      if (clientGone || clientSocket.destroyed) {
        dataSocket.destroy();
        return;
      }

      dataSocket.setNoDelay(true);
      this.agentManager.incActiveConnections(tunnel.agentId);
      let connectionReleased = false;
      const releaseConnection = () => {
        if (connectionReleased) return;
        connectionReleased = true;
        this.agentManager.decActiveConnections(tunnel.agentId);
      };
      dataSocket.once("close", releaseConnection);

      // Track tunnel traffic while preserving transparent byte forwarding.
      clientSocket.on("data", (chunk: Buffer) => this.addTrafficIn(tunnel.id, chunk.length));
      dataSocket.on("data", (chunk: Buffer) => this.addTrafficOut(tunnel.id, chunk.length));

      clientSocket.pipe(dataSocket);
      dataSocket.pipe(clientSocket);

      clientSocket.on("error", () => dataSocket.destroy());
      dataSocket.on("error", () => clientSocket.destroy());
      clientSocket.on("close", () => dataSocket.destroy());
      dataSocket.on("close", () => clientSocket.destroy());
    } catch (err) {
      clientSocket.removeListener("close", onEarlyClose);
      clientSocket.removeListener("error", onEarlyError);
      const msg = err instanceof Error ? err.message : String(err);
      if (isExpectedDialError(err)) {
        console.warn(
          `[TunnelManager] Dial skipped for requestId=${requestId} (${msg})`,
        );
      } else {
        console.error(`[TunnelManager] Dial failed for requestId=${requestId}: ${msg}`);
      }
      if (!clientGone) clientSocket.destroy();
    }
  }

  private startUdpListener(tunnel: TunnelConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket("udp4");
      const sessions = new Map<string, UdpSession>();

      sock.on("message", (msg, rinfo) => {
        const peerAddr = `${rinfo.address}:${rinfo.port}`;
        this.handleUdpMessage(tunnel, sock, sessions, peerAddr, msg);
      });

      sock.on("error", (err) => {
        console.error(`[TunnelManager] UDP listener error on port ${tunnel.listenPort}:`, err);
      });

      sock.bind(tunnel.listenPort, () => {
        console.log(
          `[TunnelManager] UDP listener started for tunnel "${tunnel.name}" on port ${tunnel.listenPort}`,
        );
        this.listeners.set(tunnel.id, { type: "udp", socket: sock, tunnelId: tunnel.id, sessions });
        resolve();
      });

      sock.once("error", reject);
    });
  }

  private refreshUdpSession(sessions: Map<string, UdpSession>, peerAddr: string): void {
    const session = sessions.get(peerAddr);
    if (!session) return;
    session.lastActivity = Date.now();
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      console.log(`[TunnelManager] UDP session idle timeout for peer ${peerAddr}`);
      session.dataConn.destroy();
      sessions.delete(peerAddr);
    }, UDP_SESSION_IDLE_MS);
  }

  private async handleUdpMessage(
    tunnel: TunnelConfig,
    udpSock: dgram.Socket,
    sessions: Map<string, UdpSession>,
    peerAddr: string,
    msg: Buffer,
  ): Promise<void> {
    let session = sessions.get(peerAddr);

    if (!session || session.dataConn.destroyed) {
      const requestId = crypto.randomUUID();
      console.log(
        `[TunnelManager] New UDP session for tunnel "${tunnel.name}", peer=${peerAddr}, requestId=${requestId}`,
      );

      let dataConn: net.Socket | import("tls").TLSSocket;
      try {
        dataConn = await this.agentManager.dialUdpSession(
          tunnel.agentId,
          requestId,
          tunnel.id,
          peerAddr,
        );
      } catch (err) {
        const msgText = err instanceof Error ? err.message : String(err);
        if (isExpectedDialError(err)) {
          console.warn(`[TunnelManager] UDP dial skipped for peer ${peerAddr} (${msgText})`);
        } else {
          console.error(`[TunnelManager] UDP dial failed for peer ${peerAddr}: ${msgText}`);
        }
        return;
      }

      const idleTimer = setTimeout(() => {
        console.log(`[TunnelManager] UDP session idle timeout for peer ${peerAddr}`);
        dataConn.destroy();
        sessions.delete(peerAddr);
      }, UDP_SESSION_IDLE_MS);

      session = { dataConn, lastActivity: Date.now(), idleTimer };
      sessions.set(peerAddr, session);
      this.agentManager.incActiveConnections(tunnel.agentId);
      let sessionReleased = false;
      const releaseSession = () => {
        if (sessionReleased) return;
        sessionReleased = true;
        this.agentManager.decActiveConnections(tunnel.agentId);
      };
      dataConn.once("close", releaseSession);

      const decoder = new FrameDecoder();

      decoder.onFrame = (frame) => {
        if (frame.msgType !== MsgType.UdpData) return;
        const body = frame.body as { peerAddr: string; payload: string };
        const lastColon = body.peerAddr.lastIndexOf(":");
        const host = body.peerAddr.slice(0, lastColon);
        const port = parseInt(body.peerAddr.slice(lastColon + 1), 10);
        const payload = Buffer.from(body.payload, "base64");
        this.addTrafficOut(tunnel.id, payload.length);
        this.refreshUdpSession(sessions, peerAddr);
        udpSock.send(payload, port, host);
      };

      decoder.onError = (err) => {
        console.error(`[TunnelManager] UDP session decoder error:`, err);
        dataConn.destroy();
      };

      dataConn.on("data", (chunk: Buffer) => decoder.push(chunk));
      dataConn.on("close", () => {
        clearTimeout(session!.idleTimer);
        sessions.delete(peerAddr);
      });
      dataConn.on("error", () => {
        dataConn.destroy();
        clearTimeout(session!.idleTimer);
        sessions.delete(peerAddr);
      });
    }

    this.refreshUdpSession(sessions, peerAddr);
    this.addTrafficIn(tunnel.id, msg.length);

    const frame = encodeFrame(MsgType.UdpData, {
      peerAddr,
      payload: msg.toString("base64"),
    });

    session.dataConn.write(frame);
  }

  private stopListener(tunnelId: string, listener: Listener): Promise<void> {
    this.listeners.delete(tunnelId);

    if (listener.type === "tcp") {
      return new Promise((resolve) => {
        listener.server.close(() => {
          console.log(`[TunnelManager] TCP listener stopped for tunnel ${tunnelId}`);
          resolve();
        });
      });
    }

    return new Promise((resolve) => {
      for (const session of listener.sessions.values()) {
        clearTimeout(session.idleTimer);
        session.dataConn.destroy();
      }
      listener.sessions.clear();
      listener.socket.close(() => {
        console.log(`[TunnelManager] UDP listener stopped for tunnel ${tunnelId}`);
        resolve();
      });
    });
  }

  async stopAll(): Promise<void> {
    this.flushTrafficToDb();
    clearInterval(this.trafficFlushInterval);
    for (const [id, listener] of this.listeners) {
      await this.stopListener(id, listener);
    }
  }

  isListening(tunnelId: string): boolean {
    return this.listeners.has(tunnelId);
  }
}
