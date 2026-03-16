import { Server } from "./server";
import { DB } from "./db";

const agentPort = parseInt(process.env.AGENT_PORT ?? "7000", 10);
const dashboardPort = parseInt(process.env.DASHBOARD_PORT ?? "8080", 10);
const tlsCert = process.env.AGENT_TLS_CERT ?? "./certs/server.crt";
const tlsKey = process.env.AGENT_TLS_KEY ?? "./certs/server.key";
const dashboardSecret = process.env.DASHBOARD_SECRET ?? "admin:password";
const dataDir = process.env.DATA_DIR ?? "./data";
const publicIp = process.env.PUBLIC_IP ?? "";

console.log("[PrivateFRP Server] Starting...");
console.log(`  Agent port    : ${agentPort}`);
console.log(`  Dashboard port: ${dashboardPort}`);
console.log(`  TLS cert      : ${tlsCert}`);
console.log(`  Data dir      : ${dataDir}`);
if (publicIp) console.log(`  Public IP     : ${publicIp}`);

const db = new DB(dataDir);
const server = new Server({ agentPort, dashboardPort, tlsCert, tlsKey, dashboardSecret, dataDir, publicIp }, db);

server.start().catch((err) => {
  console.error("[PrivateFRP Server] Failed to start:", err);
  process.exit(1);
});
