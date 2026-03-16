import tls from "tls";
import net from "net";
import dgram from "dgram";
import {
  FrameDecoder,
  encodeFrame,
  MsgType,
  type ServerHelloBody,
  type ConfigPushBody,
  type DialTcpBody,
  type DialUdpSessionBody,
  type HeartbeatBody,
  type TunnelConfig,
  type UdpDataBody,
} from "@privatefrp/shared";

const HEARTBEAT_INTERVAL_MS = 30_000;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

export interface AgentConfig {
  serverHost: string;
  serverPort: number;
  agentId: string;
  agentSecret: string;
  tlsRejectUnauthorized: boolean;
}

export class Agent {
  private config: AgentConfig;
  private tunnels: TunnelConfig[] = [];
  private socket: tls.TLSSocket | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  private stopping = false;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopping = true;
    this.socket?.destroy();
  }

  private connect(): void {
    if (this.stopping) return;

    console.log(
      `[Agent] Connecting to ${this.config.serverHost}:${this.config.serverPort}...`,
    );

    const socket = tls.connect({
      host: this.config.serverHost,
      port: this.config.serverPort,
      rejectUnauthorized: this.config.tlsRejectUnauthorized,
    });

    this.socket = socket;

    const decoder = new FrameDecoder();
    decoder.onError = (err) => {
      console.error("[Agent] Frame decoder error:", err);
      socket.destroy();
    };

    socket.on("secureConnect", () => {
      console.log("[Agent] TLS connected");
      // Send AgentHello
      socket.write(
        encodeFrame(MsgType.AgentHello, {
          agentId: this.config.agentId,
          agentSecret: this.config.agentSecret,
        }),
      );
    });

    socket.on("data", (chunk) => decoder.push(chunk));

    let authenticated = false;

    decoder.onFrame = (frame) => {
      switch (frame.msgType) {
        case MsgType.ServerHello: {
          const body = frame.body as ServerHelloBody;
          if (!body.ok) {
            console.error("[Agent] Server rejected auth:", body.message);
            socket.destroy();
            return;
          }
          console.log("[Agent] Authenticated:", body.message);
          authenticated = true;
          this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
          this.tunnels = body.tunnels;
          this.startHeartbeat(socket);
          break;
        }

        case MsgType.ConfigPush: {
          const body = frame.body as ConfigPushBody;
          console.log(`[Agent] Config pushed: ${body.tunnels.length} tunnel(s)`);
          this.tunnels = body.tunnels;
          break;
        }

        case MsgType.Heartbeat: {
          const body = frame.body as HeartbeatBody;
          // Echo back
          try {
            socket.write(encodeFrame(MsgType.Heartbeat, { timestamp: body.timestamp }));
          } catch {
            // ignore
          }
          break;
        }

        case MsgType.DialTcp: {
          const body = frame.body as DialTcpBody;
          if (!authenticated) return;
          this.handleDialTcp(body);
          break;
        }

        case MsgType.DialUdpSession: {
          const body = frame.body as DialUdpSessionBody;
          if (!authenticated) return;
          this.handleDialUdpSession(body);
          break;
        }

        default:
          console.warn(`[Agent] Unknown frame type: 0x${frame.msgType.toString(16)}`);
      }
    };

    socket.on("close", () => {
      this.cleanupHeartbeat();
      if (!this.stopping) {
        console.log(`[Agent] Disconnected. Reconnecting in ${this.reconnectDelay}ms...`);
        setTimeout(() => {
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
          this.connect();
        }, this.reconnectDelay);
      }
    });

    socket.on("error", (err) => {
      console.error("[Agent] Socket error:", err.message);
    });
  }

  private startHeartbeat(socket: tls.TLSSocket): void {
    this.cleanupHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (socket.destroyed) {
        this.cleanupHeartbeat();
        return;
      }
      try {
        socket.write(encodeFrame(MsgType.Heartbeat, { timestamp: Date.now() }));
      } catch {
        this.cleanupHeartbeat();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private cleanupHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private findTunnel(tunnelId: string): TunnelConfig | undefined {
    return this.tunnels.find((t) => t.id === tunnelId);
  }

  // ─── TCP dial handling ──────────────────────────────────────────────────────

  private handleDialTcp(body: DialTcpBody): void {
    const tunnel = this.findTunnel(body.tunnelId);
    if (!tunnel) {
      console.warn(`[Agent] DialTcp: unknown tunnel ${body.tunnelId}`);
      return;
    }

    console.log(
      `[Agent] DialTcp requestId=${body.requestId} -> ${tunnel.targetHost}:${tunnel.targetPort}`,
    );

    // Open data connection to server
    const dataConn = tls.connect({
      host: this.config.serverHost,
      port: this.config.serverPort,
      rejectUnauthorized: this.config.tlsRejectUnauthorized,
    });

    dataConn.once("secureConnect", () => {
      // Send DataConnHello
      dataConn.write(
        encodeFrame(MsgType.DataConnHello, {
          requestId: body.requestId,
          agentId: this.config.agentId,
        }),
      );

      // Connect to local target
      const target = net.createConnection({
        host: tunnel.targetHost,
        port: tunnel.targetPort,
      });

      target.once("connect", () => {
        dataConn.pipe(target);
        target.pipe(dataConn);

        dataConn.on("error", () => target.destroy());
        target.on("error", () => dataConn.destroy());
        dataConn.on("close", () => target.destroy());
        target.on("close", () => dataConn.destroy());
      });

      target.on("error", (err) => {
        console.error(`[Agent] TCP target connection error:`, err.message);
        dataConn.destroy();
      });
    });

    dataConn.on("error", (err) => {
      console.error(`[Agent] Data connection error for requestId=${body.requestId}:`, err.message);
    });
  }

  // ─── UDP session handling ───────────────────────────────────────────────────

  private handleDialUdpSession(body: DialUdpSessionBody): void {
    const tunnel = this.findTunnel(body.tunnelId);
    if (!tunnel) {
      console.warn(`[Agent] DialUdpSession: unknown tunnel ${body.tunnelId}`);
      return;
    }

    console.log(
      `[Agent] DialUdpSession requestId=${body.requestId} peer=${body.peerAddr} -> ${tunnel.targetHost}:${tunnel.targetPort}`,
    );

    const udpSock = dgram.createSocket("udp4");
    udpSock.bind(() => {
      // Open data connection to server
      const dataConn = tls.connect({
        host: this.config.serverHost,
        port: this.config.serverPort,
        rejectUnauthorized: this.config.tlsRejectUnauthorized,
      });

      dataConn.once("secureConnect", () => {
        dataConn.write(
          encodeFrame(MsgType.DataConnHello, {
            requestId: body.requestId,
            agentId: this.config.agentId,
          }),
        );

        const decoder = new FrameDecoder();

        // Forward UdpData frames from server to local UDP target
        decoder.onFrame = (frame) => {
          if (frame.msgType !== MsgType.UdpData) return;
          const udpBody = frame.body as UdpDataBody;
          const payload = Buffer.from(udpBody.payload, "base64");
          udpSock.send(payload, tunnel.targetPort, tunnel.targetHost);
        };

        decoder.onError = (err) => {
          console.error("[Agent] UDP session decoder error:", err);
          dataConn.destroy();
        };

        dataConn.on("data", (chunk: Buffer) => decoder.push(chunk));

        // Forward UDP responses from local target back to server
        udpSock.on("message", (msg) => {
          const frame = encodeFrame(MsgType.UdpData, {
            peerAddr: body.peerAddr,
            payload: msg.toString("base64"),
          });
          try {
            dataConn.write(frame);
          } catch {
            // ignore
          }
        });

        dataConn.on("close", () => {
          udpSock.close();
        });

        dataConn.on("error", (err) => {
          console.error(`[Agent] UDP data conn error:`, err.message);
          udpSock.close();
        });
      });

      dataConn.on("error", (err) => {
        console.error(
          `[Agent] Data connection error for UDP requestId=${body.requestId}:`,
          err.message,
        );
        udpSock.close();
      });
    });

    udpSock.on("error", (err) => {
      console.error("[Agent] UDP socket error:", err.message);
    });
  }
}
