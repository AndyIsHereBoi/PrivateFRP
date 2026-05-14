import net from "net";
import dgram from "dgram";
import type {
  DecodedFrame,
  StreamCloseBody,
  StreamDataBody,
  StreamOpenBody,
  TunnelConfig,
} from "@privatefrp/shared";
import { encodeFrame, MsgType } from "@privatefrp/shared";
import type { AgentManager } from "./agentManager";
import type { DB } from "./db";
import { tunnelLog } from "./logger";

/** Idle timeout for UDP sessions - matches typical NAT mapping lifetime */
const UDP_SESSION_IDLE_MS = 90_000; // 90 seconds
const TRAFFIC_FLUSH_INTERVAL_MS = 5_000;
const TRAFFIC_ROLLUP_BUCKET_SECONDS = 300;
const TRAFFIC_RETENTION_SECONDS = 190 * 24 * 60 * 60;

function parseNonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

interface TcpListener {
  type: "tcp";
  server: net.Server;
  tunnelId: string;
}

interface UdpListener {
  type: "udp";
  socket: dgram.Socket;
  tunnelId: string;
  sessions: Map<string, string>; // peerAddr -> streamId
}

interface DualListener {
  type: "tcp+udp";
  tunnelId: string;
  tcpServer: net.Server;
  udpSocket: dgram.Socket;
  sessions: Map<string, string>; // peerAddr -> streamId
}

interface TcpStream {
  streamId: string;
  agentId: string;
  tunnelId: string;
  clientSocket: net.Socket;
}

interface UdpStream {
  streamId: string;
  agentId: string;
  tunnelId: string;
  udpSock: dgram.Socket;
  peerAddr: string;
  idleTimer: ReturnType<typeof setTimeout>;
}

interface TunnelTrafficState {
  totalInBytes: number;
  totalOutBytes: number;
  pendingInBytes: number;
  pendingOutBytes: number;
  lastFlushedInBytes: number;
  lastFlushedOutBytes: number;
  dirty: boolean;
}

interface IpTrafficState {
  tunnelId: string;
  remoteIp: string;
  totalInBytes: number;
  totalOutBytes: number;
  pendingInBytes: number;
  pendingOutBytes: number;
  lastFlushedInBytes: number;
  lastFlushedOutBytes: number;
  lastSeen: number;
  dirty: boolean;
}

type Listener = TcpListener | UdpListener | DualListener;

export class TunnelManager {
  private listeners: Map<string, Listener> = new Map(); // tunnelId -> Listener
  private agentManager: AgentManager;
  private db: DB;
  private trafficByTunnel: Map<string, TunnelTrafficState> = new Map();
  private trafficByIp: Map<string, IpTrafficState> = new Map();
  private trafficFlushInterval: ReturnType<typeof setInterval>;
  private lastRollupPruneAt = 0;
  private maxActiveConnectionsPerAgent: number;
  private tcpStreams: Map<string, TcpStream> = new Map(); // streamId -> tcp stream
  private udpStreams: Map<string, UdpStream> = new Map(); // streamId -> udp stream
  // Track paused client sockets per agent control socket to avoid adding many
  // 'drain' listeners on the same agent socket.  When an agent socket drains
  // we resume all paused clients that targeted it.
  private pausedClientsByAgentSocket: WeakMap<net.Socket, Set<net.Socket>> = new WeakMap();

  constructor(agentManager: AgentManager, db: DB) {
    this.agentManager = agentManager;
    this.db = db;
    this.maxActiveConnectionsPerAgent = parseNonNegativeIntEnv("SERVER_MAX_ACTIVE_CONNECTIONS_PER_AGENT", 0);
    this.trafficFlushInterval = setInterval(() => {
      this.flushTrafficToDb();
    }, TRAFFIC_FLUSH_INTERVAL_MS);
  }

  private listenerMatchesTunnel(listener: Listener, tunnel: TunnelConfig): boolean {
    if (listener.type !== tunnel.type) return false;

    if (listener.type === "tcp") {
      const addr = listener.server.address();
      if (!addr || typeof addr === "string") return false;
      return addr.port === tunnel.listenPort;
    }

    if (listener.type === "udp") {
      const addr = listener.socket.address();
      return addr.port === tunnel.listenPort;
    }

    const tcpAddr = listener.tcpServer.address();
    if (!tcpAddr || typeof tcpAddr === "string") return false;
    const udpAddr = listener.udpSocket.address();
    return tcpAddr.port === tunnel.listenPort && udpAddr.port === tunnel.listenPort;
  }

  private isAgentAtConnectionCap(agentId: string): boolean {
    if (this.maxActiveConnectionsPerAgent <= 0) return false;
    const agent = this.agentManager.get(agentId);
    if (!agent) return false;
    return agent.activeConnections >= this.maxActiveConnectionsPerAgent;
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
      pendingInBytes: 0,
      pendingOutBytes: 0,
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
    state.pendingInBytes += bytes;
    state.dirty = true;
  }

  private addTrafficOut(tunnelId: string, bytes: number): void {
    if (bytes <= 0) return;
    const state = this.ensureTrafficState(tunnelId);
    state.totalOutBytes += bytes;
    state.pendingOutBytes += bytes;
    state.dirty = true;
  }

  private trafficIpKey(tunnelId: string, remoteIp: string): string {
    return `${tunnelId}|${remoteIp}`;
  }

  private normalizeIp(ip: string): string {
    if (!ip) return "unknown";
    if (ip.startsWith("::ffff:")) return ip.slice(7);
    return ip;
  }

  private parsePeerIp(peerAddr: string): string {
    if (!peerAddr) return "unknown";
    const raw = String(peerAddr).trim();
    if (!raw) return "unknown";

    // Bracketed IPv6 host:port form, e.g. [2001:db8::1]:443
    if (raw.startsWith("[")) {
      const end = raw.indexOf("]");
      if (end > 1) return this.normalizeIp(raw.slice(1, end));
      return this.normalizeIp(raw);
    }

    // IPv4 host:port form, e.g. 203.0.113.10:443
    const colonCount = (raw.match(/:/g) ?? []).length;
    if (raw.includes(".") && colonCount === 1) {
      const idx = raw.lastIndexOf(":");
      return this.normalizeIp(raw.slice(0, idx));
    }

    // Raw IP address (IPv4, IPv6, or IPv4-mapped IPv6)
    return this.normalizeIp(raw);
  }

  private ensureIpTrafficState(tunnelId: string, remoteIpRaw: string): IpTrafficState {
    const remoteIp = this.normalizeIp(remoteIpRaw);
    const key = this.trafficIpKey(tunnelId, remoteIp);
    const existing = this.trafficByIp.get(key);
    if (existing) return existing;

    const persisted = this.db.getIpTrafficTotals(tunnelId, remoteIp);
    const baselineIn = persisted?.inBytes ?? 0;
    const baselineOut = persisted?.outBytes ?? 0;
    const nowSec = Math.floor(Date.now() / 1000);
    const state: IpTrafficState = {
      tunnelId,
      remoteIp,
      totalInBytes: baselineIn,
      totalOutBytes: baselineOut,
      pendingInBytes: 0,
      pendingOutBytes: 0,
      lastFlushedInBytes: baselineIn,
      lastFlushedOutBytes: baselineOut,
      lastSeen: persisted?.lastSeen ?? nowSec,
      dirty: false,
    };
    this.trafficByIp.set(key, state);
    return state;
  }

  private addIpTrafficIn(tunnelId: string, remoteIp: string, bytes: number): void {
    if (bytes <= 0) return;
    const state = this.ensureIpTrafficState(tunnelId, remoteIp);
    state.totalInBytes += bytes;
    state.pendingInBytes += bytes;
    state.lastSeen = Math.floor(Date.now() / 1000);
    state.dirty = true;
  }

  private addIpTrafficOut(tunnelId: string, remoteIp: string, bytes: number): void {
    if (bytes <= 0) return;
    const state = this.ensureIpTrafficState(tunnelId, remoteIp);
    state.totalOutBytes += bytes;
    state.pendingOutBytes += bytes;
    state.lastSeen = Math.floor(Date.now() / 1000);
    state.dirty = true;
  }

  private currentRollupBucketStart(nowSec: number): number {
    return nowSec - (nowSec % TRAFFIC_ROLLUP_BUCKET_SECONDS);
  }

  private flushTrafficToDb(): void {
    const nowSec = Math.floor(Date.now() / 1000);
    const bucketStart = this.currentRollupBucketStart(nowSec);

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
        if (state.pendingInBytes > 0 || state.pendingOutBytes > 0) {
          this.db.addTrafficRollupBucket(
            bucketStart,
            tunnelId,
            "",
            state.pendingInBytes,
            state.pendingOutBytes,
          );
        }
        this.db.updateTunnelTrafficTotals(tunnelId, state.totalInBytes, state.totalOutBytes);
        state.lastFlushedInBytes = state.totalInBytes;
        state.lastFlushedOutBytes = state.totalOutBytes;
        state.pendingInBytes = 0;
        state.pendingOutBytes = 0;
        state.dirty = false;
      } catch (err) {
        tunnelLog.error(`[TunnelManager] Failed to flush traffic stats for tunnel ${tunnelId}:`, err);
      }
    }

    for (const state of this.trafficByIp.values()) {
      if (!state.dirty) continue;
      if (
        state.totalInBytes === state.lastFlushedInBytes &&
        state.totalOutBytes === state.lastFlushedOutBytes
      ) {
        state.dirty = false;
        continue;
      }

      try {
        if (state.pendingInBytes > 0 || state.pendingOutBytes > 0) {
          this.db.addTrafficRollupBucket(
            bucketStart,
            state.tunnelId,
            state.remoteIp,
            state.pendingInBytes,
            state.pendingOutBytes,
          );
        }
        this.db.upsertIpTrafficTotals(
          state.tunnelId,
          state.remoteIp,
          state.totalInBytes,
          state.totalOutBytes,
          state.lastSeen,
        );
        state.lastFlushedInBytes = state.totalInBytes;
        state.lastFlushedOutBytes = state.totalOutBytes;
        state.pendingInBytes = 0;
        state.pendingOutBytes = 0;
        state.dirty = false;
      } catch (err) {
        tunnelLog.error(
          `[TunnelManager] Failed to flush IP traffic stats for ${state.tunnelId} ${state.remoteIp}:`,
          err,
        );
      }
    }

    if (nowSec - this.lastRollupPruneAt >= 24 * 60 * 60) {
      try {
        this.db.pruneTrafficRollups(nowSec - TRAFFIC_RETENTION_SECONDS);
        this.lastRollupPruneAt = nowSec;
      } catch (err) {
        tunnelLog.error("[TunnelManager] Failed to prune traffic rollups:", err);
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

    // Start missing listeners and restart listeners with changed protocol/port.
    for (const tunnel of tunnels) {
      const existing = this.listeners.get(tunnel.id);
      if (!existing) {
        await this.startListener(tunnel);
        continue;
      }

      if (!this.listenerMatchesTunnel(existing, tunnel)) {
        await this.stopListener(tunnel.id, existing);
        await this.startListener(tunnel);
      }
    }
  }

  async startListener(tunnel: TunnelConfig): Promise<void> {
    if (this.listeners.has(tunnel.id)) return;

    try {
      if (tunnel.type === "tcp") {
        this.listeners.set(tunnel.id, await this.startTcpListener(tunnel));
      } else if (tunnel.type === "udp") {
        this.listeners.set(tunnel.id, await this.startUdpListener(tunnel));
      } else {
        const tcp = await this.startTcpListener(tunnel);
        try {
          const udp = await this.startUdpListener(tunnel);
          this.listeners.set(tunnel.id, {
            type: "tcp+udp",
            tunnelId: tunnel.id,
            tcpServer: tcp.server,
            udpSocket: udp.socket,
            sessions: udp.sessions,
          });
        } catch (err) {
          await this.stopListener(tunnel.id, tcp);
          throw err;
        }
      }
    } catch (err) {
      tunnelLog.error(`[TunnelManager] Failed to start listener for tunnel ${tunnel.id}:`, err);
    }
  }

  private startTcpListener(tunnel: TunnelConfig): Promise<TcpListener> {
    return new Promise((resolve, reject) => {
      const server = net.createServer({ allowHalfOpen: false });

      server.on("connection", (clientSocket) => {
        clientSocket.setNoDelay(true);
        this.handleTcpConnection(tunnel, clientSocket);
      });

      server.on("error", (err) => {
        tunnelLog.error(`[TunnelManager] TCP listener error on port ${tunnel.listenPort}:`, err);
      });

      server.listen(tunnel.listenPort, () => {
        tunnelLog.log(
          `[TunnelManager] TCP listener started for tunnel "${tunnel.name}" on port ${tunnel.listenPort}`,
        );
        resolve({ type: "tcp", server, tunnelId: tunnel.id });
      });

      server.once("error", reject);
    });
  }

  private async handleTcpConnection(tunnel: TunnelConfig, clientSocket: net.Socket): Promise<void> {
    const streamId = crypto.randomUUID();
    tunnelLog.log(
      `[TunnelManager] Inbound TCP on tunnel "${tunnel.name}", streamId=${streamId}`,
    );

    if (this.isAgentAtConnectionCap(tunnel.agentId)) {
      tunnelLog.warn(
        `[TunnelManager] Agent ${tunnel.agentId} at active connection cap; dropping streamId=${streamId}`,
      );
      clientSocket.destroy();
      return;
    }

    const agent = this.agentManager.get(tunnel.agentId);
    if (!agent || agent.socket.destroyed) {
      tunnelLog.warn(`[TunnelManager] Agent ${tunnel.agentId} is not connected; dropping streamId=${streamId}`);
      clientSocket.destroy();
      return;
    }

    this.agentManager.incActiveConnections(tunnel.agentId);
    const remoteIp = this.normalizeIp(clientSocket.remoteAddress ?? "unknown");

    const stream: TcpStream = {
      streamId,
      agentId: tunnel.agentId,
      tunnelId: tunnel.id,
      clientSocket,
    };
    this.tcpStreams.set(streamId, stream);

    const releaseStream = (): boolean => {
      const existing = this.tcpStreams.get(streamId);
      if (!existing) return false;
      this.tcpStreams.delete(streamId);
      this.agentManager.decActiveConnections(tunnel.agentId);
      return true;
    };

    clientSocket.on("data", (chunk: Buffer) => {
      this.addTrafficIn(tunnel.id, chunk.length);
      this.addIpTrafficIn(tunnel.id, remoteIp, chunk.length);
      try {
        const wrote = agent.socket.write(
          encodeFrame(MsgType.StreamData, {
            streamId,
            payload: chunk.toString("base64"),
          } satisfies StreamDataBody),
        );
        if (!wrote) {
          tunnelLog.warn(`[TunnelManager] Agent control socket write failed for stream ${streamId} - pausing client socket`);
          clientSocket.pause();
          try {
            const agentSock = agent.socket as net.Socket;
            let paused = this.pausedClientsByAgentSocket.get(agentSock);
            if (!paused) {
              paused = new Set<net.Socket>();
              this.pausedClientsByAgentSocket.set(agentSock, paused);
              tunnelLog.log(`[TunnelManager] Created new paused clients set for agent socket, count: ${paused.size}`);
              const pausedRef = paused;
              agentSock.once("drain", () => {
                tunnelLog.log(`[TunnelManager] Agent control socket drained, resuming ${pausedRef.size} paused clients`);
                const set = this.pausedClientsByAgentSocket.get(agentSock);
                if (set) {
                  for (const s of set) {
                    try {
                      if (!s.destroyed) s.resume();
                    } catch {}
                  }
                  this.pausedClientsByAgentSocket.delete(agentSock);
                }
              });
            }
            paused.add(clientSocket);
            tunnelLog.log(`[TunnelManager] Total paused clients for this agent: ${paused.size}`);
          } catch {
            // Best-effort: if agent/socket state changed, ignore and leave client paused
          }
        }
      } catch {
        clientSocket.destroy();
      }
    });

    clientSocket.on("close", () => {
      tunnelLog.log(`[TunnelManager] Client socket closed for stream ${streamId}`);
      const wasActive = releaseStream();
      if (!wasActive) {
        tunnelLog.log(`[TunnelManager] Stream ${streamId} already released (agent closed first)`);
        return;
      }
      try {
        agent.socket.write(
          encodeFrame(MsgType.StreamClose, {
            streamId,
            reason: "client_closed",
          } satisfies StreamCloseBody),
        );
      } catch {
        // ignore
      }
    });

    clientSocket.on("error", () => {
      clientSocket.destroy();
    });

    try {
      agent.socket.write(
        encodeFrame(MsgType.StreamOpen, {
          streamId,
          tunnelId: tunnel.id,
          kind: "tcp",
        } satisfies StreamOpenBody),
      );
    } catch {
      releaseStream();
      clientSocket.destroy();
    }
  }

  private startUdpListener(tunnel: TunnelConfig): Promise<UdpListener> {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket("udp4");
      const sessions = new Map<string, string>();

      sock.on("message", (msg, rinfo) => {
        const peerAddr = `${rinfo.address}:${rinfo.port}`;
        this.handleUdpMessage(tunnel, sock, sessions, peerAddr, msg);
      });

      sock.on("error", (err) => {
        tunnelLog.error(`[TunnelManager] UDP listener error on port ${tunnel.listenPort}:`, err);
      });

      sock.bind(tunnel.listenPort, () => {
        tunnelLog.log(
          `[TunnelManager] UDP listener started for tunnel "${tunnel.name}" on port ${tunnel.listenPort}`,
        );
        resolve({ type: "udp", socket: sock, tunnelId: tunnel.id, sessions });
      });

      sock.once("error", reject);
    });
  }

  private refreshUdpSessionIdle(streamId: string): void {
    const stream = this.udpStreams.get(streamId);
    if (!stream) return;
    clearTimeout(stream.idleTimer);
    stream.idleTimer = setTimeout(() => {
      tunnelLog.log(`[TunnelManager] UDP session idle timeout for peer ${stream.peerAddr}`);
      this.closeUdpStream(streamId, "idle_timeout");
    }, UDP_SESSION_IDLE_MS);
  }

  private closeUdpStream(streamId: string, reason: string, notifyAgent = true): void {
    const stream = this.udpStreams.get(streamId);
    if (!stream) return;

    this.udpStreams.delete(streamId);
    const listener = this.listeners.get(stream.tunnelId);
    if (listener?.type === "udp") {
      listener.sessions.delete(stream.peerAddr);
    } else if (listener?.type === "tcp+udp") {
      listener.sessions.delete(stream.peerAddr);
    }

    clearTimeout(stream.idleTimer);
    this.agentManager.decActiveConnections(stream.agentId);

    const agent = this.agentManager.get(stream.agentId);
    if (notifyAgent && agent && !agent.socket.destroyed) {
      try {
        agent.socket.write(
          encodeFrame(MsgType.StreamClose, {
            streamId,
            reason,
          } satisfies StreamCloseBody),
        );
      } catch {
        // ignore write failures on closing paths
      }
    }
  }

  private async handleUdpMessage(
    tunnel: TunnelConfig,
    udpSock: dgram.Socket,
    sessions: Map<string, string>,
    peerAddr: string,
    msg: Buffer,
  ): Promise<void> {
    const existingStreamId = sessions.get(peerAddr);
    let streamId = existingStreamId;

    if (!streamId) {
      if (this.isAgentAtConnectionCap(tunnel.agentId)) {
        tunnelLog.warn(
          `[TunnelManager] Agent ${tunnel.agentId} at active connection cap; dropping UDP peer=${peerAddr}`,
        );
        return;
      }

      const agent = this.agentManager.get(tunnel.agentId);
      if (!agent || agent.socket.destroyed) {
        return;
      }

      streamId = crypto.randomUUID();
      const currentStreamId = streamId;
      const idleTimer = setTimeout(() => {
        this.closeUdpStream(currentStreamId, "idle_timeout");
      }, UDP_SESSION_IDLE_MS);

      this.udpStreams.set(streamId, {
        streamId,
        agentId: tunnel.agentId,
        tunnelId: tunnel.id,
        udpSock,
        peerAddr,
        idleTimer,
      });
      sessions.set(peerAddr, streamId);
      this.agentManager.incActiveConnections(tunnel.agentId);

      try {
        agent.socket.write(
          encodeFrame(MsgType.StreamOpen, {
            streamId,
            tunnelId: tunnel.id,
            kind: "udp",
            peerAddr,
          } satisfies StreamOpenBody),
        );
      } catch {
        this.closeUdpStream(streamId, "open_failed");
        return;
      }
    }

    this.refreshUdpSessionIdle(streamId);
    this.addTrafficIn(tunnel.id, msg.length);
    this.addIpTrafficIn(tunnel.id, this.parsePeerIp(peerAddr), msg.length);

    const agent = this.agentManager.get(tunnel.agentId);
    if (!agent || agent.socket.destroyed) {
      this.closeUdpStream(streamId, "agent_disconnected");
      return;
    }

    try {
      agent.socket.write(
        encodeFrame(MsgType.StreamData, {
          streamId,
          payload: msg.toString("base64"),
        } satisfies StreamDataBody),
      );
    } catch {
      this.closeUdpStream(streamId, "write_failed");
    }
  }

  handleAgentStreamData(agentId: string, body: StreamDataBody): void {
    tunnelLog.log(`[TunnelManager] handleAgentStreamData called for agent ${agentId}, stream ${body.streamId}`);
    const tcpStream = this.tcpStreams.get(body.streamId);
    if (tcpStream && tcpStream.agentId === agentId) {
      tunnelLog.log(`[TunnelManager] Handling TCP stream data for stream ${body.streamId}`);
      const payload = Buffer.from(body.payload, "base64");
      this.addTrafficOut(tcpStream.tunnelId, payload.length);
      this.addIpTrafficOut(
        tcpStream.tunnelId,
        this.normalizeIp(tcpStream.clientSocket.remoteAddress ?? "unknown"),
        payload.length,
      );
      try {
        const wrote = tcpStream.clientSocket.write(payload);
        if (!wrote) {
          tunnelLog.log(`[TunnelManager] TCP client socket paused for stream ${body.streamId}`);
          const agent = this.agentManager.get(agentId);
          if (agent && !agent.socket.destroyed) {
            agent.socket.pause();
            tcpStream.clientSocket.once("drain", () => {
              if (!agent.socket.destroyed) {
                tunnelLog.log(`[TunnelManager] TCP client socket resumed for stream ${body.streamId}`);
                agent.socket.resume();
              }
            });
          }
        } else {
          tunnelLog.log(`[TunnelManager] TCP data written successfully for stream ${body.streamId}`);
        }
      } catch (err) {
        tunnelLog.error(`[TunnelManager] Error writing to TCP client socket for stream ${body.streamId}:`, err);
        tcpStream.clientSocket.destroy();
      }
      return;
    }

    const udpStream = this.udpStreams.get(body.streamId);
    if (udpStream && udpStream.agentId === agentId) {
      tunnelLog.log(`[TunnelManager] Handling UDP stream data for stream ${body.streamId}`);
      try {
        const payload = Buffer.from(body.payload, "base64");
        const lastColon = udpStream.peerAddr.lastIndexOf(":");
        const host = udpStream.peerAddr.slice(0, lastColon);
        const port = parseInt(udpStream.peerAddr.slice(lastColon + 1), 10);
        this.addTrafficOut(udpStream.tunnelId, payload.length);
        this.addIpTrafficOut(udpStream.tunnelId, this.parsePeerIp(udpStream.peerAddr), payload.length);
        this.refreshUdpSessionIdle(body.streamId);
        udpStream.udpSock.send(payload, port, host);
        tunnelLog.log(`[TunnelManager] UDP data sent successfully for stream ${body.streamId}`);
      } catch (err) {
        tunnelLog.error(`[TunnelManager] Error writing UDP data for stream ${body.streamId}:`, err);
        this.closeUdpStream(body.streamId, "write_failed", false);
      }
    } else if (udpStream && udpStream.agentId !== agentId) {
      tunnelLog.warn(`[TunnelManager] Stream ${body.streamId} not owned by agent ${agentId}`);
    } else if (!udpStream) {
      tunnelLog.warn(`[TunnelManager] No UDP stream found for stream ID ${body.streamId}`);
    }
  }

  handleAgentStreamClose(agentId: string, body: StreamCloseBody): void {
    const tcpStream = this.tcpStreams.get(body.streamId);
    if (tcpStream && tcpStream.agentId === agentId) {
      tunnelLog.log(`[TunnelManager] Agent sent StreamClose for stream ${body.streamId}, reason: ${body.reason ?? "unknown"}`);
      this.tcpStreams.delete(body.streamId);
      this.agentManager.decActiveConnections(agentId);
      tcpStream.clientSocket.destroy();
      return;
    }

    const udpStream = this.udpStreams.get(body.streamId);
    if (udpStream && udpStream.agentId === agentId) {
      this.closeUdpStream(body.streamId, body.reason ?? "agent_closed", false);
    }
  }

  closeAgentStreams(agentId: string): void {
    tunnelLog.warn(`[TunnelManager] closeAgentStreams called for agent ${agentId} (TCP streams: ${this.tcpStreams.size}, UDP streams: ${this.udpStreams.size})`);
    let tcpCount = 0;
    for (const [streamId, stream] of this.tcpStreams) {
      if (stream.agentId !== agentId) continue;
      tunnelLog.log(`[TunnelManager] Closing TCP stream ${streamId} for agent ${agentId}`);
      this.tcpStreams.delete(streamId);
      this.agentManager.decActiveConnections(agentId);
      stream.clientSocket.destroy();
      tcpCount++;
    }
    tunnelLog.log(`[TunnelManager] Closed ${tcpCount} TCP streams for agent ${agentId}`);

    const udpToClose: string[] = [];
    for (const [streamId, stream] of this.udpStreams) {
      if (stream.agentId === agentId) udpToClose.push(streamId);
    }
    for (const streamId of udpToClose) {
      this.closeUdpStream(streamId, "agent_disconnected", false);
    }
    tunnelLog.log(`[TunnelManager] Closed ${udpToClose.length} UDP streams for agent ${agentId}`);
    
    // Log remaining streams after cleanup
    const remainingTcp = this.tcpStreams.size;
    const remainingUdp = this.udpStreams.size;
    tunnelLog.log(`[TunnelManager] Remaining streams after cleanup - TCP: ${remainingTcp}, UDP: ${remainingUdp}`);
  }

  clearTrafficData(): void {
    this.trafficByTunnel.clear();
    this.trafficByIp.clear();
    this.db.clearTrafficData();
  }

  private stopListener(tunnelId: string, listener: Listener): Promise<void> {
    this.listeners.delete(tunnelId);

    if (listener.type === "tcp") {
      return new Promise((resolve) => {
        listener.server.close(() => {
          tunnelLog.log(`[TunnelManager] TCP listener stopped for tunnel ${tunnelId}`);
          resolve();
        });
      });
    }

    if (listener.type === "tcp+udp") {
      return new Promise((resolve) => {
        for (const streamId of listener.sessions.values()) {
          this.closeUdpStream(streamId, "listener_stopped", false);
        }
        listener.sessions.clear();

        let remaining = 2;
        const done = () => {
          remaining -= 1;
          if (remaining <= 0) {
            tunnelLog.log(`[TunnelManager] TCP+UDP listeners stopped for tunnel ${tunnelId}`);
            resolve();
          }
        };

        listener.tcpServer.close(done);
        listener.udpSocket.close(done);
      });
    }

    return new Promise((resolve) => {
      for (const streamId of listener.sessions.values()) {
        this.closeUdpStream(streamId, "listener_stopped", false);
      }
      listener.sessions.clear();
      listener.socket.close(() => {
        tunnelLog.log(`[TunnelManager] UDP listener stopped for tunnel ${tunnelId}`);
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
