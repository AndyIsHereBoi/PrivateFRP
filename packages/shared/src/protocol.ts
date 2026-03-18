// ─── Message type constants ───────────────────────────────────────────────────
export const MsgType = {
  AgentHello: 0x01,
  ServerHello: 0x02,
  Heartbeat: 0x03,
  ConfigPush: 0x04,
  DialTcp: 0x05,
  DialUdpSession: 0x06,
  DataConnHello: 0x07,
  UdpData: 0x08,
  /** Agent → Server: offer a pre-warmed data connection into the server's pool */
  PoolHello: 0x09,
  /** Server → Agent: assign a pooled data connection to a specific tunnel request */
  DialAssign: 0x0a,
  /** Server → Agent: open a multiplexed stream on the control socket */
  StreamOpen: 0x0b,
  /** Bidirectional: stream payload frame on the control socket */
  StreamData: 0x0c,
  /** Bidirectional: close a multiplexed stream */
  StreamClose: 0x0d,
} as const;

export type MsgTypeValue = (typeof MsgType)[keyof typeof MsgType];

// ─── Shared types ─────────────────────────────────────────────────────────────
export interface TunnelConfig {
  id: string;
  name: string;
  type: "tcp" | "udp";
  listenPort: number;
  targetHost: string;
  targetPort: number;
  agentId: string;
}

// ─── Message body shapes ──────────────────────────────────────────────────────
export interface AgentHelloBody {
  agentId: string;
  agentSecret: string;
}

export interface ServerHelloBody {
  ok: boolean;
  message: string;
  tunnels: TunnelConfig[];
}

export interface HeartbeatBody {
  timestamp: number;
}

export interface ConfigPushBody {
  tunnels: TunnelConfig[];
}

export interface DialTcpBody {
  requestId: string;
  tunnelId: string;
}

export interface DialUdpSessionBody {
  requestId: string;
  tunnelId: string;
  peerAddr: string; // "ip:port"
}

export interface DataConnHelloBody {
  requestId: string;
  agentId: string;
}

export interface UdpDataBody {
  peerAddr: string;
  payload: string; // base64
}

export interface PoolHelloBody {
  agentId: string;
}

export interface DialAssignBody {
  requestId: string;
  tunnelId: string;
}

export interface StreamOpenBody {
  streamId: string;
  tunnelId: string;
  kind: "tcp" | "udp";
  peerAddr?: string; // required for UDP streams
}

export interface StreamDataBody {
  streamId: string;
  payload: string; // base64
}

export interface StreamCloseBody {
  streamId: string;
  reason?: string;
}

// ─── Frame encoder ────────────────────────────────────────────────────────────
export function encodeFrame(msgType: number, body: Record<string, unknown>): Buffer {
  const payload = Buffer.from(JSON.stringify(body));
  const frame = Buffer.allocUnsafe(4 + 1 + payload.length);
  frame.writeUInt32BE(1 + payload.length, 0);
  frame[4] = msgType;
  payload.copy(frame, 5);
  return frame;
}

// ─── Frame decoder ────────────────────────────────────────────────────────────
export interface DecodedFrame {
  msgType: number;
  body: unknown;
}

/**
 * FrameDecoder accumulates bytes from a stream and emits complete frames.
 * Usage: call push(chunk) whenever data arrives; set onFrame to handle frames.
 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);
  private stopped = false;
  onFrame: ((frame: DecodedFrame) => void) | null = null;
  onError: ((err: Error) => void) | null = null;

  push(chunk: Buffer): void {
    if (this.stopped) return;
    this.buf = Buffer.concat([this.buf, chunk]);
    this.drain();
  }

  /**
   * Stop the decoder and return any bytes that were buffered but not yet
   * emitted as a complete frame.  Call this when transitioning the socket
   * from framed-protocol mode to raw-stream mode so that leftover bytes
   * (e.g. the first bytes of raw TCP data that arrived in the same TCP
   * segment as the final framed message) are not lost or misinterpreted.
   *
   * After calling `detach()` the decoder is permanently stopped and must
   * not be used again.  The `push()` method becomes a no-op once stopped,
   * so any external reference to this decoder instance is safe to keep but
   * will have no effect.
   *
   * Note: JavaScript's event loop is single-threaded, so callbacks can
   * never be executing concurrently with `detach()`.  Clearing the callback
   * references is therefore always safe to do synchronously here.
   */
  detach(): Buffer {
    this.stopped = true;
    const leftover = this.buf;
    this.buf = Buffer.alloc(0);
    this.onFrame = null;
    this.onError = null;
    return leftover;
  }

  private drain(): void {
    while (true) {
      if (this.stopped) break;

      // Need at least 4 bytes to read the length header
      if (this.buf.length < 4) break;

      const frameLen = this.buf.readUInt32BE(0); // includes 1 byte msgType + body

      // Sanity-check: guard against runaway frames (64 MB max)
      if (frameLen === 0 || frameLen > 64 * 1024 * 1024) {
        this.onError?.(new Error(`Invalid frame length: ${frameLen}`));
        this.buf = Buffer.alloc(0);
        break;
      }

      // Wait until we have the full frame
      if (this.buf.length < 4 + frameLen) break;

      const msgType = this.buf[4];
      const bodyBuf = this.buf.slice(5, 4 + frameLen);

      // Advance the buffer past this frame
      this.buf = this.buf.slice(4 + frameLen);

      let body: unknown;
      try {
        body = JSON.parse(bodyBuf.toString("utf8"));
      } catch (e) {
        this.onError?.(new Error(`Failed to parse frame body: ${e}`));
        continue;
      }

      this.onFrame?.({ msgType, body });
    }
  }
}
