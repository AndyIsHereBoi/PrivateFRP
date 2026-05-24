import { DEFAULTS } from './constants';
import { readInt, readJson, readString } from './utils/env';
import type { TunnelRecord } from './types';

export interface ServerRuntimeConfig {
  host: string;
  agentPort: number;
  dashboardPort: number;
  publicHost: string;
  tlsCertPath: string;
  tlsKeyPath: string;
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
  agentId: string;
  agentSecret: string;
  agentName: string;
  reconnectDelayMs: number;
  trustStorePath: string;
  tunnels: TunnelRecord[];
}

export function readServerRuntimeConfig(env: Record<string, string | undefined>): ServerRuntimeConfig {
  const dataDir = readString(env, 'DATA_DIR', 'data');
  return {
    host: readString(env, 'SERVER_HOST', DEFAULTS.SERVER_HOST),
    agentPort: readInt(env, 'AGENT_PORT', DEFAULTS.AGENT_PORT),
    dashboardPort: readInt(env, 'DASHBOARD_PORT', DEFAULTS.DASHBOARD_PORT),
    publicHost: readString(env, 'PUBLIC_HOST', '0.0.0.0'),
    tlsCertPath: readString(env, 'AGENT_TLS_CERT_PATH', 'certs/agent-server-cert.pem'),
    tlsKeyPath: readString(env, 'AGENT_TLS_KEY_PATH', 'certs/agent-server-key.pem'),
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
  return {
    serverHost: readString(env, 'SERVER_HOST', '127.0.0.1'),
    serverPort: readInt(env, 'SERVER_PORT', DEFAULTS.AGENT_PORT),
    agentId: readString(env, 'AGENT_ID', ''),
    agentSecret: readString(env, 'AGENT_SECRET', ''),
    agentName: readString(env, 'AGENT_NAME', 'privatefrp-agent'),
    reconnectDelayMs: readInt(env, 'AGENT_RECONNECT_MS', DEFAULTS.AGENT_RECONNECT_MS),
    trustStorePath: readString(env, 'TRUST_STORE_PATH', `${dataDir}/trusted-server-cert.json`),
    tunnels: readJson<TunnelRecord[]>(env, 'TUNNELS', [])
  };
}