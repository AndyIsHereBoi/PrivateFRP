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
    });
  }

  unregister(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
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
   * Send a DialTcp message to the agent and return a Promise that resolves
   * when the agent opens the corresponding data connection.
   */
  dialTcp(
    agentId: string,
    requestId: string,
    tunnelId: string,
  ): Promise<net.Socket | tls.TLSSocket> {
    const agent = this.agents.get(agentId);
    if (!agent) return Promise.reject(new Error(`Agent ${agentId} not connected`));

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
