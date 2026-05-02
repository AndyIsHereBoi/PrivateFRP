`packages/server/src/tunnelManager.ts` — listener lifecycle, stream routing, UDP session mapping, and traffic accounting/flush logic.

Summary of responsibilities:
- Start/stop TCP, UDP, and TCP+UDP listeners per `TunnelConfig`.
- Map inbound client sockets to multiplexed `streamId`s and forward data frames to agents (and vice-versa).
- Track per-tunnel and per-IP traffic, periodically flush rollups to the DB.
- Handle UDP session idle timeouts and keep per-peer stream mapping.

Selected methods (class `TunnelManager`):
- `constructor(agentManager: AgentManager, db: DB)` — needs `AgentManager` and DB for traffic persistence.
- `syncTunnels(tunnels: TunnelConfig[]): Promise<void>` — align running listeners with desired tunnels (start/stop/restart as needed).
- `startListener(tunnel: TunnelConfig): Promise<void>` — create TCP, UDP, or both listeners for `tcp+udp`.
- `startTcpListener(tunnel): Promise<TcpListener>` — bind port and call `handleTcpConnection` on accept.
- `handleTcpConnection(tunnel, clientSocket): Promise<void>` — allocate `streamId`, check agent caps, send `StreamOpen` to agent, forward client `data` → `StreamData` (pauses client if agent socket backpressures), and handle client close/error.
- `startUdpListener(tunnel): Promise<UdpListener>` — bind UDP socket and forward `message` → `handleUdpMessage`.
- `handleUdpMessage(...)` — create per-peer `streamId` on demand, refresh idle timer, and send `StreamData` frames containing base64 payloads.
- `handleAgentStreamData(agentId, body: StreamDataBody): void` — called from `Server`; write decoded payload to client socket (pauses agent socket on backpressure) or `udp.send` for UDP.
- `handleAgentStreamClose(agentId, body: StreamCloseBody): void` — close per-stream sockets on agent-initiated close.
- `flushTrafficToDb(): void` — periodically aggregates pending bytes into DB `traffic_rollups` and updates totals.
- `clearTrafficData(): void` — clear in-memory and DB traffic tables.
- `stopListener(tunnelId, listener): Promise<void>` and `stopAll(): Promise<void>` — clean shutdown.

Flow-control:
- Writes to agent sockets and client sockets are observed; when `write()` returns false the source is paused and resumed on `drain` to avoid unbounded memory growth.
