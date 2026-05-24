// PrivateFRP Agent Entry Point

import { AgentClient } from "./client/agent-client.js";
import { TunnelManager } from "./tunnel/tunnel-manager.js";

console.log("PrivateFRP Agent starting...");

// Load configuration from environment
const config = {
  serverHost: process.env.SERVER_HOST || "localhost",
  serverPort: parseInt(process.env.SERVER_PORT || "7000"),
  agentId: process.env.AGENT_ID || "",
  agentSecret: process.env.AGENT_SECRET || "",
};

if (!config.agentId || !config.agentSecret) {
  console.error("AGENT_ID and AGENT_SECRET must be set");
  process.exit(1);
}

// Create tunnel manager
const tunnelManager = new TunnelManager();

// Create agent client
const agentClient = new AgentClient(config, tunnelManager);

// Start the agent
await agentClient.start();

console.log("PrivateFRP Agent started successfully");
