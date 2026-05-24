import { validateServerEnv, validateAgentEnv, getDefaultEnv } from "./env.js";

/**
 * Configuration loader with defaults and environment variable support
 */

export interface ServerConfig {
  serverPort: number;
  dashboardPort: number;
  databasePath: string;
  tlsCert?: string;
  tlsKey?: string;
}

export interface AgentConfig {
  serverHost: string;
  serverPort: number;
  agentId: string;
  agentSecret: string;
  tlsRejectUnauthorized: boolean;
}

/**
 * Load server configuration from environment variables with defaults
 */
export function loadServerConfig(): ServerConfig {
  const env = { ...getDefaultEnv(), ...(globalThis as any).Bun?.env || {} };
  const validated = validateServerEnv(env);

  return {
    serverPort: validated.SERVER_PORT,
    dashboardPort: validated.DASHBOARD_PORT,
    databasePath: validated.DATABASE_PATH,
    tlsCert: validated.TLS_CERT,
    tlsKey: validated.TLS_KEY,
  };
}

/**
 * Load agent configuration from environment variables with defaults
 */
export function loadAgentConfig(): AgentConfig {
  const env = { ...getDefaultEnv(), ...(globalThis as any).Bun?.env || {} };
  const validated = validateAgentEnv(env);

  return {
    serverHost: validated.SERVER_HOST,
    serverPort: validated.SERVER_PORT,
    agentId: validated.AGENT_ID,
    agentSecret: validated.AGENT_SECRET,
    tlsRejectUnauthorized: validated.TLS_REJECT_UNAUTHORIZED !== false,
  };
}
