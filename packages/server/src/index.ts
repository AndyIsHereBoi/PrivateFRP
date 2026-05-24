import process from 'node:process';
import { readServerRuntimeConfig } from '@privatefrp/shared';
import { ServerStore } from './store';
import { ControlPlane } from './control';
import { DashboardServer } from './dashboard';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';
import { execSync } from 'node:child_process';

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

  // Auto-generate self-signed cert/key if they don't exist (prefer JS module)
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    let generated = false;
    try {
      const mod = await import('selfsigned');
      const selfsigned = (mod && (mod as any).default) ? (mod as any).default : mod;
      const attrs = [{ name: 'commonName', value: config.host }];
      const pems = selfsigned.generate(attrs, { days: 365, keySize: 4096 });
      await writeFile(keyPath, pems.private, 'utf8');
      await writeFile(certPath, pems.cert, 'utf8');
      globalThis.console.log(`[server] generated self-signed cert at ${certPath}`);
      generated = true;
    } catch (err) {
      globalThis.console.warn('[server] selfsigned module not available or failed, attempting openssl fallback');
    }

    if (!generated) {
      try {
        execSync(
          `openssl req -x509 -newkey rsa:4096 -nodes -sha256 -days 365 -subj "/CN=${config.host}" -keyout "${keyPath}" -out "${certPath}"`,
          { stdio: 'ignore' }
        );
        globalThis.console.log(`[server] generated self-signed cert at ${certPath}`);
      } catch (err) {
        globalThis.console.warn('[server] failed to generate self-signed certs automatically; please provide cert/key at:', certPath, keyPath);
      }
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
}
