# PrivateFRP

PrivateFRP is a reverse proxy and tunnel platform with an agent control plane and an independent web dashboard.

> **Note:** Docker is the only supported deployment method. Running directly with Bun is not covered.

## Layout

- `packages/shared`: frame protocol, shared types, config helpers
- `packages/server`: agent control plane, tunnel listeners, dashboard API/UI
- `packages/agent`: agent bootstrap and local service forwarding
- `web`: custom dashboard static assets

## Run

Copy and configure the environment files from `examples/`:

```bash
cp examples/server/server.env.example server.env
cp examples/agent/agent.env.example agent.env
```

### Server

```bash
docker compose -f examples/server/compose.yml up -d
```

### Agent

```bash
docker compose -f examples/agent/compose.yml up -d
```

Images are published to `ghcr.io/andyishereboi/privatefrp-server` and `ghcr.io/andyishereboi/privatefrp-agent`.
