import fs from "fs";
import path from "path";
import { Agent } from "./agent";

function loadEnvFile(fileName: string): void {
  const candidates: string[] = [];
  const execName = path.basename(process.execPath).toLowerCase();

  // When compiled, the binary location is where users expect agent.env.
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

loadEnvFile("agent.env");

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
