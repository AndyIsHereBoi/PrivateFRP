# Agent Example

This example shows how to run a PrivateFRP agent using Docker Compose. The agent connects to a remote PrivateFRP server and creates tunnels.

## Prerequisites

- Docker Desktop or Docker Engine installed
- Access to a running PrivateFRP server (must be deployed separately)

## Configuration

1. Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

2. Edit `.env` with your configuration:

| Variable | Description | Default |
|----------|-------------|---------|
| `SERVER_HOST` | Hostname or IP of the PrivateFRP server | (required) |
| `SERVER_PORT` | Port the server listens on for agent connections | 7000 |
| `AGENT_ID` | Unique identifier for this agent | (required) |
| `AGENT_SECRET` | Secret key for authentication | (required) |
| `LOG_LEVEL` | Logging level: debug, info, warn, error | info |

## Running

### Start the agent:

```bash
docker compose up -d
```

### View logs:

```bash
docker compose logs -f
```

### Stop the service:

```bash
docker compose down
```

## Architecture

This example runs a single PrivateFRP agent. The agent:

- Connects to the server over TLS on `SERVER_HOST:SERVER_PORT`
- Receives tunnel configurations dynamically from the server
- Creates TCP/UDP tunnels as configured
- Stores data in `./data` directory relative to this compose file

## Data Persistence

Data is stored in the `./data` directory. This includes:

- SQLite database (`privatefrp.db`)
- Trusted server certificate (`trusted-certs.json`) - saved on first connection

## TLS Certificate Validation

On first connection to the server, the agent saves the server's certificate to `./data/trusted-certs.json`. On subsequent connections, it validates that the server's certificate matches.

If the certificate doesn't match (indicating a potential man-in-the-middle attack or server certificate change), the agent will exit with an error and will not connect.

## Creating Tunnels

Once the agent is running and connected to the server, create tunnels via the server's dashboard:

1. Access the dashboard at `http://SERVER_HOST:DASHBOARD_PORT`
2. Log in with your credentials
3. Create TCP or UDP tunnels that will be forwarded through this agent

## Troubleshooting

### Agent can't connect to server

- Verify `SERVER_HOST` is correct and reachable from this machine
- Check firewall rules allow outbound connections on `SERVER_PORT`
- Ensure the server is running: `docker compose ps`

### Authentication failures

- Verify `AGENT_ID` and `AGENT_SECRET` match an agent registered in the server's database
- The server creates agents dynamically on first connection, so ensure credentials are correct

### Logs show errors

- Set `LOG_LEVEL=debug` for more detailed logging
- Check logs: `docker compose logs agent`
