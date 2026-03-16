import fs from "fs";
import path from "path";
import os from "os";
import { Agent } from "./agent";

const ENV_TEMPLATE = `# PrivateFRP Agent — environment variables
# Edit this file and fill in the required values, then run: agent

# Public IP address or hostname of the PrivateFRP server (required)
SERVER_HOST=your-server-ip

# TLS port the server listens on for agent connections (matches AGENT_PORT on the server)
SERVER_PORT=7000

# Agent UUID generated from the dashboard (required)
AGENT_ID=

# Agent secret generated from the dashboard — shown only once (required)
AGENT_SECRET=

# Set to "false" when the server uses a self-signed TLS certificate (e.g. from generate-certs.sh)
TLS_REJECT_UNAUTHORIZED=false
`;

function getConfigCandidates(fileName: string): string[] {
  const candidates: string[] = [];
  const execName = path.basename(process.execPath).toLowerCase();
  const isCompiled = !execName.startsWith("bun");

  // Standard Linux system-wide config location.
  candidates.push(path.join("/etc/privatefrp", fileName));

  // Standard Linux per-user config location.
  candidates.push(path.join(os.homedir(), ".config", "privatefrp", fileName));

  // When compiled, also check next to the binary for backward compat.
  if (isCompiled) {
    candidates.push(path.join(path.dirname(process.execPath), fileName));
  }

  // CWD fallback for local/dev runs.
  candidates.push(path.join(process.cwd(), fileName));

  return candidates;
}

function parseEnvContents(contents: string): void {
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

function loadEnvFile(fileName: string): void {
  const candidates = getConfigCandidates(fileName);
  const envPath = candidates.find((candidate) => fs.existsSync(candidate));

  if (!envPath) {
    // Only auto-create config when running as a compiled binary (i.e. installed as `agent`).
    const execName = path.basename(process.execPath).toLowerCase();
    if (!execName.startsWith("bun")) {
      const defaultConfigDir = path.join(os.homedir(), ".config", "privatefrp");
      const defaultConfigPath = path.join(defaultConfigDir, fileName);

      try {
        fs.mkdirSync(defaultConfigDir, { recursive: true });
        fs.writeFileSync(defaultConfigPath, ENV_TEMPLATE, { flag: "wx" });
        console.log(`[PrivateFRP Agent] No configuration file found.`);
        console.log(`[PrivateFRP Agent] A template has been created at: ${defaultConfigPath}`);
        console.log(`[PrivateFRP Agent] Please edit the file and run 'agent' again.`);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EEXIST") {
          // File was created between our existence check and the write — just load it now.
          const contents = fs.readFileSync(defaultConfigPath, "utf8");
          parseEnvContents(contents);
          return;
        }
        console.log(`[PrivateFRP Agent] No configuration file found.`);
        if (code === "EACCES" || code === "EPERM") {
          console.log(`[PrivateFRP Agent] Permission denied writing to: ${defaultConfigPath}`);
          console.log(`[PrivateFRP Agent] Create the file manually or run with sufficient permissions.`);
        } else {
          console.log(`[PrivateFRP Agent] Could not create config at: ${defaultConfigPath} (${code ?? err})`);
        }
      }
      process.exit(1);
    }
    return;
  }

  const contents = fs.readFileSync(envPath, "utf8");
  parseEnvContents(contents);
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
