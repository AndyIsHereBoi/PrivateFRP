# PrivateFRP

A self-hosted, FRP-style TCP/UDP tunnel system written in TypeScript for Bun.
Expose local services through a remote server using encrypted TLS control channels
and a web-based management dashboard.

---

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.0 **or** [Docker](https://docs.docker.com/get-docker/) + Docker Compose
- OpenSSL (for generating TLS certificates — only needed for non-Docker local dev)

---

## Quick Start (Docker — recommended)

### 1. Clone the repository

```bash
git clone <repo-url>
cd PrivateFRP
```

### 2. Generate TLS certificates

```bash
bash scripts/generate-certs.sh
# Creates certs/server.crt and certs/server.key
```

### 3. Start the server

```bash
# Optional: copy the example env file and customise it first
cp .env.example .env
# then edit .env, e.g. set DASHBOARD_SECRET and PUBLIC_IP

DASHBOARD_SECRET=admin:changeme docker compose up -d
```

The dashboard is now available at **http://your-server-ip:8080**.

> Add any tunnel listen ports you need to `docker-compose.yml` under `ports:` before
> starting (e.g. `"25565:25565"` for a Minecraft server).

### 4. Register an agent

Open the dashboard, click **Register Agent**, give it a name and click **Generate**.
Copy the `AGENT_ID` and `AGENT_SECRET` — the secret is shown **only once**.

### 5. Start the agent (Docker)

On the machine whose services you want to expose, create a `.env.agent` file
(use `.env.agent.example` as a template):

```bash
SERVER_HOST=your-server-ip
SERVER_PORT=7000
AGENT_ID=<paste agent id>
AGENT_SECRET=<paste agent secret>
TLS_REJECT_UNAUTHORIZED=false   # required for self-signed certs
```

Then run:

```bash
docker compose -f docker-compose.agent.yml up -d
```

### 6. Create a tunnel

Use the **Create Tunnel** form on the dashboard, or via the API:

```bash
curl -X POST http://your-server-ip:8080/api/tunnels \
  -H 'Content-Type: application/json' \
  -b 'session=<your-session-cookie>' \
  -d '{
    "name": "web",
    "type": "tcp",
    "listenPort": 9090,
    "targetHost": "localhost",
    "targetPort": 3000,
    "agentId": "<agent-id>"
  }'
```

Traffic arriving on port `9090` of the **server** is now forwarded by the agent
to `localhost:3000` on the **agent** host.

---

## Quick Start (without Docker)

### 1. Clone and install dependencies

```bash
git clone <repo-url>
cd PrivateFRP
bun install
```

### 2. Generate TLS certificates

```bash
bash scripts/generate-certs.sh
```

### 3. Configure environment variables

**Server** (create `packages/server/.env` or export variables — see `packages/server/.env.example`):

```bash
AGENT_PORT=7000
DASHBOARD_PORT=8080
AGENT_TLS_CERT=../../certs/server.crt
AGENT_TLS_KEY=../../certs/server.key
DASHBOARD_SECRET=admin:changeme
DATA_DIR=./data
PUBLIC_IP=                          # optional: public IP shown in dashboard
```

**Agent** (create `packages/agent/.env` or export variables — see `packages/agent/.env.example`):

```bash
SERVER_HOST=<your-server-ip>
SERVER_PORT=7000
AGENT_ID=<uuid-from-dashboard>
AGENT_SECRET=<secret-from-dashboard>
TLS_REJECT_UNAUTHORIZED=false   # for self-signed certs in dev
```

### 4. Start the server

```bash
cd packages/server
bun run start
# Dashboard: http://localhost:8080
```

### 5. Register an agent and get credentials

Open `http://localhost:8080`, click **Register Agent**, enter a name, click **Generate**.

### 6. Start the agent

```bash
cd packages/agent
bun run start
```

---

## Managing Agents and Tunnels

- **Register Agent** — click *Register Agent* in the dashboard navbar, give it a name and click *Generate*. Copy both values immediately.
- **Delete Agent** — click the *Delete* button in the Agents table. All tunnels for that agent are also removed.
- **Create Tunnel** — fill in the *Create Tunnel* form at the bottom of the dashboard (or use the API).
- **Delete Tunnel** — click the *Delete* button in the Tunnels table row.

The dashboard auto-refreshes every **10 seconds** using background fetch requests; focused form inputs are never interrupted.

---

## Architecture

```
┌─────────────────────────┐          ┌──────────────────────────┐
│        SERVER           │          │         AGENT            │
│                         │          │                          │
│  ┌──────────────────┐   │   TLS    │   ┌──────────────────┐  │
│  │  Control Port    │◄──┼──────────┼───│  Control Conn    │  │
│  │  (AGENT_PORT)    │   │          │   │  AgentHello      │  │
│  │                  │   │          │   │  Heartbeat (5 s) │  │
│  │  AgentManager    │   │          │   └──────────────────┘  │
│  │  TunnelManager   │   │          │                          │
│  └──────────────────┘   │          │   ┌──────────────────┐  │
│                         │          │   │  Standby Pool    │  │
│  ┌──────────────────┐   │          │   │  (5 pre-warmed)  │  │
│  │  Tunnel Ports    │   │          │   └──────────────────┘  │
│  │  (TCP/UDP)       │   │          │                          │
│  └──────────────────┘   │          │   ┌──────────────────┐  │
│                         │          │   │  Data Conns      │  │
│  ┌──────────────────┐   │          │   │  (per dial)      │  │
│  │  Dashboard       │   │          │   └──────────────────┘  │
│  │  (HTTP)          │   │          │                          │
│  └──────────────────┘   │          │  Local Services         │
└─────────────────────────┘          │  (targetHost:targetPort) │
                                     └──────────────────────────┘

Data flow (TCP tunnel):
  External client → Server tunnel port → DialTcp msg → Agent → local service
                                      ← data connection ←

Data flow (UDP tunnel):
  External peer → Server UDP port → DialUdpSession → Agent → local UDP service
                                  ← UdpData frames ←→
```

### Packages

| Package | Description |
|---|---|
| `packages/shared` | Binary protocol framing, message types, `FrameDecoder` |
| `packages/server` | TLS server, agent manager, tunnel manager, SQLite DB, HTTP dashboard |
| `packages/agent` | TLS client, reconnect logic, TCP/UDP dial handling |

### Protocol

Each frame: `[4-byte big-endian length][1-byte msg type][JSON body]`

| Type | Value | Direction | Purpose |
|---|---|---|---|
| AgentHello | 0x01 | agent→server | Authentication |
| ServerHello | 0x02 | server→agent | Auth result + initial config |
| Heartbeat | 0x03 | both | Keep-alive (every 5 s) |
| ConfigPush | 0x04 | server→agent | Full tunnel config replacement |
| DialTcp | 0x05 | server→agent | Request new TCP data connection |
| DialUdpSession | 0x06 | server→agent | Request new UDP session |
| DataConnHello | 0x07 | agent→server | Identify a data connection |
| UdpData | 0x08 | both | UDP datagram payload (base64) |
| StandbyHello | 0x09 | agent→server | Offer a pre-warmed standby connection |
| AssignStandby | 0x0a | server→agent | Assign a standby connection to a request |

### Connection Pre-Pooling (FRP `pool_count` equivalent)

Inspired by [FRP's pool_count](https://github.com/fatedier/frp), the agent
pre-opens **5 standby TLS connections** to the server after authentication.
When an inbound TCP connection arrives, the server immediately uses an available
standby instead of waiting for a round-trip `DialTcp` → `DataConnHello` exchange.

This eliminates the TLS handshake overhead from the critical path of each new
connection, which is critical for workloads like Minecraft servers where 20+
players may connect simultaneously.

After each standby is consumed, the agent automatically opens a replacement to
keep the pool filled.

### Heartbeat / Keep-alive

Both the server and the agent send a `Heartbeat` frame every **5 seconds**.
This prevents NAT/firewall idle-connection timeouts from silently dropping the
control channel. The server records the timestamp of each received heartbeat to
track agent liveness on the dashboard.

### UDP Session Idle Timeout

UDP sessions (per external peer) are automatically cleaned up after **90 seconds**
of inactivity. This matches typical NAT mapping lifetimes and prevents resource
leaks from abandoned UDP senders.

---

## Development

```bash
# Run server with hot reload
bun run dev:server

# Run agent with hot reload
bun run dev:agent

# Build binaries
bun run build:server
bun run build:agent
```

---

## Docker Reference

### Server (`docker-compose.yml`)

| Variable | Default | Description |
|---|---|---|
| `AGENT_PORT` | `7000` | TLS port for agent connections |
| `DASHBOARD_PORT` | `8080` | HTTP port for the dashboard |
| `DASHBOARD_SECRET` | `admin:changeme` | Dashboard credentials `user:pass` |
| `AGENT_TLS_CERT` | `/app/certs/server.crt` | Path to TLS certificate |
| `AGENT_TLS_KEY` | `/app/certs/server.key` | Path to TLS private key |
| `DATA_DIR` | `/app/data` | Directory for the SQLite database |
| `PUBLIC_IP` | *(empty)* | Public IP shown in dashboard tunnel connection strings |

### Agent (`docker-compose.agent.yml`)

| Variable | Default | Description |
|---|---|---|
| `SERVER_HOST` | *(required)* | Public IP or hostname of the server |
| `SERVER_PORT` | `7000` | Agent TLS port on the server |
| `AGENT_ID` | *(required)* | Agent UUID from the dashboard |
| `AGENT_SECRET` | *(required)* | Agent secret from the dashboard |
| `TLS_REJECT_UNAUTHORIZED` | `true` | Set `false` for self-signed certificates |

---

## Summary Notes

- **Heartbeat keep-alive every 5 s** — both the server and agent send `Heartbeat` frames every 5 seconds (down from 30 s) to prevent NAT/firewall timeouts from dropping idle control connections.
- The heartbeat echo loop (both sides echoing every received heartbeat, creating an infinite ping-pong) was removed; each side now only sends its own independent interval heartbeat.
- The duplicate `socket.on("data")` listener on the server control channel (which caused every frame to be processed twice) was removed.
- Standby connections now capture the control-socket reference at creation time so that reconnect events can no longer trigger stale standbys to send `StandbyHello` before the new control connection is registered.

---

## License

MIT

