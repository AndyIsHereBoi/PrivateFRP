# Deployment Guide

## Prerequisites

- [Bun](https://bun.sh/) runtime (v1.0+)
- Docker and Docker Compose (for containerized deployment)

## Building from Source

```bash
# Clone the repository
git clone <repository-url>
cd new-PrivateFRP

# Install dependencies
bun install
```

Run directly with Bun:
```bash
# Server
bun run start:server

# Agent
bun run start:agent
```

## Docker Deployment

### Using Docker Compose (Recommended)

The project includes `docker-compose.yml` for easy deployment:

```bash
# Build and start all services
docker compose up --build

# View logs
docker compose logs -f

# Stop services
docker compose down
```

### Manual Docker Deployment

#### Server

```bash
docker build -f Dockerfile.server -t privatefrp-server .
docker run -d \
  --name privatefrp-server \
  -p 7000:7000 \
  -p 8089:8089 \
  -v server-data:/data \
  privatefrp-server
```

#### Agent

```bash
docker build -f Dockerfile.agent -t privatefrp-agent .
docker run -d \
  --name privatefrp-agent \
  --network=host \
  -e SERVER_HOST=your-server-host \
  -e SERVER_PORT=7000 \
  -e AGENT_ID=my-agent \
  -e AGENT_SECRET=my-secret \
  privatefrp-agent
```

## Binary Deployment

### Linux/macOS

```bash
# Build the binary
bun build ./packages/server/src/index.ts --outfile ./bin/privatefrp-server --target=bun --compile

# Run the binary
./bin/privatefrp-server
```

### Windows

```powershell
# Build the binary
bun build .\packages\server\src\index.ts --outfile .\bin\privatefrp-server.exe --target=bun --compile

# Run the binary
.\bin\privatefrp-server.exe
```

## Environment Variables

See `.env.example` for server configuration and `agent.env.example` for agent configuration.

### Server Environment Variables
- `SERVER_PORT` - Port for agent connections (default: 7000)
- `DASHBOARD_PORT` - Port for dashboard HTTP API (default: 8089)
- `LOG_LEVEL` - Logging level: debug, info, warn, error (default: info)

### Agent Environment Variables
- `SERVER_HOST` - Server hostname or IP address
- `SERVER_PORT` - Server port (default: 7000)
- `AGENT_ID` - Unique identifier for this agent
- `AGENT_SECRET` - Secret key for authentication
- `LOG_LEVEL` - Logging level

## Firewall Configuration

- **Server**: Open port 7000 (agent connections) and 8089 (dashboard)
- **Agent**: Outbound connection to server on port 7000
