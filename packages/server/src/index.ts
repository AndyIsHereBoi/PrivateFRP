import fs from "fs";
import path from "path";
import { Server } from "./server";
import { DB } from "./db";
import { configureServerLogging, tunnelLog } from "./logger";

function loadEnvFile(fileName: string): void {
  const candidates: string[] = [];
  const execName = path.basename(process.execPath).toLowerCase();

  // When compiled, the binary location is where users expect server.env.
  if (!execName.startsWith("bun")) {
    candidates.push(path.join(path.dirname(process.execPath), fileName));
  }

  // Keep cwd fallback for local runs.
  candidates.push(path.join(process.cwd(), fileName));

  const envPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!envPath) {
    return;
  }

  const contents = fs.readFileSync(envPath, "utf8");
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile("server.env");

const logPath = process.env.LOG_PATH ?? "./logs";
configureServerLogging(logPath);

const agentPort = parseInt(process.env.AGENT_PORT ?? "7000", 10);
const dashboardPort = parseInt(process.env.DASHBOARD_PORT ?? "8080", 10);
const tlsCert = process.env.AGENT_TLS_CERT ?? "./certs/server.crt";
const tlsKey = process.env.AGENT_TLS_KEY ?? "./certs/server.key";
const dashboardSecret = process.env.DASHBOARD_SECRET ?? "admin:password";
const dataDir = process.env.DATA_DIR ?? "./data";
const publicIp = process.env.PUBLIC_IP ?? "";

tunnelLog.log("[PrivateFRP Server] Starting...");
tunnelLog.log(`  Agent port    : ${agentPort}`);
tunnelLog.log(`  Dashboard port: ${dashboardPort}`);
tunnelLog.log(`  TLS cert      : ${tlsCert}`);
tunnelLog.log(`  Data dir      : ${dataDir}`);
tunnelLog.log(`  Log path      : ${path.resolve(logPath)}`);
if (publicIp) tunnelLog.log(`  Public IP     : ${publicIp}`);

const db = new DB(dataDir);
const server = new Server({ agentPort, dashboardPort, tlsCert, tlsKey, dashboardSecret, dataDir, publicIp }, db);

server.start().catch((err) => {
  tunnelLog.error("[PrivateFRP Server] Failed to start:", err);
  process.exit(1);
});
