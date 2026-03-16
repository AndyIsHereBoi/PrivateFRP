# PrivateFRP Backend

This document explains how the backend works, how traffic is routed, and why
specific implementation choices exist.

## Table of Contents

- [Goals](#goals)
- [High-Level Components](#high-level-components)
- [Connection Types](#connection-types)
- [Database Structure](#database-structure)
- [TCP Flow](#tcp-flow)
- [UDP Flow](#udp-flow)
- [Config State and EnableDisable Semantics](#config-state-and-enabledisable-semantics)
- [Why Pre-Warmed Pooling Exists](#why-pre-warmed-pooling-exists)
- [Why There Is a Brief Handoff Pause](#why-there-is-a-brief-handoff-pause)
- [Why `setNoDelay(true)` Is Enabled](#why-setnodelaytrue-is-enabled)
- [Reconnect and Control-Channel Resilience](#reconnect-and-control-channel-resilience)
- [Backpressure and Transparency](#backpressure-and-transparency)
- [Safety Guards](#safety-guards)
- [Tradeoffs](#tradeoffs)
- [Where to Look in Code](#where-to-look-in-code)

## Goals

- Keep the data path byte-for-byte transparent once a tunnel is established.
- Minimize first-packet latency for new TCP connections.
- Recover quickly from network drops and half-open control channels.
- Avoid resource leaks under high connection churn.

## High-Level Components

- `packages/server`
: Accepts agent connections, manages tunnels, and routes inbound traffic.

- `packages/agent`
: Maintains control connection to server and forwards traffic to local services.

- `packages/shared`
: Defines framed message types and frame encoder/decoder utilities.

## Connection Types

- Control connection
: Long-lived TLS socket between agent and server for auth, heartbeat, and dial coordination.

- Pooled data connection
: Pre-warmed TLS socket opened by the agent and parked on the server, ready for assignment.

- Fallback data connection
: On-demand TLS socket opened when no pooled socket is available.

## Database Structure

Storage uses a single SQLite file at `data/privatefrp.db` with WAL mode enabled.

### Table: `agents`

| Column | Type | Notes |
|---|---|---|
| `id` | `TEXT` | Primary key (agent ID) |
| `name` | `TEXT` | Human-friendly dashboard label |
| `secret` | `TEXT` | Agent authentication secret |
| `enabled` | `INTEGER` | `1` enabled, `0` disabled |
| `created_at` | `INTEGER` | Unix timestamp default via `unixepoch()` |

### Table: `tunnels`

| Column | Type | Notes |
|---|---|---|
| `id` | `TEXT` | Primary key (tunnel ID) |
| `name` | `TEXT` | Tunnel display name |
| `type` | `TEXT` | `tcp` or `udp` |
| `listen_port` | `INTEGER` | Public server-side port |
| `target_host` | `TEXT` | Host on the agent side |
| `target_port` | `INTEGER` | Port on the agent side |
| `agent_id` | `TEXT` | Assigned agent ID (empty string means unassigned) |
| `enabled` | `INTEGER` | `1` enabled, `0` disabled |
| `created_at` | `INTEGER` | Unix timestamp default via `unixepoch()` |

### Relationship

- `tunnels.agent_id` references `agents.id`.
- One agent can own many tunnels.
- Deleting an agent in app logic unassigns that agent's tunnels (`agent_id = ''`) instead of deleting them.

### Runtime behavior

- Tunnel listener state is in memory; DB stores configuration/state snapshots, not live sockets.
- On tunnel create/update/delete, server reloads listeners from DB and pushes config to connected agents.
- A tunnel is considered active only when all of these are true:
  - Tunnel has an assigned agent (`agent_id` is non-empty)
  - Tunnel `enabled = 1`
  - Assigned agent `enabled = 1`

## Config State and EnableDisable Semantics

- Agent disable is a routing control, not an authentication block.
- Disabled agents can still connect and keep a control channel.
- Disabled agents receive no tunnel config from the server.
- Disabling an agent does not rewrite per-tunnel enabled flags.
- Tunnel disable is per-tunnel and independent of assignment.
- Unassigned tunnels stay in DB/UI but are never activated on server listen ports.

Operationally, this gives a layered model:

- Assignment decides ownership.
- Tunnel enabled decides whether that tunnel is eligible.
- Agent enabled decides whether any assigned eligible tunnels can be activated.

## TCP Flow

1. External client connects to a tunnel listen port on the server.
2. Server asks `AgentManager` for a data socket.
3. Fast path:
: Server takes a pooled socket and writes `DialAssign` on that socket.
4. Agent receives `DialAssign`, connects to local target service.
5. Agent and server switch to raw stream mode and `pipe()` both directions.
6. Bytes flow transparently between external client and local service.

If no pooled socket is available:

- Server sends fallback dial request on control channel.
- Agent opens a fresh data connection and identifies it.
- Server binds request to that connection and pipes as above.

## UDP Flow

- Server tracks sessions per external peer.
- A UDP session dial request is sent to the agent when needed.
- UDP payloads are exchanged as framed `UdpData` messages over a data connection.
- Idle UDP sessions are reaped to prevent unbounded growth.

## Why Pre-Warmed Pooling Exists

Without pooling, each new TCP connection waits for an extra control round-trip and
TLS setup on the data path. For bursty traffic (browser tabs, game joins), this
adds visible latency and timeouts under load.

Pooling removes handshake cost from the critical path by keeping ready-to-use
sockets parked on the server.

## Why There Is a Brief Handoff Pause

A key reliability fix is intentionally pausing sockets during the framed-to-raw
handoff.

### Problem that occurred

When moving a socket from frame decoding to raw piping, removing a `data`
listener does not automatically stop stream flow in Node.js. A socket can remain
in flowing mode. If bytes arrive in that gap before `pipe()` is attached, those
bytes can be dropped.

This manifested as:

- Browser sends `GET`.
- Server sees inbound request.
- Agent never delivers request to local service.
- Browser hangs waiting for response.

### Current behavior

During handoff, code now:

1. Detaches decoder.
2. Removes decode listener.
3. Calls `pause()` immediately.
4. Re-injects leftover bytes with `unshift()`.
5. Establishes `pipe()` to target.

This guarantees bytes are buffered until the raw pipe is ready.

The pause is not an artificial delay timer; it is a short flow-control hold to
prevent packet loss during mode transition.

## Why `setNoDelay(true)` Is Enabled

TCP defaults can coalesce small writes (Nagle algorithm), adding latency for
small packets. For game/interactive traffic, this is undesirable.

`setNoDelay(true)` is enabled on tunnel path sockets to reduce latency spikes on
small payloads.

## Reconnect and Control-Channel Resilience

The agent reconnect strategy includes:

- Exponential backoff reconnect after disconnect.
- Keepalive heartbeats.
- Control socket timeout handling.
- Idle watchdog that forces reconnect if control traffic stalls.

Why this matters:

Some failures leave a socket half-open (no clean close event). Explicit timeout
and watchdog teardown guarantees reconnect logic still triggers.

## Backpressure and Transparency

After tunnel setup, forwarding uses Node stream `pipe()` directly between
sockets. No application-level chunk parsing is done on raw tunnel traffic.

This keeps behavior protocol-agnostic and preserves the exact data stream.

## Safety Guards

- Pending dial caps to prevent runaway memory growth under load.
- Early client disconnect handling to avoid orphaned data sockets.
- Pool socket age/health checks before assignment.
- Cleanup on reconnect/disconnect to avoid stale pooled sockets.

## Tradeoffs

- Pooling increases baseline open socket count but improves connection latency.
- Watchdog/timeout can trigger reconnect during severe transient pauses, but this
  is preferable to silently stuck control channels.
- UDP is session-managed with framed payloads, while TCP is raw-stream forwarded.

## Where to Look in Code

- `packages/server/src/server.ts`
: TLS accept path and first-frame classification.

- `packages/server/src/agentManager.ts`
: Agent state, pooled sockets, pending dials.

- `packages/server/src/tunnelManager.ts`
: Per-tunnel listener lifecycle and TCP/UDP forwarding entry points.

- `packages/agent/src/agent.ts`
: Control lifecycle, pool maintenance, reconnect logic, target connection bridging.

- `packages/shared/src/protocol.ts`
: Message types and frame encoding/decoding.
