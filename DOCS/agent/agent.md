`packages/agent/src/agent.ts` — core Agent runtime: TLS control connection, pre-warmed pool, multiplexed StreamOpen/StreamData/StreamClose handling, and TCP/UDP proxying.

Top-level helpers/constants:
- `parsePositiveIntEnv(name: string, fallback: number): number` — parse positive integer env var.
- `POOL_SIZE` — number of pre-warmed data connections (env `AGENT_POOL_SIZE`).

Class `Agent` (selected methods):
- `constructor(config: AgentConfig)` — `AgentConfig = { serverHost, serverPort, agentId, agentSecret, tlsRejectUnauthorized }`.
- `start(): void` — begin connect/reconnect lifecycle.
- `stop(): void` — stop reconnects, close pools and streams, destroy connections.
- `connect(): void` — establish TLS control socket, authenticate (AgentHello/ServerHello), install `FrameDecoder` and frame handlers.
- `isActiveControlSocket(socket, generation): boolean` — internal guard to ignore stale sockets.
- `handleControlDisconnect(reason: string): void` — cleanup on control disconnect and schedule reconnect.
- `startHeartbeat(socket): void` — send Heartbeat frames periodically (500ms) and manage interval.
- `writeControlFrame(msgType: number, body: Record<string, unknown>): boolean` — encode and write a framed control message; returns `socket.write()` boolean for flow-control.

Stream/topic handlers:
- `handleStreamOpen(body: StreamOpenBody): void` — on `StreamOpen` open local TCP (`net.createConnection`) or UDP socket for the stream and hook data/close; encodes outgoing payloads to `StreamData`.
- `handleStreamData(body: StreamDataBody): void` — decode base64 payload and write into target socket (TCP/UDP).
- `closeStream(streamId: string, reason: string, notifyServer: boolean): void` — close a single stream and optionally notify server with `StreamClose`.
- `closeAllStreams(notifyServer: boolean, reason: string): void` — close all active streams.

Pool and fallback dial:
- `maintainPool(): void` — ensure `POOL_SIZE` pre-warmed TLS data connections.
- `openPoolConnection(): void` — open a pooled TLS connection, send `PoolHello`, wait for a `DialAssign`, then transition to raw pipe mode and call `connectToTarget()`.
- `connectToTarget(dataConn, targetHost, targetPort, requestId): void` — establish `net` connection to local target and `pipe()` the data connection and target socket (raw byte pipe).
- `handleDialTcp(body: DialTcpBody): void` — slow-path DialTcp: open dedicated data connection then `connectToTarget`.
- `handleDialUdpSession(body: DialUdpSessionBody): void` — establish UDP session over new data connection and relay `UdpData` frames.

Flow-control notes:
- `writeControlFrame` is used by data paths; callers observe its boolean return to `pause()`/`resume()` sources to prevent unbounded buffering.
Agent package — persistent TLS control socket and per-stream proxies.

Key file: `src/agent.ts`

Important functions:
- `handleStreamOpen(body)`: body = `{streamId,tunnelId,kind,peerAddr?}` — opens local TCP/UDP target for stream.
- `handleStreamData(body)`: decodes base64 `payload` and writes to target; pauses control socket if `write()` backpressures.
- `writeControlFrame(msgType, body)`: writes framed message to control socket; returns boolean `write()` result for flow-control.
