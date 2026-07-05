import process from 'node:process';
import { readServerRuntimeConfig } from '@privatefrp/shared';
import { ServerStore } from './store';
import { ControlPlane } from './control';
import { DashboardServer } from './dashboard';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

async function ensureTlsCerts(dataDir: string): Promise<{ certFile: string; keyFile: string }> {
  const certsDir = resolve(process.cwd(), dataDir, 'certs');
  await mkdir(certsDir, { recursive: true });
  const certFile = join(certsDir, 'cert.pem');
  const keyFile = join(certsDir, 'key.pem');

  if (existsSync(certFile) && existsSync(keyFile)) {
    return { certFile, keyFile };
  }

  const selfsigned = await import('selfsigned');
  const attrs = [{ name: 'commonName', value: 'PrivateFRP Dashboard' }];
  const pems = selfsigned.generate(attrs, { days: 3650, keySize: 2048 });

  await writeFile(certFile, pems.cert, 'utf-8');
  await writeFile(keyFile, pems.private, 'utf-8');
  console.log(`[server] generated self-signed TLS cert at ${certsDir}`);
  return { certFile, keyFile };
}

export async function startServer(): Promise<void> {
  const config = readServerRuntimeConfig(process.env);
  // ensure data directory exists
  await mkdir(resolve(process.cwd(), config.dataDir), { recursive: true });

  // Auto-generate TLS certs if not explicitly configured
  const overrides: Record<string, string> = {};
  if (!config.tlsCertFile || !config.tlsKeyFile) {
    const { certFile, keyFile } = await ensureTlsCerts(config.dataDir);
    overrides.tlsCertFile = certFile;
    overrides.tlsKeyFile = keyFile;
  }

  const store = new ServerStore(config.databasePath);
  let dashboard!: DashboardServer;

  const control = new ControlPlane(config, store, () => dashboard?.notify(), process.cwd());
  dashboard = new DashboardServer({ ...config, ...overrides }, control, store, process.cwd());

  await control.start();
  dashboard.start();

  const buildVer = process.env.BUILD_VERSION ?? 'dev';
  const buildCommit = process.env.BUILD_COMMIT ?? 'unknown';
  globalThis.console.log(`[server] PrivateFRP Server v${buildVer} (commit ${buildCommit})`);
  globalThis.console.log(`[server] agent control plane on ${config.host}:${config.agentPort}`);
  globalThis.console.log(`[server] dashboard https://${config.host}:${config.dashboardPort}`);
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
