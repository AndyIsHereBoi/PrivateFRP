# PrivateFRP - Project Summary

## Overview

PrivateFRP is a high-performance, low-latency reverse proxy and tunneling solution designed to expose local services running on private networks to the public internet. It enables users to securely access services like web servers, game servers, databases, and other TCP/UDP applications running on their local machines without requiring port forwarding, DNS records, or public IP addresses.

The system is built with a client-server architecture where lightweight agents run on machines hosting local services, and a central server coordinates connections between external clients and these agents. The project prioritizes performance, security, and reliability for hosting game servers, development environments, and other time-sensitive applications.

## Core Goals

- **Expose Local Services**: Allow services running on private networks (behind NAT/firewalls) to be accessible from the public internet
- **Low Latency**: Minimize overhead and delay to provide near-native performance for real-time applications like game servers
- **Security**: Encrypt all traffic using TLS to protect data in transit
- **Scalability**: Support multiple agents and tunnels from a single server instance
- **Simplicity**: Easy setup and configuration without complex networking knowledge
- **Reliability**: Maintain stable connections with automatic reconnection and health monitoring

## Architecture

The system consists of three main components:

### 1. Agent (Client)

The agent runs on the machine hosting the local services to be exposed. It is responsible for:

- **Service Registration**: Defining which local services (tunnels) should be exposed, including the target host, port, and public-facing configuration
- **Control Connection**: Maintaining a persistent TLS connection to the central server for receiving commands and sending status updates
- **Data Connections**: Establishing and managing connections to the local target services when external clients connect
- **Connection Pooling**: Maintaining a pool of pre-warmed connections to minimize latency when new tunnels are requested
- **Heartbeat Monitoring**: Sending regular heartbeat messages to the server to prove liveness and detect disconnections
- **Automatic Reconnection**: Attempting to reconnect to the server if the connection is lost, with exponential backoff
- **Configuration Push**: Receiving tunnel configurations from the server and applying them dynamically

The agent acts as the bridge between the public internet (via the server) and the local services. When the server receives a connection request for a tunnel, it instructs the agent to connect to the local target service and establish a data path.

### 2. Server (Backend)

The server is the central coordination point that manages all agents and tunnels. It is responsible for:

- **Agent Management**: Tracking connected agents, their health status, active connections, and tunnel configurations
- **Tunnel Management**: Maintaining the mapping between public-facing ports and internal tunnel configurations
- **Connection Routing**: Directing incoming client connections to the appropriate agent and target stream
- **Authentication**: Verifying agent credentials and preventing unauthorized access
- **Dashboard/API**: Providing a web interface and API for managing tunnels, monitoring agents, and configuring the system
- **Database**: Persisting tunnel configurations and agent information
- **TLS Termination**: Handling TLS encryption for incoming client connections

The server exposes two main ports:
- **Agent Port**: For agents to connect and authenticate (TLS)
- **Dashboard Port**: For web interface access

### 3. Dashboard (Frontend)

The dashboard is a web-based management interface for administering the FRP server. It provides:

- **Agent Monitoring**: Real-time view of connected agents, their health, latency, and active connections
- **Tunnel Management**: Create, edit, and delete tunnel configurations
- **Authentication**: Secure login to access the management interface
- **Configuration Export**: Generate configuration files for agents

## Connection Flow

### Agent Registration

1. The agent starts and reads its configuration (server address, agent ID, secret)
2. The agent establishes a TLS control connection to the server
3. The agent sends an authentication frame with its credentials
4. The server validates the credentials and responds with success/failure
5. Upon successful authentication, the server pushes the agent's tunnel configurations
6. The agent acknowledges and begins managing its tunnels

### Tunnel Establishment

1. For each tunnel, the agent connects to the local target service
2. The agent notifies the server that the tunnel is ready
3. The server adds the tunnel to its listener pool, binding to the specified public port
4. When an external client connects to the public port, the server routes the connection

### Data Path (Client to Local Service)

1. An external client connects to the server on a tunnel's public port
2. The server identifies the target tunnel and its associated agent
3. The server sends a dial command to the agent via the control connection
4. The agent either uses a pooled connection or creates a new data connection to the server
5. The agent connects to the local target service
6. The server multiplexes the data between the client connection and the agent's stream
7. Data flows bidirectionally through this path: Client → Server → Agent → Local Service

### Heartbeat and Health

1. The agent sends periodic heartbeat messages to the server
2. The server tracks the last heartbeat time and calculates latency
3. If heartbeats stop, the server marks the agent as disconnected
4. The server closes all streams associated with disconnected agents
5. The agent detects disconnection and attempts reconnection with exponential backoff

## Tunnel Types

### TCP Tunnels

- Expose TCP services (web servers, SSH, game servers, databases)
- Support both inbound (external to local) and outbound (local to external) directions
- Maintain persistent connections for low latency

### UDP Tunnels

- Expose UDP services (game servers, DNS, real-time protocols)
- Track peer sessions with idle timeouts
- Map external peer addresses to internal streams

## Security Considerations

- All communications use TLS encryption
- Agents authenticate with ID/secret credentials
- The dashboard requires authentication
- TLS certificate verification is configurable (can be disabled for self-signed certs)
- Agents should be run in trusted environments as they have network access to local services

## Deployment

The project is built using Bun and can be deployed in two ways:

1. **Binary Execution**: Run directly from Bun-produced binaries
2. **Docker Container**: Run within a single Docker container

By default, running the binary or container starts the agent. To start the server instead, use the `--server` flag or set the `SERVER_MODE=1` environment variable.

## Technology Stack

- **Language**: TypeScript
- **Runtime**: Bun (for performance and fast startup)
- **Protocol**: Custom binary protocol over TLS for agent-server communication
- **Database**: SQLite for persistent storage
- **Logging**: log4js with rolling file and console output

## Shared Protocol Layer

The project includes a shared protocol layer that contains common definitions used by both the server and agent:

- **Message Types**: Constants defining all frame types (AgentHello, ServerHello, Heartbeat, ConfigPush, DialTcp, DialUdpSession, DataConnHello, UdpData, PoolHello, DialAssign, StreamOpen, StreamData, StreamClose)
- **Type Definitions**: TypeScript interfaces for tunnel configuration, message bodies, and frame structures
- **Frame Encoding/Decoding**: Functions for serializing and parsing the binary frame protocol
- **Tunnel Configuration**: Shared type for tunnel definitions used across all components

This shared layer ensures type consistency between the server and agent without code duplication.

## Traffic Flow

### Unified Connection Model

All communication between the agent and server travels through a single persistent encrypted connection. This unified channel handles both control messages (configuration, commands, heartbeats) and all tunnel data traffic. The agent maintains this connection to the server, and all tunnel data—whether originating as TCP or UDP—flows through it.

### TCP Tunnel Traffic Flow

For TCP tunnels, the data path works as follows:

1. **External Client → Server**: Client connects to the server's public port
2. **Server → Agent**: Server notifies the agent of the incoming connection
3. **Agent → Local Service**: Agent connects to the local target service
4. **Bidirectional Data**: Data flows bidirectionally through the connection:
   - **Inbound** (Client → Local): Client data → Server → Agent → Local target
   - **Outbound** (Local → Client): Local data → Agent → Server → Client

### UDP Tunnel Traffic Flow

UDP tunnels use the same connection as TCP tunnels, with the agent handling protocol translation:

1. **External Peer → Server**: UDP packet arrives at the server's UDP listener
2. **Server → Agent**: Server forwards the packet data to the agent over the connection
3. **Agent → Local Service**: Agent sends the original UDP packet to the local target
4. **Bidirectional Data**: All UDP packets flow through the connection:
   - **Inbound** (Peer → Local): UDP packet → Server → Agent → Local UDP socket
   - **Outbound** (Local → Peer): Local UDP data → Agent → Server → Original UDP packet → Peer

The agent is responsible for translating between the tunnel's internal protocol and the original UDP protocol, maintaining session state for active peers.

### Connection Multiplexing

Multiple tunnels and streams share the single connection simultaneously. Each tunnel and stream is identified by unique IDs that the server and agent use to route data to the correct destination.

## Database

The server uses SQLite as its persistent storage backend. All data is stored in a single SQLite database file located in the server's data directory. The database uses Write-Ahead Logging (WAL) mode for better concurrent read performance.

### Database Schema

#### Agents Table

Stores registered agent credentials and configuration.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT | Unique agent identifier (primary key) |
| name | TEXT | Human-readable agent name |
| secret | TEXT | Authentication secret for the agent |
| enabled | INTEGER | Whether the agent is active (1 = enabled, 0 = disabled) |
| created_at | INTEGER | Unix timestamp of when the agent was created |

#### Tunnels Table

Stores tunnel configurations mapping public ports to local services.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT | Unique tunnel identifier (primary key) |
| name | TEXT | Human-readable tunnel name |
| type | TEXT | Tunnel type: "tcp", "udp", or "tcp+udp" |
| listen_port | INTEGER | Public port the server listens on |
| target_host | TEXT | Local host address to forward to |
| target_port | INTEGER | Local port to forward to |
| agent_id | TEXT | Foreign key referencing the agent that handles this tunnel |
| enabled | INTEGER | Whether the tunnel is active (1 = enabled, 0 = disabled) |
| created_at | INTEGER | Unix timestamp of when the tunnel was created |

## Key Design Principles

1. **Performance First**: Minimize latency and overhead for real-time applications. The system is designed to handle high-throughput traffic with minimal delay, making it suitable for game servers and other time-sensitive applications. Connection pooling and pre-warmed connections reduce handshake overhead.

2. **Security by Default**: TLS encryption for all connections. Both agent-server and client-server communications are encrypted. Agent authentication uses ID/secret credentials, and the dashboard requires session-based authentication.

3. **Reliability**: Automatic reconnection and health monitoring. Agents detect disconnections and reconnect with exponential backoff. The server tracks agent heartbeats and cleans up stale connections. Streams are properly closed when agents disconnect.

4. **Simplicity**: Easy configuration and deployment. Components are configured via environment files. Data persistence uses a simple directory structure. Docker support enables one-command deployment.

5. **Extensibility**: Support for multiple tunnel types and configurations. The system supports TCP, UDP, and combined TCP+UDP tunnels. New tunnel types can be added by extending the protocol and tunnel manager.

6. **Unified Binary/Container**: The project is built with Bun and produces a single binary or container that can run either the agent (default) or server mode (via `--server` flag or `SERVER_MODE=1` environment variable). This simplifies deployment and distribution.
