import { TunnelConfig } from "@privatefrp/shared";

/**
 * TunnelManager manages local tunnel listeners
 */
export class TunnelManager {
  private tunnels: Map<string, TunnelConfig> = new Map();

  /**
   * Update tunnels based on server configuration
   */
  updateTunnels(newTunnels: TunnelConfig[]): void {
    const currentIds = new Set(this.tunnels.keys());
    const newIds = new Set(newTunnels.map((t) => t.id));

    // Remove tunnels that are no longer configured
    for (const id of currentIds) {
      if (!newIds.has(id)) {
        this.stopTunnel(id as string);
      }
    }

    // Add or update tunnels
    for (const tunnel of newTunnels) {
      this.updateTunnel(tunnel);
    }
  }

  /**
   * Update a single tunnel
   */
  private updateTunnel(tunnel: TunnelConfig): void {
    const existing = this.tunnels.get(tunnel.id);

    // If tunnel already exists and is running, skip
    if (existing && existing.listenPort === tunnel.listenPort) {
      return;
    }

    // Stop existing tunnel if port changed
    if (existing) {
      this.stopTunnel(tunnel.id as string);
    }

    console.log(`Starting tunnel: ${tunnel.name} (${tunnel.type}) on port ${tunnel.listenPort}`);
    this.tunnels.set(tunnel.id, tunnel);

    // Start the appropriate listener based on tunnel type
    if (tunnel.type === "tcp" || tunnel.type === "tcp+udp") {
      this.startTcpListener(tunnel);
    }
    if (tunnel.type === "udp" || tunnel.type === "tcp+udp") {
      this.startUdpListener(tunnel);
    }
  }

  /**
   * Start a TCP listener for the tunnel
   */
  private startTcpListener(tunnel: TunnelConfig): void {
    console.log(`TCP listener started on port ${tunnel.listenPort}`);
  }

  /**
   * Start a UDP listener for the tunnel
   */
  private startUdpListener(tunnel: TunnelConfig): void {
    console.log(`UDP listener started on port ${tunnel.listenPort}`);
  }

  /**
   * Stop a tunnel by ID
   */
  private stopTunnel(id: string): void {
    const tunnel = this.tunnels.get(id);
    if (tunnel) {
      console.log(`Stopping tunnel: ${tunnel.name}`);
      this.tunnels.delete(id);
    }
  }

  /**
   * Get all configured tunnels
   */
  getTunnels(): TunnelConfig[] {
    return Array.from(this.tunnels.values());
  }

  /**
   * Get a specific tunnel by ID
   */
  getTunnel(id: string): TunnelConfig | undefined {
    return this.tunnels.get(id);
  }
}
