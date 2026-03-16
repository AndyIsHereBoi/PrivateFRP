import { Agent } from "./agent";

const serverHost = process.env.SERVER_HOST ?? "localhost";
const serverPort = parseInt(process.env.SERVER_PORT ?? "7000", 10);
const agentId = process.env.AGENT_ID;
const agentSecret = process.env.AGENT_SECRET;
const tlsRejectUnauthorized = process.env.TLS_REJECT_UNAUTHORIZED !== "false";

if (!agentId || !agentSecret) {
  console.error("[PrivateFRP Agent] AGENT_ID and AGENT_SECRET environment variables are required.");
  process.exit(1);
}

console.log("[PrivateFRP Agent] Starting...");
console.log("[PrivateFRP Agent] Build marker: reconnect-guard-v4");
console.log(`  Server : ${serverHost}:${serverPort}`);
console.log(`  Agent  : ${agentId}`);
console.log(`  TLS verify: ${tlsRejectUnauthorized}`);

const agent = new Agent({
  serverHost,
  serverPort,
  agentId,
  agentSecret,
  tlsRejectUnauthorized,
});

agent.start();

process.on("SIGINT", () => {
  console.log("\n[PrivateFRP Agent] Shutting down...");
  agent.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  agent.stop();
  process.exit(0);
});
