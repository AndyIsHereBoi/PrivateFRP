import dgram from 'node:dgram';
import { connect, type Socket } from 'bun';
import { FRAME_TYPES, type AgentRuntimeConfig, type DialTcpFrame, type DialUdpSessionFrame, type TunnelRecord } from '@privatefrp/shared';
import { encodeFrame, FrameParser, nowMs } from '@privatefrp/shared';

type LocalTcpStream = {
  streamId: string;
  tunnelId: string;
  socket: Socket;
};

type LocalUdpSession = {
  sessionId: string;
  socket: any;
  targetHost: string;
  targetPort: number;
};

function asUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array(0);
}

function writeSocket(socket: any, data: Uint8Array): number {
  if (typeof socket.write === 'function') {
    return socket.write(data);
  }
  if (typeof socket.send === 'function') {
    const result = socket.send(data);
    return typeof result === 'number' ? result : data.byteLength;
  }
  return -1;
}

const MAX_SERVER_QUEUE_BYTES = 512 * 1024;
const BACKPRESSURE_LOG_MS = 2000;

export class AgentClient {
  private socket: Socket | null = null;
  private parser = new FrameParser();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly tcpStreams = new Map<string, LocalTcpStream>();
  private readonly udpSessions = new Map<string, LocalUdpSession>();
  private tunnels = new Map<string, TunnelRecord>();
  private stopping = false;
  private pendingWrites: Uint8Array[] = [];
  private pendingBytes = 0;
  private lastBackpressureLogAt = 0;
  private pausedSockets = new Set<Socket>();

  constructor(private readonly config: AgentRuntimeConfig) {}

  start(): void {
    void this.connectLoop();
  }

  stop(): void {
    this.stopping = true;
    this.stopHeartbeat();
    this.cleanupAllStreams();
    this.pendingWrites = [];
    this.pendingBytes = 0;
    this.pausedSockets.clear();
    try {
      this.socket?.close?.();
    } catch {
      // ignore
    }
    this.socket = null;
  }

  private async connectLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.connectOnce();
      } catch (error) {
        if (this.stopping) break;
        console.error('[agent] connection failed', error);
        await new Promise(resolve => setTimeout(resolve, this.config.reconnectDelayMs));
      }
    }
  }

  private async connectOnce(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const resolveOnce = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const rejectOnce = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      const socket = connect({
        hostname: this.config.serverHost,
        port: this.config.serverPort,
        socket: {
          open: (s: Socket) => {
            void this.handleSocketOpen(s).then(() => {
              this.socket = s;
              this.parser = new FrameParser();
              this.sendHello();
              this.startHeartbeat();
              console.log('[agent] connected');
            }).catch(error => {
              rejectOnce(error);
              try {
                s.close();
              } catch {
                // ignore
              }
            });
          },
          data: (_s: Socket, data: unknown) => {
            for (const frame of this.parser.push(asUint8Array(data))) {
              void this.handleFrame(frame);
            }
          },
          close: () => {
            this.stopHeartbeat();
            this.cleanupAllStreams();
            this.socket = null;
            console.log('[agent] disconnected');
            resolveOnce();
          },
          drain: () => {
            this.flushPendingWrites();
          },
          error: (_s: Socket, error: Error) => {
            this.stopHeartbeat();
            console.error('[agent] control socket error', error);
            rejectOnce(error);
          }
        }
      });
      void socket;
    });
  }

  private async handleSocketOpen(socket: Socket): Promise<void> {
    socket.setNoDelay(true);
  }

  private sendHello(): void {
    this.send({
      type: FRAME_TYPES.AGENT_HELLO,
      payload: {
        agentId: this.config.agentId,
        agentSecret: this.config.agentSecret,
        agentName: this.config.agentName,
        protocolVersion: 1
      }
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({
        type: FRAME_TYPES.HEARTBEAT,
        payload: { timestamp: nowMs() }
      });
    }, 5000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private send(frame: Parameters<typeof encodeFrame>[0]): boolean {
    if (!this.socket) return false;
    return this.writeToServer(encodeFrame(frame));
  }

  private writeToServer(data: Uint8Array): boolean {
    if (!this.socket) return false;
    if (this.pendingBytes > 0) {
      this.queueServerBytes(data);
      return this.backpressureStatus();
    }

    const written = writeSocket(this.socket, data);
    if (written < 0) return false;
    if (written < data.byteLength) {
      this.queueServerBytes(data.subarray(written));
      return this.backpressureStatus();
    }

    return true;
  }

  private queueServerBytes(data: Uint8Array): void {
    if (data.byteLength <= 0) return;
    this.pendingWrites.push(data);
    this.pendingBytes += data.byteLength;
  }

  private flushPendingWrites(): void {
    if (!this.socket) return;
    while (this.pendingWrites.length > 0) {
      const chunk = this.pendingWrites[0];
      if (!chunk) break;
      const written = writeSocket(this.socket, chunk);
      if (written < 0) return;
      if (written < chunk.byteLength) {
        this.pendingWrites[0] = chunk.subarray(written);
        this.pendingBytes -= written;
        return;
      }
      this.pendingWrites.shift();
      this.pendingBytes -= chunk.byteLength;
    }

    if (this.pendingBytes === 0 && this.pausedSockets.size > 0) {
      for (const sock of this.pausedSockets) {
        try {
          sock.resume?.();
        } catch {
          // ignore
        }
      }
      this.pausedSockets.clear();
    }
  }

  private backpressureStatus(): boolean {
    if (this.pendingBytes > MAX_SERVER_QUEUE_BYTES) {
      const now = nowMs();
      if (now - this.lastBackpressureLogAt > BACKPRESSURE_LOG_MS) {
        this.lastBackpressureLogAt = now;
        console.warn(`[agent] backpressure queue=${this.pendingBytes}`);
      }
    }
    return this.pendingBytes === 0;
  }

  private async handleFrame(frame: { type: string; payload?: unknown; streamId?: string }): Promise<void> {
    switch (frame.type) {
      case FRAME_TYPES.SERVER_HELLO:
        return;
      case FRAME_TYPES.CONFIG_PUSH: {
        const payload = frame.payload as { tunnels?: TunnelRecord[] } | undefined;
        this.tunnels = new Map((payload?.tunnels || []).map(tunnel => [tunnel.id, tunnel]));
        this.send({ type: FRAME_TYPES.CONFIG_ACK, payload: { receivedAt: nowMs() } });
        console.log(`[agent] config push (${this.tunnels.size} tunnels)`);
        return;
      }
      case FRAME_TYPES.DIAL_TCP: {
        const payload = frame.payload as DialTcpFrame | undefined;
        if (!payload?.streamId) return;
        console.log(`[agent] dial tcp ${payload.streamId} -> ${payload.tunnelId}`);
        await this.openLocalTcpStream(payload);
        return;
      }
      case FRAME_TYPES.DIAL_UDP_SESSION: {
        const payload = frame.payload as DialUdpSessionFrame | undefined;
        if (!payload?.sessionId) return;
        console.log(`[agent] dial udp ${payload.sessionId} -> ${payload.tunnelId}`);
        this.openLocalUdpSession(payload);
        return;
      }
      case FRAME_TYPES.STREAM_CLOSE: {
        const payload = frame.payload as { streamId?: string } | undefined;
        if (!payload?.streamId) return;
        const stream = this.tcpStreams.get(payload.streamId);
        if (stream?.socket) {
          try {
            stream.socket.close?.();
          } catch { /* ignore */ }
        }
        this.tcpStreams.delete(payload.streamId);
        console.log(`[agent] stream close ${payload.streamId}`);
        return;
      }
      default:
        return;
    }
  }

  private async openLocalTcpStream(payload: DialTcpFrame): Promise<void> {
    const tunnel = this.tunnels.get(payload.tunnelId);
    if (!tunnel) {
      console.warn(`[agent] missing tunnel ${payload.tunnelId} for stream ${payload.streamId}`);
      return;
    }

    console.log(`[agent] opening data pipe ${payload.streamId} -> ${tunnel.targetHost}:${tunnel.targetPort}`);
    // Connect to the local service first, then establish the server data socket.
    const localPromise = connect({
      hostname: tunnel.targetHost,
      port: tunnel.targetPort,
      socket: {
        open: (ls: Socket) => {
          ls.setNoDelay(true);
          // register local stream but keep it paused until data socket is ready
          this.tcpStreams.set(payload.streamId, { streamId: payload.streamId, tunnelId: payload.tunnelId, socket: ls });
          try { ls.pause?.(); } catch {}

          // Now open data socket to server
          const dataPromise = connect({
            hostname: this.config.serverHost,
            port: this.config.dataPort,
            socket: {
              open: (ds: Socket) => {
                // Send streamId header
                const idBytes = new TextEncoder().encode(payload.streamId);
                const header = new Uint8Array(2 + idBytes.length);
                new DataView(header.buffer).setUint16(0, idBytes.length, false);
                header.set(idBytes, 2);
                ds.write(header);
                try { ds.setNoDelay(Boolean(this.config.dataTcpNoDelay)); } catch {}

                // link sockets
                (ds as any).__local = ls;
                (ls as any).__remote = ds;

                // resume local now that ds is ready
                try { ls.resume?.(); } catch {}
              },
              data: (ds: Socket, data: unknown) => {
                const local = (ds as any).__local as Socket | undefined;
                if (!local) {
                  // no local yet; pause ds to avoid buffering
                  try { ds.pause?.(); } catch {}
                  return;
                }
                const bytes = asUint8Array(data);
                if (bytes.byteLength === 0) return;
                const written = writeSocket(local, bytes);
                if (written < 0) {
                  try { local.end?.(); } catch {}
                  return;
                }
                if (written < bytes.byteLength) {
                  // single-slot pending for local
                  (local as any).__pendingLocal = { buf: bytes, offset: written };
                  try { ds.pause?.(); } catch {}
                  return;
                }
              },
              close: (ds: Socket) => {
                console.log(`[agent] data socket closed ${payload.streamId}`);
                const local = (ds as any).__local as Socket | undefined;
                this.tcpStreams.delete(payload.streamId);
                try { local?.end?.(); } catch {}
              },
              drain: (ds: Socket) => {
                // flush pending bytes from local -> server if any
                const pending = (ds as any).__pendingToServer as { buf: Uint8Array; offset: number } | undefined;
                if (pending) {
                  const chunk = pending.buf.subarray(pending.offset);
                  const wrote = writeSocket(ds, chunk);
                  if (wrote < 0) {
                    try { (ds as any).__local?.end?.(); } catch {}
                    return;
                  }
                  if (wrote < chunk.length) {
                    pending.offset += wrote;
                    return;
                  }
                  (ds as any).__pendingToServer = undefined;
                }
                try { (ds as any).__local?.resume?.(); } catch {}
              },
              error: (_ds: Socket, error: Error) => {
                console.error('[agent] data socket error', error);
              }
            }
          });
          dataPromise.catch((err: Error) => {
            console.error(`[agent] data connect failed ${payload.streamId}`, err);
            try { ls.end?.(); } catch {}
          });
        },
        data: (ls: Socket, data: unknown) => {
          const ds = (ls as any).__remote as Socket | undefined;
          if (!ds) {
            // pause local until ds is ready - avoids buffering in the agent process
            try { ls.pause?.(); } catch {}
            return;
          }
          const bytes = asUint8Array(data);
          if (bytes.byteLength === 0) return;
          const written = writeSocket(ds, bytes);
          if (written < 0) {
            try { ls.end?.(); } catch {}
            return;
          }
          if (written < bytes.byteLength) {
            // single-slot pending for ds
            (ds as any).__pendingToServer = { buf: bytes, offset: written };
            try { ls.pause?.(); } catch {}
            return;
          }
        },
        close: () => {
          console.log(`[agent] local closed ${payload.streamId}`);
          this.tcpStreams.delete(payload.streamId);
        },
        drain: (ls: Socket) => {
          const pendingLocal = (ls as any).__pendingLocal as { buf: Uint8Array; offset: number } | undefined;
          if (pendingLocal) {
            const chunk = pendingLocal.buf.subarray(pendingLocal.offset);
            const wrote = writeSocket(ls, chunk);
            if (wrote < 0) {
              try { (ls as any).__remote?.end?.(); } catch {}
              return;
            }
            if (wrote < chunk.length) {
              pendingLocal.offset += wrote;
              return;
            }
            (ls as any).__pendingLocal = undefined;
          }
          try { (ls as any).__remote?.resume?.(); } catch {}
        },
        error: (_ls: Socket, error: Error) => {
          console.error('[agent] local tcp error', error);
        }
      }
    });
    localPromise.catch((err: Error) => {
      console.error(`[agent] local connect failed ${payload.streamId} -> ${tunnel.targetHost}:${tunnel.targetPort}`, err);
    });
  }

  private openLocalUdpSession(payload: DialUdpSessionFrame): void {
    const session = this.udpSessions.get(payload.sessionId);
    if (session) return;

    const socket = dgram.createSocket('udp4');
    socket.on('message', (message: Uint8Array) => {
      this.send({
        type: FRAME_TYPES.UDP_DATA,
        streamId: payload.sessionId,
        payload: {
          sessionId: payload.sessionId,
          data: Buffer.from(message).toString('base64'),
          peerAddress: payload.peerAddress,
          peerPort: payload.peerPort
        }
      });
    });
    socket.bind();
    this.udpSessions.set(payload.sessionId, {
      sessionId: payload.sessionId,
      socket,
      targetHost: payload.targetHost,
      targetPort: payload.targetPort
    });
    console.log(`[agent] udp session ${payload.sessionId} -> ${payload.targetHost}:${payload.targetPort}`);
  }

  private cleanupAllStreams(): void {
    for (const stream of this.tcpStreams.values()) {
      try {
        stream.socket?.close?.();
      } catch {
        // ignore
      }
    }
    this.tcpStreams.clear();

    for (const session of this.udpSessions.values()) {
      try {
        session.socket.close();
      } catch {
        // ignore
      }
    }
    this.udpSessions.clear();
    console.log('[agent] cleaned up all streams');
  }
}
