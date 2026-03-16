import type { DB } from "./db";
import type { AgentManager } from "./agentManager";

// ─── Session management ───────────────────────────────────────────────────────
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

// ─── HTML helpers ─────────────────────────────────────────────────────────────
const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
  .container { max-width: 1200px; margin: 0 auto; padding: 2rem; }
  h1 { font-size: 1.8rem; font-weight: 700; color: #38bdf8; margin-bottom: 0.25rem; }
  h2 { font-size: 1.2rem; font-weight: 600; color: #7dd3fc; margin: 1.5rem 0 0.75rem; }
  .subtitle { color: #94a3b8; font-size: 0.9rem; margin-bottom: 2rem; }
  nav { display: flex; gap: 1rem; align-items: center; margin-bottom: 2rem; }
  nav a { color: #7dd3fc; text-decoration: none; font-size: 0.9rem; }
  nav a:hover { text-decoration: underline; }
  nav .spacer { flex: 1; }
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
  label { display: block; font-size: 0.85rem; color: #94a3b8; margin-bottom: 0.35rem; }
  input, select { width: 100%; padding: 0.5rem 0.75rem; background: #0f172a; border: 1px solid #334155; border-radius: 6px; color: #e2e8f0; font-size: 0.9rem; margin-bottom: 1rem; }
  input:focus, select:focus { outline: none; border-color: #38bdf8; }
  .form-row { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 1rem; }
  .form-row > div { display: flex; flex-direction: column; }
  .form-row > div input, .form-row > div select { margin-bottom: 0; }
  button, .btn { padding: 0.5rem 1.25rem; border: none; border-radius: 6px; cursor: pointer; font-size: 0.9rem; font-weight: 600; transition: opacity 0.15s; }
  button:hover, .btn:hover { opacity: 0.85; }
  .btn-primary { background: #0284c7; color: #fff; }
  .btn-danger { background: #b91c1c; color: #fff; padding: 0.3rem 0.75rem; font-size: 0.8rem; }
  .btn-success { background: #15803d; color: #fff; }
  .login-wrap { display: flex; justify-content: center; align-items: center; min-height: 100vh; }
  .login-card { background: #1e293b; border-radius: 12px; padding: 2.5rem; width: 360px; }
  .login-card h1 { margin-bottom: 0.5rem; }
  .login-card .subtitle { margin-bottom: 1.5rem; }
  .alert { padding: 0.75rem 1rem; border-radius: 6px; margin-bottom: 1rem; font-size: 0.9rem; }
  .alert-error { background: #450a0a; color: #fca5a5; border: 1px solid #7f1d1d; }
  .modal-bg { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:100; justify-content:center; align-items:center; }
  .modal-bg.open { display:flex; }
  .modal { background:#1e293b; border-radius:10px; padding:2rem; max-width:480px; width:90%; }
  .modal h2 { margin-top:0; }
  .code-block { background:#0f172a; border:1px solid #334155; border-radius:6px; padding:1rem; font-family:monospace; font-size:0.85rem; word-break:break-all; color:#4ade80; margin:0.5rem 0 1rem; }
  .mt-1 { margin-top:0.5rem; }
  .actions { display:flex; gap:0.5rem; }
`;

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

function dashboardPage(
  agents: Array<{
    id: string;
    name: string;
    connected: boolean;
    lastHeartbeat: number;
    remoteAddress: string;
  }>,
  tunnels: Array<{
    id: string;
    name: string;
    type: string;
    listenPort: number;
    targetHost: string;
    targetPort: number;
    agentId: string;
    agentName: string;
  }>,
  agentSelectOptions: Array<{ id: string; name: string }>,
  publicIp: string,
): string {
  const agentRows = agents
    .map((a) => {
      const status = a.connected
        ? `<span class="badge badge-green">Connected</span>`
        : `<span class="badge badge-gray">Offline</span>`;
      const hb = a.lastHeartbeat
        ? new Date(a.lastHeartbeat).toLocaleString()
        : "—";
      const standbyInfo = "";
      return `<tr>
        <td><code style="font-size:0.78rem">${escHtml(a.id)}</code></td>
        <td>${escHtml(a.name)}</td>
        <td>${status} ${standbyInfo}</td>
        <td>${escHtml(a.remoteAddress) || "—"}</td>
        <td>${hb}</td>
        <td><button class="btn btn-danger" data-agent-id="${escHtml(a.id)}" data-agent-name="${escHtml(a.name)}" onclick="deleteAgent(this.dataset.agentId,this.dataset.agentName)">Delete</button></td>
      </tr>`;
    })
    .join("\n");

  const tunnelRows = tunnels
    .map((t) => {
      const typeBadge =
        t.type === "tcp"
          ? `<span class="badge badge-blue">TCP</span>`
          : `<span class="badge badge-purple">UDP</span>`;
      const publicAddr = publicIp ? `${escHtml(publicIp)}:${t.listenPort}` : `${t.listenPort}`;
      return `<tr>
        <td>${escHtml(t.name)}</td>
        <td>${typeBadge}</td>
        <td><code>${publicAddr}</code></td>
        <td>${escHtml(t.targetHost)}:${t.targetPort}</td>
        <td>${escHtml(t.agentName)}</td>
        <td><button class="btn btn-danger" data-tunnel-id="${escHtml(t.id)}" data-tunnel-name="${escHtml(t.name)}" onclick="deleteTunnel(this.dataset.tunnelId,this.dataset.tunnelName)">Delete</button></td>
      </tr>`;
    })
    .join("\n");

  const agentOptions = agentSelectOptions
    .map((a) => `<option value="${escHtml(a.id)}">${escHtml(a.name)} (${escHtml(a.id.slice(0, 8))}…)</option>`)
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>PrivateFRP Dashboard</title>
<style>${CSS}</style>
</head>
<body>
<div class="container">
  <nav>
    <div>
      <h1>PrivateFRP</h1>
      <p class="subtitle" style="margin-bottom:0">Tunnel Dashboard${publicIp ? ` &mdash; Public IP: <code style="color:#4ade80">${escHtml(publicIp)}</code>` : ""}</p>
    </div>
    <div class="spacer"></div>
    <a href="#" onclick="document.getElementById('registerModal').classList.add('open');return false">Register Agent</a>
    <form method="POST" action="/logout" style="display:inline">
      <button class="btn btn-danger" type="submit">Sign Out</button>
    </form>
  </nav>

  <h2>Agents</h2>
  <table>
    <thead><tr><th>ID</th><th>Name</th><th>Status</th><th>IP Address</th><th>Last Heartbeat</th><th>Actions</th></tr></thead>
    <tbody id="agents-tbody">${agentRows || '<tr><td colspan="6" style="color:#64748b;text-align:center">No agents registered</td></tr>'}</tbody>
  </table>

  <h2>Tunnels</h2>
  <table>
    <thead><tr><th>Name</th><th>Type</th><th>Public Port</th><th>Local Service</th><th>Agent</th><th>Actions</th></tr></thead>
    <tbody id="tunnels-tbody">${tunnelRows || '<tr><td colspan="6" style="color:#64748b;text-align:center">No tunnels configured</td></tr>'}</tbody>
  </table>

  <h2>Create Tunnel</h2>
  <div class="card">
    <form id="createTunnelForm" onsubmit="createTunnel(event)">
      <div class="form-row">
        <div><label>Name</label><input name="name" placeholder="my-tunnel" required></div>
        <div><label>Type</label>
          <select name="type">
            <option value="tcp">TCP</option>
            <option value="udp">UDP</option>
          </select>
        </div>
        <div><label>Public Port</label><input name="listenPort" type="number" min="1" max="65535" placeholder="8080" required></div>
        <div><label>Local Service Host</label><input name="targetHost" placeholder="localhost" required></div>
        <div><label>Local Service Port</label><input name="targetPort" type="number" min="1" max="65535" placeholder="3000" required></div>
        <div><label>Agent ID</label>
          <select name="agentId" id="agentSelect">
            ${agentOptions || '<option value="">No agents</option>'}
          </select>
        </div>
      </div>
      <button class="btn btn-primary mt-1" type="submit">Create Tunnel</button>
    </form>
  </div>
</div>

<!-- Register Agent Modal -->
<div class="modal-bg" id="registerModal" onclick="if(event.target===this)this.classList.remove('open')">
  <div class="modal">
    <h2>Register New Agent</h2>
    <p style="color:#94a3b8;margin:0.5rem 0 1rem;font-size:0.9rem">Give your agent a name and click Generate to get its credentials.</p>
    <label>Agent Name</label>
    <input id="regName" placeholder="my-home-server" style="margin-bottom:1rem">
    <div id="regResult" style="display:none">
      <label>Agent ID</label><div class="code-block" id="regId"></div>
      <label>Agent Secret</label><div class="code-block" id="regSecret"></div>
      <p style="color:#fbbf24;font-size:0.8rem">⚠ Copy the secret now — it won't be shown again.</p>
    </div>
    <div class="actions mt-1">
      <button class="btn btn-success" onclick="registerAgent()">Generate</button>
      <button class="btn" style="background:#334155" onclick="document.getElementById('registerModal').classList.remove('open')">Close</button>
    </div>
  </div>
</div>

<script>
const PUBLIC_IP = ${JSON.stringify(publicIp)};

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function refreshData() {
  try {
    const [agentsRes, tunnelsRes] = await Promise.all([
      fetch('/api/agents'),
      fetch('/api/tunnels')
    ]);
    if (!agentsRes.ok || !tunnelsRes.ok) return;
    const agents = await agentsRes.json();
    const tunnels = await tunnelsRes.json();
    const nameMap = {};
    agents.forEach(a => { nameMap[a.id] = a.name; });
    updateAgentsTable(agents);
    updateTunnelsTable(tunnels, nameMap);
    updateAgentSelect(agents);
  } catch (_) { /* network error — skip this tick */ }
}

function updateAgentsTable(agents) {
  const tbody = document.getElementById('agents-tbody');
  if (!agents.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="color:#64748b;text-align:center">No agents registered</td></tr>';
    return;
  }
  tbody.innerHTML = agents.map(a => {
    const status = a.connected
      ? '<span class="badge badge-green">Connected</span>'
      : '<span class="badge badge-gray">Offline</span>';
    const standby = '';
    const hb = a.lastHeartbeat ? new Date(a.lastHeartbeat).toLocaleString() : '—';
    return \`<tr>
      <td><code style="font-size:0.78rem">\${esc(a.id)}</code></td>
      <td>\${esc(a.name)}</td>
      <td>\${status} \${standby}</td>
      <td>\${esc(a.remoteAddress || '') || '—'}</td>
      <td>\${hb}</td>
      <td><button class="btn btn-danger" data-agent-id="\${esc(a.id)}" data-agent-name="\${esc(a.name)}" onclick="deleteAgent(this.dataset.agentId,this.dataset.agentName)">Delete</button></td>
    </tr>\`;
  }).join('');
}

function updateTunnelsTable(tunnels, nameMap) {
  const tbody = document.getElementById('tunnels-tbody');
  if (!tunnels.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="color:#64748b;text-align:center">No tunnels configured</td></tr>';
    return;
  }
  tbody.innerHTML = tunnels.map(t => {
    const badge = t.type === 'tcp'
      ? '<span class="badge badge-blue">TCP</span>'
      : '<span class="badge badge-purple">UDP</span>';
    const agentName = nameMap[t.agentId] || t.agentId;
    const publicAddr = PUBLIC_IP ? esc(PUBLIC_IP) + ':' + t.listenPort : t.listenPort;
    return \`<tr>
      <td>\${esc(t.name)}</td>
      <td>\${badge}</td>
      <td><code>\${publicAddr}</code></td>
      <td>\${esc(t.targetHost)}:\${t.targetPort}</td>
      <td>\${esc(agentName)}</td>
      <td><button class="btn btn-danger" data-tunnel-id="\${esc(t.id)}" data-tunnel-name="\${esc(t.name)}" onclick="deleteTunnel(this.dataset.tunnelId,this.dataset.tunnelName)">Delete</button></td>
    </tr>\`;
  }).join('');
}

function updateAgentSelect(agents) {
  const sel = document.getElementById('agentSelect');
  const current = sel.value;
  sel.innerHTML = agents.length
    ? agents.map(a => \`<option value="\${esc(a.id)}">\${esc(a.name)} (\${esc(a.id.slice(0,8))}…)</option>\`).join('')
    : '<option value="">No agents</option>';
  if (current) sel.value = current;
}

async function deleteAgent(id, name) {
  if (!confirm("Delete agent '" + name + "'? This will also remove all associated tunnels.")) return;
  const res = await fetch('/api/agents/' + encodeURIComponent(id) + '/delete', { method: 'POST' });
  if (!res.ok) { alert('Failed to delete agent'); return; }
  await refreshData();
}

async function deleteTunnel(id, name) {
  if (!confirm("Delete tunnel '" + name + "'?")) return;
  const res = await fetch('/api/tunnels/' + encodeURIComponent(id), { method: 'DELETE' });
  if (!res.ok) { alert('Failed to delete tunnel'); return; }
  await refreshData();
}

async function createTunnel(e) {
  e.preventDefault();
  const form = e.target;
  const data = Object.fromEntries(new FormData(form));
  const res = await fetch('/api/tunnels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (res.ok) {
    form.reset();
    await refreshData();
  } else {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    alert('Error: ' + (err.error || res.status));
  }
}

async function registerAgent() {
  const name = document.getElementById('regName').value.trim();
  const params = name ? '?name=' + encodeURIComponent(name) : '';
  const res = await fetch('/api/agents/register' + params, { method: 'POST' });
  const data = await res.json();
  document.getElementById('regId').textContent = data.agentId;
  document.getElementById('regSecret').textContent = data.agentSecret;
  document.getElementById('regResult').style.display = 'block';
  await refreshData();
}

// Live-update tables every 10 seconds without a full page reload
setInterval(refreshData, 10000);
</script>
</body></html>`;
}

function escHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Dashboard server ─────────────────────────────────────────────────────────
export function startDashboard(opts: {
  port: number;
  credentials: { user: string; pass: string };
  db: DB;
  agentManager: AgentManager;
  publicIp: string;
  onTunnelsChanged: () => Promise<void>;
}): void {
  const { port, credentials, db, agentManager, publicIp, onTunnelsChanged } = opts;

  Bun.serve({
    port,
    async fetch(req: Request) {
      const url = new URL(req.url);
      const cookie = req.headers.get("cookie");

      // ── Auth routes ────────────────────────────────────────────────────────
      if (url.pathname === "/login") {
        if (req.method === "GET") {
          return html(loginPage());
        }
        if (req.method === "POST") {
          const form = await req.formData();
          const user = form.get("username")?.toString() ?? "";
          const pass = form.get("password")?.toString() ?? "";
          if (user === credentials.user && pass === credentials.pass) {
            const sid = createSession(user);
            return new Response(null, {
              status: 302,
              headers: {
                Location: "/dashboard",
                "Set-Cookie": `session=${sid}; Path=/; HttpOnly; SameSite=Lax`,
              },
            });
          }
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
          headers: { Location: user ? "/dashboard" : "/login" },
        });
      }

      // ── All routes below require auth ──────────────────────────────────────
      const user = validateSession(cookie);
      if (!user) {
        if (url.pathname.startsWith("/api/")) {
          return json({ error: "Unauthorized" }, 401);
        }
        return new Response(null, { status: 302, headers: { Location: "/login" } });
      }

      // ── Dashboard page ─────────────────────────────────────────────────────
      if (url.pathname === "/dashboard" && req.method === "GET") {
        const dbAgents = db.listAgents();
        const connectedAgents = agentManager.getAll();
        const connectedMap = new Map(connectedAgents.map((a) => [a.agentId, a]));
        const agentNameMap = new Map(dbAgents.map((a) => [a.id, a.name]));

        const agentsView = dbAgents.map((a) => {
          const connected = connectedMap.get(a.id);
          return {
            id: a.id,
            name: a.name,
            connected: !!connected,
            lastHeartbeat: connected?.lastHeartbeat ?? 0,
            remoteAddress: connected?.remoteAddress ?? "",
            standbyCount: connected?.standbyPool.length ?? 0,
          };
        });

        const tunnelRows = db.listTunnels().map((t) => ({
          id: t.id,
          name: t.name,
          type: t.type,
          listenPort: t.listen_port,
          targetHost: t.target_host,
          targetPort: t.target_port,
          agentId: t.agent_id,
          agentName: agentNameMap.get(t.agent_id) ?? t.agent_id,
        }));

        const agentSelectOptions = dbAgents.map((a) => ({ id: a.id, name: a.name }));
        return html(dashboardPage(agentsView, tunnelRows, agentSelectOptions, publicIp));
      }

      // ── API: agents ────────────────────────────────────────────────────────
      if (url.pathname === "/api/agents" && req.method === "GET") {
        const dbAgents = db.listAgents();
        const connectedMap = new Map(agentManager.getAll().map((a) => [a.agentId, a]));
        return json(
          dbAgents.map((a) => {
            const connected = connectedMap.get(a.id);
            return {
              id: a.id,
              name: a.name,
              connected: !!connected,
              remoteAddress: connected?.remoteAddress ?? null,
              standbyCount: connected?.standbyPool.length ?? 0,
              lastHeartbeat: connected?.lastHeartbeat ?? null,
              createdAt: a.created_at,
            };
          }),
        );
      }

      if (
        url.pathname === "/api/agents/register" &&
        (req.method === "GET" || req.method === "POST")
      ) {
        const agentId = crypto.randomUUID();
        const agentSecret = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
        const agentName = url.searchParams.get("name")?.trim() || `agent-${agentId.slice(0, 8)}`;
        db.createAgent(agentId, agentName, agentSecret);
        return json({ agentId, agentName, agentSecret });
      }

      // ── API: tunnels ───────────────────────────────────────────────────────
      if (url.pathname === "/api/tunnels" && req.method === "GET") {
        return json(db.listTunnels().map((t) => db.rowToTunnelConfig(t)));
      }

      if (url.pathname === "/api/tunnels" && req.method === "POST") {
        let body: Record<string, string>;
        const contentType = req.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          body = await req.json();
        } else {
          const form = await req.formData();
          body = Object.fromEntries(
            Array.from(form.entries()).map(([k, v]) => [k, v.toString()]),
          );
        }

        const { name, type, listenPort, targetHost, targetPort, agentId } = body;
        if (!name || !type || !listenPort || !targetHost || !targetPort || !agentId) {
          return json({ error: "Missing required fields" }, 400);
        }
        if (type !== "tcp" && type !== "udp") {
          return json({ error: "type must be tcp or udp" }, 400);
        }
        if (!db.getAgent(agentId)) {
          return json({ error: "Agent not found" }, 404);
        }

        const id = crypto.randomUUID();
        const row = db.createTunnel(
          id,
          name,
          type,
          parseInt(listenPort, 10),
          targetHost,
          parseInt(targetPort, 10),
          agentId,
        );

        await onTunnelsChanged();

        const isJsonReq = contentType.includes("application/json");
        if (isJsonReq) {
          return json(db.rowToTunnelConfig(row), 201);
        }
        return new Response(null, { status: 302, headers: { Location: "/dashboard" } });
      }

      // ── DELETE /api/tunnels/:id ─────────────────────────────────────────────
      const deleteTunnelMatch = url.pathname.match(/^\/api\/tunnels\/([^/]+)\/delete$/) ||
        (req.method === "DELETE" && url.pathname.match(/^\/api\/tunnels\/([^/]+)$/));
      if (deleteTunnelMatch) {
        const id = deleteTunnelMatch[1];
        if (!db.getTunnel(id)) {
          return json({ error: "Tunnel not found" }, 404);
        }
        db.deleteTunnel(id);
        await onTunnelsChanged();

        if (req.method === "DELETE") {
          return json({ ok: true });
        }
        return new Response(null, { status: 302, headers: { Location: "/dashboard" } });
      }

      // ── DELETE /api/agents/:id ─────────────────────────────────────────────
      const deleteAgentMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/delete$/) ||
        (req.method === "DELETE" && url.pathname.match(/^\/api\/agents\/([^/]+)$/));
      if (deleteAgentMatch) {
        const id = deleteAgentMatch[1];
        if (!db.getAgent(id)) {
          return json({ error: "Agent not found" }, 404);
        }
        // Remove all tunnels for this agent first, then delete the agent
        const agentTunnels = db.listTunnelsForAgent(id);
        for (const t of agentTunnels) db.deleteTunnel(t.id);
        db.deleteAgent(id);
        // Disconnect the agent if it is currently connected
        agentManager.unregister(id);
        await onTunnelsChanged();

        if (req.method === "DELETE" || url.pathname.endsWith("/delete")) {
          return json({ ok: true });
        }
        return new Response(null, { status: 302, headers: { Location: "/dashboard" } });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  console.log(`[Dashboard] Listening on http://0.0.0.0:${port}`);
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
