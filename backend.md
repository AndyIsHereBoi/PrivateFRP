# PrivateFRP Backend

This document explains how the backend works, how traffic is routed, and why
specific implementation choices exist.

## Table of Contents

- [Goals](#goals)
- [High-Level Components](#high-level-components)
- [Connection Types](#connection-types)
- [Current Transport Model](#current-transport-model)
- [Database Structure](#database-structure)
- [TCP Flow](#tcp-flow)
- [UDP Flow](#udp-flow)
- [Config State and EnableDisable Semantics](#config-state-and-enabledisable-semantics)
- [Why `setNoDelay(true)` Is Enabled](#why-setnodelaytrue-is-enabled)
- [Reconnect and Control-Channel Resilience](#reconnect-and-control-channel-resilience)
- [Backpressure and Transparency](#backpressure-and-transparency)
- [Operational Metrics](#operational-metrics)
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
: Long-lived TLS socket between agent and server for auth, heartbeat, config push, and stream control.

- Multiplexed stream
: Logical per-client flow carried over the control connection using framed `StreamOpen`, `StreamData`, and `StreamClose` messages.

- Legacy pooled data connection
: Older compatibility path using pre-warmed data sockets (`PoolHello` / `DialAssign`).

- Legacy fallback data connection
: Older on-demand path (`DialTcp` / `DataConnHello` and `DialUdpSession`).

## Current Transport Model

- Primary path is single-control-connection multiplexing.
- Tunnel traffic and control traffic share the same TLS control socket.
- Server opens a logical stream per inbound TCP client (or UDP peer session).
- Agent opens a corresponding local target socket/session and relays payload frames.
- Stream lifecycle is explicit via `StreamOpen` and `StreamClose`.
- Legacy data-connection handlers still exist for compatibility but are not the intended steady-state path.

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
2. Server creates a stream ID and sends `StreamOpen(kind=tcp, tunnelId, streamId)` on control.
3. Agent opens local TCP connection to the tunnel target.
4. Both sides exchange `StreamData` frames with base64 payloads.
5. Either side sends `StreamClose` to terminate the logical stream.

Result: many concurrent TCP clients can be carried over one physical control TLS connection.

## UDP Flow

- Server tracks UDP sessions keyed by external peer and maps each session to a stream ID.
- On first packet for a peer, server sends `StreamOpen(kind=udp, peerAddr, streamId)`.
- UDP payloads are exchanged as `StreamData` frames over control.
- Idle UDP sessions are reaped; server sends `StreamClose` on reap.
- Agent-side UDP socket/session is closed when stream closes.

## Legacy Data-Path Notes

- Pre-warmed pooling and fallback data sockets are historical optimization paths from the multi-connection architecture.
- The framed-to-raw handoff pause (`pause()` / `unshift()`) remains relevant only for those legacy data-socket paths.
- In current multiplex mode, traffic stays framed end-to-end on control and does not switch to raw data sockets.

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

In multiplex mode, payload bytes are relayed as framed `StreamData` messages,
so the transport is no longer raw `pipe()` between server and agent sockets.
Application payload still passes through unchanged at the byte level (aside from
base64 framing), and no protocol-specific parsing is performed.

## Operational Metrics

- Dashboard `Current Connections` represents active logical streams/sessions per agent.
- It is not the physical control-socket count.
- Examples counted:
  - Active TCP client connections (for example WebSocket clients, game clients).
  - Active UDP peer sessions.

## Safety Guards

- Pending dial caps to prevent runaway memory growth under load.
- Active stream caps per agent via `SERVER_MAX_ACTIVE_CONNECTIONS_PER_AGENT`.
- Early client disconnect handling to avoid orphaned streams.
- Cleanup on reconnect/disconnect to avoid stale stream/session state.

## Tradeoffs

- Multiplexing drastically reduces socket churn and baseline socket count.
- A single control channel becomes a higher-value dependency, so heartbeat and reconnect behavior is critical.
- Framed payload transport adds serialization overhead (JSON + base64), trading some CPU for simpler connection management.
- Legacy data-socket paths still in code increase maintenance complexity until fully removed.

## Where to Look in Code

- `packages/server/src/server.ts`
: TLS accept path and first-frame classification.

- `packages/server/src/agentManager.ts`
: Agent state, active connection counters, and legacy pool/pending dial compatibility handlers.

- `packages/server/src/tunnelManager.ts`
: Per-tunnel listener lifecycle, stream open/data/close routing, and TCP/UDP forwarding entry points.

- `packages/agent/src/agent.ts`
: Control lifecycle, multiplex stream handlers, reconnect logic, plus legacy pool handlers.

- `packages/shared/src/protocol.ts`
: Message types and frame encoding/decoding.
