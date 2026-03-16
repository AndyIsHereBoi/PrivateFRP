# PrivateFRP

PrivateFRP is a self-hosted reverse tunnel service for exposing local TCP/UDP
services through a public server, with TLS-encrypted agent links and a simple
web dashboard.

> **Linux only** — Windows is not supported.

## Table of Contents

- [Highlights](#highlights)
- [Quick Start (Docker)](#quick-start-docker)
- [Quick Start (Local Bun)](#quick-start-local-bun)
- [Using Release Binaries](#using-release-binaries)
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

## Using Release Binaries

The release workflow publishes these Linux (amd64) assets:

- `privatefrp-server-linux-amd64` — the server binary
- `agent` — the agent binary (place in your `PATH`, e.g. `/usr/local/bin/agent`)

These x64 binaries are compiled with Bun baseline targets for maximum CPU compatibility.

### 1. Download binaries from a GitHub release

- Open the repository Releases page
- Open the version you want
- Download the server and agent assets

### 2. Install and run the server

```bash
chmod +x ./privatefrp-server-linux-amd64
cp server.env.example server.env
# Edit server.env and set DASHBOARD_SECRET, etc.
./privatefrp-server-linux-amd64
```

Dashboard: `http://<server-ip>:8080`

### 3. Install and run the agent

Place the `agent` binary in your `PATH` so it can be started with a single command:

```bash
chmod +x ./agent
sudo mv ./agent /usr/local/bin/agent
```

Run the agent for the first time to auto-create the configuration file:

```bash
agent
```

On the first run, if no configuration file is found, `agent` automatically
creates a template at `~/.config/privatefrp/agent.env` and exits. Open that
file, fill in `SERVER_HOST`, `AGENT_ID`, and `AGENT_SECRET`, then run:

```bash
agent
```

The agent will read its configuration from (in order of priority):

1. `/etc/privatefrp/agent.env` — system-wide config
2. `~/.config/privatefrp/agent.env` — per-user config
3. `agent.env` next to the binary — backward-compatible location
4. `agent.env` in the current working directory

### 4. Register agent and create tunnels

- Open dashboard at `http://<server-ip>:8080`
- Register agent and copy `AGENT_ID` and `AGENT_SECRET`
- Set those values in `~/.config/privatefrp/agent.env` and run `agent`
- Create your TCP/UDP tunnel in the dashboard

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

- Windows is not supported.
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

