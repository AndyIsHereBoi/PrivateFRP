`packages/server/src/server.ts` — main server class: TLS listener, connection classification (control vs data vs pool), agent registration, heartbeat, and dashboard integration.

Class `Server` (selected methods):
- `constructor(config: ServerConfig, db: DB)` — inject DB and configuration.
- `start(): Promise<void>` — load tunnels, start TLS server, and start dashboard HTTP/WebSocket service (`startDashboard`).
- `reloadTunnels(): Promise<void>` — read DB tunnels, compute assigned tunnels, call `tunnelManager.syncTunnels()` and push `ConfigPush` to connected agents.
- `startTlsServer(): Promise<void>` — create TLS server with configured cert/key and accept connections.
- `handleIncomingConnection(socket: tls.TLSSocket): void` — use `FrameDecoder` to peek first frame and classify connection as `AgentHello` (control), `DataConnHello` (data), or `PoolHello` (pool socket), then dispatch.
- `handleControlConnection(socket, decoder, hello: AgentHelloBody): void` — authenticate agent, send `ServerHello`, register agent in `AgentManager`, set up frame handlers, and manage heartbeat echo and decoder error handling.
- `handleDataConnection(socket, hello: DataConnHelloBody): void` — resolve pending dial via `agentManager.fulfillDial()`.

Resilience:
- `shouldLogProbeNoise(remoteAddress)` — rate-limited logging to avoid scanner noise spam.
Server package — accepts agent control connections, manages listeners, routes frames, and serves the dashboard.

Key files: `src/server.ts`, `src/tunnelManager.ts`

Important functions:
- `handleAgentStreamData(agentId, body)`: decodes base64 `payload` and writes to client socket; pauses agent socket if client `write()` backpressures.
- `startTcpListener(tunnel)`: binds listen port; on client connect sends `StreamOpen` to agent and wires client socket.
- `handleUdpMessage(tunnel, udpSock, sessions, peerAddr, msg)`: maps `peerAddr`→`streamId`, refreshes idle timer, sends `StreamData` frames.
