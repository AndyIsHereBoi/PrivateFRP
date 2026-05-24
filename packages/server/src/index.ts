// PrivateFRP Server Entry Point

import { AgentServer } from "./server/agent-server.js";
import { DashboardServer } from "./server/dashboard-server.js";
import { Database } from "./database/index.js";

console.log("PrivateFRP Server starting...");

// Initialize database
const db = new Database("./data/privatefrp.db");

// Create agent server for handling agent connections
const agentServer = new AgentServer(7000);

// Create dashboard server for web interface
const dashboardServer = new DashboardServer(db, 8089);

// Start servers
await agentServer.start();
await dashboardServer.start();

console.log("PrivateFRP Server started successfully");
