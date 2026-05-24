import process from 'node:process';
import { readServerRuntimeConfig } from '@privatefrp/shared';
import { ServerStore } from './store';
import { ControlPlane } from './control';
import { DashboardServer } from './dashboard';

export async function startServer(): Promise<void> {
  const config = readServerRuntimeConfig(process.env);
  const store = new ServerStore(config.databasePath);
  let dashboard!: DashboardServer;

  const control = new ControlPlane(config, store, () => dashboard?.notify(), process.cwd());
  dashboard = new DashboardServer(config, control, process.cwd());

  await control.start();
  dashboard.start();

  globalThis.console.log(`[server] agent tls control plane on ${config.host}:${config.agentPort}`);
  globalThis.console.log(`[server] dashboard http on ${config.host}:${config.dashboardPort}`);
}
