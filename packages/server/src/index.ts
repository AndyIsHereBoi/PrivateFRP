import process from 'node:process';
import { readServerRuntimeConfig } from '@privatefrp/shared';
import { ServerStore } from './store';
import { ControlPlane } from './control';
import { DashboardServer } from './dashboard';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';

export async function startServer(): Promise<void> {
  const config = readServerRuntimeConfig(process.env);
  // ensure data directory exists
  await mkdir(resolve(process.cwd(), config.dataDir), { recursive: true });

  // Resolve cert paths: if not absolute, treat them as relative to DATA_DIR
  const certPath = isAbsolute(config.tlsCertPath)
    ? config.tlsCertPath
    : resolve(process.cwd(), config.dataDir, config.tlsCertPath);
  const keyPath = isAbsolute(config.tlsKeyPath)
    ? config.tlsKeyPath
    : resolve(process.cwd(), config.dataDir, config.tlsKeyPath);

  // Ensure cert directory exists
  await mkdir(dirname(certPath), { recursive: true });

  // Auto-generate self-signed cert/key if they don't exist using an in-process module
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    try {
      const mod = await import('selfsigned');
      const selfsigned = (mod && (mod as any).default) ? (mod as any).default : mod;
      const attrs = [{ name: 'commonName', value: config.host }];
      const pems = selfsigned.generate(attrs, { days: 365, keySize: 4096 });
      await writeFile(keyPath, pems.private, 'utf8');
      await writeFile(certPath, pems.cert, 'utf8');
      globalThis.console.log(`[server] generated self-signed cert at ${certPath}`);
    } catch (err) {
      console.error('[server] failed to generate self-signed certs: selfsigned module missing or generation failed');
      console.error('[server] ensure you ran `bun install` so `selfsigned` is available, or provide cert/key files at:', certPath, keyPath);
      process.exit(1);
    }
  }
  const store = new ServerStore(config.databasePath);
  let dashboard!: DashboardServer;

  const control = new ControlPlane(config, store, () => dashboard?.notify(), process.cwd());
  dashboard = new DashboardServer(config, control, process.cwd());

  await control.start();
  dashboard.start();

  globalThis.console.log(`[server] agent tls control plane on ${config.host}:${config.agentPort}`);
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
