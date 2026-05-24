# Server Example

This example shows how to run a PrivateFRP server using Docker Compose.

## Prerequisites

- Docker Desktop or Docker Engine installed

## Configuration

1. Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

2. Edit `.env` with your configuration:

| Variable | Description | Default |
|----------|-------------|---------|
| `SERVER_PORT` | Port the server listens on for agent connections | 7000 |
| `DASHBOARD_PORT` | Port the dashboard web interface runs on | 8089 |
| `LOG_LEVEL` | Logging level: debug, info, warn, error | info |

## Running

### Start the server:

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

This example runs a single PrivateFRP server. The server:

- Listens for agent connections on `SERVER_PORT` (default: 7000)
- Provides a dashboard web interface on `DASHBOARD_PORT` (default: 8089)
- Stores data in `/app/data` inside the container

## Accessing the Dashboard

Once running, access the dashboard at:

```
http://localhost:DASHBOARD_PORT
```

Replace `DASHBOARD_PORT` with your configured port (default: 8089).

## Data Persistence

Data is stored in the `./data` directory relative to this compose file. This includes:

- SQLite database (`privatefrp.db`)
- TLS certificates (auto-generated if not present)

## Troubleshooting

### Server won't start

- Check logs: `docker compose logs server`
- Ensure ports are not already in use
- Verify Docker has write permissions to the `./data` directory

### Can't access dashboard

- Verify `DASHBOARD_PORT` is correct
- Check firewall rules allow inbound connections on that port
- Ensure container is running: `docker compose ps`
