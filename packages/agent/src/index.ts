import process from 'node:process';
import { readAgentRuntimeConfig } from '@privatefrp/shared';
import { AgentClient } from './client';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve, isAbsolute } from 'node:path';

export async function startAgent(): Promise<void> {
  const config = readAgentRuntimeConfig(process.env);
  if (!config.agentId || !config.agentSecret) {
    throw new Error('AGENT_ID and AGENT_SECRET are required for agent mode');
  }

  const client = new AgentClient(config);
  // ensure agent data dir (parent of trust store) exists so TOFU can write
  const trustStoreDir = dirname(isAbsolute(config.trustStorePath) ? config.trustStorePath : resolve(process.cwd(), config.dataDir || 'data', config.trustStorePath));
  await mkdir(trustStoreDir, { recursive: true });
  client.start();
  globalThis.console.log(`[agent] connecting to ${config.serverHost}:${config.serverPort}`);
}