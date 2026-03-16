# PrivateFRP

PrivateFRP is a self-hosted reverse tunnel service for exposing local TCP/UDP
services through a public server, with TLS-encrypted agent links and a simple
web dashboard.

## Table of Contents

- [Highlights](#highlights)
- [Quick Start (Docker)](#quick-start-docker)
- [Quick Start (Local Bun)](#quick-start-local-bun)
- [Dashboard Workflow](#dashboard-workflow)
- [Typical Use Cases](#typical-use-cases)
- [Notes](#notes)
- [Backend Documentation](#backend-documentation)
- [Development](#development)
- [License](#license)

## Highlights

- Self-hosted remote access for local services
- TCP and UDP tunnel support
- TLS-encrypted server-agent communication
- Web dashboard for agent and tunnel management
- Automatic agent reconnect and health tracking
- Pre-warmed connection pool for low-latency new connections
- Designed for latency-sensitive services (game servers, voice, real-time apps)

## Quick Start (Docker)

### 1. Clone the repository

```bash
git clone <repo-url>
cd PrivateFRP
```

### 2. Generate TLS certificates

```bash
bash scripts/generate-certs.sh
```

### 3. Configure and start the server

```bash
cp server.env.example server.env
# Edit server.env and set DASHBOARD_SECRET
bash scripts/start-server.sh
```

Dashboard: `http://<server-ip>:8080`

### 4. Register an agent from the dashboard

- Open the dashboard
- Click Register Agent
- Copy AGENT_ID and AGENT_SECRET (secret is shown once)

### 5. Configure and start the agent

```bash
cp agent.env.example agent.env
# Edit agent.env with SERVER_HOST, AGENT_ID, AGENT_SECRET
bash scripts/start-agent.sh
```

### 6. Create a tunnel in the dashboard

Create a tunnel with:

- Type (`tcp` or `udp`)
- Public listen port (on the server)
- Target host/port (on the agent machine)
- Agent assignment

## Quick Start (Local Bun)

### 1. Install dependencies

```bash
git clone <repo-url>
cd PrivateFRP
bun install
```

### 2. Generate certs

```bash
bash scripts/generate-certs.sh
```

### 3. Configure env files

- Copy `server.env.example` to `server.env`
- Copy `agent.env.example` to `agent.env`

### 4. Start server and agent

```bash
cd packages/server
bun run start

cd ../agent
bun run start
```

## Dashboard Workflow

- Register agents
- Create and remove tunnels
- Monitor connected/offline status
- Check last heartbeat and remote address

## Typical Use Cases

- Host a game server from home without router port-forwarding
- Expose internal web apps for personal/team access
- Route UDP services through a single remote endpoint
- Keep a stable external endpoint while local network changes

## Notes

- If using self-signed certs, set `TLS_REJECT_UNAUTHORIZED=false` on agents.
- Ensure tunnel listen ports are exposed in Docker if you run the server in containers.
- Agent credentials are generated from the dashboard and must match exactly.

## Backend Documentation

For protocol/architecture details and implementation rationale, see:

- [backend.md](backend.md)

## Development

```bash
bun run dev:server
bun run dev:agent
bun run build:server
bun run build:agent
 bun run build:binaries
```

Compiled binaries are produced with Bun `--compile` at:

- `dist/server`
- `dist/agent`

## License

MIT

