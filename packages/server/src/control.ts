import dgram from 'node:dgram';
import { type Socket } from 'bun';
import { DEFAULTS, FRAME_TYPES, type AgentConfig, type AgentRecord, type DialTcpFrame, type DialUdpSessionFrame, type Frame, type TunnelRecord } from '@privatefrp/shared';
import { encodeFrame, FrameParser, nowMs } from '@privatefrp/shared';
import type { ServerRuntimeConfig } from '@privatefrp/shared';
import type { ServerStore } from './store';

type TcpClientState = {
  streamId: string;
  tunnelId: string;
  agentId: string;
  socket: any;             // external client socket
  dataSocket: any | null;  // agent data socket (raw pipe)
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
  pendingWrites: Uint8Array[];
  pendingBytes: number;
};

// Tracks agent data connections before the streamId is received
type AgentDataCon = {
  socket: any;
  buf: Uint8Array;
};

const MAX_AGENT_QUEUE_BYTES = 512 * 1024;
const BACKPRESSURE_LOG_MS = 2000;

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

/**
 * Write data to a relay socket with zero-copy partial-write buffering.
 * Uses a chunk list (like control-frame backpressure) to avoid O(n²) merging.
 * On drain, call flushRelayBuffer(socket) to flush remaining chunks.
 * Returns true if all bytes were written, false if some were queued.
 */
function bufferedRelayWrite(socket: any, data: Uint8Array): boolean {
  const pending = (socket as any).__relayPending as Uint8Array[] | undefined;
  if (pending && pending.length > 0) {
    pending.push(data);
    return false;
  }

  const written = writeSocket(socket, data);
  if (written < 0) return false;
  if (written < data.byteLength) {
    (socket as any).__relayPending = [data.subarray(written)];
    return false;
  }
  return true;
}

/** Call on socket drain to flush queued relay chunks. Each chunk is a subarray
 *  of the original data — no copies were made during buffering. */
function flushRelayBuffer(socket: any): void {
  const pending = (socket as any).__relayPending as Uint8Array[] | undefined;
  if (!pending || pending.length === 0) return;

  while (pending.length > 0) {
    const chunk = pending[0]!;
    const written = writeSocket(socket, chunk);
    if (written < 0) {
      (socket as any).__relayPending = undefined;
      return;
    }
    if (written < chunk.byteLength) {
      pending[0] = chunk.subarray(written);
      return;
    }
    pending.shift();
  }
  (socket as any).__relayPending = undefined;
}

export class ControlPlane {
  private readonly agentConnections = new Map<string, AgentConnectionState>();
  private readonly tcpStreams = new Map<string, TcpClientState>();
  private readonly udpSessions = new Map<string, UdpSessionState>();
  private readonly tcpListeners = new Map<string, any>();
  private readonly udpListeners = new Map<string, any>();
  private agentListener: any = null;
  private dataListener: any = null;
  private lastBackpressureLogAt = 0;

  constructor(
    private readonly config: ServerRuntimeConfig,
    private readonly store: ServerStore,
    private readonly broadcastDashboard: () => void,
    private readonly assetBasePath: string
  ) {}

  async start(): Promise<void> {
    this.agentListener = Bun.listen({
      hostname: this.config.host,
      port: this.config.agentPort,
      socket: {
        open: (socket: Socket) => this.onAgentSocketOpen(socket),
        data: (socket: Socket, data: unknown) => this.onAgentSocketData(socket, data),
        close: (socket: Socket) => this.onAgentSocketClose(socket),
        drain: (socket: Socket) => this.onAgentSocketDrain(socket),
        error: (_socket: Socket, error: Error) => {
          console.error('[agent] socket error', error);
        }
      }
    });

    // Raw TCP data listener — agents connect here per stream
    this.dataListener = Bun.listen({
      hostname: this.config.host,
      port: this.config.dataPort,
      socket: {
        open: (socket: any) => {
          socket.setNoDelay(Boolean(this.config.dataTcpNoDelay));
          (socket as any).__dataCon = { socket, buf: new Uint8Array(0) } as AgentDataCon;
        },
        data: (socket: any, data: unknown) => this.onAgentDataSocketData(socket, data),
        close: (socket: any) => this.onAgentDataSocketClose(socket),
        drain: (socket: any) => this.onAgentDataSocketDrain(socket),
        error: (_socket: any, error: Error) => {
          console.error('[data] socket error', error);
        }
      }
    });
    console.log(`[data] listening on ${this.config.host}:${this.config.dataPort}`);
  }

  async stop(): Promise<void> {
    try {
      try { this.agentListener?.close?.(); } catch {}
      try { this.dataListener?.close?.(); } catch {}

      for (const listener of this.tcpListeners.values()) {
        try { listener.close?.(); } catch {}
      }
      this.tcpListeners.clear();

      for (const s of this.udpListeners.values()) {
        try { s.close?.(); } catch {}
      }
      this.udpListeners.clear();

      // Close any data sockets
      for (const { dataSocket, socket } of this.tcpStreams.values()) {
        try { dataSocket?.close?.(); } catch {}
        try { socket?.end?.(); } catch {}
      }
      this.tcpStreams.clear();

      for (const state of this.agentConnections.values()) {
        try { state.socket.close?.(); } catch {}
      }
      this.agentConnections.clear();
    } catch (err) {
      console.error('[control] error during stop', err);
    }
  }

  getAgents(): Array<AgentRecord & { connected: boolean }> {
    return this.store.listAgents().map(agent => {
      const live = this.agentConnections.get(agent.id);
      return {
        ...agent,
        remoteAddress: live?.remoteAddress ?? null,
        lastHeartbeat: live?.lastHeartbeat ?? null,
        latencyMs: live?.lastLatency ?? null,
        activeConnections: agent.activeConnections,
        connected: Boolean(live)
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
    this.pushConfigToAllAgents();
    this.broadcastDashboard();
    return tunnel;
  }

  updateTunnel(tunnelId: string, patch: Partial<Omit<TunnelRecord, 'id' | 'createdAt'>>): TunnelRecord | null {
    const tunnel = this.store.updateTunnel(tunnelId, patch);
    this.refreshTunnelListeners().catch(console.error);
    this.pushConfigToAllAgents();
    this.broadcastDashboard();
    return tunnel;
  }

  deleteTunnel(tunnelId: string): void {
    this.store.deleteTunnel(tunnelId);
    this.refreshTunnelListeners().catch(console.error);
    this.pushConfigToAllAgents();
    this.broadcastDashboard();
  }

  setTunnelEnabled(tunnelId: string, enabled: boolean): TunnelRecord | null {
    const tunnel = this.store.setTunnelEnabled(tunnelId, enabled);
    this.refreshTunnelListeners().catch(console.error);
    this.pushConfigToAllAgents();
    this.broadcastDashboard();
    return tunnel;
  }

  async refreshTunnelListeners(): Promise<void> {
    const tunnels = this.store.listTunnels();
    const tunnelsById = new Map(tunnels.map(t => [t.id, t]));
    const activeIds = new Set<string>();

    for (const tunnel of tunnels) {
      if (!tunnel.enabled) continue;
      if (!tunnel.agentId) {
        console.log(`[tunnel] skipping ${tunnel.name} - no agent assigned`);
        continue;
      }
      const agent = this.agentConnections.get(tunnel.agentId);
      if (!agent) {
        console.log(`[tunnel] skipping ${tunnel.name} (agent: ${tunnel.agentId}) - agent not connected`);
        continue;
      }

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
        const name = tunnelsById.get(tunnelId)?.name ?? tunnelId;
        console.log(`[tcp] stopping listener on ${this.config.publicHost}:${listener.port ?? '?'} for ${name}`);
        listener.stop?.(true);
        this.tcpListeners.delete(tunnelId);
        this.closeTunnelSessions(tunnelId, 'tunnel disabled');
      }
    }
    for (const [tunnelId, listener] of this.udpListeners) {
      if (!activeIds.has(tunnelId)) {
        const name = tunnelsById.get(tunnelId)?.name ?? tunnelId;
        console.log(`[udp] stopping listener on ${this.config.publicHost}:${listener.port ?? '?'} for ${name}`);
        listener.close();
        this.udpListeners.delete(tunnelId);
        this.closeTunnelSessions(tunnelId, 'tunnel disabled');
      }
    }
  }

  private closeTunnelSessions(tunnelId: string, reason: string): void {
    for (const [streamId, stream] of this.tcpStreams) {
      if (stream.tunnelId !== tunnelId) continue;
      try { stream.dataSocket?.end?.(); } catch {}
      try { stream.socket.end?.(); } catch {}
      this.tcpStreams.delete(streamId);
    }

    for (const [sessionId, session] of this.udpSessions) {
      if (session.tunnelId !== tunnelId) continue;
      try { session.socket.close(); } catch {}
      this.udpSessions.delete(sessionId);
    }
  }

  private ensureTcpListener(tunnel: TunnelRecord): void {
    // Check if agent is connected before creating or keeping listener
    const agent = tunnel.agentId ? this.agentConnections.get(tunnel.agentId) : null;
    if (!agent && tunnel.agentId) {
      console.log(`[tunnel] skipping ${tunnel.name} - agent not connected`);
      return;
    }
    
    const existing = this.tcpListeners.get(tunnel.id);
    if (existing) return;

    const listener = Bun.listen({
      hostname: this.config.publicHost,
      port: tunnel.listenPort,
      socket: {
        open: (socket: any) => this.onTcpClientOpen(tunnel, socket),
        data: (socket: any, data: unknown) => this.onTcpClientData(tunnel, socket, data),
        close: (socket: any) => this.onTcpClientClose(tunnel, socket),
        drain: (socket: any) => this.onTcpClientDrain(socket)
      }
    });

    this.tcpListeners.set(tunnel.id, listener);
    console.log(`[tcp] listening on ${this.config.publicHost}:${tunnel.listenPort} for ${tunnel.name}`);
  }

  private ensureUdpListener(tunnel: TunnelRecord): void {
    // Check if agent is connected before creating or keeping listener
    const agent = tunnel.agentId ? this.agentConnections.get(tunnel.agentId) : null;
    if (!agent && tunnel.agentId) {
      console.log(`[tunnel] skipping ${tunnel.name} - agent not connected`);
      return;
    }
    
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
          this.writeToAgent(agent, encodeFrame({
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
      console.log(`[tunnel] rejecting ${tunnel.name} (agent not connected)`);
      return;
    }
    console.log(`[tunnel] client connected ${tunnel.name} port ${tunnel.listenPort}`);
    try { socket.setNoDelay(Boolean(this.config.dataTcpNoDelay)); } catch {}

    const streamId = `${tunnel.id}:${nowMs()}:${Math.random().toString(36).slice(2, 10)}`;
    const state: TcpClientState = {
      streamId,
      tunnelId: tunnel.id,
      agentId,
      socket,
      dataSocket: null
    };
    this.tcpStreams.set(streamId, state);
    socket.__privateFrpStreamId = streamId;
    // Pause external client until agent data socket connects, so we don't drop the Upgrade request
    try { socket.pause?.(); } catch {}

    this.writeToAgent(agent, encodeFrame({
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
    const payload = asUint8Array(data);
    if (payload.byteLength === 0) return;
    if (!state.dataSocket) return;
    bufferedRelayWrite(state.dataSocket, payload);
  }

  private onTcpClientClose(_tunnel: TunnelRecord, socket: any): void {
    const streamId = socket.__privateFrpStreamId as string | undefined;
    if (!streamId) return;
    const state = this.tcpStreams.get(streamId);
    if (!state) return;
    console.log(`[tunnel] client disconnected ${state.tunnelId}`);
    if (state.dataSocket) {
      try { state.dataSocket.end?.(); } catch {}
    }
    this.tcpStreams.delete(streamId);
  }

  private onTcpClientDrain(socket: any): void {
    // Flush any queued relay data to the agent data socket
    const streamId = socket.__privateFrpStreamId as string | undefined;
    if (streamId) {
      const state = this.tcpStreams.get(streamId);
      if (state?.dataSocket) {
        flushRelayBuffer(state.dataSocket);
      }
    }
  }

  // ---- Agent data connections (raw TCP pipe) ----

  private onAgentDataSocketData(socket: any, data: unknown): void {
    const con = (socket as any).__dataCon as AgentDataCon | undefined;
    if (!con) return;

    if (!con.socket.__dataStreamId) {
      // Accumulate until we have the streamId
      const chunk = asUint8Array(data);
      const merged = new Uint8Array(con.buf.length + chunk.length);
      merged.set(con.buf, 0);
      merged.set(chunk, con.buf.length);
      con.buf = merged;

      if (con.buf.length < 2) return;
      const idLen = new DataView(con.buf.buffer, con.buf.byteOffset, con.buf.byteLength).getUint16(0, false);
      if (con.buf.length < 2 + idLen) return;
      const streamId = new TextDecoder().decode(con.buf.subarray(2, 2 + idLen));
      con.socket.__dataStreamId = streamId;

      const state = this.tcpStreams.get(streamId);
      if (!state) {
        console.log(`[data] unknown stream ${streamId}, closing`);
        try { socket.end?.(); } catch {}
        return;
      }

      console.log(`[data] stream ${streamId} established`);
      try { socket.setNoDelay(Boolean(this.config.dataTcpNoDelay)); } catch {}

      // Connect the data socket to the external client
      state.dataSocket = socket;

      // Flush any data that arrived before the streamId was matched
      const remaining = con.buf.subarray(2 + idLen);
      if (remaining.length > 0) {
        bufferedRelayWrite(state.socket, remaining);
      }

      // Resume external client now that data socket is linked
      try { state.socket.resume?.(); } catch {}
    } else {
      // Raw tunnel data from agent → write to external client
      const state = this.tcpStreams.get(con.socket.__dataStreamId);
      if (!state) {
        try { socket.end?.(); } catch {}
        return;
      }
      const payload = asUint8Array(data);
      if (payload.length === 0) return;
      bufferedRelayWrite(state.socket, payload);
    }
  }

  private onAgentDataSocketDrain(socket: any): void {
    // Flush any queued relay data to the external client socket
    const streamId = (socket as any).__dataStreamId as string | undefined;
    if (streamId) {
      const state = this.tcpStreams.get(streamId);
      if (state) {
        flushRelayBuffer(state.socket);
      }
    }
  }

  private onAgentDataSocketClose(socket: any): void {
    const streamId = (socket as any).__dataStreamId as string | undefined;
    (socket as any).__dataCon = undefined;
    if (!streamId) return;
    const state = this.tcpStreams.get(streamId);
    if (!state) return;
    console.log(`[data] stream ${streamId} closed by agent`);
    try { state.socket.end?.(); } catch {}
    this.tcpStreams.delete(streamId);
  }

  private onAgentSocketOpen(socket: Socket): void {
    const parser = new FrameParser();
    (socket as any).__privateFrpParser = parser;
    (socket as any).__privateFrpAuthenticated = false;
    console.log(`[agent] connection from ${String((socket as any).remoteAddress ?? 'unknown')}`);
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

  private onAgentSocketDrain(socket: Socket): void {
    const agentId = (socket as any).__privateFrpAgentId as string | undefined;
    if (!agentId) return;
    const state = this.agentConnections.get(agentId);
    if (!state) return;
    this.flushAgentQueue(state);
  }

  private writeToAgent(state: AgentConnectionState, data: Uint8Array): boolean {
    if (state.pendingBytes > 0) {
      this.queueAgentBytes(state, data);
      return this.backpressureStatus(state);
    }

    const written = writeSocket(state.socket, data);
    if (written < 0) return false;
    if (written < data.byteLength) {
      this.queueAgentBytes(state, data.subarray(written));
      return this.backpressureStatus(state);
    }

    return true;
  }

  private queueAgentBytes(state: AgentConnectionState, data: Uint8Array): void {
    if (data.byteLength <= 0) return;
    state.pendingWrites.push(data);
    state.pendingBytes += data.byteLength;
  }

  private flushAgentQueue(state: AgentConnectionState): void {
    while (state.pendingWrites.length > 0) {
      const chunk = state.pendingWrites[0];
      if (!chunk) break;
      const written = writeSocket(state.socket, chunk);
      if (written < 0) {
        this.closeAgentConnection(state.agentId, 'socket closed');
        return;
      }
      if (written < chunk.byteLength) {
        state.pendingWrites[0] = chunk.subarray(written);
        state.pendingBytes -= written;
        return;
      }

      state.pendingWrites.shift();
      state.pendingBytes -= chunk.byteLength;
    }

    if (state.pendingBytes === 0) {
      // Queue flushed
    }
  }

  private backpressureStatus(state: AgentConnectionState): boolean {
    if (state.pendingBytes > MAX_AGENT_QUEUE_BYTES) {
      const now = nowMs();
      if (now - this.lastBackpressureLogAt > BACKPRESSURE_LOG_MS) {
        this.lastBackpressureLogAt = now;
        console.warn(`[agent] backpressure on ${state.agentId} queue=${state.pendingBytes}`);
      }
    }
    return state.pendingBytes === 0;
  }

  private sendUdpPayloadToAgent(sessionId: string, message: Uint8Array): void {
    const session = this.udpSessions.get(sessionId);
    if (!session) return;
    const agent = session.agentId ? this.agentConnections.get(session.agentId) : null;
    if (!agent) return;
    this.writeToAgent(agent, encodeFrame({
      type: FRAME_TYPES.UDP_DATA,
      streamId: sessionId,
      payload: {
        sessionId,
        data: Buffer.from(message).toString('base64'),
        peerAddress: session.peerAddress,
        peerPort: session.peerPort
      }
    }));
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
          console.warn(`[agent] auth failed ${agentId || '(missing id)'}`);
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
          lastLatency: null,
          pendingWrites: [],
          pendingBytes: 0
        };
        this.agentConnections.set(agent.id, state);
        this.store.setAgentConnections(agent.id, 0);
        this.store.touchAgent(agent.id, nowMs(), null, state.remoteAddress);
        this.writeToAgent(state, encodeFrame({
          type: FRAME_TYPES.SERVER_HELLO,
          payload: {
            serverTime: nowMs(),
            agentName: agent.name
          }
        }));
        this.pushConfigToAgent(agent.id);
        void this.refreshTunnelListeners();
        this.broadcastDashboard();
        console.log(`[agent] connected ${agent.id} (${agent.name}) - ${String((socket as any).remoteAddress ?? 'unknown')}`);
        return;
      }
      case FRAME_TYPES.HEARTBEAT: {
        const agentId = (socket as any).__privateFrpAgentId as string | undefined;
        if (!agentId) return;
        const p = frame.payload as { timestamp?: number } | undefined;
        const st = this.agentConnections.get(agentId);
        if (st) {
          st.lastHeartbeat = nowMs();
          st.lastLatency = typeof p?.timestamp === 'number' ? Math.max(0, nowMs() - p.timestamp) : null;
          this.store.touchAgent(agentId, st.lastHeartbeat, st.lastLatency, st.remoteAddress);
          this.broadcastDashboard();
        }
        return;
      }
      case FRAME_TYPES.CONFIG_ACK: {
        const agentId = (socket as any).__privateFrpAgentId as string | undefined;
        if (agentId) {
          console.log(`[agent] config ack ${agentId}`);
        }
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
    this.writeToAgent(agent, encodeFrame({
      type: FRAME_TYPES.CONFIG_PUSH,
      payload: config
    }));
    const tunnelNames = tunnels.map(t => `${t.name}:${t.listenPort}`).join(', ');
    console.log(`[agent] config push ${agentId} (${tunnels.length} tunnels): [${tunnelNames}]`);
  }

  private pushConfigToAllAgents(): void {
    for (const agentId of this.agentConnections.keys()) {
      this.pushConfigToAgent(agentId);
    }
  }

  private closeAgentConnection(agentId: string, reason: string): void {
    const state = this.agentConnections.get(agentId);
    if (!state) return;
    for (const [streamId, stream] of this.tcpStreams) {
      if (stream.agentId === agentId) {
        try { stream.dataSocket?.end?.(); } catch {}
        try { stream.socket.end?.(); } catch {}
        this.tcpStreams.delete(streamId);
      }
    }
    for (const [sessionId, session] of this.udpSessions) {
      if (session.agentId === agentId) {
        try { session.socket.close(); } catch {}
        this.udpSessions.delete(sessionId);
      }
    }
    this.agentConnections.delete(agentId);
    this.store.setAgentConnections(agentId, 0);
    this.store.touchAgent(agentId, nowMs(), null, null);
    console.log(`[agent] disconnected ${agentId} (${reason})`);
    void this.refreshTunnelListeners();
    this.broadcastDashboard();
  }
}