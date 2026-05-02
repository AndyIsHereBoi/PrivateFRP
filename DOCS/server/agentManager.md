`packages/server/src/agentManager.ts` — track connected agents, pre-warmed pool sockets, pending dials, and active connection counts.

Selected API (class `AgentManager`):
- `register(agentId, socket, tunnels, remoteAddress): void` — accept new agent connection, replace previous connection if any.
- `unregister(agentId): void` — remove and destroy agent and its warm pool.
- `get(agentId): ConnectedAgent | undefined`, `getAll(): ConnectedAgent[]`.
- `updateHeartbeat(agentId)`, `updateLatency(agentId, latencyMs)` — heartbeat/latency bookkeeping.
- `incActiveConnections(agentId)`, `decActiveConnections(agentId)` — track active streams per agent.
- `addToPool(agentId, socket): void` — accept PoolHello sockets into `warmPool`.
- `dialTcp(agentId, requestId, tunnelId): Promise<Socket>` — get a pre-warmed pool socket (fast path) or send `DialTcp` and await a `DataConnHello` (slow path). May reject when `MAX_PENDING_DIALS` exceeded.
- `dialUdpSession(agentId, requestId, tunnelId, peerAddr): Promise<Socket>` — request a UDP session data connection.
- `fulfillDial(agentId, requestId, dataSocket): boolean` — resolve pending dial promise when `DataConnHello` arrives.
