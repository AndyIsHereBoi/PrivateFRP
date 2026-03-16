# PrivateFRP

PrivateFRP is a self-hosted reverse tunnel service for exposing local TCP/UDP
services through a public server, with TLS-encrypted agent links and a simple
web dashboard.

## Table of Contents

- [Highlights](#highlights)
- [Quick Start](#quick-start)
- [Dashboard Workflow](#dashboard-workflow)
- [Typical Use Cases](#typical-use-cases)
- [Notes](#notes)
- [Backend Documentation](#backend-documentation)
- [Run with Docker](#run-with-docker)
- [License](#license)

## Highlights

- Self-hosted remote access for local services
- TCP and UDP tunnel support
- TLS-encrypted server-agent communication
- Web dashboard for agent and tunnel management
- Automatic agent reconnect and health tracking
- Pre-warmed connection pool for low-latency new connections
- Designed for latency-sensitive services (game servers, voice, real-time apps)

## Quick Start

Choose one install method:

- [Using Release Binaries](#using-release-binaries)
- [Quick Start (Docker)](#quick-start-docker)
- [Quick Start (Local Bun)](#quick-start-local-bun)

## Using Release Binaries

The release workflow publishes these assets:

- privatefrp-server-windows-x64.exe
- privatefrp-agent-windows-x64.exe
- privatefrp-server-linux-amd64
- privatefrp-agent-linux-amd64

### 1. Download binaries

- Download one server binary and one agent binary for your platform from Releases.

### 2. Create env files next to the binaries

- Server binary reads server.env
- Agent binary reads agent.env
- Copy server.env.example to server.env
- Copy agent.env.example to agent.env

### 3. Start server, then start agent

Windows (PowerShell):

```powershell
./privatefrp-server-windows-x64.exe
./privatefrp-agent-windows-x64.exe
```

Linux (amd64):

```bash
chmod +x ./privatefrp-server-linux-amd64 ./privatefrp-agent-linux-amd64
./privatefrp-server-linux-amd64
./privatefrp-agent-linux-amd64
```

### 4. Finish in dashboard

- Open http://<server-ip>:8080
- Register agent and copy AGENT_ID + AGENT_SECRET
- Put those values in agent.env and restart agent
- Create your tunnel

## Quick Start (Docker)

### 1. Download the repository

- Download this repository (zip or clone).

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

### 4. Configure and start the agent

```bash
cp agent.env.example agent.env
# Edit agent.env with SERVER_HOST, AGENT_ID, AGENT_SECRET
bash scripts/start-agent.sh
```

### 5. Create a tunnel in the dashboard

Create a tunnel with:

- Type (`tcp` or `udp`)
- Public listen port (on the server)
- Target host/port (on the agent machine)
- Agent assignment

## Quick Start (Local Bun)

### 1. Download the repository and install dependencies

```bash
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
bun --cwd packages/server run start
bun --cwd packages/agent run start
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
- Set `LOG_PATH` to control where runtime logs are written.
- Server writes `tunnel.log` and `webserver.log`; agent writes `agent.log`.

## Backend Documentation

For protocol/architecture details and implementation rationale, see:

- [backend.md](backend.md)

## Run with Docker

Run these from the repo root.

### Server host

```bash
cp server.env.example server.env
# edit server.env (set DASHBOARD_SECRET and PUBLIC_IP)
docker compose -f docker-compose.yml --env-file server.env up -d --build
```

### Agent host

```bash
cp agent.env.example agent.env
# edit agent.env (set SERVER_HOST, AGENT_ID, AGENT_SECRET)
docker compose -f docker-compose.agent.yml --env-file agent.env up -d --build
```

### Stop

```bash
docker compose -f docker-compose.yml --env-file server.env down
docker compose -f docker-compose.agent.yml --env-file agent.env down
```

## License

MIT

