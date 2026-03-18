import type { DB } from "./db";
import type { AgentManager } from "./agentManager";
import { webLog } from "./logger";

// Session management
const sessions = new Map<string, { user: string; expiresAt: number }>();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

function createSession(user: string): string {
  const id = crypto.randomUUID();
  sessions.set(id, { user, expiresAt: Date.now() + SESSION_TTL_MS });
  return id;
}

function validateSession(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/session=([^;]+)/);
  if (!match) return null;
  const session = sessions.get(match[1]);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(match[1]);
    return null;
  }
  return session.user;
}

function deleteSession(cookieHeader: string | null): void {
  if (!cookieHeader) return;
  const match = cookieHeader.match(/session=([^;]+)/);
  if (match) sessions.delete(match[1]);
}

function normalizeRemoteIp(ip: string | null | undefined): string {
  if (!ip) return "";
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

function getRequestIp(req: Request, requestIpResolver?: (req: Request) => string | null): string {
  if (requestIpResolver) {
    const ip = requestIpResolver(req);
    if (ip) return normalizeRemoteIp(ip) || "unknown";
  }

  const xForwardedFor = req.headers.get("x-forwarded-for");
  if (xForwardedFor) {
    const first = xForwardedFor.split(",")[0]?.trim();
    if (first) return normalizeRemoteIp(first) || "unknown";
  }

  const xRealIp = req.headers.get("x-real-ip")?.trim();
  if (xRealIp) return normalizeRemoteIp(xRealIp) || "unknown";

  const cfConnectingIp = req.headers.get("cf-connecting-ip")?.trim();
  if (cfConnectingIp) return normalizeRemoteIp(cfConnectingIp) || "unknown";

  return "unknown";
}

function getRequestUserAgent(req: Request): string {
  const userAgent = req.headers.get("user-agent");
  if (!userAgent) return "unknown";
  return userAgent.replace(/\s+/g, " ").trim() || "unknown";
}

type TrafficTunnelRow = {
  id: string;
  name: string;
  type: string;
  agentName: string;
  incomingTraffic: number;
  outgoingTraffic: number;
};

type TrafficWindow = "6h" | "1d" | "7d" | "1mo" | "6mo";
type SortDir = "asc" | "desc";
type TunnelSortKey = "total" | "in" | "out" | "name" | "type" | "agent";
type IpSortKey = "total" | "in" | "out" | "ip" | "tunnels" | "lastSeen";

type TrafficPayload = {
  window: TrafficWindow;
  tunnelSort: TunnelSortKey;
  tunnelDir: SortDir;
  ipSort: IpSortKey;
  ipDir: SortDir;
  tunnels: TrafficTunnelRow[];
  topIps: TrafficIpRow[];
};

const TRAFFIC_WINDOW_SECONDS: Record<TrafficWindow, number> = {
  "6h": 6 * 60 * 60,
  "1d": 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
  "1mo": 30 * 24 * 60 * 60,
  "6mo": 180 * 24 * 60 * 60,
};

function parseTrafficWindow(value: string | null): TrafficWindow {
  if (value === "6h" || value === "1d" || value === "7d" || value === "1mo" || value === "6mo") {
    return value;
  }
  return "1d";
}

function parseSortDir(value: string | null): SortDir {
  return value === "asc" ? "asc" : "desc";
}

function parseTunnelSort(value: string | null): TunnelSortKey {
  if (value === "in" || value === "out" || value === "name" || value === "type" || value === "agent") {
    return value;
  }
  return "total";
}

function parseIpSort(value: string | null): IpSortKey {
  if (value === "in" || value === "out" || value === "ip" || value === "tunnels" || value === "lastSeen") {
    return value;
  }
  return "total";
}

type TrafficIpRow = {
  ip: string;
  incomingTraffic: number;
  outgoingTraffic: number;
  totalTraffic: number;
  tunnelCount: number;
  asn: string;
  asnName: string;
  lastSeen: number;
};

const ENABLE_IP_ASN_LOOKUP = /^(1|true|yes)$/i.test(process.env.IP_ASN_LOOKUP ?? "");
const ASN_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const asnLookupCache = new Map<string, { asn: string; asnName: string; expiresAt: number }>();

function isPrivateIp(ip: string): boolean {
  if (!ip) return true;
  if (ip === "127.0.0.1" || ip === "::1") return true;
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("192.168.")) return true;
  if (ip.startsWith("172.")) {
    const parts = ip.split(".");
    const second = Number(parts[1]);
    if (Number.isFinite(second) && second >= 16 && second <= 31) return true;
  }
  return false;
}

async function lookupAsnByIp(ip: string): Promise<{ asn: string; asnName: string }> {
  if (!ENABLE_IP_ASN_LOOKUP || isPrivateIp(ip) || ip === "unknown") {
    return { asn: "", asnName: "" };
  }

  const cached = asnLookupCache.get(ip);
  if (cached && cached.expiresAt > Date.now()) {
    return { asn: cached.asn, asnName: cached.asnName };
  }

  try {
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,connection`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = (await res.json()) as {
      success?: boolean;
      connection?: { asn?: number | string; org?: string };
    };
    const asnRaw = body.connection?.asn;
    const asn = asnRaw === undefined || asnRaw === null || String(asnRaw).trim() === ""
      ? ""
      : `AS${String(asnRaw).replace(/^AS/i, "")}`;
    const asnName = body.connection?.org?.trim() ?? "";
    asnLookupCache.set(ip, { asn, asnName, expiresAt: Date.now() + ASN_CACHE_TTL_MS });
    return { asn, asnName };
  } catch {
    // Cache negative lookups briefly to avoid repeated outbound requests.
    asnLookupCache.set(ip, { asn: "", asnName: "", expiresAt: Date.now() + 5 * 60 * 1000 });
    return { asn: "", asnName: "" };
  }
}

function applyDirCompare(base: number, dir: SortDir): number {
  return dir === "asc" ? base : -base;
}

async function buildTrafficPayload(db: DB, opts: {
  window: TrafficWindow;
  tunnelSort: TunnelSortKey;
  tunnelDir: SortDir;
  ipSort: IpSortKey;
  ipDir: SortDir;
}): Promise<TrafficPayload> {
  const nowSec = Math.floor(Date.now() / 1000);
  const sinceSec = nowSec - TRAFFIC_WINDOW_SECONDS[opts.window];

  const agentNameMap = new Map(db.listAgents().map((a) => [a.id, a.name]));
  const windowByTunnel = new Map(
    db.listTunnelTrafficWindow(sinceSec).map((row) => [row.tunnel_id, row]),
  );
  const tunnels: TrafficTunnelRow[] = db.listTunnels().map((t) => {
    const windowRow = windowByTunnel.get(t.id);
    return {
    id: t.id,
    name: t.name,
    type: t.type,
    agentName: t.agent_id ? (agentNameMap.get(t.agent_id) ?? "Unknown Agent") : "Unassigned",
      incomingTraffic: windowRow?.traffic_in_bytes ?? 0,
      outgoingTraffic: windowRow?.traffic_out_bytes ?? 0,
    };
  });

  tunnels.sort((a, b) => {
    const aTotal = a.incomingTraffic + a.outgoingTraffic;
    const bTotal = b.incomingTraffic + b.outgoingTraffic;
    switch (opts.tunnelSort) {
      case "in":
        return applyDirCompare(a.incomingTraffic - b.incomingTraffic, opts.tunnelDir);
      case "out":
        return applyDirCompare(a.outgoingTraffic - b.outgoingTraffic, opts.tunnelDir);
      case "name":
        return opts.tunnelDir === "asc" ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
      case "type":
        return opts.tunnelDir === "asc" ? a.type.localeCompare(b.type) : b.type.localeCompare(a.type);
      case "agent":
        return opts.tunnelDir === "asc"
          ? a.agentName.localeCompare(b.agentName)
          : b.agentName.localeCompare(a.agentName);
      default:
        return applyDirCompare(aTotal - bTotal, opts.tunnelDir);
    }
  });

  const ipAgg = new Map<
    string,
    { incomingTraffic: number; outgoingTraffic: number; tunnelIds: Set<string>; lastSeen: number }
  >();
  for (const row of db.listIpTrafficWindow(sinceSec)) {
    const ip = normalizeRemoteIp(row.remote_ip || "unknown") || "unknown";
    const existing = ipAgg.get(ip);
    if (existing) {
      existing.incomingTraffic += row.traffic_in_bytes ?? 0;
      existing.outgoingTraffic += row.traffic_out_bytes ?? 0;
      existing.tunnelIds.add(row.tunnel_id);
      existing.lastSeen = Math.max(existing.lastSeen, row.last_bucket_start ?? 0);
    } else {
      ipAgg.set(ip, {
        incomingTraffic: row.traffic_in_bytes ?? 0,
        outgoingTraffic: row.traffic_out_bytes ?? 0,
        tunnelIds: new Set([row.tunnel_id]),
        lastSeen: row.last_bucket_start ?? 0,
      });
    }
  }

  const sortedIp = Array.from(ipAgg.entries())
    .map(([ip, value]) => ({
      ip,
      incomingTraffic: value.incomingTraffic,
      outgoingTraffic: value.outgoingTraffic,
      totalTraffic: value.incomingTraffic + value.outgoingTraffic,
      tunnelCount: value.tunnelIds.size,
      lastSeen: value.lastSeen,
    }));

  sortedIp.sort((a, b) => {
    switch (opts.ipSort) {
      case "in":
        return applyDirCompare(a.incomingTraffic - b.incomingTraffic, opts.ipDir);
      case "out":
        return applyDirCompare(a.outgoingTraffic - b.outgoingTraffic, opts.ipDir);
      case "ip":
        return opts.ipDir === "asc" ? a.ip.localeCompare(b.ip) : b.ip.localeCompare(a.ip);
      case "tunnels":
        return applyDirCompare(a.tunnelCount - b.tunnelCount, opts.ipDir);
      case "lastSeen":
        return applyDirCompare(a.lastSeen - b.lastSeen, opts.ipDir);
      default:
        return applyDirCompare(a.totalTraffic - b.totalTraffic, opts.ipDir);
    }
  });

  const topBase = sortedIp.slice(0, 50);
  const asnResults = await Promise.all(topBase.map((row) => lookupAsnByIp(row.ip)));
  const topIps: TrafficIpRow[] = topBase.map((row, i) => ({
    ...row,
    asn: asnResults[i]?.asn ?? "",
    asnName: asnResults[i]?.asnName ?? "",
  }));

  return {
    window: opts.window,
    tunnelSort: opts.tunnelSort,
    tunnelDir: opts.tunnelDir,
    ipSort: opts.ipSort,
    ipDir: opts.ipDir,
    tunnels,
    topIps,
  };
}

const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
  .container { max-width: 1200px; margin: 0 auto; padding: 6.5rem 2rem 2rem; }
  .topbar {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: 72px;
    background: rgba(15, 23, 42, 0.96);
    border-bottom: 1px solid #334155;
    backdrop-filter: blur(6px);
    z-index: 200;
  }
  .topbar-inner {
    max-width: 1200px;
    height: 100%;
    margin: 0 auto;
    padding: 0 2rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }
  .topbar-left { display:flex; align-items:center; gap:0.65rem; min-width:0; flex-wrap: wrap; }
  .brand { font-size: 1.15rem; font-weight: 800; color: #38bdf8; letter-spacing: 0.02em; }
  .topbar-right { display:flex; align-items:center; gap:0.5rem; margin-left:auto; }
  h1 { font-size: 1.8rem; font-weight: 700; color: #38bdf8; margin-bottom: 0.25rem; }
  h2 { font-size: 1.2rem; font-weight: 600; color: #7dd3fc; margin: 1.5rem 0 0.75rem; }
  h3 { font-size: 1rem; font-weight: 600; color: #bfdbfe; margin: 1rem 0 0.5rem; }
  .subtitle { color: #94a3b8; font-size: 0.9rem; margin-bottom: 2rem; }
  .tabs { display:flex; gap:0.5rem; margin-bottom: 0; }
  .tab { display:inline-block; padding:0.42rem 0.72rem; border:1px solid #334155; border-radius:8px; color:#93c5fd; text-decoration:none; font-size:0.82rem; }
  .tab.active { background:#1d4ed8; border-color:#2563eb; color:#fff; }
  .topbar .btn-danger {
    padding: 0.42rem 0.72rem;
    font-size: 0.82rem;
    border: 1px solid #7f1d1d;
    border-radius: 8px;
    line-height: 1.2;
  }
  table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 8px; overflow: hidden; margin-bottom: 1rem; }
  th { background: #0f172a; padding: 0.75rem 1rem; text-align: left; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: #94a3b8; }
  td { padding: 0.75rem 1rem; border-top: 1px solid #334155; font-size: 0.9rem; }
  tr:hover td { background: #263347; }
  .badge { display: inline-block; padding: 0.2rem 0.6rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600; }
  .badge-green { background: #14532d; color: #4ade80; }
  .badge-gray { background: #1e293b; color: #94a3b8; border: 1px solid #334155; }
  .badge-blue { background: #1e3a5f; color: #60a5fa; }
  .badge-purple { background: #3b0764; color: #c084fc; }
  .card { background: #1e293b; border-radius: 8px; padding: 1.5rem; margin-bottom: 1rem; }
  .card.compact { padding: 1rem 1.1rem; }
  .traffic-layout { display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap:1rem; align-items:start; }
  .traffic-panel { min-width:0; }
  .traffic-controls { display:grid; grid-template-columns: 1fr; gap:0.65rem; margin-bottom:0.85rem; }
  .traffic-controls label { margin-bottom:0.25rem; }
  .traffic-controls select { margin-bottom:0; }
  .traffic-table-wrap { overflow-x:auto; }
  label { display: block; font-size: 0.85rem; color: #94a3b8; margin-bottom: 0.35rem; }
  input, select { width: 100%; padding: 0.5rem 0.75rem; background: #0f172a; border: 1px solid #334155; border-radius: 6px; color: #e2e8f0; font-size: 0.9rem; margin-bottom: 1rem; }
  input:focus, select:focus { outline: none; border-color: #38bdf8; }
  .form-row { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 1rem; }
  .form-row > div { display: flex; flex-direction: column; }
  .form-row > div input, .form-row > div select { margin-bottom: 0; }
  .create-tunnel-grid { display:grid; grid-template-columns: 1.1fr 0.65fr 0.95fr 1.15fr 1fr 1fr; gap:0.75rem; }
  .create-tunnel-grid > div { display:flex; flex-direction:column; }
  .create-tunnel-grid > div input, .create-tunnel-grid > div select { margin-bottom:0; }
  .create-actions { display:flex; justify-content:flex-end; margin-top:0.85rem; }
  @media (max-width: 1050px) {
    .create-tunnel-grid { grid-template-columns: repeat(2, minmax(200px, 1fr)); }
  }
  @media (max-width: 640px) {
    .create-tunnel-grid { grid-template-columns: 1fr; }
  }
  @media (max-width: 980px) {
    .traffic-layout { grid-template-columns: 1fr; }
  }
  button, .btn { padding: 0.5rem 1.25rem; border: none; border-radius: 6px; cursor: pointer; font-size: 0.9rem; font-weight: 600; transition: opacity 0.15s; }
  button:hover, .btn:hover { opacity: 0.85; }
  .btn-primary { background: #0284c7; color: #fff; }
  .btn-danger { background: #b91c1c; color: #fff; padding: 0.3rem 0.75rem; font-size: 0.8rem; }
  .btn-success { background: #15803d; color: #fff; }
  .btn-compact { padding: 0.3rem 0.75rem; font-size: 0.8rem; }
  .btn-edit { background:#0f766e; color:#ecfeff; padding:0.3rem 0.75rem; font-size:0.8rem; }
  .group { margin-top: 1rem; }
  .login-wrap { display: flex; justify-content: center; align-items: center; min-height: 100vh; }
  .login-card { background: #1e293b; border-radius: 12px; padding: 2.5rem; width: 360px; }
  .login-card h1 { margin-bottom: 0.5rem; }
  .login-card .subtitle { margin-bottom: 1.5rem; }
  .alert { padding: 0.75rem 1rem; border-radius: 6px; margin-bottom: 1rem; font-size: 0.9rem; }
  .alert-error { background: #450a0a; color: #fca5a5; border: 1px solid #7f1d1d; }
  .modal-bg { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:100; justify-content:center; align-items:center; }
  .modal-bg.open { display:flex; }
  .modal { background:#1e293b; border-radius:10px; padding:2rem; max-width:560px; width:90%; }
  .modal h2 { margin-top:0; }
  .code-block { background:#0f172a; border:1px solid #334155; border-radius:6px; padding:1rem; font-family:monospace; font-size:0.85rem; word-break:break-all; color:#4ade80; margin:0.5rem 0 1rem; }
  .mt-1 { margin-top:0.5rem; }
  .actions { display:flex; gap:0.5rem; }
  .toast-wrap { position: fixed; top: 88px; right: 16px; z-index: 1000; display:flex; flex-direction:column; gap:0.5rem; max-width:420px; }
  .toast { border-radius:8px; border:1px solid #334155; background:#1e293b; color:#e2e8f0; padding:0.75rem 0.9rem; box-shadow: 0 8px 24px rgba(0,0,0,0.35); font-size:0.88rem; }
  .toast.error { border-color:#7f1d1d; background:#3f1212; color:#fecaca; }
  .toast.success { border-color:#14532d; background:#0f2d1f; color:#86efac; }
`;

function escHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function loginPage(error?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>PrivateFRP Login</title>
<style>${CSS}</style></head>
<body>
<div class="login-wrap">
  <div class="login-card">
    <h1>PrivateFRP</h1>
    <p class="subtitle">Sign in to the dashboard</p>
    ${error ? `<div class="alert alert-error">${error}</div>` : ""}
    <form method="POST" action="/login">
      <label>Username</label>
      <input name="username" type="text" required autofocus autocomplete="username">
      <label>Password</label>
      <input name="password" type="password" required autocomplete="current-password">
      <button class="btn btn-primary" style="width:100%;margin-top:0.5rem" type="submit">Sign In</button>
    </form>
  </div>
</div>
</body></html>`;
}

function pageShell(opts: {
  title: string;
  subtitle: string;
  activeTab: "agents" | "tunnels" | "traffic";
  publicIp: string;
  content: string;
  registerAction?: boolean;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escHtml(opts.title)}</title>
<style>${CSS}</style>
</head>
<body>
<header class="topbar">
  <div class="topbar-inner">
    <div class="topbar-left">
      <div class="brand">PrivateFRP</div>
      <div class="tabs">
        <a class="tab ${opts.activeTab === "agents" ? "active" : ""}" href="/dashboard/agents">Agents</a>
        <a class="tab ${opts.activeTab === "tunnels" ? "active" : ""}" href="/dashboard/tunnels">Tunnels</a>
        <a class="tab ${opts.activeTab === "traffic" ? "active" : ""}" href="/dashboard/traffic">Data Tracking</a>
      </div>
      ${opts.registerAction ? '<a class="tab" href="#" onclick="document.getElementById(\'registerModal\').classList.add(\'open\');return false">Register Agent</a>' : ""}
    </div>
    <div class="topbar-right">
      <form method="POST" action="/logout" style="display:inline">
        <button class="btn btn-danger" type="submit">Sign Out</button>
      </form>
    </div>
  </div>
</header>
<div id="toast-wrap" class="toast-wrap" aria-live="polite" aria-atomic="true"></div>
<script>
(() => {
  const wsProtocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = wsProtocol + '://' + location.host + '/ws/dashboard';
  let ws = null;
  let connectPromise = null;
  let reqSeq = 0;
  const pending = new Map();

  function rejectAllPending(reason) {
    for (const [, entry] of pending) {
      clearTimeout(entry.timeout);
      entry.reject(new Error(reason));
    }
    pending.clear();
  }

  function openSocket() {
    if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve(ws);
    if (connectPromise) return connectPromise;

    connectPromise = new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl);

      socket.onopen = () => {
        ws = socket;
        connectPromise = null;
        resolve(socket);
      };

      socket.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(String(event.data || '{}'));
        } catch {
          return;
        }

        const reqId = typeof msg.reqId === 'string' ? msg.reqId : '';
        if (!reqId) return;

        const entry = pending.get(reqId);
        if (!entry) return;
        pending.delete(reqId);
        clearTimeout(entry.timeout);

        if (msg.ok === false) {
          entry.reject(new Error(String(msg.error || 'WebSocket request failed')));
          return;
        }

        entry.resolve(msg.data);
      };

      socket.onerror = () => {
        if (connectPromise) {
          connectPromise = null;
          reject(new Error('WebSocket connection failed'));
        }
      };

      socket.onclose = () => {
        ws = null;
        rejectAllPending('WebSocket disconnected');
      };
    });

    return connectPromise;
  }

  window.dashboardWsRequest = async function(type, payload) {
    const socket = await openSocket();
    const reqId = 'req-' + (++reqSeq) + '-' + Date.now();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(reqId);
        reject(new Error('WebSocket request timeout'));
      }, 10000);

      pending.set(reqId, { resolve, reject, timeout });
      socket.send(JSON.stringify({ reqId, type, payload: payload || {} }));
    });
  };

  window.showToast = function(message, kind) {
    const wrap = document.getElementById('toast-wrap');
    if (!wrap) return;
    const el = document.createElement('div');
    el.className = 'toast ' + (kind === 'success' ? 'success' : 'error');
    el.textContent = String(message || 'Unexpected error');
    wrap.appendChild(el);
    setTimeout(() => {
      el.remove();
    }, 4200);
  };
})();
</script>
<div class="container">
  ${opts.content}
</div>
</body></html>`;
}

function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  const rounded = value >= 10 || idx === 0 ? value.toFixed(0) : value.toFixed(1);
  return `${rounded} ${units[idx]}`;
}

function trafficPage(
  payload: TrafficPayload,
  publicIp: string,
): string {
  const { window, tunnelSort, tunnelDir, ipSort, ipDir, tunnels, topIps } = payload;
  const byAgent = new Map<string, typeof tunnels>();
  for (const t of tunnels) {
    const key = t.agentName || "Unassigned";
    const list = byAgent.get(key);
    if (list) list.push(t);
    else byAgent.set(key, [t]);
  }

  const rows = Array.from(byAgent.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([agentName, items]) => {
      const itemRows = items
        .map((t) => {
          return `<tr>
            <td>${escHtml(t.name)}</td>
            <td>${escHtml(String(t.type).toUpperCase())}</td>
            <td>${escHtml(fmtBytes(t.incomingTraffic))}</td>
            <td>${escHtml(fmtBytes(t.outgoingTraffic))}</td>
          </tr>`;
        })
        .join("\n");
      return `<tr><td colspan="4" style="background:#111827;color:#93c5fd;font-weight:700;border-top:1px solid #334155">${escHtml(agentName)}</td></tr>${itemRows}`;
    })
    .join("\n");

  const ipRows = topIps
    .map((ip) => {
      const asnLabel = ip.asn
        ? `${escHtml(ip.asn)}${ip.asnName ? ` - ${escHtml(ip.asnName)}` : ""}`
        : "";
      const lastSeenLabel = ip.lastSeen ? new Date(ip.lastSeen * 1000).toLocaleString() : "";
      return `<tr>
        <td><code>${escHtml(ip.ip)}</code></td>
        <td>${escHtml(asnLabel)}</td>
        <td>${escHtml(String(ip.tunnelCount))}</td>
        <td>${escHtml(fmtBytes(ip.incomingTraffic))}</td>
        <td>${escHtml(fmtBytes(ip.outgoingTraffic))}</td>
        <td>${escHtml(fmtBytes(ip.totalTraffic))}</td>
        <td>${escHtml(lastSeenLabel)}</td>
      </tr>`;
    })
    .join("\n");

  return pageShell({
    title: "PrivateFRP - Data Tracking",
    subtitle: "Data Tracking",
    activeTab: "traffic",
    publicIp,
    content: `
  <h1>Data Tracking</h1>
  <div class="card compact" style="max-width:320px">
    <div>
      <label style="margin-bottom:0.25rem">Range</label>
      <select id="traffic-window" style="margin-bottom:0">
        <option value="6h" ${window === "6h" ? "selected" : ""}>Last 6 hours</option>
        <option value="1d" ${window === "1d" ? "selected" : ""}>Last 1 day</option>
        <option value="7d" ${window === "7d" ? "selected" : ""}>Last 7 days</option>
        <option value="1mo" ${window === "1mo" ? "selected" : ""}>Last 1 month</option>
        <option value="6mo" ${window === "6mo" ? "selected" : ""}>Last 6 months</option>
      </select>
    </div>
  </div>

  <div class="traffic-layout">
    <section class="traffic-panel">
      <h2>Top IPs</h2>
      <p style="color:#94a3b8;font-size:0.85rem;margin-bottom:0.75rem">
        Per-IP traffic is tracked across all tunnels. ${ENABLE_IP_ASN_LOOKUP ? "ASN lookups enabled." : "Set IP_ASN_LOOKUP=true on the server to enable ASN/org lookups."}
      </p>
      <div class="card compact traffic-controls">
        <div>
          <label>IP sort</label>
          <select id="ip-sort">
            <option value="total" ${ipSort === "total" ? "selected" : ""}>Total</option>
            <option value="in" ${ipSort === "in" ? "selected" : ""}>Incoming</option>
            <option value="out" ${ipSort === "out" ? "selected" : ""}>Outgoing</option>
            <option value="ip" ${ipSort === "ip" ? "selected" : ""}>IP</option>
            <option value="tunnels" ${ipSort === "tunnels" ? "selected" : ""}>Tunnel count</option>
            <option value="lastSeen" ${ipSort === "lastSeen" ? "selected" : ""}>Last seen</option>
          </select>
        </div>
        <div>
          <label>IP direction</label>
          <select id="ip-dir">
            <option value="desc" ${ipDir === "desc" ? "selected" : ""}>Descending</option>
            <option value="asc" ${ipDir === "asc" ? "selected" : ""}>Ascending</option>
          </select>
        </div>
      </div>
      <div class="traffic-table-wrap">
        <table>
          <thead>
            <tr>
              <th>IP</th>
              <th>ASN / Org</th>
              <th>Tunnels</th>
              <th>Incoming</th>
              <th>Outgoing</th>
              <th>Total</th>
              <th>Last Seen</th>
            </tr>
          </thead>
          <tbody id="top-ips-tbody">${ipRows || '<tr><td colspan="7" style="color:#64748b;text-align:center">No IP traffic captured yet</td></tr>'}</tbody>
        </table>
      </div>
    </section>

    <section class="traffic-panel">
      <h2>Tunnel Totals</h2>
      <div class="card compact traffic-controls">
        <div>
          <label>Tunnel sort</label>
          <select id="tunnel-sort">
            <option value="total" ${tunnelSort === "total" ? "selected" : ""}>Total</option>
            <option value="in" ${tunnelSort === "in" ? "selected" : ""}>Incoming</option>
            <option value="out" ${tunnelSort === "out" ? "selected" : ""}>Outgoing</option>
            <option value="name" ${tunnelSort === "name" ? "selected" : ""}>Name</option>
            <option value="type" ${tunnelSort === "type" ? "selected" : ""}>Type</option>
            <option value="agent" ${tunnelSort === "agent" ? "selected" : ""}>Agent</option>
          </select>
        </div>
        <div>
          <label>Tunnel direction</label>
          <select id="tunnel-dir">
            <option value="desc" ${tunnelDir === "desc" ? "selected" : ""}>Descending</option>
            <option value="asc" ${tunnelDir === "asc" ? "selected" : ""}>Ascending</option>
          </select>
        </div>
      </div>
      <div class="traffic-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Tunnel</th>
              <th>Type</th>
              <th>Incoming traffic</th>
              <th>Outgoing traffic</th>
            </tr>
          </thead>
          <tbody id="traffic-tbody">${rows || '<tr><td colspan="4" style="color:#64748b;text-align:center">No tunnels configured</td></tr>'}</tbody>
        </table>
      </div>
    </section>
  </div>

<script>
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;');
}
function fmtBytes(bytes) {
  const num = Number(bytes || 0);
  if (!Number.isFinite(num) || num <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = num;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  const rounded = value >= 10 || idx === 0 ? value.toFixed(0) : value.toFixed(1);
  return rounded + ' ' + units[idx];
}
async function refreshTraffic() {
  try {
    const trafficWindow = document.getElementById('traffic-window').value;
    const tunnelSort = document.getElementById('tunnel-sort').value;
    const tunnelDir = document.getElementById('tunnel-dir').value;
    const ipSort = document.getElementById('ip-sort').value;
    const ipDir = document.getElementById('ip-dir').value;
    const payload = await window.dashboardWsRequest('traffic', {
      window: trafficWindow,
      tunnelSort,
      tunnelDir,
      ipSort,
      ipDir,
    });
    const tunnels = Array.isArray(payload) ? payload : (payload.tunnels || []);
    const topIps = Array.isArray(payload) ? [] : (payload.topIps || []);
    const ipTbody = document.getElementById('top-ips-tbody');
    const tbody = document.getElementById('traffic-tbody');

    if (!topIps.length) {
      ipTbody.innerHTML = '<tr><td colspan="7" style="color:#64748b;text-align:center">No IP traffic captured yet</td></tr>';
    } else {
      ipTbody.innerHTML = topIps.map(ip => {
        const asn = ip.asn ? String(ip.asn) + (ip.asnName ? ' - ' + String(ip.asnName) : '') : '';
        const lastSeen = ip.lastSeen ? new Date(Number(ip.lastSeen) * 1000).toLocaleString() : '';
        return '<tr>' +
          '<td><code>' + esc(ip.ip) + '</code></td>' +
          '<td>' + esc(asn) + '</td>' +
          '<td>' + esc(String(ip.tunnelCount || 0)) + '</td>' +
          '<td>' + esc(fmtBytes(ip.incomingTraffic)) + '</td>' +
          '<td>' + esc(fmtBytes(ip.outgoingTraffic)) + '</td>' +
          '<td>' + esc(fmtBytes(ip.totalTraffic)) + '</td>' +
          '<td>' + esc(lastSeen) + '</td>' +
        '</tr>';
      }).join('');
    }

    if (!tunnels.length) {
      tbody.innerHTML = '<tr><td colspan="4" style="color:#64748b;text-align:center">No tunnels configured</td></tr>';
      return;
    }
    const byAgent = {};
    tunnels.forEach(t => {
      const key = t.agentName || 'Unassigned';
      if (!byAgent[key]) byAgent[key] = [];
      byAgent[key].push(t);
    });
    const groups = Object.keys(byAgent).sort();
    tbody.innerHTML = groups.map(agentName => {
      const groupHeader = '<tr><td colspan="4" style="background:#111827;color:#93c5fd;font-weight:700;border-top:1px solid #334155">' + esc(agentName) + '</td></tr>';
      const rows = byAgent[agentName].map(t => {
        return '<tr>' +
          '<td>' + esc(t.name) + '</td>' +
          '<td>' + esc(String(t.type || '').toUpperCase()) + '</td>' +
          '<td>' + esc(fmtBytes(t.incomingTraffic)) + '</td>' +
          '<td>' + esc(fmtBytes(t.outgoingTraffic)) + '</td>' +
        '</tr>';
      }).join('');
      return groupHeader + rows;
    }).join('');
  } catch (_) {}
}

['traffic-window', 'tunnel-sort', 'tunnel-dir', 'ip-sort', 'ip-dir'].forEach((id) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', refreshTraffic);
});

refreshTraffic();
setInterval(refreshTraffic, 1000);
</script>
`,
  });
}

function agentsPage(
  agents: Array<{
    id: string;
    name: string;
    enabled: boolean;
    connected: boolean;
    activeConnections: number;
    latencyMs: number | null;
    lastHeartbeat: number;
    remoteAddress: string;
  }>,
  publicIp: string,
): string {
  const agentRows = agents
    .map((a) => {
      const status = !a.enabled
        ? `<span class="badge badge-red">Disabled</span>`
        : a.connected
        ? `<span class="badge badge-green">Connected</span>`
        : `<span class="badge badge-gray">Offline</span>`;
      const latency = a.latencyMs === null || a.latencyMs === undefined
        ? "-"
        : `${Math.max(0, Math.round(a.latencyMs))} ms`;
      const hb = a.lastHeartbeat ? new Date(a.lastHeartbeat).toLocaleString() : "";
      return `<tr>
        <td><code style="font-size:0.78rem">${escHtml(a.id)}</code></td>
        <td>${escHtml(a.name)}</td>
        <td>${status}</td>
        <td>${latency}</td>
        <td>${a.activeConnections}</td>
        <td>${escHtml(a.remoteAddress) || ""}</td>
        <td>${hb}</td>
        <td>
          <button class="btn btn-compact ${a.enabled ? "btn-danger" : "btn-success"}" data-agent-id="${escHtml(a.id)}" data-agent-enabled="${a.enabled ? "1" : "0"}" onclick="toggleAgentEnabled(this.dataset.agentId,this.dataset.agentEnabled)">${a.enabled ? "Disable" : "Enable"}</button>
          <button class="btn btn-danger" data-agent-id="${escHtml(a.id)}" data-agent-name="${escHtml(a.name)}" onclick="deleteAgent(this.dataset.agentId,this.dataset.agentName)">Delete</button>
        </td>
      </tr>`;
    })
    .join("\n");
  return pageShell({
    title: "PrivateFRP - Agents",
    subtitle: "Agents",
    activeTab: "agents",
    publicIp,
    registerAction: false,
    content: `
  <h1>Agents</h1>
  <table>
    <thead><tr><th>ID</th><th>Name</th><th>Status</th><th>Latency</th><th>Current Connections</th><th>IP Address</th><th>Last Heartbeat</th><th>Actions</th></tr></thead>
    <tbody id="agents-tbody">${agentRows || '<tr><td colspan="8" style="color:#64748b;text-align:center">No agents registered</td></tr>'}</tbody>
  </table>

  <div class="card">
    <h3 style="margin-top:0">Register Agent</h3>
    <p style="color:#94a3b8;font-size:0.9rem;margin-bottom:1rem">Create a new agent credential pair for a machine you want to connect.</p>
    <button class="btn btn-primary" onclick="document.getElementById('registerModal').classList.add('open')">Register New Agent</button>
  </div>

  <div class="modal-bg" id="registerModal" onclick="if(event.target===this)this.classList.remove('open')">
    <div class="modal">
      <h2>Register New Agent</h2>
      <p style="color:#94a3b8;margin:0.5rem 0 1rem;font-size:0.9rem">Give your agent a name and click Generate to get its credentials.</p>
      <label>Agent Name</label>
      <input id="regName" placeholder="my-home-server" style="margin-bottom:1rem">
      <div id="regResult" style="display:none">
        <label>Agent ID</label><div class="code-block" id="regId"></div>
        <label>Agent Secret</label><div class="code-block" id="regSecret"></div>
        <p style="color:#fbbf24;font-size:0.8rem"> Copy the secret now  it won't be shown again.</p>
      </div>
      <div class="actions mt-1">
        <button class="btn btn-success" onclick="registerAgent()">Generate</button>
        <button class="btn" style="background:#334155" onclick="document.getElementById('registerModal').classList.remove('open')">Close</button>
      </div>
    </div>
  </div>

<script>
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;');
}
function normalizeIp(ip) {
  if (!ip) return '';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}
async function refreshAgents() {
  try {
    const agents = await window.dashboardWsRequest('agents', {});
    const tbody = document.getElementById('agents-tbody');
    if (!agents.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="color:#64748b;text-align:center">No agents registered</td></tr>';
      return;
    }
    tbody.innerHTML = agents.map(a => {
      const status = !a.enabled
        ? '<span class="badge badge-red">Disabled</span>'
        : a.connected
        ? '<span class="badge badge-green">Connected</span>'
        : '<span class="badge badge-gray">Offline</span>';
      const latency = a.latencyMs === null || a.latencyMs === undefined
        ? '-'
        : Math.max(0, Math.round(Number(a.latencyMs))) + ' ms';
      const hb = a.lastHeartbeat ? new Date(a.lastHeartbeat).toLocaleString() : '—';
      return \`<tr>
        <td><code style="font-size:0.78rem">\${esc(a.id)}</code></td>
        <td>\${esc(a.name)}</td>
        <td>\${status}</td>
        <td>\${latency}</td>
        <td>\${Number(a.activeConnections || 0)}</td>
        <td>\${esc(normalizeIp(a.remoteAddress || '')) || '—'}</td>
        <td>\${hb}</td>
        <td>
          <button class="btn btn-compact \${a.enabled ? 'btn-danger' : 'btn-success'}" data-agent-id="\${esc(a.id)}" data-agent-enabled="\${a.enabled ? '1' : '0'}" onclick="toggleAgentEnabled(this.dataset.agentId,this.dataset.agentEnabled)">\${a.enabled ? 'Disable' : 'Enable'}</button>
          <button class="btn btn-danger" data-agent-id="\${esc(a.id)}" data-agent-name="\${esc(a.name)}" onclick="deleteAgent(this.dataset.agentId,this.dataset.agentName)">Delete</button>
        </td>
      </tr>\`;
    }).join('');
  } catch (_) {}
}

async function toggleAgentEnabled(id, enabledFlag) {
  const currentlyEnabled = enabledFlag === '1';
  const res = await fetch('/api/agents/' + encodeURIComponent(id) + '/enabled', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: !currentlyEnabled }),
  });
  if (!res.ok) {
    window.showToast('Failed to update agent state');
    return;
  }
  await refreshAgents();
}

async function deleteAgent(id, name) {
  if (!confirm("Delete agent '" + name + "'? This will unassign its tunnels.")) return;
  const res = await fetch('/api/agents/' + encodeURIComponent(id) + '/delete', { method: 'POST' });
  if (!res.ok) { window.showToast('Failed to delete agent'); return; }
  await refreshAgents();
}

async function registerAgent() {
  const name = document.getElementById('regName').value.trim();
  const params = name ? '?name=' + encodeURIComponent(name) : '';
  const res = await fetch('/api/agents/register' + params, { method: 'POST' });
  const data = await res.json();
  document.getElementById('regId').textContent = data.agentId;
  document.getElementById('regSecret').textContent = data.agentSecret;
  document.getElementById('regResult').style.display = 'block';
  await refreshAgents();
}

refreshAgents();
setInterval(refreshAgents, 1000);
</script>
`,
  });
}

function tunnelsPage(
  agents: Array<{ id: string; name: string }>,
  tunnels: Array<{
    id: string;
    name: string;
    type: string;
    listenPort: number;
    targetHost: string;
    targetPort: number;
    agentId: string;
    enabled: boolean;
  }>,
  publicIp: string,
): string {
  const safeAgents = JSON.stringify(agents);
  const safeTunnels = JSON.stringify(tunnels);

  return pageShell({
    title: "PrivateFRP - Tunnels",
    subtitle: "Tunnels",
    activeTab: "tunnels",
    publicIp,
    content: `
  <h1>Tunnels</h1>
  <h2>All Tunnels</h2>
  <div id="groups"></div>

  <h2>Create Tunnel</h2>
  <div class="card compact">
    <form id="createTunnelForm" onsubmit="createTunnel(event)">
      <div class="create-tunnel-grid">
        <div><label>Agent</label><select name="agentId" id="agentSelect"></select></div>
        <div><label>Type</label>
          <select name="type">
            <option value="tcp">TCP</option>
            <option value="udp">UDP</option>
          </select>
        </div>
        <div><label>Name</label><input name="name" placeholder="my-tunnel" required></div>
        <div><label>Public Port</label><input name="listenPort" type="number" min="1" max="65535" placeholder="8080" required></div>
        <div><label>Local Service Host</label><input name="targetHost" placeholder="localhost" required></div>
        <div><label>Local Service Port</label><input name="targetPort" type="number" min="1" max="65535" placeholder="3000" required></div>
      </div>
      <div class="create-actions">
        <button class="btn btn-primary" type="submit">Create Tunnel</button>
      </div>
    </form>
  </div>

  <div class="modal-bg" id="editTunnelModal" onclick="if(event.target===this)this.classList.remove('open')">
    <div class="modal">
      <h2>Edit Tunnel</h2>
      <form id="editTunnelForm" onsubmit="saveTunnelEdit(event)">
        <input type="hidden" name="id" id="editTunnelId">
        <label>Name</label><input name="name" id="editName" required>
        <label>Type</label>
        <select name="type" id="editType">
          <option value="tcp">TCP</option>
          <option value="udp">UDP</option>
        </select>
        <label>Public Port</label><input name="listenPort" id="editListenPort" type="number" min="1" max="65535" required>
        <label>Local Service Host</label><input name="targetHost" id="editTargetHost" required>
        <label>Local Service Port</label><input name="targetPort" id="editTargetPort" type="number" min="1" max="65535" required>
        <label>Agent</label><select name="agentId" id="editAgentId"></select>
        <div class="actions mt-1">
          <button class="btn btn-success" type="submit">Save</button>
          <button class="btn" style="background:#334155" type="button" onclick="document.getElementById('editTunnelModal').classList.remove('open')">Cancel</button>
        </div>
      </form>
    </div>
  </div>

<script>
const PUBLIC_IP = ${JSON.stringify(publicIp)};
let AGENTS = ${safeAgents};
let TUNNELS = ${safeTunnels};
let agentSelectsFrozen = false;

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;');
}

function updateAgentSelects() {
  const unassignedOption = '<option value="">Unassigned</option>';
  const agentOptions = AGENTS.length
    ? AGENTS.map(a => \`<option value="\${esc(a.id)}">\${esc(a.name)} (\${esc(a.id.slice(0,8))})</option>\`).join('')
    : '';
  const options = unassignedOption + agentOptions;
  document.getElementById('agentSelect').innerHTML = options;
  document.getElementById('editAgentId').innerHTML = options;
}

function renderGroups() {
  const byAgent = {};
  for (const t of TUNNELS) {
    if (!byAgent[t.agentId]) byAgent[t.agentId] = [];
    byAgent[t.agentId].push(t);
  }

  const agentName = {};
  AGENTS.forEach(a => { agentName[a.id] = a.name; });
  agentName[''] = 'Unassigned';

  const orderedAgentIds = [
    '',
    ...AGENTS.map(a => a.id),
    ...Object.keys(byAgent).filter(id => id !== '' && !agentName[id]),
  ];
  const groupsEl = document.getElementById('groups');

  if (!TUNNELS.length) {
    groupsEl.innerHTML = '<div class="card" style="color:#64748b;text-align:center">No tunnels configured</div>';
    return;
  }

  groupsEl.innerHTML = orderedAgentIds
    .filter(id => (byAgent[id] || []).length > 0)
    .map(id => {
      const rows = byAgent[id].map(t => {
        const badge = t.type === 'tcp'
          ? '<span class="badge badge-blue">TCP</span>'
          : '<span class="badge badge-purple">UDP</span>';
        const stateBadge = t.enabled
          ? '<span class="badge badge-green">Enabled</span>'
          : '<span class="badge badge-gray">Disabled</span>';
        const publicAddr = PUBLIC_IP ? esc(PUBLIC_IP) + ':' + t.listenPort : t.listenPort;
        const toggleClass = t.enabled ? 'btn-danger' : 'btn-success';
        const toggleLabel = t.enabled ? 'Disable' : 'Enable';
        return \`<tr>
          <td>\${esc(t.name)}</td>
          <td>\${badge} \${stateBadge}</td>
          <td><code>\${publicAddr}</code></td>
          <td>\${esc(t.targetHost)}:\${t.targetPort}</td>
          <td>
            <button class="btn btn-edit" onclick="openEditTunnel('\${esc(t.id)}')">Edit</button>
            <button class="btn btn-compact \${toggleClass}" onclick="toggleTunnelEnabled('\${esc(t.id)}', \${t.enabled ? 'true' : 'false'})">\${toggleLabel}</button>
            <button class="btn btn-danger" data-tunnel-id="\${esc(t.id)}" data-tunnel-name="\${esc(t.name)}" onclick="deleteTunnel(this.dataset.tunnelId,this.dataset.tunnelName)">Delete</button>
          </td>
        </tr>\`;
      }).join('');
      return \`<div class="group">
        <h3>\${esc(agentName[id] || ('Unknown Agent: ' + id))}</h3>
        <table>
          <thead><tr><th>Name</th><th>Type</th><th>Public Port</th><th>Local Service</th><th>Actions</th></tr></thead>
          <tbody>\${rows}</tbody>
        </table>
      </div>\`;
    }).join('');
}

function openEditTunnel(id) {
  const t = TUNNELS.find(x => x.id === id);
  if (!t) return;
  document.getElementById('editTunnelId').value = t.id;
  document.getElementById('editName').value = t.name;
  document.getElementById('editType').value = t.type;
  document.getElementById('editListenPort').value = t.listenPort;
  document.getElementById('editTargetHost').value = t.targetHost;
  document.getElementById('editTargetPort').value = t.targetPort;
  document.getElementById('editAgentId').value = t.agentId;
  document.getElementById('editTunnelModal').classList.add('open');
}

async function saveTunnelEdit(e) {
  e.preventDefault();
  const form = e.target;
  const id = form.id.value;
  const payload = {
    name: form.name.value,
    type: form.type.value,
    listenPort: form.listenPort.value,
    targetHost: form.targetHost.value,
    targetPort: form.targetPort.value,
    agentId: form.agentId.value
  };

  const res = await fetch('/api/tunnels/' + encodeURIComponent(id), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Update failed' }));
    window.showToast('Error: ' + (err.error || res.status));
    return;
  }
  document.getElementById('editTunnelModal').classList.remove('open');
  await refreshData();
}

async function createTunnel(e) {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  const res = await fetch('/api/tunnels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (res.ok) {
    e.target.reset();
    await refreshData();
  } else {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    window.showToast('Error: ' + (err.error || res.status));
  }
}

async function deleteTunnel(id, name) {
  if (!confirm("Delete tunnel '" + name + "'?")) return;
  const res = await fetch('/api/tunnels/' + encodeURIComponent(id), { method: 'DELETE' });
  if (!res.ok) { window.showToast('Failed to delete tunnel'); return; }
  await refreshData();
}

async function toggleTunnelEnabled(id, currentlyEnabled) {
  const nextEnabled = !currentlyEnabled;
  const res = await fetch('/api/tunnels/' + encodeURIComponent(id) + '/enabled', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: nextEnabled })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Toggle failed' }));
    window.showToast('Error: ' + (err.error || res.status));
    return;
  }
  await refreshData();
}

async function refreshData() {
  try {
    const [agents, tunnels] = await Promise.all([
      window.dashboardWsRequest('agents', {}),
      window.dashboardWsRequest('tunnels', {}),
    ]);
    AGENTS = agents;
    TUNNELS = tunnels;
    const createSelect = document.getElementById('agentSelect');
    const editSelect = document.getElementById('editAgentId');

    // Once a specific agent is selected, freeze option list updates to avoid
    // live-refresh replacing the user's in-progress selection context.
    if (!agentSelectsFrozen) {
      const createVal = createSelect ? String(createSelect.value || '') : '';
      const editVal = editSelect ? String(editSelect.value || '') : '';
      if (createVal !== '' || editVal !== '') {
        agentSelectsFrozen = true;
      }
    }

    if (!agentSelectsFrozen) {
      updateAgentSelects();
    }
    renderGroups();
  } catch (_) {}
}

refreshData();
setInterval(refreshData, 500);
</script>
`,
  });
}

function buildAgentsPayload(db: DB, agentManager: AgentManager): Array<{
  id: string;
  name: string;
  enabled: boolean;
  connected: boolean;
  activeConnections: number;
  latencyMs: number | null;
  remoteAddress: string | null;
  lastHeartbeat: number | null;
  createdAt: number;
}> {
  const dbAgents = db.listAgents();
  const connectedMap = new Map(agentManager.getAll().map((a) => [a.agentId, a]));
  return dbAgents.map((a) => {
    const connected = connectedMap.get(a.id);
    return {
      id: a.id,
      name: a.name,
      enabled: !!a.enabled,
      connected: !!connected && !!a.enabled,
      activeConnections: connected?.activeConnections ?? 0,
      latencyMs: connected?.lastLatencyMs ?? null,
      remoteAddress: normalizeRemoteIp(connected?.remoteAddress ?? null),
      lastHeartbeat: connected?.lastHeartbeat ?? null,
      createdAt: a.created_at,
    };
  });
}

function buildTunnelsPayload(db: DB): Array<ReturnType<DB["rowToTunnelConfig"]> & { enabled: boolean }> {
  return db.listTunnels().map((t) => ({
    ...db.rowToTunnelConfig(t),
    enabled: !!t.enabled,
  }));
}

function isListenPortInUse(db: DB, listenPort: number, excludeTunnelId?: string): boolean {
  return db.listTunnels().some((t) => t.listen_port === listenPort && t.id !== (excludeTunnelId ?? ""));
}

type DashboardWsRequest = {
  reqId?: unknown;
  type?: unknown;
  payload?: unknown;
};

type DashboardWsData = { user: string };

export function startDashboard(opts: {
  port: number;
  credentials: { user: string; pass: string };
  db: DB;
  agentManager: AgentManager;
  publicIp: string;
  reservedPublicPorts?: number[];
  onTunnelsChanged: () => Promise<void>;
}): void {
  const { port, credentials, db, agentManager, publicIp, reservedPublicPorts, onTunnelsChanged } = opts;
  const envAgentPort = Number.parseInt(process.env.AGENT_PORT ?? "7000", 10);
  const blockedPrivilegedPortMax = 1023;
  const allowedPrivilegedPorts = new Set<number>([80, 443]);
  const reservedPorts = new Set<number>(
    [
      ...(reservedPublicPorts ?? []),
      port,
      Number.isFinite(envAgentPort) ? envAgentPort : 7000,
    ].filter((p) => Number.isFinite(p) && p > 0 && p <= 65535),
  );

  Bun.serve({
    port,
    websocket: {
      async message(ws, message) {
        const send = (body: unknown) => ws.send(JSON.stringify(body));

        let req: DashboardWsRequest;
        try {
          req = JSON.parse(String(message));
        } catch {
          send({ ok: false, error: "Invalid JSON" });
          return;
        }

        const reqId = typeof req.reqId === "string" ? req.reqId : "";
        const reqType = typeof req.type === "string" ? req.type : "";
        const payload = (req.payload ?? {}) as Record<string, unknown>;
        if (!reqId || !reqType) {
          send({ reqId, ok: false, error: "Missing reqId or type" });
          return;
        }

        try {
          if (reqType === "agents") {
            send({ reqId, ok: true, data: buildAgentsPayload(db, agentManager) });
            return;
          }

          if (reqType === "tunnels") {
            send({ reqId, ok: true, data: buildTunnelsPayload(db) });
            return;
          }

          if (reqType === "traffic") {
            const window = parseTrafficWindow(typeof payload.window === "string" ? payload.window : null);
            const tunnelSort = parseTunnelSort(typeof payload.tunnelSort === "string" ? payload.tunnelSort : null);
            const tunnelDir = parseSortDir(typeof payload.tunnelDir === "string" ? payload.tunnelDir : null);
            const ipSort = parseIpSort(typeof payload.ipSort === "string" ? payload.ipSort : null);
            const ipDir = parseSortDir(typeof payload.ipDir === "string" ? payload.ipDir : null);

            const traffic = await buildTrafficPayload(db, { window, tunnelSort, tunnelDir, ipSort, ipDir });
            send({ reqId, ok: true, data: traffic });
            return;
          }

          send({ reqId, ok: false, error: "Unknown request type" });
        } catch (err) {
          webLog.error(`[Dashboard] websocket ${reqType} failed:`, err);
          send({ reqId, ok: false, error: "Internal server error" });
        }
      },
    },
    async fetch(req: Request, server: ReturnType<typeof Bun.serve>) {
      const method = req.method || "GET";
      const ip = getRequestIp(req, (request) => {
        const runtimeIp = (server as any)?.requestIP?.(request)?.address as string | undefined;
        return runtimeIp ?? null;
      });
      const userAgent = getRequestUserAgent(req);
      const url = parseRequestUrl(req);
      if (!url) {
        webLog.warn(`${method} <invalid-url> ${ip} ${userAgent}`);
        return new Response("Bad Request", { status: 400 });
      }

      const cookie = req.headers.get("cookie");
      webLog.log(`${method} ${url.pathname} ${ip} ${userAgent}`);

      try {
        if (url.pathname === "/login") {
          if (req.method === "GET") return html(loginPage());
          if (req.method === "POST") {
            const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
            const isForm = contentType.includes("application/x-www-form-urlencoded") ||
              contentType.includes("multipart/form-data");
            if (!isForm) {
              webLog.warn(`[Dashboard] ${method} ${url.pathname} invalid login content-type: ${contentType || "none"}`);
              return html(loginPage("Invalid login request"), 400);
            }

            let form: FormData;
            try {
              form = await req.formData();
            } catch {
              webLog.warn(`[Dashboard] ${method} ${url.pathname} invalid login form body`);
              return html(loginPage("Invalid login request"), 400);
            }

            const user = form.get("username")?.toString() ?? "";
            const pass = form.get("password")?.toString() ?? "";
            if (user === credentials.user && pass === credentials.pass) {
              const sid = createSession(user);
              return new Response(null, {
                status: 302,
                headers: {
                  Location: "/dashboard/agents",
                  "Set-Cookie": `session=${sid}; Path=/; HttpOnly; SameSite=Lax`,
                },
              });
            }
            webLog.warn(`[Dashboard] ${method} ${url.pathname} login rejected for user=${user || "<empty>"}`);
            return html(loginPage("Invalid username or password"), 401);
          }
        }

        if (url.pathname === "/logout" && req.method === "POST") {
          deleteSession(cookie);
          return new Response(null, {
            status: 302,
            headers: {
              Location: "/login",
              "Set-Cookie": "session=; Path=/; HttpOnly; Max-Age=0",
            },
          });
        }

        if (url.pathname === "/" || url.pathname === "") {
          const user = validateSession(cookie);
          return new Response(null, {
            status: 302,
            headers: { Location: user ? "/dashboard/agents" : "/login" },
          });
        }

        if (url.pathname === "/ws/dashboard") {
          const user = validateSession(cookie);
          if (!user) return new Response("Unauthorized", { status: 401 });

          const upgraded = server.upgrade<DashboardWsData>(req, { data: { user } });
          if (upgraded) return;
          return new Response("WebSocket upgrade failed", { status: 500 });
        }

        const user = validateSession(cookie);
        if (!user) {
          if (url.pathname.startsWith("/api/")) return json({ error: "Unauthorized" }, 401);
          return new Response(null, { status: 302, headers: { Location: "/login" } });
        }

        if ((url.pathname === "/dashboard" || url.pathname === "/dashboard/agents") && req.method === "GET") {
        const agentsView = buildAgentsPayload(db, agentManager).map((a) => {
          return {
            id: a.id,
            name: a.name,
            enabled: a.enabled,
            connected: a.connected,
            activeConnections: a.activeConnections,
            latencyMs: a.latencyMs,
            lastHeartbeat: a.lastHeartbeat ?? 0,
            remoteAddress: a.remoteAddress ?? "",
          };
        });
        return html(agentsPage(agentsView, publicIp));
        }

        if (url.pathname === "/dashboard/tunnels" && req.method === "GET") {
        const dbAgents = db.listAgents().map((a) => ({ id: a.id, name: a.name }));
        const tunnelRows = db.listTunnels().map((t) => ({
          id: t.id,
          name: t.name,
          type: t.type,
          listenPort: t.listen_port,
          targetHost: t.target_host,
          targetPort: t.target_port,
          agentId: t.agent_id,
          enabled: !!t.enabled,
        }));
        return html(tunnelsPage(dbAgents, tunnelRows, publicIp));
        }

        if (url.pathname === "/dashboard/traffic" && req.method === "GET") {
        const payload = await buildTrafficPayload(db, {
          window: parseTrafficWindow(url.searchParams.get("window")),
          tunnelSort: parseTunnelSort(url.searchParams.get("tunnelSort")),
          tunnelDir: parseSortDir(url.searchParams.get("tunnelDir")),
          ipSort: parseIpSort(url.searchParams.get("ipSort")),
          ipDir: parseSortDir(url.searchParams.get("ipDir")),
        });
        return html(trafficPage(payload, publicIp));
        }

        if (url.pathname === "/api/agents" && req.method === "GET") {
        return json(buildAgentsPayload(db, agentManager));
        }

        const setAgentEnabledMatch = req.method === "POST"
          ? url.pathname.match(/^\/api\/agents\/([^/]+)\/enabled$/)
          : null;
        if (setAgentEnabledMatch) {
          const id = setAgentEnabledMatch[1];
          const existing = db.getAgent(id);
          if (!existing) return json({ error: "Agent not found" }, 404);

          const body = await req.json().catch(() => null) as { enabled?: unknown } | null;
          if (!body || typeof body.enabled !== "boolean") {
            return json({ error: "enabled must be boolean" }, 400);
          }

          const updated = db.setAgentEnabled(id, body.enabled);
          if (!updated) return json({ error: "Agent not found" }, 404);

          await onTunnelsChanged();
          return json({
            id: updated.id,
            name: updated.name,
            enabled: !!updated.enabled,
          });
        }

        if (url.pathname === "/api/agents/register" && (req.method === "GET" || req.method === "POST")) {
        const agentId = generateAgentId(db);
        const agentSecret = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
        const agentName = url.searchParams.get("name")?.trim() || `agent-${agentId.slice(0, 8)}`;
        db.createAgent(agentId, agentName, agentSecret);
        return json({ agentId, agentName, agentSecret });
        }

        if (url.pathname === "/api/tunnels" && req.method === "GET") {
          return json(buildTunnelsPayload(db));
        }

        if (url.pathname === "/api/traffic" && req.method === "GET") {
          return json(
            await buildTrafficPayload(db, {
              window: parseTrafficWindow(url.searchParams.get("window")),
              tunnelSort: parseTunnelSort(url.searchParams.get("tunnelSort")),
              tunnelDir: parseSortDir(url.searchParams.get("tunnelDir")),
              ipSort: parseIpSort(url.searchParams.get("ipSort")),
              ipDir: parseSortDir(url.searchParams.get("ipDir")),
            }),
          );
        }

        if (url.pathname === "/api/tunnels" && req.method === "POST") {
        let body: Record<string, string>;
        const contentType = req.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          body = await req.json();
        } else {
          const form = await req.formData();
          body = Object.fromEntries(Array.from(form.entries()).map(([k, v]) => [k, v.toString()]));
        }

        const { name, type, listenPort, targetHost, targetPort, agentId } = body;
        if (!name || !type || !listenPort || !targetHost || !targetPort || agentId === undefined) {
          return json({ error: "Missing required fields" }, 400);
        }
        if (type !== "tcp" && type !== "udp") return json({ error: "type must be tcp or udp" }, 400);
        const listenPortNum = Number.parseInt(listenPort, 10);
        const targetPortNum = Number.parseInt(targetPort, 10);
        if (!Number.isInteger(listenPortNum) || listenPortNum < 1 || listenPortNum > 65535) {
          return json({ error: "listenPort must be 1-65535" }, 400);
        }
        if (!Number.isInteger(targetPortNum) || targetPortNum < 1 || targetPortNum > 65535) {
          return json({ error: "targetPort must be 1-65535" }, 400);
        }
        if (
          listenPortNum >= 1 &&
          listenPortNum <= blockedPrivilegedPortMax &&
          !allowedPrivilegedPorts.has(listenPortNum)
        ) {
          return json({ error: `Public port ${listenPortNum} is a reserved system port (1-1023)` }, 400);
        }
        if (isListenPortInUse(db, listenPortNum)) {
          return json({ error: `Public port ${listenPortNum} is already used by another tunnel` }, 409);
        }
        if (reservedPorts.has(listenPortNum)) {
          return json({ error: `Public port ${listenPortNum} is reserved by server configuration` }, 400);
        }
        if (agentId && !db.getAgent(agentId)) return json({ error: "Agent not found" }, 404);

        const id = crypto.randomUUID();
        const row = db.createTunnel(id, name, type, listenPortNum, targetHost, targetPortNum, agentId);
        await onTunnelsChanged();
        return json(db.rowToTunnelConfig(row), 201);
        }

        const updateTunnelMatch = (req.method === "PUT" || req.method === "PATCH")
          ? url.pathname.match(/^\/api\/tunnels\/([^/]+)$/)
          : null;
        if (updateTunnelMatch) {
        const id = updateTunnelMatch[1];
        if (!db.getTunnel(id)) return json({ error: "Tunnel not found" }, 404);

        let body: Record<string, string>;
        const contentType = req.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          body = await req.json();
        } else {
          const form = await req.formData();
          body = Object.fromEntries(Array.from(form.entries()).map(([k, v]) => [k, v.toString()]));
        }

        const { name, type, listenPort, targetHost, targetPort, agentId } = body;
        if (!name || !type || !listenPort || !targetHost || !targetPort || agentId === undefined) {
          return json({ error: "Missing required fields" }, 400);
        }
        if (type !== "tcp" && type !== "udp") return json({ error: "type must be tcp or udp" }, 400);
        const listenPortNum = Number.parseInt(listenPort, 10);
        const targetPortNum = Number.parseInt(targetPort, 10);
        if (!Number.isInteger(listenPortNum) || listenPortNum < 1 || listenPortNum > 65535) {
          return json({ error: "listenPort must be 1-65535" }, 400);
        }
        if (!Number.isInteger(targetPortNum) || targetPortNum < 1 || targetPortNum > 65535) {
          return json({ error: "targetPort must be 1-65535" }, 400);
        }
        if (
          listenPortNum >= 1 &&
          listenPortNum <= blockedPrivilegedPortMax &&
          !allowedPrivilegedPorts.has(listenPortNum)
        ) {
          return json({ error: `Public port ${listenPortNum} is a reserved system port (1-1023)` }, 400);
        }
        if (isListenPortInUse(db, listenPortNum, id)) {
          return json({ error: `Public port ${listenPortNum} is already used by another tunnel` }, 409);
        }
        if (reservedPorts.has(listenPortNum)) {
          return json({ error: `Public port ${listenPortNum} is reserved by server configuration` }, 400);
        }
        if (agentId && !db.getAgent(agentId)) return json({ error: "Agent not found" }, 404);

        const updated = db.updateTunnel(id, name, type, listenPortNum, targetHost, targetPortNum, agentId);
        await onTunnelsChanged();
        if (!updated) return json({ error: "Tunnel not found" }, 404);
        return json(db.rowToTunnelConfig(updated));
        }

        const deleteTunnelMatch = url.pathname.match(/^\/api\/tunnels\/([^/]+)\/delete$/) ||
          (req.method === "DELETE" && url.pathname.match(/^\/api\/tunnels\/([^/]+)$/));
        if (deleteTunnelMatch) {
        const id = deleteTunnelMatch[1];
        if (!db.getTunnel(id)) return json({ error: "Tunnel not found" }, 404);
        db.deleteTunnel(id);
        await onTunnelsChanged();
        return json({ ok: true });
        }

        const setTunnelEnabledMatch = req.method === "POST"
          ? url.pathname.match(/^\/api\/tunnels\/([^/]+)\/enabled$/)
          : null;
        if (setTunnelEnabledMatch) {
          const id = setTunnelEnabledMatch[1];
          const existing = db.getTunnel(id);
          if (!existing) return json({ error: "Tunnel not found" }, 404);

          const body = await req.json().catch(() => null) as { enabled?: unknown } | null;
          if (!body || typeof body.enabled !== "boolean") {
            return json({ error: "enabled must be boolean" }, 400);
          }

          const updated = db.setTunnelEnabled(id, body.enabled);
          await onTunnelsChanged();
          if (!updated) return json({ error: "Tunnel not found" }, 404);
          return json({
            ...db.rowToTunnelConfig(updated),
            enabled: !!updated.enabled,
          });
        }

        const deleteAgentMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/delete$/) ||
          (req.method === "DELETE" && url.pathname.match(/^\/api\/agents\/([^/]+)$/));
        if (deleteAgentMatch) {
        const id = deleteAgentMatch[1];
        if (!db.getAgent(id)) return json({ error: "Agent not found" }, 404);
        db.unassignTunnelsForAgent(id);
        db.deleteAgent(id);
        agentManager.unregister(id);
        await onTunnelsChanged();
        return json({ ok: true });
        }

        return new Response("Not Found", { status: 404 });
      } catch (err) {
        webLog.error(`[Dashboard] ${method} ${url.pathname} failed:`, err);
        return json({ error: "Internal server error" }, 500);
      }
    },
  });

  webLog.log(`[Dashboard] Listening on http://0.0.0.0:${port}`);
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parseRequestUrl(req: Request): URL | null {
  try {
    const host = req.headers.get("host") || "localhost";
    return new URL(req.url, `http://${host}`);
  } catch {
    return null;
  }
}

function generateAgentId(db: DB): string {
  for (let i = 0; i < 10; i++) {
    const candidate = crypto.randomUUID().split("-")[0];
    if (!db.getAgent(candidate)) return candidate;
  }
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}
