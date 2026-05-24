import dgram from 'node:dgram';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { connect, type Socket } from 'bun';
import { FRAME_TYPES, type AgentRuntimeConfig, type DialTcpFrame, type DialUdpSessionFrame, type TunnelRecord } from '@privatefrp/shared';
import { decodeData, encodeData, encodeFrame, FrameParser, nowMs } from '@privatefrp/shared';

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

type TrustedServerCertificate = {
  fingerprint256: string;
  subject?: string;
  issuer?: string;
  validFrom?: string;
  validTo?: string;
};

function asUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array(0);
}

function writeSocket(socket: any, data: Uint8Array): void {
  if (typeof socket.write === 'function') {
    socket.write(data);
    return;
  }
  if (typeof socket.send === 'function') {
    socket.send(data);
  }
}

export class AgentClient {
  private socket: Socket | null = null;
  private parser = new FrameParser();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly tcpStreams = new Map<string, LocalTcpStream>();
  private readonly udpSessions = new Map<string, LocalUdpSession>();
  private tunnels = new Map<string, TunnelRecord>();

  constructor(private readonly config: AgentRuntimeConfig) {}

  start(): void {
    void this.connectLoop();
  }

  private async connectLoop(): Promise<void> {
    while (true) {
      try {
        await this.connectOnce();
      } catch (error) {
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
        tls: { rejectUnauthorized: false } as any,
        socket: {
          open: (s: Socket) => {
            void this.handleSocketOpen(s).then(() => {
              this.socket = s;
              this.parser = new FrameParser();
              this.sendHello();
              this.startHeartbeat();
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
            resolveOnce();
          },
          error: (_s: Socket, error: Error) => {
            this.stopHeartbeat();
            rejectOnce(error);
          }
        }
      });
      void socket;
    });
  }

  private async handleSocketOpen(socket: Socket): Promise<void> {
    await this.verifyServerCertificate(socket);
    socket.setNoDelay(true);
  }

  private async verifyServerCertificate(socket: Socket): Promise<void> {
    const peerCertificate = socket.getPeerX509Certificate?.();
    if (!peerCertificate) {
      throw new Error('TLS server certificate is not available');
    }

    const fingerprint256 = String((peerCertificate as { fingerprint256?: string }).fingerprint256 || '').trim();
    if (!fingerprint256) {
      throw new Error('TLS server certificate fingerprint is missing');
    }

    const trusted = await this.readTrustedServerCertificate();
    if (!trusted) {
      await this.storeTrustedServerCertificate({
        fingerprint256,
        subject: String((peerCertificate as { subject?: string }).subject || ''),
        issuer: String((peerCertificate as { issuer?: string }).issuer || ''),
        validFrom: String((peerCertificate as { validFrom?: string }).validFrom || ''),
        validTo: String((peerCertificate as { validTo?: string }).validTo || '')
      });
      return;
    }

    if (trusted.fingerprint256 !== fingerprint256) {
      throw new Error('Trusted server certificate fingerprint mismatch');
    }
  }

  private async readTrustedServerCertificate(): Promise<TrustedServerCertificate | null> {
    try {
      await access(this.config.trustStorePath);
      const text = await readFile(this.config.trustStorePath, 'utf8');
      if (!text.trim()) return null;
      const parsed = JSON.parse(text) as TrustedServerCertificate;
      return typeof parsed?.fingerprint256 === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }

  private async storeTrustedServerCertificate(record: TrustedServerCertificate): Promise<void> {
    await mkdir(dirname(this.config.trustStorePath), { recursive: true });
    await writeFile(this.config.trustStorePath, JSON.stringify(record, null, 2), 'utf8');
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

  private send(frame: Parameters<typeof encodeFrame>[0]): void {
    if (!this.socket) return;
    writeSocket(this.socket, encodeFrame(frame));
  }

  private async handleFrame(frame: { type: string; payload?: unknown; streamId?: string }): Promise<void> {
    switch (frame.type) {
      case FRAME_TYPES.SERVER_HELLO:
        return;
      case FRAME_TYPES.CONFIG_PUSH: {
        const payload = frame.payload as { tunnels?: TunnelRecord[] } | undefined;
        this.tunnels = new Map((payload?.tunnels || []).map(tunnel => [tunnel.id, tunnel]));
        this.send({ type: FRAME_TYPES.CONFIG_ACK, payload: { receivedAt: nowMs() } });
        return;
      }
      case FRAME_TYPES.DIAL_TCP: {
        const payload = frame.payload as DialTcpFrame | undefined;
        if (!payload?.streamId) return;
        await this.openLocalTcpStream(payload);
        return;
      }
      case FRAME_TYPES.DIAL_UDP_SESSION: {
        const payload = frame.payload as DialUdpSessionFrame | undefined;
        if (!payload?.sessionId) return;
        this.openLocalUdpSession(payload);
        return;
      }
      case FRAME_TYPES.STREAM_DATA: {
        const payload = frame.payload as { streamId?: string; data?: string } | undefined;
        if (!payload?.streamId || typeof payload.data !== 'string') return;
        const stream = this.tcpStreams.get(payload.streamId);
        if (!stream) return;
        stream.socket.write(decodeData(payload.data));
        return;
      }
      case FRAME_TYPES.STREAM_CLOSE: {
        const payload = frame.payload as { streamId?: string } | undefined;
        if (!payload?.streamId) return;
        const stream = this.tcpStreams.get(payload.streamId);
        stream?.socket.close?.();
        this.tcpStreams.delete(payload.streamId);
        return;
      }
      case FRAME_TYPES.UDP_DATA: {
        const payload = frame.payload as { sessionId?: string; data?: string } | undefined;
        if (!payload?.sessionId || typeof payload.data !== 'string') return;
        const session = this.udpSessions.get(payload.sessionId);
        if (!session) return;
        session.socket.send(decodeData(payload.data), session.targetPort, session.targetHost);
        return;
      }
      default:
        return;
    }
  }

  private async openLocalTcpStream(payload: DialTcpFrame): Promise<void> {
    const tunnel = this.tunnels.get(payload.tunnelId);
    if (!tunnel) {
      this.send({ type: FRAME_TYPES.STREAM_CLOSE, streamId: payload.streamId, payload: { streamId: payload.streamId, reason: 'tunnel missing' } });
      return;
    }

    const socket = connect({
      hostname: tunnel.targetHost,
      port: tunnel.targetPort,
      socket: {
        open: (localSocket: Socket) => {
          this.tcpStreams.set(payload.streamId, { streamId: payload.streamId, tunnelId: payload.tunnelId, socket: localSocket });
          this.send({ type: FRAME_TYPES.STREAM_OPEN, streamId: payload.streamId, payload: { streamId: payload.streamId } });
        },
        data: (_localSocket: Socket, data: unknown) => {
          const bytes = asUint8Array(data);
          this.send({ type: FRAME_TYPES.STREAM_DATA, streamId: payload.streamId, payload: { streamId: payload.streamId, data: encodeData(bytes) } });
        },
        close: () => {
          this.send({ type: FRAME_TYPES.STREAM_CLOSE, streamId: payload.streamId, payload: { streamId: payload.streamId, reason: 'local closed' } });
          this.tcpStreams.delete(payload.streamId);
        },
        error: (_socket: Socket, error: Error) => {
          console.error('[agent] local tcp error', error);
        }
      }
    });
    void socket;
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
          data: encodeData(message),
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
  }

  private cleanupAllStreams(): void {
    for (const stream of this.tcpStreams.values()) {
      try {
        stream.socket.close?.();
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
  }
}
