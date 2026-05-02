PrivateFRP — Bun+TypeScript monorepo implementing a multiplexed TLS control-plane.

Core:
- Framed control protocol: `StreamOpen`, `StreamData`, `StreamClose`.
- Base64 payload frames routed between client sockets and agent-local target sockets.
- Backpressure: sources pause when destination `write()` returns false; resume on `drain`.

Key files:
- `packages/server/src/tunnelManager.ts` — listener lifecycle, routing, traffic accounting.
- `packages/agent/src/agent.ts` — control client, per-stream proxy, pool logic.
- `packages/shared/src/protocol.ts` — protocol types.

Build:
- `cd packages/server && bun build`
- `cd packages/agent && bun build`
