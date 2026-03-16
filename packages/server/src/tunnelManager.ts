import net from "net";
import dgram from "dgram";
import type { TunnelConfig } from "@privatefrp/shared";
import { encodeFrame, MsgType, FrameDecoder } from "@privatefrp/shared";
import type { AgentManager } from "./agentManager";

interface TcpListener {
  type: "tcp";
  server: net.Server;
  tunnelId: string;
}

interface UdpListener {
  type: "udp";
  socket: dgram.Socket;
  tunnelId: string;
  // per-peer sessions: peerAddr -> data connection socket
  sessions: Map<string, net.Socket | import("tls").TLSSocket>;
}

type Listener = TcpListener | UdpListener;

export class TunnelManager {
  private listeners: Map<string, Listener> = new Map(); // tunnelId -> Listener
  private agentManager: AgentManager;

  constructor(agentManager: AgentManager) {
    this.agentManager = agentManager;
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

    try {
      const dataSocket = await this.agentManager.dialTcp(
        tunnel.agentId,
        requestId,
        tunnel.id,
      );

      // Pipe the client and agent data connection together
      clientSocket.pipe(dataSocket);
      dataSocket.pipe(clientSocket);

      clientSocket.on("error", () => dataSocket.destroy());
      dataSocket.on("error", () => clientSocket.destroy());
      clientSocket.on("close", () => dataSocket.destroy());
      dataSocket.on("close", () => clientSocket.destroy());
    } catch (err) {
      console.error(`[TunnelManager] Dial failed for requestId=${requestId}:`, err);
      clientSocket.destroy();
    }
  }

  private startUdpListener(tunnel: TunnelConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket("udp4");
      const sessions = new Map<string, net.Socket | import("tls").TLSSocket>();

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

  private async handleUdpMessage(
    tunnel: TunnelConfig,
    udpSock: dgram.Socket,
    sessions: Map<string, net.Socket | import("tls").TLSSocket>,
    peerAddr: string,
    msg: Buffer,
  ): Promise<void> {
    let dataConn = sessions.get(peerAddr);

    if (!dataConn || dataConn.destroyed) {
      const requestId = crypto.randomUUID();
      console.log(
        `[TunnelManager] New UDP session for tunnel "${tunnel.name}", peer=${peerAddr}, requestId=${requestId}`,
      );

      try {
        dataConn = await this.agentManager.dialUdpSession(
          tunnel.agentId,
          requestId,
          tunnel.id,
          peerAddr,
        );

        sessions.set(peerAddr, dataConn);

        // Forward UdpData frames from agent back to the external UDP peer
        const decoder = new FrameDecoder();

        decoder.onFrame = (frame) => {
          if (frame.msgType !== MsgType.UdpData) return;
          const body = frame.body as { peerAddr: string; payload: string };
          const lastColon = body.peerAddr.lastIndexOf(":");
          const host = body.peerAddr.slice(0, lastColon);
          const port = parseInt(body.peerAddr.slice(lastColon + 1), 10);
          const payload = Buffer.from(body.payload, "base64");
          udpSock.send(payload, port, host);
        };

        decoder.onError = (err) => {
          console.error(`[TunnelManager] UDP session decoder error:`, err);
          dataConn!.destroy();
        };

        dataConn.on("data", (chunk: Buffer) => decoder.push(chunk));
        dataConn.on("close", () => sessions.delete(peerAddr));
        dataConn.on("error", () => {
          dataConn!.destroy();
          sessions.delete(peerAddr);
        });
      } catch (err) {
        console.error(`[TunnelManager] UDP dial failed for peer ${peerAddr}:`, err);
        return;
      }
    }

    // Forward incoming UDP datagram to agent via UdpData frame
    const frame = encodeFrame(MsgType.UdpData, {
      peerAddr,
      payload: msg.toString("base64"),
    });

    dataConn.write(frame);
  }

  private stopListener(tunnelId: string, listener: Listener): Promise<void> {
    this.listeners.delete(tunnelId);

    if (listener.type === "tcp") {
      return new Promise((resolve) => {
        // Stop accepting new connections; existing ones continue
        listener.server.close(() => {
          console.log(`[TunnelManager] TCP listener stopped for tunnel ${tunnelId}`);
          resolve();
        });
      });
    } else {
      return new Promise((resolve) => {
        // Close all existing UDP sessions
        for (const conn of listener.sessions.values()) {
          conn.destroy();
        }
        listener.sessions.clear();
        listener.socket.close(() => {
          console.log(`[TunnelManager] UDP listener stopped for tunnel ${tunnelId}`);
          resolve();
        });
      });
    }
  }

  async stopAll(): Promise<void> {
    for (const [id, listener] of this.listeners) {
      await this.stopListener(id, listener);
    }
  }

  isListening(tunnelId: string): boolean {
    return this.listeners.has(tunnelId);
  }
}
