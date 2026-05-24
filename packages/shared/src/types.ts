export type TunnelType = 'tcp' | 'udp' | 'tcp+udp';

export interface TunnelRecord {
  id: string;
  name: string;
  type: TunnelType;
  listenPort: number;
  targetHost: string;
  targetPort: number;
  agentId: string | null;
  enabled: boolean;
  createdAt: number;
}

export interface AgentRecord {
  id: string;
  name: string;
  secretHash: string;
  enabled: boolean;
  createdAt: number;
  lastHeartbeat: number | null;
  latencyMs: number | null;
  remoteAddress: string | null;
  activeConnections: number;
  connected?: boolean;
}

export interface AgentConfig {
  id: string;
  name: string;
  enabled: boolean;
  tunnels: TunnelRecord[];
}

export interface AgentHelloFrame {
  agentId: string;
  agentSecret: string;
  agentName?: string;
  protocolVersion: number;
}

export interface ServerHelloFrame {
  serverTime: number;
  agentName: string;
}

export interface HeartbeatFrame {
  timestamp: number;
}

export interface ConfigPushFrame {
  agentId: string;
  tunnels: TunnelRecord[];
}

export interface DialTcpFrame {
  streamId: string;
  tunnelId: string;
  clientAddress: string;
}

export interface DialUdpSessionFrame {
  sessionId: string;
  tunnelId: string;
  peerAddress: string;
  peerPort: number;
  targetHost: string;
  targetPort: number;
}

export interface StreamOpenFrame {
  streamId: string;
}

export interface StreamDataFrame {
  streamId: string;
  data: Uint8Array;
}

export interface StreamCloseFrame {
  streamId: string;
  reason?: string;
}

export interface UdpDataFrame {
  sessionId: string;
  data: Uint8Array;
  peerAddress?: string;
  peerPort?: number;
}

export interface ErrorFrame {
  message: string;
}

export interface Frame<T = unknown> {
  type: string;
  reqId?: string;
  streamId?: string;
  payload?: T;
}

export type DashboardWsRequest =
  | { reqId: string; type: 'agents'; payload: Record<string, never> }
  | { reqId: string; type: 'tunnels'; payload: Record<string, never> }
  | { reqId: string; type: 'status'; payload: Record<string, never> }
  | { reqId: string; type: 'refresh'; payload: Record<string, never> };

export interface DashboardWsResponse {
  reqId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}