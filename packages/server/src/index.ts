import process from 'node:process';
import { readServerRuntimeConfig } from '@privatefrp/shared';
import { ServerStore } from './store';
import { ControlPlane } from './control';
import { DashboardServer } from './dashboard';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function startServer(): Promise<void> {
  const config = readServerRuntimeConfig(process.env);
  // ensure data directory exists
  await mkdir(resolve(process.cwd(), config.dataDir), { recursive: true });

  const store = new ServerStore(config.databasePath);
  let dashboard!: DashboardServer;

  const control = new ControlPlane(config, store, () => dashboard?.notify(), process.cwd());
  dashboard = new DashboardServer(config, control, process.cwd());

  await control.start();
  dashboard.start();

  const buildVer = process.env.BUILD_VERSION ?? 'dev';
  const buildCommit = process.env.BUILD_COMMIT ?? 'unknown';
  globalThis.console.log(`[server] PrivateFRP Server v${buildVer} (commit ${buildCommit})`);
  globalThis.console.log(`[server] agent control plane on ${config.host}:${config.agentPort}`);
  globalThis.console.log(`[server] dashboard http on ${config.host}:${config.dashboardPort}`);
  const shutdown = async (signal: string) => {
    try {
      globalThis.console.log(`[server] received ${signal}, shutting down...`);
      await control.stop();
      dashboard.stop();
      process.exit(0);
    } catch (err) {
      console.error('[server] error during shutdown', err);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
