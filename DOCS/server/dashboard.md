`packages/server/src/dashboard.ts` — HTTP + WebSocket dashboard server: HTML page renderers, WebSocket API (`agents`, `tunnels`, `traffic`), and REST endpoints for CRUD and traffic controls.

Top-level helpers:
- Session: `createSession(user): string`, `validateSession(cookieHeader): string | null`, `deleteSession(cookieHeader): void`, `clearSessionCookieHeaders(): Record<string,string>`.
- Request helpers: `getRequestIp(req, resolver?)`, `getRequestUserAgent(req)`.
- Traffic helpers: `parseTrafficWindow()`, `parseTunnelSort()`, `parseIpSort()`, and `buildTrafficPayload(db, opts): Promise<TrafficPayload>` which aggregates DB rollups and optionally enriches ASN via `lookupAsnByIp(ip)`.

Renderers and endpoints (selected):
- `loginPage(error?)`, `loginResponse(error?, status?)` — login HTML.
- `pageShell(opts)` — shared HTML shell used by agents/tunnels/traffic pages.
- `trafficPage(payload, publicIp)`, `agentsPage(agents, publicIp)`, `tunnelsPage(agents, tunnels, publicIp)` — server-side HTML for each view.
- `startDashboard(opts)` — exported function to start Bun HTTP/WebSocket server. Handles WebSocket message types `{ reqId,type,payload }` mapping to `agents`, `tunnels`, `traffic`; provides REST endpoints under `/api/*` for agent/tunnel management and `/api/traffic/clear`.

Notes:
- Client JS uses `dashboardWsRequest(type,payload)` over a single WS to request slices of data; server attempts to avoid re-sending unchanged payloads by the client-side render key logic.
