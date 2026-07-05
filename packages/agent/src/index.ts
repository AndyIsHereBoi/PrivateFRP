import process from 'node:process';
import { readAgentRuntimeConfig } from '@privatefrp/shared';
import { AgentClient } from './client';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function startAgent(): Promise<void> {
  const config = readAgentRuntimeConfig(process.env);
  if (!config.agentId || !config.agentSecret) {
    throw new Error('AGENT_ID and AGENT_SECRET are required for agent mode');
  }

  const client = new AgentClient(config);
  // ensure agent data dir exists
  await mkdir(resolve(process.cwd(), config.dataDir || 'data'), { recursive: true });
  client.start();
  const shutdown = (signal: string) => {
    globalThis.console.log(`[agent] received ${signal}, shutting down...`);
    client.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  const buildVer = process.env.BUILD_VERSION ?? 'dev';
  const buildCommit = process.env.BUILD_COMMIT ?? 'unknown';
  globalThis.console.log(`[agent] PrivateFRP Agent v${buildVer} (commit ${buildCommit})`);
  globalThis.console.log(`[agent] connecting to ${config.serverHost}:${config.serverPort}`);
}