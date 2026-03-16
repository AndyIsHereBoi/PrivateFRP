# PrivateFRP

A self-hosted, FRP-style TCP/UDP tunnel system written in TypeScript for Bun.
Expose local services through a remote server using encrypted TLS control channels
and a web-based management dashboard.

---

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.0
- OpenSSL (for generating dev TLS certificates)

---

## Quick Start

### 1. Clone and install dependencies

```bash
git clone <repo-url>
cd PrivateFRP
bun install
```

### 2. Generate dev TLS certificates

```bash
bash scripts/generate-certs.sh
# Creates certs/server.crt and certs/server.key
```

### 3. Configure environment

Create a `.env` file (or export variables):

```bash
# Server
AGENT_PORT=7000
DASHBOARD_PORT=8080
AGENT_TLS_CERT=./certs/server.crt
AGENT_TLS_KEY=./certs/server.key
DASHBOARD_SECRET=admin:changeme
DATA_DIR=./data
```

```bash
# Agent
SERVER_HOST=<your-server-ip>
SERVER_PORT=7000
AGENT_ID=<uuid-from-register>
AGENT_SECRET=<secret-from-register>
TLS_REJECT_UNAUTHORIZED=false   # for self-signed certs in dev
```

### 4. Start the server

```bash
cd packages/server
bun run start
# Dashboard: http://localhost:8080  (default: admin / password)
```

### 5. Register an agent

Open the dashboard at `http://localhost:8080`, click **Register Agent**, enter a
friendly name (e.g. `home-server`), and click **Generate**. Copy the
`AGENT_ID` and `AGENT_SECRET` — the secret is shown only once.

Alternatively via API (append `?name=my-agent` to set the name):

```bash
curl -b 'session=<cookie>' -X POST \
  "http://localhost:8080/api/agents/register?name=home-server"
```

### 6. Start the agent

```bash
cd packages/agent
AGENT_ID=<id> AGENT_SECRET=<secret> TLS_REJECT_UNAUTHORIZED=false bun run start
```

---

## Creating a Tunnel

Via the dashboard **Create Tunnel** form, or via API:

```bash
curl -X POST http://localhost:8080/api/tunnels \
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

Traffic arriving on port `9090` of the **server** will be forwarded by the agent
to `localhost:3000` on the **agent** host.

---

## Architecture

```
┌─────────────────────────┐          ┌──────────────────────────┐
│        SERVER           │          │         AGENT            │
│                         │          │                          │
│  ┌──────────────────┐   │   TLS    │   ┌──────────────────┐  │
│  │  Control Port    │◄──┼──────────┼───│  Control Conn    │  │
│  │  (AGENT_PORT)    │   │          │   │  AgentHello      │  │
│  │                  │   │          │   │  Heartbeat       │  │
│  │  AgentManager    │   │          │   └──────────────────┘  │
│  │  TunnelManager   │   │          │                          │
│  └──────────────────┘   │          │   ┌──────────────────┐  │
│                         │          │   │  Data Conns      │  │
│  ┌──────────────────┐   │          │   │  (per dial)      │  │
│  │  Tunnel Ports    │   │          │   └──────────────────┘  │
│  │  (TCP/UDP)       │   │          │                          │
│  └──────────────────┘   │          │  Local Services         │
│                         │          │  (targetHost:targetPort) │
│  ┌──────────────────┐   │          └──────────────────────────┘
│  │  Dashboard       │   │
│  │  (HTTP)          │   │
│  └──────────────────┘   │
└─────────────────────────┘

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
| Heartbeat | 0x03 | both | Keep-alive |
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

## Docker

A `docker-compose.yml` and `Dockerfile.server` are included for containerised
deployment. Add your tunnel ports to `docker-compose.yml` then:

```bash
# Generate certs first
bash scripts/generate-certs.sh

DASHBOARD_SECRET=admin:changeme docker compose up -d
```

The agent still runs as a Bun process on your private machine.

---

## License

MIT
