/**
 * Environment variable validation utilities
 */

export interface ServerEnv {
  SERVER_PORT: number;
  DASHBOARD_PORT: number;
  DATABASE_PATH: string;
  TLS_CERT?: string;
  TLS_KEY?: string;
}

export interface AgentEnv {
  SERVER_HOST: string;
  SERVER_PORT: number;
  AGENT_ID: string;
  AGENT_SECRET: string;
  TLS_REJECT_UNAUTHORIZED?: boolean;
}

/**
 * Validate server environment variables
 */
export function validateServerEnv(env: Record<string, string | undefined>): ServerEnv {
  const errors: string[] = [];

  const serverPort = parseInt(env.SERVER_PORT || "");
  if (isNaN(serverPort)) {
    errors.push("SERVER_PORT must be a valid number");
  }

  const dashboardPort = parseInt(env.DASHBOARD_PORT || "");
  if (isNaN(dashboardPort)) {
    errors.push("DASHBOARD_PORT must be a valid number");
  }

  if (!env.DATABASE_PATH) {
    errors.push("DATABASE_PATH is required");
  }

  if (errors.length > 0) {
    throw new Error(`Environment validation failed:\n${errors.join("\n")}`);
  }

  return {
    SERVER_PORT: serverPort,
    DASHBOARD_PORT: dashboardPort,
    DATABASE_PATH: env.DATABASE_PATH!,
    TLS_CERT: env.TLS_CERT,
    TLS_KEY: env.TLS_KEY,
  };
}

/**
 * Validate agent environment variables
 */
export function validateAgentEnv(env: Record<string, string | undefined>): AgentEnv {
  const errors: string[] = [];

  if (!env.SERVER_HOST) {
    errors.push("SERVER_HOST is required");
  }

  const serverPort = parseInt(env.SERVER_PORT || "");
  if (isNaN(serverPort)) {
    errors.push("SERVER_PORT must be a valid number");
  }

  if (!env.AGENT_ID) {
    errors.push("AGENT_ID is required");
  }

  if (!env.AGENT_SECRET) {
    errors.push("AGENT_SECRET is required");
  }

  if (errors.length > 0) {
    throw new Error(`Environment validation failed:\n${errors.join("\n")}`);
  }

  return {
    SERVER_HOST: env.SERVER_HOST!,
    SERVER_PORT: serverPort,
    AGENT_ID: env.AGENT_ID!,
    AGENT_SECRET: env.AGENT_SECRET!,
    TLS_REJECT_UNAUTHORIZED: env.TLS_REJECT_UNAUTHORIZED !== "false",
  };
}

/**
 * Get default environment values
 */
export function getDefaultEnv(): Record<string, string> {
  return {
    SERVER_PORT: "7000",
    DASHBOARD_PORT: "8089",
    DATABASE_PATH: "./data/privatefrp.db",
    TLS_REJECT_UNAUTHORIZED: "true",
  };
}
