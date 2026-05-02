`packages/server/src/db.ts` — SQLite-backed persistence layer: agents, tunnels, ip traffic, and traffic rollups.

Class `DB` (selected methods):
- `constructor(dataDir: string)` — open/create DB, apply schema and migrations.
- Agent ops: `getAgent(id)`, `listAgents()`, `createAgent(id,name,secret)`, `deleteAgent(id)`, `setAgentEnabled(id,enabled)`.
- Tunnel ops: `getTunnel(id)`, `listTunnels()`, `listTunnelsForAgent(agentId)`, `createTunnel(...)`, `updateTunnel(...)`, `deleteTunnel(id)`, `setTunnelEnabled(id,enabled)`, `rowToTunnelConfig(row)`.
- Traffic ops: `updateTunnelTrafficTotals(id,in,out)`, `getTunnelTrafficTotals(id)`, `upsertIpTrafficTotals(...)`, `getIpTrafficTotals(...)`, `addTrafficRollupBucket(bucketStart,tunnelId,remoteIp,inDelta,outDelta)`, `listTunnelTrafficWindow(since)`, `listIpTrafficWindow(since)`, `pruneTrafficRollups(beforeEpochSec)`, `clearTrafficData()`.

Notes:
- Uses WAL journal mode; migrations ensure added columns are present.
