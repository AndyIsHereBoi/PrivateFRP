# PrivateFRP

PrivateFRP is a Bun + TypeScript reverse proxy and tunnel platform with an agent control plane and an independent web dashboard.

## Layout

- `packages/shared`: frame protocol, shared types, config helpers
- `packages/server`: agent control plane, tunnel listeners, dashboard API/UI
- `packages/agent`: agent bootstrap and local service forwarding
- `web`: custom dashboard static assets

## Run

1. Set the server and dashboard environment variables from the `examples/server/server.env` and `examples/agent/agent.env` files.
2. Start the agent with `bun run agent` or the server with `bun run server`.

The agent/server control channel uses plain TCP. The dashboard is served separately over plain HTTP by default.