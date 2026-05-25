# PrivateFRP — Product Requirements Document

> **Version:** 3.0  
> **Runtime:** Bun (TypeScript, no compilation step)  
> **License:** Private / Proprietary

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [High-Level Architecture](#2-high-level-architecture)
3. [Core Components](#3-core-components)
4. [Protocol Definition](#4-protocol-definition)
5. [Connection Lifecycle](#5-connection-lifecycle)
6. [Data Plane](#6-data-plane)
7. [Control Plane](#7-control-plane)
8. [Tunnel Types & Establishment](#8-tunnel-types--establishment)
9. [Dashboard & Frontend](#9-dashboard--frontend)
10. [Database Schema](#10-database-schema)
11. [Configuration & Environment](#11-configuration--environment)
12. [Security Model](#12-security-model)
13. [Deployment & Operations](#13-deployment--operations)
14. [Deployment Destinations](#14-deployment-destinations)
15. [Key Design Principles](#15-key-design-principles)

---

## 1. Executive Summary

PrivateFRP is a high-performance, low-latency reverse proxy and tunneling solution that exposes local services running on private networks to the public internet. It enables users to securely access services such as web servers, game servers (Minecraft, BeamNG.drive), databases, and any other TCP/UDP application without requiring port forwarding, static DNS records, or public IP addresses at the edge.

The system uses a **client–server (agent–server) architecture**. Lightweight agents run on the machines hosting local services. A central server (the public-facing endpoint) coordinates connections between external clients and these agents. All control-plane communication is TLS-encrypted; tunnel data flows over dedicated per-stream TCP connections.

**Target use cases:**
- Hosting game servers from a home network
- Exposing development/preview environments
- Providing remote access to internal tools (databases, SSH, APIs)
- Sharing services across NAT/firewall boundaries without VPN complexity

---

## 2. High-Level Architecture

```
┌──────────────────────┐       ┌──────────────────────────────────┐       ┌─────────────────────┐
│   External Client    │──────▶│         PrivateFRP Server        │──────▶│  PrivateFRP Agent   │
│  (browser, curl,     │       │                                  │       │                     │
│   game client)       │       │  ┌──────────┐  ┌──────────────┐  │       │  ┌───────────────┐  │
│                      │       │  │  Control  │  │   Data       │  │       │  │  Control      │  │
│                      │       │  │  Plane    │  │   Listener   │  │       │  │  Client       │  │
│                      │       │  │  (TLS)    │  │   (Raw TCP)  │  │       │  │               │  │
│                      │       │  │  :7000    │  │   :7001      │  │       │  │               │  │
│                      │       │  └─────┬─────┘  └──────┬───────┘  │       │  └───────┬───────┘  │
│                      │       │        │               │          │       │          │          │
│                      │       │  ┌─────▼─────────────────▼──────┐  │       │  ┌───────▼───────┐  │
│                      │       │  │        ServerStore (SQLite)  │  │       │  │  Local TCP    │  │
│                      │       │  └──────────────────────────────┘  │       │  │  Connectors   │  │
│                      │       │                                    │       │  └───────────────┘  │
│                      │       │  ┌──────────────────────────────┐  │       │                     │
│                      │       │  │     Dashboard (HTTP/WS)      │  │       │  ┌───────────────┐  │
│                      │       │  │     :8080                    │  │       │  │  Local UDP    │  │
│                      │       │  └──────────────────────────────┘│       │  │  Sessions     │  │
│                      │       └──────────────────────────────────┘       │  └───────────────┘  │
│                                                                         └─────────────────────┘
│                                                                                  │
│                                                                         ┌───────▼───────┐
│                                                                         │  Local Service │
│                                                                         │  (HTTP server, │
│                                                                         │   game server, │
│                                                                         │   SSH, etc.)   │
│                                                                         └───────────────┘
```

### 2.1 High-Level Flow Summary

1. **Agent connects** to the server on the control port (7000, TLS) and authenticates with ID/secret.
2. **Server pushes** tunnel configurations to the agent via the control channel.
3. **Agent starts** listening for instructions and opening data connections as needed.
4. **External client connects** to a tunnel's public port on the server.
5. **Server sends a `DIAL_TCP`** command to the agent over the control channel.
6. **Agent opens a data socket** back to the server's data port (7001), sending a stream ID header.
7. **Agent connects to the local service** and pipes: data socket ⇄ local socket.
8. **Server links** the agent data socket to the external client's socket — raw TCP bytes flow bidirectionally with no application-level framing.

### 2.2 Technology Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Runtime | **Bun** | Fast startup, TypeScript-native runtime, built-in bundler, SQLite, TLS |
| Language | **TypeScript** (strict mode) | Type safety across monorepo packages |
| Database | **SQLite** (via `bun:sqlite`) | Zero-dependency, WAL mode, embedded |
| Control protocol | **JSON-framed messages** over TLS | 4-byte length prefix + JSON envelope |
| Data plane | **Raw TCP byte streams** | Zero overhead per-stream, kernel-level flow control |
| Dashboard | **Vanilla HTML/CSS/JS** + Bun.serve + WebSocket | No framework dependencies |
| Authentication | **bcrypt-style hash** + session cookie | Agent auth uses hashed secrets; dashboard uses cookie |
| Containerization | **Docker** (oven/bun base image) | Official Bun runtime image |

---

## 3. Core Components

### 3.1 Shared Package (`@privatefrp/shared`)

A TypeScript library with no runtime dependencies that both server and agent import. Contains all shared constants, types, frame encoding/decoding, and utility functions.

**Sub-modules:**

| Module | Responsibility |
|--------|---------------|
| `constants.ts` | `FRAME_TYPES` enum, default port/interval constants, cookie names |
| `types.ts` | All TypeScript interfaces: `Frame`, `TunnelRecord`, `AgentRecord`, `AgentConfig`, frame payload types, `DashboardWsRequest`, `DashboardWsResponse` |
| `frame.ts` | `encodeFrame()` — wraps a frame as JSON with 4-byte big-endian length prefix. `FrameParser` — accumulates chunks and yields parsed frames. |
| `config.ts` | `readServerRuntimeConfig(env)` — parses server env vars into a typed config. `readAgentRuntimeConfig(env)` — parses agent env vars. |
| `utils/env.ts` | Typed env-read helpers: `readString`, `readBool`, `readInt`, `readJson`. |
| `utils/crypto.ts` | `hashSecret()`, `secretsMatch()` — credential hashing. `randomId()`, `randomSecret()` — ID/secret generation. |

### 3.2 Server (`@privatefrp/server`)

The public-facing central coordination point. Accepts agent control connections (TLS), external client connections (raw TCP), and serves the dashboard (HTTP + WebSocket).

**Key classes:**

| Class | File | Responsibility |
|-------|------|---------------|
| `ControlPlane` | `control.ts` | All tunnel management: agent connections, TCP/UDP listeners, stream routing, config push, data socket management |
| `ServerStore` | `store.ts` | SQLite database wrapper: agents CRUD, tunnels CRUD, authentication |
| `DashboardServer` | `dashboard.ts` | HTTP server + REST API + WebSocket live updates for the web UI |
| `main()` | `index.ts` | Entry point; reads config, initializes TLS certs (auto-generates self-signed if missing), starts ControlPlane and DashboardServer |

**Ports exposed by the server:**

| Port | Purpose | Protocol | TLS |
|------|---------|----------|-----|
| `AGENT_PORT` (default 7000) | Agent control connections | Framed JSON over TCP | Yes |
| `DATA_PORT` (default 7001) | Per-stream raw data sockets | Raw TCP byte streams | No |
| `DASHBOARD_PORT` (default 8080) | Web dashboard + REST API | HTTP + WebSocket | No (separate TLS if behind reverse proxy) |

### 3.3 Agent (`@privatefrp/agent`)

The lightweight client that runs on the machine hosting the local services. Maintains a persistent control connection to the server and opens per-stream data connections on demand.

**Key class:**

| Class | File | Responsibility |
|-------|------|---------------|
| `AgentClient` | `client.ts` | Control connection with reconnect loop, TOFU certificate verification, frame handler, `openLocalTcpStream()` data pipe establishment, UDP session management, graceful shutdown |

**TOFU (Trust On First Use):**
The agent pins the server's TLS certificate fingerprint on first successful connection. On subsequent connections, it verifies the fingerprint matches the saved value. The trust store is a JSON file at `{DATA_DIR}/trusted-server-cert.json`.

### 3.4 Dashboard Web Frontend

A zero-dependency single-page application served by the server's HTTP handler. Three HTML pages with shared CSS/JS:

| Page | Purpose |
|------|---------|
| `login.html` | Authentication form (username/password) |
| `agents.html` | Agent list, status, latency, register new agents |
| `tunnels.html` | Tunnel list, CRUD operations, enable/disable |

**Communication pattern:**
- Initial page load via HTTP GET
- REST API calls (`/api/*`) for CRUD operations
- WebSocket (`/ws/dashboard`) for real-time push updates

---

## 4. Protocol Definition

### 4.1 Control Frame Format

All control frames share a fixed wire format:

```
┌─────────────────────────────────────────────────┐
│ 4 bytes: Payload Length (big-endian uint32)     │
├─────────────────────────────────────────────────┤
│ N bytes: JSON object (UTF-8 encoded)            │
│ {                                               │
│   "v": 1,           // protocol version         │
│   "type": "...",    // FRAME_TYPE string        │
│   "reqId": "...",   // optional request ID      │
│   "streamId": "...",// optional stream ID       │
│   "payload": {...}  // optional typed payload   │
│ }                                               │
└─────────────────────────────────────────────────┘
```

### 4.2 Frame Types

| Frame Type | Direction | Purpose | Payload |
|-----------|-----------|---------|---------|
| `AgentHello` | Agent → Server | Authentication on connect | `{ agentId, agentSecret, agentName?, protocolVersion }` |
| `ServerHello` | Server → Agent | Authentication response | `{ serverTime, agentName }` |
| `Heartbeat` | Bidirectional | Liveness + latency measurement | `{ timestamp }` |
| `ConfigPush` | Server → Agent | Tunnel config update | `{ id, name, enabled, tunnels[] }` |
| `ConfigAck` | Agent → Server | Config receipt confirmation | `{ receivedAt }` |
| `DialTcp` | Server → Agent | Instruct agent to open a TCP stream | `{ streamId, tunnelId, clientAddress }` |
| `DialUdpSession` | Server → Agent | Instruct agent to start UDP session | `{ sessionId, tunnelId, peerAddress, peerPort, targetHost, targetPort }` |
| `StreamClose` | Server → Agent | Terminate a stream | `{ streamId, reason? }` |
| `UdpData` | Server → Agent | UDP payload for a session | `{ sessionId, data (base64), peerAddress?, peerPort? }` |
| `Error` | Either | Error notification | `{ message }` |

### 4.3 Data Plane Protocol (Per-Stream Raw TCP)

The data plane uses **separate TCP connections** — one per active tunnel stream — between the agent and the server's `DATA_PORT`. There is no multiplexing or framing beyond the initial stream-ID handshake:

```
Agent opens TCP → Server DATA_PORT
Agent sends immediately:
  ┌──────────────────────────────────────────────┐
  │ 2 bytes: streamId length (big-endian uint16) │
  │ N bytes: streamId string (UTF-8)             │
  └──────────────────────────────────────────────┘
After header: raw bidirectional byte stream (no application framing)
```

This design ensures:
- Zero per-byte overhead during data transfer
- Kernel-level TCP flow control per stream
- No head-of-line blocking between streams
- No base64 inflation or JSON parsing on the hot path

---

## 5. Connection Lifecycle

### 5.1 Agent → Server Control Connection

```
┌──────────┐                    ┌──────────┐
│  Agent   │                    │  Server  │
└────┬─────┘                    └────┬─────┘
     │                               │
     │  1. TCP connect :7000         │
     │  (TLS handshake, TOFU verify) │
     │──────────────────────────────▶│
     │                               │
     │  2. AgentHello                │
     │  {agentId, agentSecret, ...}  │
     │──────────────────────────────▶│
     │                               │
     │  3. ServerHello               │
     │  {serverTime, agentName}      │
     │◀──────────────────────────────│
     │                               │
     │  4. ConfigPush                │
     │  {tunnels: [...]}             │
     │◀──────────────────────────────│
     │                               │
     │  5. ConfigAck                 │
     │──────────────────────────────▶│
     │                               │
     │  ◀══ Heartbeat (5s) ═══▶     │
     │                               │
```

### 5.2 Reconnection

- Agent detects disconnection via socket `close` event or heartbeat timeout.
- Backoff: starts at `AGENT_RECONNECT_MS` (default 1s) and doubles up to 15s.
- On reconnect: re-authenticates, receives updated ConfigPush, resumes normal operation.
- All in-flight streams are cleaned up on disconnect before reconnect.

### 5.3 External Client → Tunnel Connection

```
External Client    PrivateFRP Server         PrivateFRP Agent        Local Service
      │                   │                        │                     │
      │ 1. TCP connect    │                        │                     │
      │   :listenPort     │                        │                     │
      │──────────────────▶│                        │                     │
      │                   │ 2. Pause client         │                     │
      │                   │ 3. DialTcp (control)   │                     │
      │                   │───────────────────────▶│                     │
      │                   │                        │ 4. TCP connect      │
      │                   │                        │   :DATA_PORT        │
      │                   │◀───────────────────────│                     │
      │                   │                        │ 5. streamId header  │
      │                   │◀───────────────────────│                     │
      │                   │ 6. Link dataSocket     │                     │
      │                   │ 7. Resume client        │                     │
      │                   │                        │ 8. TCP connect      │
      │                   │                        │   :targetPort      │
      │                   │                        │────────────────────▶│
      │                   │                        │◀────────────────────│
      │                   │                        │ 9. Pipe active      │
      │  ◀══════════════════════ Raw TCP pipe ════════════════════▶     │
```

### 5.4 Stream Teardown

- Agent detects local socket `close` → closes data socket → server detects data socket `close` → closes external client socket → cleans up stream state.
- Server detects external client socket `close` → sends `StreamClose` to agent → agent closes local socket → cleans up stream state.
- Agent disconnection → server closes all streams associated with that agent.

---

## 6. Data Plane

### 6.1 Architecture

The data plane is intentionally minimal:

```
┌────────────┐    write()     ┌────────────┐    write()     ┌────────────┐
│  External  │───────────────▶│   Server   │───────────────▶│   Agent    │
│  Client    │                │  (relay)   │                │   (relay)  │
│  Socket    │◀───────────────│            │◀───────────────│            │
└────────────┘    write()     └────────────┘    write()     └────────────┘
                                                              │
                                                         write()
                                                              │
                                                              ▼
                                                      ┌────────────┐
                                                      │   Local    │
                                                      │  Service   │
                                                      └────────────┘
```

- Each `write()` is handed to Bun's internal buffering — no application-level partial-write tracking.
- TCP flow control propagates naturally: if the external client is slow, the server stops reading from the agent's data socket, the agent stops reading from the local service, and the local service's TCP send buffer fills up, causing it to slow down. This chain works without any application-level pause/resume logic.

### 6.2 Pre-Connection Buffering

The only application buffering is during the brief window between the data socket connecting and the local service connecting:

- Data from server → agent that arrives before the local socket is linked is accumulated in a single growing `Uint8Array` on the agent data socket (`__pendingBuf`).
- When the local socket opens, the buffer is flushed with a single `writeSocket(ls, buffer)` call.

This handles the case where the external client sends data (e.g., an HTTP request) before the agent has finished connecting to the local service.

### 6.3 TLS Policy

| Path | TLS | Rationale |
|------|-----|-----------|
| Agent → Server control | **Yes** | Authentication + command secrecy |
| Agent → Server data | **No** | Performance; runs on same private link as control |
| External client → Server tunnel | **No** | Server is the TLS termination point if needed |
| Dashboard | **No** | Meant for reverse-proxy TLS (Caddy/nginx) |

### 6.4 Nagle Algorithm

Controlled by `DATA_TCP_NODELAY` env var:
- `false` (default) — Nagle enabled, lower CPU, better bulk throughput.
- `true` — `TCP_NODELAY` set on all data sockets, lower latency for interactive protocols (WebSockets, game servers).

---

## 7. Control Plane

### 7.1 Agent Connection State

For each connected agent, the server maintains:

| Field | Type | Purpose |
|-------|------|---------|
| `socket` | Bun.Socket | The control socket |
| `parser` | FrameParser | Frame accumulator for this socket |
| `agentId` | string | Unique agent ID |
| `agentName` | string | Human-readable name |
| `remoteAddress` | string \| null | Agent's IP |
| `connectedAt` | number | Unix ms |
| `lastHeartbeat` | number | Unix ms |
| `lastLatency` | number \| null | Most recent RTT |
| `pendingWrites` | Uint8Array[] | Queue for control frames during backpressure |
| `pendingBytes` | number | Total bytes queued |

### 7.2 Backpressure (Control Frames Only)

Control frames use a bounded pending queue (max 512 KiB) to handle slow agent control sockets while preserving frame ordering. The `drain` callback on the control socket flushes the queue. If the queue exceeds the threshold, a warning is logged but no data is dropped.

### 7.3 Config Push Mechanism

When a tunnel is created, updated, deleted, or when an agent is enabled/disabled:
1. The change is persisted to SQLite via `ServerStore`.
2. `refreshTunnelListeners()` is called — starts/stops TCP/UDP listeners on the server for affected tunnels.
3. `pushConfigToAllAgents()` is called — sends a `ConfigPush` frame to every connected agent.
4. Each agent acknowledges with `ConfigAck`.
5. `broadcastDashboard()` is called — pushes a live update to WebSocket-connected dashboard clients.

### 7.4 Heartbeat

- Agent sends `Heartbeat` every 5 seconds with a client timestamp.
- Server records `lastHeartbeat` and calculates `latency = now - clientTimestamp`.
- Dashboard shows latency in real-time.
- If heartbeats stop, the agent's socket `close` callback fires, triggering `closeAgentConnection()`.

---

## 8. Tunnel Types & Establishment

### 8.1 TCP Tunnels

**Establishment:**
1. External client connects to server on `listenPort`.
2. `onTcpClientOpen()`: validates agent is connected, assigns a `streamId`, pauses the client socket, sends `DialTcp` to agent.
3. Agent receives `DialTcp`, calls `openLocalTcpStream()`.
4. Agent opens a data socket to server's `DATA_PORT`, sends `streamId` header.
5. Server receives data socket connection, parses `streamId`, links `dataSocket` to the client stream state, resumes the client socket.
6. Agent connects to `targetHost:targetPort` and links local socket ↔ data socket.
7. Raw bytes flow bidirectionally until either side closes.

**Stream ID format:** `{tunnelId}:{timestamp}:{random}` — unique per tunnel connection.

### 8.2 UDP Tunnels

**Establishment:**
1. Server creates a `dgram` UDP socket on `listenPort`.
2. On first packet from an external peer, creates a `UdpSessionState` and sends `DialUdpSession` to the agent.
3. Agent creates a local UDP socket, binds to an ephemeral port, and starts forwarding:
   - Agent → Server: wraps UDP datagrams in `UdpData` frames (base64-encoded) over the control channel.
   - Server → Agent: unwraps `UdpData` and resends as raw UDP to the external peer.
4. Session mapping is maintained per `{peerAddress}:{peerPort}`.

### 8.3 Combined TCP+UDP Tunnels

Creates both a TCP listener and a UDP listener on the same `listenPort`. Used for protocols that require both transports (e.g., some game servers).

### 8.4 Tunnel Configuration Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Auto-generated unique ID (`tun_xxx`) |
| `name` | string | Human-readable label |
| `type` | "tcp" \| "udp" \| "tcp+udp" | Transport protocol |
| `listenPort` | number | Public port on the server |
| `targetHost` | string | Local host (agent side) to forward to |
| `targetPort` | number | Local port (agent side) to forward to |
| `agentId` | string \| null | Assigned agent |
| `enabled` | boolean | Whether the tunnel is active |
| `createdAt` | number | Unix ms timestamp |

---

## 9. Dashboard & Frontend

### 9.1 Pages

#### Login (`/login`)
- Username/password form (POST).
- Sets a session cookie (`privatefrp_dashboard_session`) on success.
- Credentials configured via `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` env vars.

#### Agents (`/agents.html`)
- Table with columns: ID, Name, Status (Connected/Offline/Disabled), Latency, Current Connections, IP Address, Last Heartbeat, Actions.
- Action buttons per agent: Enable/Disable, Delete.
- "Register Agent" button → modal dialog for generating new agent credentials.
- Auto-refresh every 1 second via WebSocket-driven `refreshAgents()`.
- Renders only when data changes (render-key comparison to avoid unnecessary DOM updates).

#### Tunnels (`/tunnels.html`)
- Table with columns: Name, Type, Listen Port, Target, Agent, Status (Enabled/Disabled), Actions.
- Action buttons per tunnel: Enable/Disable, Edit (inline modal), Delete.
- "Create Tunnel" button → modal dialog with form fields (all configurable tunnel parameters).
- Auto-refresh every 1 second.
- "Assign Agent" dropdown populated from connected agent list.

### 9.2 REST API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/agents` | List all agents with status |
| POST | `/api/agents/register?name=...` | Create new agent credentials |
| POST | `/api/agents/{id}/enabled` | Toggle agent enabled state |
| POST | `/api/agents/{id}/delete` | Remove agent |
| GET | `/api/tunnels` | List all tunnels |
| POST | `/api/tunnels` | Create tunnel |
| PATCH | `/api/tunnels/{id}` | Update tunnel fields |
| POST | `/api/tunnels/{id}/enabled` | Toggle tunnel enabled state |
| POST | `/api/tunnels/{id}/delete` | Delete tunnel |
| DELETE | `/api/tunnels/{id}` | Delete tunnel |

All API endpoints (except login) require the session cookie.

### 9.3 WebSocket (`/ws/dashboard`)

Two-way JSON-message protocol for live updates:

**Client → Server request:**
```json
{ "reqId": "abc123", "type": "agents", "payload": {} }
// type can be: "agents", "tunnels", "status"
```

**Server → Client response:**
```json
{ "reqId": "abc123", "ok": true, "data": [...] }
```

**Server broadcast (on tunnel/agent change):**
```json
{ "reqId": "broadcast", "ok": true, "data": { "refreshedAt": 1234567890 } }
```

The client's `refreshAgents()` / `refreshTunnels()` functions detect broadcasts and re-fetch via the REST API (not via WebSocket data), ensuring data consistency.

### 9.4 Shared Frontend Code (`common.js`)

| Function | Purpose |
|----------|---------|
| `esc(str)` | HTML-escape a string |
| `window.showToast(msg)` | Display a temporary notification |
| `window.dashboardWsRequest(type, payload)` | Send a WS request and return a promise for the response |
| `window.copyToClipboard(text)` | Copy text helper |

### 9.5 Styling (`styles.css`)

Dark theme with:
- Color-coded badges (green=connected, gray=offline/disabled, red=danger)
- Modal overlay system
- Toast notifications (top-right)
- Responsive table layout
- Card components for supplementary actions

---

## 10. Database Schema

### 10.1 Technology

- **Engine:** SQLite via `bun:sqlite`.
- **Journal mode:** WAL (Write-Ahead Logging) for concurrent read performance.
- **Location:** `{DATA_DIR}/privatefrp.sqlite`.
- **Initialization:** Tables auto-created on first start via `CREATE TABLE IF NOT EXISTS`.

### 10.2 `agents` Table

```sql
CREATE TABLE agents (
  id               TEXT PRIMARY KEY,          -- "agt_" + random alphanumeric
  name             TEXT NOT NULL,             -- human-readable name
  secret_hash      TEXT NOT NULL,             -- hashed (salted) secret
  enabled          INTEGER NOT NULL DEFAULT 1,-- 1=active, 0=disabled
  created_at       INTEGER NOT NULL,          -- Unix timestamp ms
  last_heartbeat   INTEGER,                   -- Unix timestamp ms
  latency_ms       INTEGER,                   -- Most recent RTT in ms
  remote_address   TEXT,                      -- IP address from last connection
  active_connections INTEGER NOT NULL DEFAULT 0
);
```

### 10.3 `tunnels` Table

```sql
CREATE TABLE tunnels (
  id               TEXT PRIMARY KEY,          -- "tun_" + random alphanumeric
  name             TEXT NOT NULL,             -- human-readable name
  type             TEXT NOT NULL,             -- "tcp", "udp", or "tcp+udp"
  listen_port      INTEGER NOT NULL,          -- public facing port on server
  target_host      TEXT NOT NULL,             -- agent-side target host
  target_port      INTEGER NOT NULL,          -- agent-side target port
  agent_id         TEXT,                      -- FK → agents.id (nullable)
  enabled          INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL
);
```

### 10.4 Queries

The `ServerStore` class exposes these operations:

- `listAgents()` — all agents, ordered by creation date
- `getAgent(id)` — single agent by ID
- `createAgent(name)` — insert new agent; returns generated ID + raw secret
- `updateAgent(id, patch)` — update name/enabled
- `deleteAgent(id)` — remove agent and unassign its tunnels
- `authenticateAgent(id, secret)` — verify credentials and enabled status
- `touchAgent(id, heartbeatAt, latencyMs, remoteAddress)` — update liveness
- `setAgentConnections(id, count)` — update active connection count
- `listTunnels()` — all tunnels, ordered by creation date
- `getTunnel(id)` — single tunnel by ID
- `createTunnel(input)` — insert new tunnel
- `updateTunnel(id, patch)` — update any mutable field
- `deleteTunnel(id)` — remove tunnel
- `setTunnelEnabled(id, enabled)` — toggle enabled state
- `listTunnelsForAgent(agentId)` — enabled tunnels assigned to a specific agent (for ConfigPush)

---

## 11. Configuration & Environment

### 11.1 Server Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVER_HOST` | `0.0.0.0` | Bind address |
| `AGENT_PORT` | `7000` | Agent control listener port (TLS) |
| `DATA_PORT` | `AGENT_PORT + 1` | Agent data socket listener port |
| `DASHBOARD_PORT` | `8080` | Dashboard HTTP port |
| `PUBLIC_HOST` | `0.0.0.0` | Public tunnel listener bind address |
| `DATA_DIR` | `data` | Data directory (certs, database, etc.) |
| `DASHBOARD_USERNAME` | `admin` | Dashboard login username |
| `DASHBOARD_PASSWORD` | `admin` | Dashboard login password |
| `DASHBOARD_SESSION_SECRET` | `change-me-in-production` | Session cookie signing key |
| `DASHBOARD_PUBLIC_IP` | `""` | Public IP shown in dashboard (for client instructions) |
| `DATA_TCP_NODELAY` | `false` | Disable Nagle on data sockets (lower latency) |

### 11.2 Agent Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVER_HOST` | `127.0.0.1` | Server hostname/IP |
| `SERVER_PORT` | `7000` | Server control port |
| `DATA_PORT` | `SERVER_PORT + 1` | Server data port |
| `AGENT_ID` | `""` | Agent identifier (from dashboard registration) |
| `AGENT_SECRET` | `""` | Agent secret (from dashboard registration) |
| `AGENT_NAME` | `privatefrp-agent` | Display name |
| `AGENT_RECONNECT_MS` | `1000` | Initial reconnect delay |
| `DATA_DIR` | `data` | Agent data directory (trust store, etc.) |
| `DATA_TCP_NODELAY` | `false` | Disable Nagle on data+local sockets |

### 11.3 Data Directory Structure

```
{DATA_DIR}/                            # Mounted as Docker volume
├── privatefrp.sqlite                  # SQLite database (server only)
├── certs/                             # TLS certificates (server only)
│   ├── privatefrp.key                 # Auto-generated if missing
│   └── privatefrp.crt                 # Self-signed if not provided
└── trusted-server-cert.json           # Agent TOFU trust store (agent only)
```

### 11.4 Agent Trust Store (`trusted-server-cert.json`)

```json
{
  "serverFingerprint": "SHA256:...",
  "trustedAt": 1700000000000,
  "serverHost": "example.com:7000"
}
```

On first connection, the agent pins the SHA-256 fingerprint of the server's TLS certificate. On subsequent connections, it verifies the fingerprint matches. If mistmatch, the agent refuses to connect (security measure against MITM attacks).

---

## 12. Security Model

### 12.1 Agent Authentication

- Each agent is authenticated by **ID + secret pair**.
- Secret is generated once during dashboard registration and hashed before storage (SHA-256 with salt).
- Secret hash is compared using `secretsMatch()` (constant-time comparison).
- Agent sends credentials in `AgentHello` immediately after TLS handshake.
- Server rejects unauthenticated agents by sending an `Error` frame and closing the socket.

### 12.2 Dashboard Authentication

- Session-based authentication with a cookie (`privatefrp_dashboard_session`).
- Credentials configured via environment variables.
- Login form submits via POST; session cookie set on success.
- All API routes check cookie presence; unauthorized requests return 401.
- `/logout` clears the session cookie.

### 12.3 TLS Configuration

- Server auto-generates self-signed certificates on first start using the `selfsigned` npm module (or a built-in fallback).
- Certificate and key are stored in `{DATA_DIR}/certs/`.
- Custom certificates can be provided by placing `privatefrp.key` and `privatefrp.crt` in the certs directory before starting the server.
- Agent performs TOFU (Trust On First Use) pinning — saves and compares the server certificate SHA-256 fingerprint.
- Verification can be disabled by setting `NODE_TLS_REJECT_UNAUTHORIZED=0` (not recommended for production).

### 12.4 Agent Trust Boundaries

- Agents have full network access to target local services — they must run in a trusted environment.
- The server never directly connects to local services; it only relays through the agent.
- An agent's credentials and trust store are stored on the agent's filesystem — protect the `DATA_DIR`.

---

## 13. Deployment & Operations

### 13.1 Docker Deployment

#### Server

```yaml
services:
  privatefrp-server:
    image: ghcr.io/andyishereboi/privatefrp-server:latest
    network_mode: host
    env_file: ./server.env
    volumes:
      - ./data:/app/data
    restart: unless-stopped
```

#### Agent

```yaml
services:
  privatefrp-agent:
    image: ghcr.io/andyishereboi/privatefrp-agent:latest
    network_mode: host
    env_file: ./agent.env
    volumes:
      - ./data:/app/data
    restart: unless-stopped
```

`network_mode: host` is used because the agent connects to local services via localhost, and the server binds to well-known ports that must be reachable without port mapping.

### 13.2 Docker Image Build

Both server and agent use `oven/bun:latest` as the base image. Build artifacts are Docker layers — `bun install` runs during build, `bun run` starts the process at runtime. There is no TypeScript compilation step; TypeScript is executed directly by Bun.

### 13.3 CI/CD

GitHub Actions workflow:
1. On push/tag: build Docker images for server and agent.
2. Tag with `git short SHA` and release version.
3. Push to GitHub Container Registry (`ghcr.io/andyishereboi/privatefrp-{server,agent}:{tag}`).

### 13.4 Logging

- Console-based logging with colored prefixes:
  - `[agent]` — agent connection events
  - `[tunnel]` — external client connection events
  - `[data]` — data socket events
  - `[dashboard]` — web server events
  - `[tcp]` / `[udp]` — tunnel listener events
- No external logging library — `console.log` / `console.error` suffices for Bun's structured logging.

### 13.5 Monitoring

- Dashboard shows real-time agent status, latency, connection counts.
- Agent auto-reconnect with exponential backoff (1s → 2s → 4s → ... → 15s cap).
- No external monitoring integration (Prometheus, etc.) — can be added via the REST API.

---

## 14. Deployment Destinations

### 14.1 VPS (Virtual Private Server)

| Resource | Recommendation |
|----------|---------------|
| CPU | 2+ cores (handles encryption + socket I/O) |
| RAM | 1–4 GB (depends on concurrent tunnel count) |
| Network | Unmetered or high-bandwidth (server relays all traffic) |
| OS | Linux (x86_64 / aarch64) |
| Docker | Required for containerized deployment |

Typical hosting: Hetzner, DigitalOcean, Linode, AWS EC2, Oracle Cloud free tier.

### 14.2 Home Server / NAS

The agent is designed to run on low-power devices:
- Raspberry Pi 4/5 (aarch64)
- Intel NUC / Mini PC
- Synology/QNAP NAS (via Docker)
- Any machine behind NAT that can run Docker or Bun directly

### 14.3 Network Requirements

| Direction | Port | Requirement |
|-----------|------|-------------|
| Agent → Server | 7000 (TCP) | Outbound open (typically no firewall issue) |
| Agent → Server | 7001 (TCP) | Outbound open for data sockets |
| External → Server | Tunnel ports (TCP/UDP) | Inbound open on VPS |
| External → Server | 8080 (TCP) | Optional: inbound for dashboard |
| Server → Agent | None (agent-initiated) | No inbound rules needed |

---

## 15. Key Design Principles

### 15.1 Performance First

- **Data plane has zero per-byte overhead.** No framing, no JSON, no base64 on the hot path.
- **Per-stream data connections** eliminate head-of-line blocking.
- **Kernel-level TCP flow control** handles backpressure without application intervention.
- **Bun runtime** provides fast I/O, fast startup, and native TypeScript execution.
- **`TCP_NODELAY` configurable** to trade latency vs. CPU based on workload.

### 15.2 Security by Default

- **TLS for all control-plane communication** between agent and server.
- **TOFU certificate pinning** prevents MITM attacks without requiring a CA.
- **Agent authentication** with hashed ID/secret pairs.
- **Dashboard session authentication** with HttpOnly cookies.
- **Auto-generated self-signed certificates** for zero-config TLS.

### 15.3 Reliability

- **Automatic reconnection** with exponential backoff.
- **Heartbeat monitoring** for liveness detection.
- **Graceful shutdown** — cleans up all streams on SIGINT/SIGTERM.
- **SQLite persistence** — tunnel and agent state survives restarts.
- **Config push on change** — agents receive updated tunnel configs without restart.

### 15.4 Simplicity

- **Single binary** — no compilation step, no dependencies beyond Bun.
- **Environment-based configuration** — no YAML/JSON config files to manage.
- **No external databases** — SQLite is embedded.
- **No build step** — TypeScript runs directly in Bun.
- **Minimal frontend** — no SPA framework, just vanilla HTML/CSS/JS.
- **Docker ready** — single Dockerfile per component.

### 15.5 Extensibility

- **Modular monorepo** — shared types and utilities prevent code duplication.
- **Protocol is extensible** — new frame types can be added without breaking existing ones.
- **Multi-protocol tunnels** — TCP, UDP, and combined TCP+UDP.
- **REST API** enables programmatic management and third-party integrations.

### 15.6 Zero-Copy Philosophy

Where possible, data arrays received in socket callbacks are passed directly to the next socket via `write()` without copying. The only copying occurs during the brief pre-connection buffering window (agent data socket → local socket), and even that uses `Uint8Array` slicing/concatenation rather than expensive encoding steps.
