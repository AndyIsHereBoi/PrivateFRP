// Message Type Constants - Frame Types for Agent-Server Protocol

/**
 * Frame types used in the PrivateFRP protocol
 */
export enum FrameType {
  // Handshake frames
  AgentHello = 0x01,
  ServerHello = 0x02,

  // Control frames
  Heartbeat = 0x10,
  ConfigPush = 0x11,
  DialTcp = 0x12,
  DialUdpSession = 0x13,

  // Data connection frames
  DataConnHello = 0x20,
  UdpData = 0x21,

  // Stream frames
  PoolHello = 0x30,
  DialAssign = 0x31,
  StreamOpen = 0x40,
  StreamData = 0x41,
  StreamClose = 0x42,
}

/**
 * Tunnel types supported by PrivateFRP
 */
export enum TunnelType {
  TCP = "tcp",
  UDP = "udp",
  TCPUDP = "tcp+udp",
}

/**
 * Status codes for agent connections
 */
export enum AgentStatus {
  Disconnected = "disconnected",
  Connecting = "connecting",
  Connected = "connected",
  Error = "error",
}

/**
 * Default ports used by PrivateFRP
 */
export const DEFAULT_PORTS = {
  AGENT: 7000,
  DASHBOARD: 8089,
};

/**
 * Protocol version
 */
export const PROTOCOL_VERSION = "1.0";
