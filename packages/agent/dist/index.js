// @bun
// packages/agent/src/client/agent-client.ts
class AgentClient {
  config;
  tunnelManager;
  socket = null;
  connected = false;
  constructor(config, tunnelManager) {
    this.config = config;
    this.tunnelManager = tunnelManager;
  }
  async start() {
    console.log(`Connecting to server ${this.config.serverHost}:${this.config.serverPort}...`);
    while (true) {
      try {
        await this.connect();
        this.connected = true;
        const helloPayload = JSON.stringify({
          version: "1.0",
          agentId: this.config.agentId,
          secret: this.config.agentSecret
        });
        console.log("Agent connected successfully");
        break;
      } catch (err) {
        console.error(`Connection failed: ${err.message}`);
        console.log("Retrying in 5 seconds...");
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }
  async connect() {
    return new Promise((resolve, reject) => {
      try {
        this.socket = netConnect({
          host: this.config.serverHost,
          port: this.config.serverPort,
          tls: true
        });
        this.socket.ondata = (chunk) => {
          console.log("Received data:", chunk);
        };
        this.socket.onerror = (err) => {
          console.error(`Socket error: ${err.message}`);
          reject(err);
        };
        this.socket.onclose = () => {
          console.log("Connection closed");
          this.connected = false;
        };
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  }
  async stop() {
    if (this.socket) {
      this.socket.close();
    }
  }
  handleConfigPush(payload) {
    console.log(`Received config for ${payload.tunnels.length} tunnels`);
    this.tunnelManager.updateTunnels(payload.tunnels);
  }
  sendHeartbeat() {
    if (!this.connected || !this.socket)
      return;
    const payload = JSON.stringify({
      timestamp: Date.now()
    });
    console.log("Heartbeat sent");
  }
}

// packages/agent/src/tunnel/tunnel-manager.ts
class TunnelManager {
  tunnels = new Map;
  updateTunnels(newTunnels) {
    const currentIds = new Set(this.tunnels.keys());
    const newIds = new Set(newTunnels.map((t) => t.id));
    for (const id of currentIds) {
      if (!newIds.has(id)) {
        this.stopTunnel(id);
      }
    }
    for (const tunnel of newTunnels) {
      this.updateTunnel(tunnel);
    }
  }
  updateTunnel(tunnel) {
    const existing = this.tunnels.get(tunnel.id);
    if (existing && existing.listenPort === tunnel.listenPort) {
      return;
    }
    if (existing) {
      this.stopTunnel(tunnel.id);
    }
    console.log(`Starting tunnel: ${tunnel.name} (${tunnel.type}) on port ${tunnel.listenPort}`);
    this.tunnels.set(tunnel.id, tunnel);
    if (tunnel.type === "tcp" || tunnel.type === "tcp+udp") {
      this.startTcpListener(tunnel);
    }
    if (tunnel.type === "udp" || tunnel.type === "tcp+udp") {
      this.startUdpListener(tunnel);
    }
  }
  startTcpListener(tunnel) {
    console.log(`TCP listener started on port ${tunnel.listenPort}`);
  }
  startUdpListener(tunnel) {
    console.log(`UDP listener started on port ${tunnel.listenPort}`);
  }
  stopTunnel(id) {
    const tunnel = this.tunnels.get(id);
    if (tunnel) {
      console.log(`Stopping tunnel: ${tunnel.name}`);
      this.tunnels.delete(id);
    }
  }
  getTunnels() {
    return Array.from(this.tunnels.values());
  }
  getTunnel(id) {
    return this.tunnels.get(id);
  }
}

// packages/agent/src/index.ts
console.log("PrivateFRP Agent starting...");
var config = {
  serverHost: process.env.SERVER_HOST || "localhost",
  serverPort: parseInt(process.env.SERVER_PORT || "7000"),
  agentId: process.env.AGENT_ID || "",
  agentSecret: process.env.AGENT_SECRET || ""
};
if (!config.agentId || !config.agentSecret) {
  console.error("AGENT_ID and AGENT_SECRET must be set");
  process.exit(1);
}
var tunnelManager = new TunnelManager;
var agentClient = new AgentClient(config, tunnelManager);
await agentClient.start();
console.log("PrivateFRP Agent started successfully");
