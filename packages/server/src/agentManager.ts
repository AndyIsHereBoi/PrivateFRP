import type { TunnelConfig } from "@privatefrp/shared";
import { encodeFrame, MsgType } from "@privatefrp/shared";
import type net from "net";
import type tls from "tls";

/** Max age for a pooled socket — discard anything older (may be TCP-idle-closed). */
const POOL_SOCKET_MAX_AGE_MS = 30_000;

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * Cap on pending (on-demand) dials per agent.  Requests beyond this are
 * rejected immediately rather than being queued; this prevents a thundering
 * herd from filling memory when an agent is slow to respond.
 */
const MAX_PENDING_DIALS = parsePositiveIntEnv("SERVER_MAX_PENDING_DIALS", 10000);
const DIAL_TIMEOUT_MS = parsePositiveIntEnv("SERVER_DIAL_TIMEOUT_MS", 30000);

export interface PendingDial {
  requestId: string;
  tunnelId: string;
  resolve: (socket: net.Socket | tls.TLSSocket) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** A pre-warmed TLS data connection sitting in the agent's server-side pool. */
interface PooledSocket {
  socket: net.Socket | tls.TLSSocket;
  addedAt: number;
  /** Bound 'close' handler so it can be removed when the socket is claimed. */
  onClose: () => void;
}

export interface ConnectedAgent {
  agentId: string;
  socket: net.Socket | tls.TLSSocket;
  tunnels: TunnelConfig[];
  lastHeartbeat: number;
  lastLatencyMs: number | null;
  connectedAt: number;
  /** Remote IP of the control connection */
  remoteAddress: string;
  activeConnections: number;
  pendingDials: Map<string, PendingDial>;
  /** Pre-warmed data connections waiting to be assigned to a tunnel request. */
  warmPool: PooledSocket[];
}

export class AgentManager {
  private agents: Map<string, ConnectedAgent> = new Map();

  register(
    agentId: string,
    socket: net.Socket | tls.TLSSocket,
    tunnels: TunnelConfig[],
    remoteAddress: string,
  ): void {
    // If agent reconnects, clean up previous connection
    const existing = this.agents.get(agentId);
    if (existing) {
      existing.socket.destroy();
      // Drain warm pool
      for (const entry of existing.warmPool) {
        entry.socket.removeListener("close", entry.onClose);
        entry.socket.destroy();
      }
      // Reject all pending dials
      for (const dial of existing.pendingDials.values()) {
        clearTimeout(dial.timer);
        dial.reject(new Error("Agent reconnected, previous connection dropped"));
      }
    }

    this.agents.set(agentId, {
      agentId,
      socket,
      tunnels,
      lastHeartbeat: Date.now(),
      lastLatencyMs: null,
      connectedAt: Date.now(),
      remoteAddress,
      activeConnections: 0,
      pendingDials: new Map(),
      warmPool: [],
    });
  }

  unregister(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    // Forcefully terminate the control connection so removed agents are
    // disconnected immediately from the server.
    agent.socket.destroy();

    // Drain warm pool
    for (const entry of agent.warmPool) {
      entry.socket.removeListener("close", entry.onClose);
      entry.socket.destroy();
    }
    for (const dial of agent.pendingDials.values()) {
      clearTimeout(dial.timer);
      dial.reject(new Error("Agent disconnected"));
    }
    this.agents.delete(agentId);
  }

  get(agentId: string): ConnectedAgent | undefined {
    return this.agents.get(agentId);
  }

  getAll(): ConnectedAgent[] {
    return Array.from(this.agents.values());
  }

  updateHeartbeat(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (agent) agent.lastHeartbeat = Date.now();
  }

  updateLatency(agentId: string, latencyMs: number): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.lastLatencyMs = Math.max(0, Math.round(latencyMs));
  }

  incActiveConnections(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.activeConnections += 1;
  }

  decActiveConnections(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.activeConnections = Math.max(0, agent.activeConnections - 1);
  }

  updateTunnels(agentId: string, tunnels: TunnelConfig[]): void {
    const agent = this.agents.get(agentId);
    if (agent) agent.tunnels = tunnels;
  }

  /**
   * Called when the agent opens a pre-warmed PoolHello connection.
   * The socket is held until claimed by the next dialTcp call.
   */
  addToPool(agentId: string, socket: net.Socket | tls.TLSSocket): void {
    const agent = this.agents.get(agentId);
    if (!agent) {
      socket.destroy();
      return;
    }

    const entry: PooledSocket = { socket, addedAt: Date.now(), onClose: () => {} };
    const onClose = () => {
      const idx = agent.warmPool.indexOf(entry);
      if (idx !== -1) agent.warmPool.splice(idx, 1);
    };
    entry.onClose = onClose;

    socket.once("close", onClose);
    socket.once("error", (err: Error) => {
      console.warn(`[AgentManager] Pool socket error for agent ${agentId}: ${err.message}`);
      onClose();
      socket.destroy();
    });

    agent.warmPool.push(entry);
  }

  /**
   * Pop the most recently added live pool socket for the given agent, or
   * return null if the pool is empty / all entries are stale.
   */
  private takeFromPool(agent: ConnectedAgent): (net.Socket | tls.TLSSocket) | null {
    const now = Date.now();
    while (agent.warmPool.length > 0) {
      // Take from the back — most recently added, most likely still alive
      const entry = agent.warmPool.pop()!;
      entry.socket.removeListener("close", entry.onClose);

      if (entry.socket.destroyed) continue;
      if (now - entry.addedAt > POOL_SOCKET_MAX_AGE_MS) {
        entry.socket.destroy();
        continue;
      }
      return entry.socket;
    }
    return null;
  }

  /**
   * Obtain a data connection for a TCP tunnel request.
   *
   * Fast path: if a pre-warmed pool socket is available, send DialAssign
   * directly on it — the agent immediately connects to the local target
   * without any extra round-trip.
   *
   * Slow path: send DialTcp on the control socket and wait for the agent
   * to open a fresh DataConnHello data connection (≥1 RTT).
   */
  dialTcp(
    agentId: string,
    requestId: string,
    tunnelId: string,
  ): Promise<net.Socket | tls.TLSSocket> {
    const agent = this.agents.get(agentId);
    if (!agent) return Promise.reject(new Error(`Agent ${agentId} not connected`));

    // ── Fast path: use a pre-warmed pool socket ─────────────────────────────
    const poolSocket = this.takeFromPool(agent);
    if (poolSocket) {
      try {
        poolSocket.write(encodeFrame(MsgType.DialAssign, { requestId, tunnelId }));
        return Promise.resolve(poolSocket);
      } catch (e) {
        poolSocket.destroy();
        // Fall through to slow path
      }
    }

    // ── Slow path: on-demand DialTcp ────────────────────────────────────────
    if (agent.pendingDials.size >= MAX_PENDING_DIALS) {
      return Promise.reject(new Error("Too many pending dials — agent overloaded"));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        agent.pendingDials.delete(requestId);
        reject(new Error(`Dial timeout for request ${requestId}`));
      }, DIAL_TIMEOUT_MS);

      agent.pendingDials.set(requestId, { requestId, tunnelId, resolve, reject, timer });

      try {
        agent.socket.write(encodeFrame(MsgType.DialTcp, { requestId, tunnelId }));
      } catch (e) {
        clearTimeout(timer);
        agent.pendingDials.delete(requestId);
        reject(e);
      }
    });
  }

  /**
   * Send a DialUdpSession message and return a Promise for the data connection.
   */
  dialUdpSession(
    agentId: string,
    requestId: string,
    tunnelId: string,
    peerAddr: string,
  ): Promise<net.Socket | tls.TLSSocket> {
    const agent = this.agents.get(agentId);
    if (!agent) return Promise.reject(new Error(`Agent ${agentId} not connected`));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        agent.pendingDials.delete(requestId);
        reject(new Error(`UDP dial timeout for request ${requestId}`));
      }, DIAL_TIMEOUT_MS);

      agent.pendingDials.set(requestId, { requestId, tunnelId, resolve, reject, timer });

      try {
        agent.socket.write(
          encodeFrame(MsgType.DialUdpSession, { requestId, tunnelId, peerAddr }),
        );
      } catch (e) {
        clearTimeout(timer);
        agent.pendingDials.delete(requestId);
        reject(e);
      }
    });
  }

  /**
   * Called when a data connection arrives with DataConnHello (slow-path fallback).
   * Resolves the pending dial promise.
   */
  fulfillDial(agentId: string, requestId: string, dataSocket: net.Socket | tls.TLSSocket): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;

    const pending = agent.pendingDials.get(requestId);
    if (!pending) return false;

    clearTimeout(pending.timer);
    agent.pendingDials.delete(requestId);
    pending.resolve(dataSocket);
    return true;
  }
}
