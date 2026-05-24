// PrivateFRP Server Entry Point

import { AgentServer } from "./server/agent-server.js";
import { DashboardServer } from "./server/dashboard-server.js";
import { Database } from "./database/index.js";
import { loadServerConfig } from "@privatefrp/shared";

console.log("PrivateFRP Server starting...");

// Load configuration from environment
const config = loadServerConfig();

// Initialize database with configured path
const db = new Database(config.databasePath);

// Create agent server for handling agent connections
const agentServer = new AgentServer(config.serverPort);

// Create dashboard server for web interface
const dashboardServer = new DashboardServer(db, config.dashboardPort);

// Start servers
await agentServer.start();
await dashboardServer.start();

console.log("PrivateFRP Server started successfully");
