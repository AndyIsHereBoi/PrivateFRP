# PrivateFRP - TypeScript Rewrite

PrivateFRP is a high-performance reverse proxy and tunneling solution written in TypeScript with Bun runtime.

## Architecture

```
┌─────────────┐     TLS      ┌──────────────┐     TCP/UDP      ┌──────────────┐
│   Agent     │◄────────────►│   Server     │◄────────────────►│  Local App   │
└─────────────┘              └──────────────┘                  └──────────────┘
                                                    │
                                                    ▼
                                            ┌──────────────┐
                                            │ Dashboard UI │
                                            └──────────────┘
```

## Project Structure

```
new-PrivateFRP/
├── packages/
│   ├── shared/          # Shared types and protocol definitions
│   │   └── src/
│   │       ├── constants.ts    # Protocol constants
│   │       ├── types.ts        # TypeScript interfaces
│   │       ├── protocol/
│   │       │   └── frame.ts    # Binary frame encoding/decoding
│   │       └── utils/
│   │           ├── env.ts      # Environment validation
│   │           └── config.ts   # Configuration loader
│   ├── server/          # Server implementation
│   │   └── src/
│   │       ├── index.ts              # Entry point
│   │       ├── database/             # SQLite database layer
│   │       ├── server/               # Agent and Dashboard servers
│   │       └── utils/                # Utility functions
│   └── agent/           # Agent implementation
│       └── src/
│           ├── index.ts              # Entry point
│           ├── client/               # Agent client
│           └── tunnel/               # Tunnel management
├── web/                 # Dashboard web UI (vanilla JS)
└── docs/                # Documentation
```

## Prerequisites

- [Bun](https://bun.sh/) runtime (v1.0+)

## Installation

```bash
# Clone the repository
git clone <repository-url>
cd new-PrivateFRP

# Install dependencies
bun install
```

## Running

### Server

```bash
# Start the server with watch mode
bun run dev:server

# Or start directly (no watch)
bun run start:server
```

### Agent

```bash
# Start the agent with watch mode
bun run dev:agent

# Or start directly (no watch)
bun run start:agent
```

## Configuration

### Server Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVER_PORT` | 7000 | Port for agent connections |
| `DASHBOARD_PORT` | 8089 | Port for dashboard HTTP API |
| `LOG_LEVEL` | info | Logging level: debug, info, warn, error |

### Agent Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVER_HOST` | - | Server hostname or IP (required) |
| `SERVER_PORT` | 7000 | Server port |
| `AGENT_ID` | - | Agent identifier (required) |
| `AGENT_SECRET` | - | Agent secret for authentication (required) |
| `LOG_LEVEL` | info | Logging level |

## API Endpoints

### Authentication

- `POST /login` - Login with username/password
- `POST /logout` - Logout current session

### Agents

- `GET /api/agents` - List all agents

### Tunnels

- `GET /api/tunnels` - List all tunnels
- `POST /api/tunnels` - Create a new tunnel
  ```json
  {
    "agentId": "agent-id",
    "publicPort": 8080,
    "localAddress": "localhost:3000",
    "tunnelType": "tcp"
  }
  ```
- `DELETE /api/tunnels/:id` - Delete a tunnel

## Certificate Generation

Generate self-signed certificates for development:

```bash
# Linux/macOS
./generate-certs.sh

# Windows
.\generate-certs.ps1
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

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for more details.

## Development

```bash
# Run tests
bun test

# Run type checking (via bun build)
bun run build:shared
```

## License

MIT
