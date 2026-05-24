import dgram from 'node:dgram';
import { connect, type Socket } from 'bun';
import { DEFAULTS, FRAME_TYPES, type AgentConfig, type DialTcpFrame, type DialUdpSessionFrame, type Frame, type StreamCloseFrame, type StreamDataFrame, type TunnelRecord } from '@privatefrp/shared';
import { encodeData, encodeFrame, decodeData, FrameParser, nowMs } from '@privatefrp/shared';
import type { ServerRuntimeConfig } from '@privatefrp/shared';
import type { ServerStore } from './store';

type TcpClientState = {
  streamId: string;
  tunnelId: string;
  agentId: string;
  socket: any;
  open: boolean;
  queued: Uint8Array[];
};

type UdpSessionState = {
  sessionId: string;
  tunnelId: string;
  agentId: string;
  socket: any;
  peerAddress: string;
  peerPort: number;
  targetHost: string;
  targetPort: number;
};

type AgentConnectionState = {
  socket: Socket;
  parser: FrameParser;
  agentId: string;
  agentName: string;
  remoteAddress: string | null;
  connectedAt: number;
  lastHeartbeat: number;
  lastLatency: number | null;
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

export class ControlPlane {
  private readonly agentConnections = new Map<string, AgentConnectionState>();
  private readonly tcpStreams = new Map<string, TcpClientState>();
  private readonly udpSessions = new Map<string, UdpSessionState>();
  private readonly tcpListeners = new Map<string, any>();
  private readonly udpListeners = new Map<string, any>();
  private agentTlsCert = '';
  private agentTlsKey = '';

  constructor(
    private readonly config: ServerRuntimeConfig,
    private readonly store: ServerStore,
    private readonly broadcastDashboard: () => void,
    private readonly assetBasePath: string
  ) {}

  async start(): Promise<void> {
    this.agentTlsCert = await Bun.file(this.config.tlsCertPath).text();
    this.agentTlsKey = await Bun.file(this.config.tlsKeyPath).text();

    Bun.listen({
      hostname: this.config.host,
      port: this.config.agentPort,
      tls: {
        cert: this.agentTlsCert,
        key: this.agentTlsKey
      },
      socket: {
        open: (socket: Socket) => this.onAgentSocketOpen(socket),
        data: (socket: Socket, data: unknown) => this.onAgentSocketData(socket, data),
        close: (socket: Socket) => this.onAgentSocketClose(socket),
        error: (_socket: Socket, error: Error) => {
          console.error('[agent] socket error', error);
        }
      }
    });

    await this.refreshTunnelListeners();
  }

  getAgents(): ReturnType<ServerStore['listAgents']> {
    return this.store.listAgents().map(agent => {
      const live = this.agentConnections.get(agent.id);
      return {
        ...agent,
        remoteAddress: live?.remoteAddress ?? agent.remoteAddress,
        lastHeartbeat: live?.lastHeartbeat ?? agent.lastHeartbeat,
        latencyMs: live?.lastLatency ?? agent.latencyMs,
        activeConnections: agent.activeConnections
      };
    });
  }

  getTunnels(): TunnelRecord[] {
    return this.store.listTunnels();
  }

  registerAgent(name: string): { agentId: string; agentSecret: string } {
    const created = this.store.createAgent(name);
    this.broadcastDashboard();
    return created;
  }

  updateAgent(agentId: string, patch: { enabled?: boolean; name?: string }): void {
    this.store.updateAgent(agentId, patch);
    this.refreshTunnelListeners().catch(console.error);
    this.broadcastDashboard();
  }

  deleteAgent(agentId: string): void {
    this.closeAgentConnection(agentId, 'agent deleted');
    this.store.deleteAgent(agentId);
    this.refreshTunnelListeners().catch(console.error);
    this.broadcastDashboard();
  }

  createTunnel(input: Omit<TunnelRecord, 'id' | 'createdAt'>): TunnelRecord {
    const tunnel = this.store.createTunnel(input);
    this.refreshTunnelListeners().catch(console.error);
    this.broadcastDashboard();
    return tunnel;
  }

  updateTunnel(tunnelId: string, patch: Partial<Omit<TunnelRecord, 'id' | 'createdAt'>>): TunnelRecord | null {
    const tunnel = this.store.updateTunnel(tunnelId, patch);
    this.refreshTunnelListeners().catch(console.error);
    this.broadcastDashboard();
    return tunnel;
  }

  deleteTunnel(tunnelId: string): void {
    this.store.deleteTunnel(tunnelId);
    this.refreshTunnelListeners().catch(console.error);
    this.broadcastDashboard();
  }

  setTunnelEnabled(tunnelId: string, enabled: boolean): TunnelRecord | null {
    const tunnel = this.store.setTunnelEnabled(tunnelId, enabled);
    this.refreshTunnelListeners().catch(console.error);
    this.broadcastDashboard();
    return tunnel;
  }

  async refreshTunnelListeners(): Promise<void> {
    const tunnels = this.store.listTunnels();
    const activeIds = new Set<string>();

    for (const tunnel of tunnels) {
      if (!tunnel.enabled) continue;
      activeIds.add(tunnel.id);
      if (tunnel.type === 'tcp' || tunnel.type === 'tcp+udp') {
        this.ensureTcpListener(tunnel);
      }
      if (tunnel.type === 'udp' || tunnel.type === 'tcp+udp') {
        this.ensureUdpListener(tunnel);
      }
    }

    for (const [tunnelId, listener] of this.tcpListeners) {
      if (!activeIds.has(tunnelId)) {
        listener.close?.();
        this.tcpListeners.delete(tunnelId);
      }
    }
    for (const [tunnelId, listener] of this.udpListeners) {
      if (!activeIds.has(tunnelId)) {
        listener.close();
        this.udpListeners.delete(tunnelId);
      }
    }
  }

  private ensureTcpListener(tunnel: TunnelRecord): void {
    const existing = this.tcpListeners.get(tunnel.id);
    if (existing) return;

    const listener = Bun.listen({
      hostname: this.config.publicHost,
      port: tunnel.listenPort,
      socket: {
        open: (socket: any) => this.onTcpClientOpen(tunnel, socket),
        data: (socket: any, data: unknown) => this.onTcpClientData(tunnel, socket, data),
        close: (socket: any) => this.onTcpClientClose(tunnel, socket)
      }
    });

    this.tcpListeners.set(tunnel.id, listener);
    console.log(`[tcp] listening on ${this.config.publicHost}:${tunnel.listenPort} for ${tunnel.name}`);
  }

  private ensureUdpListener(tunnel: TunnelRecord): void {
    const existing = this.udpListeners.get(tunnel.id);
    if (existing) return;

    const socket = dgram.createSocket('udp4');
    const sessionMap = new Map<string, string>();

    socket.on('message', (message: Uint8Array, rinfo: { address: string; port: number }) => {
      const peerKey = `${rinfo.address}:${rinfo.port}`;
      let sessionId = sessionMap.get(peerKey);
      if (!sessionId) {
        sessionId = `${tunnel.id}:${rinfo.address}:${rinfo.port}`;
        sessionMap.set(peerKey, sessionId);
        this.udpSessions.set(sessionId, {
          sessionId,
          tunnelId: tunnel.id,
          agentId: tunnel.agentId ?? '',
          socket,
          peerAddress: rinfo.address,
          peerPort: rinfo.port,
          targetHost: tunnel.targetHost,
          targetPort: tunnel.targetPort
        });
        const agent = tunnel.agentId ? this.agentConnections.get(tunnel.agentId) : null;
        if (agent) {
          writeSocket(agent.socket, encodeFrame({
            type: FRAME_TYPES.DIAL_UDP_SESSION,
            streamId: sessionId,
            payload: {
              sessionId,
              tunnelId: tunnel.id,
              peerAddress: rinfo.address,
              peerPort: rinfo.port,
              targetHost: tunnel.targetHost,
              targetPort: tunnel.targetPort
            } satisfies DialUdpSessionFrame
          }));
        }
      }

      this.sendUdpPayloadToAgent(sessionId, message);
    });

    socket.bind(tunnel.listenPort, this.config.publicHost);
    this.udpListeners.set(tunnel.id, socket);
    console.log(`[udp] listening on ${this.config.publicHost}:${tunnel.listenPort} for ${tunnel.name}`);
  }

  private onTcpClientOpen(tunnel: TunnelRecord, socket: any): void {
    const agentId = tunnel.agentId ?? '';
    const agent = agentId ? this.agentConnections.get(agentId) : null;
    if (!agent) {
      socket.end?.();
      return;
    }

    const streamId = `${tunnel.id}:${nowMs()}:${Math.random().toString(36).slice(2, 10)}`;
    const state: TcpClientState = {
      streamId,
      tunnelId: tunnel.id,
      agentId,
      socket,
      open: false,
      queued: []
    };
    this.tcpStreams.set(streamId, state);
    socket.__privateFrpStreamId = streamId;

    writeSocket(agent.socket, encodeFrame({
      type: FRAME_TYPES.DIAL_TCP,
      streamId,
      payload: {
        streamId,
        tunnelId: tunnel.id,
        clientAddress: String(socket.remoteAddress ?? 'unknown')
      } satisfies DialTcpFrame
    }));
  }

  private onTcpClientData(_tunnel: TunnelRecord, socket: any, data: unknown): void {
    const streamId = socket.__privateFrpStreamId as string | undefined;
    if (!streamId) return;
    const state = this.tcpStreams.get(streamId);
    if (!state) return;
    const agent = this.agentConnections.get(state.agentId);
    if (!agent) {
      socket.end?.();
      this.tcpStreams.delete(streamId);
      return;
    }

    const payload = asUint8Array(data);
    if (!state.open) {
      state.queued.push(payload);
      return;
    }

    writeSocket(agent.socket, encodeFrame({
      type: FRAME_TYPES.STREAM_DATA,
      streamId,
      payload: {
        streamId,
        data: encodeData(payload)
      } satisfies StreamDataFrame
    }));
  }

  private onTcpClientClose(_tunnel: TunnelRecord, socket: any): void {
    const streamId = socket.__privateFrpStreamId as string | undefined;
    if (!streamId) return;
    const state = this.tcpStreams.get(streamId);
    if (!state) return;
    const agent = this.agentConnections.get(state.agentId);
    if (agent) {
      writeSocket(agent.socket, encodeFrame({
        type: FRAME_TYPES.STREAM_CLOSE,
        streamId,
        payload: { streamId, reason: 'client closed' } satisfies StreamCloseFrame
      }));
    }
    this.tcpStreams.delete(streamId);
  }

  private sendUdpPayloadToAgent(sessionId: string, message: Uint8Array): void {
    const session = this.udpSessions.get(sessionId);
    if (!session) return;
    const agent = session.agentId ? this.agentConnections.get(session.agentId) : null;
    if (!agent) return;
    writeSocket(agent.socket, encodeFrame({
      type: FRAME_TYPES.UDP_DATA,
      streamId: sessionId,
      payload: {
        sessionId,
        data: encodeData(message),
        peerAddress: session.peerAddress,
        peerPort: session.peerPort
      }
    }));
  }

  private onAgentSocketOpen(socket: Socket): void {
    const parser = new FrameParser();
    (socket as any).__privateFrpParser = parser;
    (socket as any).__privateFrpAuthenticated = false;
  }

  private onAgentSocketData(socket: Socket, data: unknown): void {
    const parser = ((socket as any).__privateFrpParser as FrameParser | undefined) ?? new FrameParser();
    (socket as any).__privateFrpParser = parser;

    for (const frame of parser.push(asUint8Array(data))) {
      this.handleAgentFrame(socket, frame);
    }
  }

  private onAgentSocketClose(socket: Socket): void {
    const agentId = (socket as any).__privateFrpAgentId as string | undefined;
    if (!agentId) return;
    this.closeAgentConnection(agentId, 'socket closed');
  }

  private handleAgentFrame(socket: Socket, frame: Frame): void {
    switch (frame.type) {
      case FRAME_TYPES.AGENT_HELLO: {
        const payload = frame.payload as { agentId?: string; agentSecret?: string; agentName?: string; protocolVersion?: number } | undefined;
        const agentId = String(payload?.agentId || '');
        const agentSecret = String(payload?.agentSecret || '');
        const agent = this.store.authenticateAgent(agentId, agentSecret);
        if (!agent) {
          writeSocket(socket, encodeFrame({ type: FRAME_TYPES.ERROR, payload: { message: 'unauthorized' } }));
          socket.close?.();
          return;
        }

        (socket as any).__privateFrpAuthenticated = true;
        (socket as any).__privateFrpAgentId = agent.id;
        const state: AgentConnectionState = {
          socket,
          parser: (socket as any).__privateFrpParser as FrameParser,
          agentId: agent.id,
          agentName: payload?.agentName || agent.name,
          remoteAddress: String((socket as any).remoteAddress ?? '') || null,
          connectedAt: nowMs(),
          lastHeartbeat: nowMs(),
          lastLatency: null
        };
        this.agentConnections.set(agent.id, state);
        this.store.setAgentConnections(agent.id, 0);
        this.store.touchAgent(agent.id, nowMs(), null, state.remoteAddress);
        writeSocket(socket, encodeFrame({
          type: FRAME_TYPES.SERVER_HELLO,
          payload: {
            serverTime: nowMs(),
            agentName: agent.name
          }
        }));
        this.pushConfigToAgent(agent.id);
        this.broadcastDashboard();
        console.log(`[agent] connected ${agent.id} (${agent.name})`);
        return;
      }
      case FRAME_TYPES.HEARTBEAT: {
        const agentId = (socket as any).__privateFrpAgentId as string | undefined;
        if (!agentId) return;
        const payload = frame.payload as { timestamp?: number } | undefined;
        const state = this.agentConnections.get(agentId);
        if (state) {
          state.lastHeartbeat = nowMs();
          state.lastLatency = typeof payload?.timestamp === 'number' ? Math.max(0, nowMs() - payload.timestamp) : null;
          this.store.touchAgent(agentId, state.lastHeartbeat, state.lastLatency, state.remoteAddress);
          this.broadcastDashboard();
        }
        return;
      }
      case FRAME_TYPES.CONFIG_ACK:
        return;
      case FRAME_TYPES.STREAM_OPEN: {
        const payload = frame.payload as { streamId?: string } | undefined;
        if (!payload?.streamId) return;
        const state = this.tcpStreams.get(payload.streamId);
        if (!state) return;
        state.open = true;
        for (const queued of state.queued) {
          const agent = this.agentConnections.get(state.agentId);
          agent?.socket && writeSocket(agent.socket, encodeFrame({
            type: FRAME_TYPES.STREAM_DATA,
            streamId: state.streamId,
            payload: { streamId: state.streamId, data: encodeData(queued) } satisfies StreamDataFrame
          }));
        }
        state.queued = [];
        return;
      }
      case FRAME_TYPES.STREAM_DATA: {
        const payload = frame.payload as { streamId?: string; data?: string } | undefined;
        if (!payload?.streamId || typeof payload.data !== 'string') return;
        const state = this.tcpStreams.get(payload.streamId);
        if (!state) return;
        state.socket.write(decodeData(payload.data));
        return;
      }
      case FRAME_TYPES.STREAM_CLOSE: {
        const payload = frame.payload as { streamId?: string } | undefined;
        if (!payload?.streamId) return;
        const state = this.tcpStreams.get(payload.streamId);
        if (!state) return;
        state.socket.end?.();
        this.tcpStreams.delete(payload.streamId);
        return;
      }
      case FRAME_TYPES.UDP_DATA: {
        const payload = frame.payload as { sessionId?: string; data?: string } | undefined;
        if (!payload?.sessionId || typeof payload.data !== 'string') return;
        const session = this.udpSessions.get(payload.sessionId);
        if (!session) return;
        session.socket.send(decodeData(payload.data), session.peerPort, session.peerAddress);
        return;
      }
      default:
        return;
    }
  }

  private pushConfigToAgent(agentId: string): void {
    const agent = this.agentConnections.get(agentId);
    if (!agent) return;
    const tunnels = this.store.listTunnelsForAgent(agentId);
    const config: AgentConfig = {
      id: agentId,
      name: agent.agentName,
      enabled: true,
      tunnels
    };
    writeSocket(agent.socket, encodeFrame({
      type: FRAME_TYPES.CONFIG_PUSH,
      payload: config
    }));
  }

  private closeAgentConnection(agentId: string, reason: string): void {
    const state = this.agentConnections.get(agentId);
    if (!state) return;
    for (const [streamId, stream] of this.tcpStreams) {
      if (stream.agentId === agentId) {
        stream.socket.end?.();
        this.tcpStreams.delete(streamId);
      }
    }
    for (const [sessionId, session] of this.udpSessions) {
      if (session.agentId === agentId) {
        session.socket.close();
        this.udpSessions.delete(sessionId);
      }
    }
    this.agentConnections.delete(agentId);
    this.store.setAgentConnections(agentId, 0);
    console.log(`[agent] disconnected ${agentId}: ${reason}`);
    this.broadcastDashboard();
  }
}