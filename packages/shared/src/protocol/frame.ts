import { FrameType } from "../constants.js";
import { Frame, ProtocolError } from "../types.js";

// Frame header structure:
// 1 byte: Type
// 4 bytes: ID (big-endian)
// 4 bytes: Body length (big-endian)
const HEADER_SIZE = 9;

/**
 * Encode a frame to binary format
 */
export function encodeFrame(type: FrameType, id: number, body: Uint8Array): Uint8Array {
  const bodyLength = body.length;
  const buffer = new ArrayBuffer(HEADER_SIZE + bodyLength);
  const view = new DataView(buffer);

  // Write type (1 byte)
  view.setUint8(0, type);

  // Write ID (4 bytes, big-endian)
  view.setUint32(1, id, false);

  // Write body length (4 bytes, big-endian)
  view.setUint32(5, bodyLength, false);

  // Copy body
  const data = new Uint8Array(buffer);
  if (bodyLength > 0) {
    data.set(body, HEADER_SIZE);
  }

  return data;
}

/**
 * Decode a frame from binary data
 */
export function decodeFrame(data: Uint8Array): Frame {
  if (data.length < HEADER_SIZE) {
    throw new ProtocolError(`Frame too small: ${data.length} bytes`);
  }

  const view = new DataView(data.buffer, data.byteOffset, data.length);
  const type = view.getUint8(0);
  const id = view.getUint32(1, false);
  const bodyLength = view.getUint32(5, false);

  if (data.length < HEADER_SIZE + bodyLength) {
    throw new ProtocolError(
      `Expected ${HEADER_SIZE + bodyLength} bytes, got ${data.length}`
    );
  }

  let body: Uint8Array;
  if (bodyLength > 0) {
    body = data.slice(HEADER_SIZE, HEADER_SIZE + bodyLength);
  } else {
    body = new Uint8Array();
  }

  return { type, id, body };
}

/**
 * Parse AgentHello payload
 */
export function parseAgentHello(body: Uint8Array): { version: string; agentId: string; secret: string } {
  const text = new TextDecoder().decode(body);
  try {
    return JSON.parse(text);
  } catch {
    throw new ProtocolError("Invalid AgentHello JSON");
  }
}

/**
 * Parse ServerHello payload
 */
export function parseServerHello(body: Uint8Array): { version: string; serverId: string; success: boolean; message?: string } {
  const text = new TextDecoder().decode(body);
  try {
    return JSON.parse(text);
  } catch {
    throw new ProtocolError("Invalid ServerHello JSON");
  }
}

/**
 * Parse Heartbeat payload
 */
export function parseHeartbeat(body: Uint8Array): { timestamp: number; latency?: number } {
  const text = new TextDecoder().decode(body);
  try {
    return JSON.parse(text);
  } catch {
    throw new ProtocolError("Invalid Heartbeat JSON");
  }
}

/**
 * Parse TunnelConfig from body
 */
export function parseTunnelConfigs(body: Uint8Array): Array<{
  id: string;
  name: string;
  type: "tcp" | "udp" | "tcp+udp";
  listenPort: number;
  targetHost: string;
  targetPort: number;
  enabled: boolean;
  createdAt: number;
}> {
  const text = new TextDecoder().decode(body);
  try {
    return JSON.parse(text);
  } catch {
    throw new ProtocolError("Invalid TunnelConfigs JSON");
  }
}

/**
 * Parse DialTcp payload
 */
export function parseDialTcp(body: Uint8Array): { streamId: number; targetHost: string; targetPort: number } {
  const text = new TextDecoder().decode(body);
  try {
    return JSON.parse(text);
  } catch {
    throw new ProtocolError("Invalid DialTcp JSON");
  }
}

/**
 * Parse DialUdpSession payload
 */
export function parseDialUdpSession(body: Uint8Array): { sessionId: number; peerAddr: string } {
  const text = new TextDecoder().decode(body);
  try {
    return JSON.parse(text);
  } catch {
    throw new ProtocolError("Invalid DialUdpSession JSON");
  }
}

/**
 * Parse StreamData payload
 */
export function parseStreamData(body: Uint8Array): { streamId: number; data: Uint8Array; offset?: number; length?: number } {
  if (body.length < 4) {
    throw new ProtocolError("StreamData body too small");
  }

  const view = new DataView(body.buffer, body.byteOffset, body.length);
  const streamId = view.getUint32(0, false);

  let data: Uint8Array;
  if (body.length > 4) {
    data = body.slice(4);
  } else {
    data = new Uint8Array();
  }

  return { streamId, data };
}

/**
 * Parse StreamClose payload
 */
export function parseStreamClose(body: Uint8Array): { streamId: number; reason?: string } {
  if (body.length === 0) {
    return { streamId: 0 };
  }

  const text = new TextDecoder().decode(body);
  try {
    const parsed = JSON.parse(text);
    return { streamId: parsed.streamId ?? 0, reason: parsed.reason };
  } catch {
    throw new ProtocolError("Invalid StreamClose JSON");
  }
}
