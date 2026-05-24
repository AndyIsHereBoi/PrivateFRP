import process from 'node:process';
import { readAgentRuntimeConfig } from '@privatefrp/shared';
import { AgentClient } from './client';

export async function startAgent(): Promise<void> {
  const config = readAgentRuntimeConfig(process.env);
  if (!config.agentId || !config.agentSecret) {
    throw new Error('AGENT_ID and AGENT_SECRET are required for agent mode');
  }

  const client = new AgentClient(config);
  client.start();
  globalThis.console.log(`[agent] connecting to ${config.serverHost}:${config.serverPort}`);
}