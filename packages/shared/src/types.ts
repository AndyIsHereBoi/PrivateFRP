import { FrameType, TunnelType } from "./constants.js";

/**
 * AgentHello frame payload
 */
export interface AgentHelloPayload {
  version: string;
  agentId: string;
  secret: string;
}

/**
 * ServerHello frame payload
 */
export interface ServerHelloPayload {
  version: string;
  serverId: string;
  success: boolean;
  message?: string;
}

/**
 * Heartbeat frame payload
 */
export interface HeartbeatPayload {
  timestamp: number;
  latency?: number;
}

/**
 * Tunnel configuration for a single tunnel
 */
export interface TunnelConfig {
  id: string;
  name: string;
  type: TunnelType;
  listenPort: number;
  targetHost: string;
  targetPort: number;
  enabled: boolean;
  createdAt: number;
}

/**
 * Agent configuration payload
 */
export interface AgentConfigPayload {
  agentId: string;
  agentName: string;
  tunnels: TunnelConfig[];
}

/**
 * DialTCP frame payload
 */
export interface DialTcpPayload {
  streamId: number;
  targetHost: string;
  targetPort: number;
}

/**
 * DialUDP session frame payload
 */
export interface DialUdpSessionPayload {
  sessionId: number;
  peerAddr: string;
}

/**
 * Data connection hello payload
 */
export interface DataConnHelloPayload {
  agentId: string;
  secret: string;
}

/**
 * UDP data frame payload
 */
export interface UdpDataPayload {
  sessionId: number;
  data: Uint8Array;
}

/**
 * Pool hello payload
 */
export interface PoolHelloPayload {
  agentId: string;
}

/**
 * Dial assign payload
 */
export interface DialAssignPayload {
  streamId: number;
  tunnelId: string;
}

/**
 * Stream open frame payload
 */
export interface StreamOpenPayload {
  streamId: number;
  tunnelId: string;
  peerAddr?: string;
}

/**
 * Stream data frame payload
 */
export interface StreamDataPayload {
  streamId: number;
  data: Uint8Array;
  offset?: number;
  length?: number;
}

/**
 * Stream close frame payload
 */
export interface StreamClosePayload {
  streamId: number;
  reason?: string;
}

/**
 * Base frame structure for all protocol messages
 */
export interface Frame {
  type: FrameType;
  id: number;
  body: Uint8Array;
}

/**
 * Error types for the protocol
 */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

/**
 * Connection error types
 */
export enum ConnectionErrorCode {
  AuthFailed = "AUTH_FAILED",
  InvalidFrame = "INVALID_FRAME",
  Timeout = "TIMEOUT",
  Closed = "CLOSED",
  Unknown = "UNKNOWN",
}

/**
 * Connection error class
 */
export class ConnectionError extends Error {
  code: ConnectionErrorCode;

  constructor(code: ConnectionErrorCode, message: string) {
    super(message);
    this.name = "ConnectionError";
    this.code = code;
  }
}
