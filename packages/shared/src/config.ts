import { DEFAULTS } from './constants';
import { readInt, readJson, readString } from './utils/env';
import type { TunnelRecord } from './types';

export interface ServerRuntimeConfig {
  host: string;
  agentPort: number;
  dataPort: number;
  dashboardPort: number;
  publicHost: string;
  databasePath: string;
  dashboardUsername: string;
  dashboardPassword: string;
  sessionSecret: string;
  dataDir: string;
  dashboardPublicIp: string;
}

export interface AgentRuntimeConfig {
  serverHost: string;
  serverPort: number;
  dataPort: number;
  agentId: string;
  agentSecret: string;
  agentName: string;
  reconnectDelayMs: number;
  dataDir: string;
  tunnels: TunnelRecord[];
}

export function readServerRuntimeConfig(env: Record<string, string | undefined>): ServerRuntimeConfig {
  const dataDir = readString(env, 'DATA_DIR', 'data');
  const agentPort = readInt(env, 'AGENT_PORT', DEFAULTS.AGENT_PORT);
  return {
    host: readString(env, 'SERVER_HOST', DEFAULTS.SERVER_HOST),
    agentPort,
    dataPort: readInt(env, 'DATA_PORT', agentPort + 1),
    dashboardPort: readInt(env, 'DASHBOARD_PORT', DEFAULTS.DASHBOARD_PORT),
    publicHost: readString(env, 'PUBLIC_HOST', '0.0.0.0'),
    databasePath: readString(env, 'DATABASE_PATH', `${dataDir}/privatefrp.sqlite`),
    dashboardUsername: readString(env, 'DASHBOARD_USERNAME', 'admin'),
    dashboardPassword: readString(env, 'DASHBOARD_PASSWORD', 'admin'),
    sessionSecret: readString(env, 'DASHBOARD_SESSION_SECRET', 'change-me-in-production'),
    dataDir,
    dashboardPublicIp: readString(env, 'DASHBOARD_PUBLIC_IP', '')
  };
}

export function readAgentRuntimeConfig(env: Record<string, string | undefined>): AgentRuntimeConfig {
  const dataDir = readString(env, 'DATA_DIR', 'data');
  const serverPort = readInt(env, 'SERVER_PORT', DEFAULTS.AGENT_PORT);
  return {
    serverHost: readString(env, 'SERVER_HOST', '127.0.0.1'),
    serverPort,
    dataPort: readInt(env, 'DATA_PORT', serverPort + 1),
    agentId: readString(env, 'AGENT_ID', ''),
    agentSecret: readString(env, 'AGENT_SECRET', ''),
    agentName: readString(env, 'AGENT_NAME', 'privatefrp-agent'),
    reconnectDelayMs: readInt(env, 'AGENT_RECONNECT_MS', DEFAULTS.AGENT_RECONNECT_MS),
    dataDir,
    tunnels: readJson<TunnelRecord[]>(env, 'TUNNELS', [])
  };
}