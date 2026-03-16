import type { TunnelConfig } from "@privatefrp/shared";
import { encodeFrame, MsgType } from "@privatefrp/shared";
import type net from "net";
import type tls from "tls";

export interface PendingDial {
  requestId: string;
  tunnelId: string;
  resolve: (socket: net.Socket | tls.TLSSocket) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ConnectedAgent {
  agentId: string;
  socket: net.Socket | tls.TLSSocket;
  tunnels: TunnelConfig[];
  lastHeartbeat: number;
  connectedAt: number;
  /** Remote IP of the control connection */
  remoteAddress: string;
  pendingDials: Map<string, PendingDial>;
  /** Pre-warmed standby data connections (FIFO queue) */
  standbyPool: Array<net.Socket | tls.TLSSocket>;
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
      // Drain standby pool
      for (const s of existing.standbyPool) s.destroy();
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
      connectedAt: Date.now(),
      remoteAddress,
      pendingDials: new Map(),
      standbyPool: [],
    });
  }

  unregister(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    for (const s of agent.standbyPool) s.destroy();
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

  updateTunnels(agentId: string, tunnels: TunnelConfig[]): void {
    const agent = this.agents.get(agentId);
    if (agent) agent.tunnels = tunnels;
  }

  /**
   * Accept a pre-warmed standby socket from the agent's pool.
   * Returns true if added, false if agent not found.
   */
  addStandby(agentId: string, socket: net.Socket | tls.TLSSocket): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;

    // Clean up on socket close so we don't leak stale entries
    socket.once("close", () => {
      const idx = agent.standbyPool.indexOf(socket);
      if (idx !== -1) agent.standbyPool.splice(idx, 1);
    });

    agent.standbyPool.push(socket);
    return true;
  }

  /**
   * Pop a standby socket from the agent's pool, or null if none available.
   */
  private popStandby(agentId: string): (net.Socket | tls.TLSSocket) | null {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    while (agent.standbyPool.length > 0) {
      const sock = agent.standbyPool.shift()!;
      if (!sock.destroyed) return sock;
    }
    return null;
  }

  /**
   * Send a DialTcp message to the agent and return a Promise that resolves
   * when the agent opens the corresponding data connection.
   *
   * If a pre-warmed standby connection is available, it is used immediately
   * (zero round-trip latency). Otherwise falls back to the normal DialTcp flow.
   */
  dialTcp(
    agentId: string,
    requestId: string,
    tunnelId: string,
  ): Promise<net.Socket | tls.TLSSocket> {
    const agent = this.agents.get(agentId);
    if (!agent) return Promise.reject(new Error(`Agent ${agentId} not connected`));

    // Try standby pool first
    const standby = this.popStandby(agentId);
    if (standby) {
      // Assign the standby connection to this dial via AssignStandby
      try {
        standby.write(
          encodeFrame(MsgType.AssignStandby, {
            requestId,
            tunnelId,
            connType: "tcp",
          }),
        );
        return Promise.resolve(standby);
      } catch {
        // Standby socket died; fall through to normal dial
      }
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        agent.pendingDials.delete(requestId);
        reject(new Error(`Dial timeout for request ${requestId}`));
      }, 10_000);

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

    // Try standby pool for UDP sessions too
    const standby = this.popStandby(agentId);
    if (standby) {
      try {
        standby.write(
          encodeFrame(MsgType.AssignStandby, {
            requestId,
            tunnelId,
            connType: "udp-session",
            peerAddr,
          }),
        );
        return Promise.resolve(standby);
      } catch {
        // fall through
      }
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        agent.pendingDials.delete(requestId);
        reject(new Error(`UDP dial timeout for request ${requestId}`));
      }, 10_000);

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
   * Called when a data connection arrives with DataConnHello.
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
