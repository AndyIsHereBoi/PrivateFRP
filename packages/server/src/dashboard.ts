import type { DB } from "./db";
import type { AgentManager } from "./agentManager";

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

const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
  .container { max-width: 1200px; margin: 0 auto; padding: 2rem; }
  h1 { font-size: 1.8rem; font-weight: 700; color: #38bdf8; margin-bottom: 0.25rem; }
  h2 { font-size: 1.2rem; font-weight: 600; color: #7dd3fc; margin: 1.5rem 0 0.75rem; }
  h3 { font-size: 1rem; font-weight: 600; color: #bfdbfe; margin: 1rem 0 0.5rem; }
  .subtitle { color: #94a3b8; font-size: 0.9rem; margin-bottom: 2rem; }
  nav { display: flex; gap: 1rem; align-items: center; margin-bottom: 1rem; }
  nav a { color: #7dd3fc; text-decoration: none; font-size: 0.9rem; }
  nav a:hover { text-decoration: underline; }
  nav .spacer { flex: 1; }
  .tabs { display:flex; gap:0.5rem; margin-bottom: 1rem; }
  .tab { display:inline-block; padding:0.45rem 0.8rem; border:1px solid #334155; border-radius:999px; color:#93c5fd; text-decoration:none; font-size:0.85rem; }
  .tab.active { background:#1d4ed8; border-color:#2563eb; color:#fff; }
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
  activeTab: "agents" | "tunnels";
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
<div class="container">
  <nav>
    <div>
      <h1>PrivateFRP</h1>
      <p class="subtitle" style="margin-bottom:0">${opts.subtitle}${opts.publicIp ? ` &mdash; Public IP: <code style="color:#4ade80">${escHtml(opts.publicIp)}</code>` : ""}</p>
    </div>
    <div class="spacer"></div>
    ${opts.registerAction ? '<a href="#" onclick="document.getElementById(\'registerModal\').classList.add(\'open\');return false">Register Agent</a>' : ""}
    <form method="POST" action="/logout" style="display:inline">
      <button class="btn btn-danger" type="submit">Sign Out</button>
    </form>
  </nav>
  <div class="tabs">
    <a class="tab ${opts.activeTab === "agents" ? "active" : ""}" href="/dashboard/agents">Agents</a>
    <a class="tab ${opts.activeTab === "tunnels" ? "active" : ""}" href="/dashboard/tunnels">Tunnels</a>
  </div>
  ${opts.content}
</div>
</body></html>`;
}

function agentsPage(
  agents: Array<{
    id: string;
    name: string;
    connected: boolean;
    lastHeartbeat: number;
    remoteAddress: string;
  }>,
  publicIp: string,
): string {
  const agentRows = agents
    .map((a) => {
      const status = a.connected
        ? `<span class="badge badge-green">Connected</span>`
        : `<span class="badge badge-gray">Offline</span>`;
      const hb = a.lastHeartbeat ? new Date(a.lastHeartbeat).toLocaleString() : "";
      return `<tr>
        <td><code style="font-size:0.78rem">${escHtml(a.id)}</code></td>
        <td>${escHtml(a.name)}</td>
        <td>${status}</td>
        <td>${escHtml(a.remoteAddress) || ""}</td>
        <td>${hb}</td>
        <td><button class="btn btn-danger" data-agent-id="${escHtml(a.id)}" data-agent-name="${escHtml(a.name)}" onclick="deleteAgent(this.dataset.agentId,this.dataset.agentName)">Delete</button></td>
      </tr>`;
    })
    .join("\n");

  return pageShell({
    title: "PrivateFRP - Agents",
    subtitle: "Agent Dashboard",
    activeTab: "agents",
    publicIp,
    registerAction: false,
    content: `
  <h2>Agents</h2>
  <table>
    <thead><tr><th>ID</th><th>Name</th><th>Status</th><th>IP Address</th><th>Last Heartbeat</th><th>Actions</th></tr></thead>
    <tbody id="agents-tbody">${agentRows || '<tr><td colspan="6" style="color:#64748b;text-align:center">No agents registered</td></tr>'}</tbody>
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
    const res = await fetch('/api/agents');
    if (!res.ok) return;
    const agents = await res.json();
    const tbody = document.getElementById('agents-tbody');
    if (!agents.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="color:#64748b;text-align:center">No agents registered</td></tr>';
      return;
    }
    tbody.innerHTML = agents.map(a => {
      const status = a.connected
        ? '<span class="badge badge-green">Connected</span>'
        : '<span class="badge badge-gray">Offline</span>';
      const hb = a.lastHeartbeat ? new Date(a.lastHeartbeat).toLocaleString() : '—';
      return \`<tr>
        <td><code style="font-size:0.78rem">\${esc(a.id)}</code></td>
        <td>\${esc(a.name)}</td>
        <td>\${status}</td>
        <td>\${esc(normalizeIp(a.remoteAddress || '')) || '—'}</td>
        <td>\${hb}</td>
        <td><button class="btn btn-danger" data-agent-id="\${esc(a.id)}" data-agent-name="\${esc(a.name)}" onclick="deleteAgent(this.dataset.agentId,this.dataset.agentName)">Delete</button></td>
      </tr>\`;
    }).join('');
  } catch (_) {}
}

async function deleteAgent(id, name) {
  if (!confirm("Delete agent '" + name + "'? This will also remove all associated tunnels.")) return;
  const res = await fetch('/api/agents/' + encodeURIComponent(id) + '/delete', { method: 'POST' });
  if (!res.ok) { alert('Failed to delete agent'); return; }
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
setInterval(refreshAgents, 10000);
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
  }>,
  publicIp: string,
): string {
  const safeAgents = JSON.stringify(agents);
  const safeTunnels = JSON.stringify(tunnels);

  return pageShell({
    title: "PrivateFRP - Tunnels",
    subtitle: "Tunnels Dashboard",
    activeTab: "tunnels",
    publicIp,
    content: `
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
        <div><label>Agent ID</label><select name="agentId" id="agentSelect"></select></div>
      </div>
      <button class="btn btn-primary mt-1" type="submit">Create Tunnel</button>
    </form>
  </div>

  <h2>All Tunnels</h2>
  <div id="groups"></div>

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

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;');
}

function updateAgentSelects() {
  const options = AGENTS.length
    ? AGENTS.map(a => \`<option value="\${esc(a.id)}">\${esc(a.name)} (\${esc(a.id.slice(0,8))})</option>\`).join('')
    : '<option value="">No agents</option>';
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

  const orderedAgentIds = [...AGENTS.map(a => a.id), ...Object.keys(byAgent).filter(id => !agentName[id])];
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
        const publicAddr = PUBLIC_IP ? esc(PUBLIC_IP) + ':' + t.listenPort : t.listenPort;
        return \`<tr>
          <td>\${esc(t.name)}</td>
          <td>\${badge}</td>
          <td><code>\${publicAddr}</code></td>
          <td>\${esc(t.targetHost)}:\${t.targetPort}</td>
          <td>
            <button class="btn btn-edit" onclick="openEditTunnel('\${esc(t.id)}')">Edit</button>
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
    alert('Error: ' + (err.error || res.status));
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
    alert('Error: ' + (err.error || res.status));
  }
}

async function deleteTunnel(id, name) {
  if (!confirm("Delete tunnel '" + name + "'?")) return;
  const res = await fetch('/api/tunnels/' + encodeURIComponent(id), { method: 'DELETE' });
  if (!res.ok) { alert('Failed to delete tunnel'); return; }
  await refreshData();
}

async function refreshData() {
  try {
    const [agentsRes, tunnelsRes] = await Promise.all([
      fetch('/api/agents'),
      fetch('/api/tunnels')
    ]);
    if (!agentsRes.ok || !tunnelsRes.ok) return;
    AGENTS = await agentsRes.json();
    TUNNELS = await tunnelsRes.json();
    updateAgentSelects();
    renderGroups();
  } catch (_) {}
}

refreshData();
setInterval(refreshData, 10000);
</script>
`,
  });
}

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

      if (url.pathname === "/login") {
        if (req.method === "GET") return html(loginPage());
        if (req.method === "POST") {
          const form = await req.formData();
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

      const user = validateSession(cookie);
      if (!user) {
        if (url.pathname.startsWith("/api/")) return json({ error: "Unauthorized" }, 401);
        return new Response(null, { status: 302, headers: { Location: "/login" } });
      }

      if ((url.pathname === "/dashboard" || url.pathname === "/dashboard/agents") && req.method === "GET") {
        const dbAgents = db.listAgents();
        const connectedMap = new Map(agentManager.getAll().map((a) => [a.agentId, a]));
        const agentsView = dbAgents.map((a) => {
          const connected = connectedMap.get(a.id);
          return {
            id: a.id,
            name: a.name,
            connected: !!connected,
            lastHeartbeat: connected?.lastHeartbeat ?? 0,
            remoteAddress: normalizeRemoteIp(connected?.remoteAddress ?? ""),
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
        }));
        return html(tunnelsPage(dbAgents, tunnelRows, publicIp));
      }

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
              remoteAddress: normalizeRemoteIp(connected?.remoteAddress ?? null),
              lastHeartbeat: connected?.lastHeartbeat ?? null,
              createdAt: a.created_at,
            };
          }),
        );
      }

      if (url.pathname === "/api/agents/register" && (req.method === "GET" || req.method === "POST")) {
        const agentId = crypto.randomUUID();
        const agentSecret = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
        const agentName = url.searchParams.get("name")?.trim() || `agent-${agentId.slice(0, 8)}`;
        db.createAgent(agentId, agentName, agentSecret);
        return json({ agentId, agentName, agentSecret });
      }

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
          body = Object.fromEntries(Array.from(form.entries()).map(([k, v]) => [k, v.toString()]));
        }

        const { name, type, listenPort, targetHost, targetPort, agentId } = body;
        if (!name || !type || !listenPort || !targetHost || !targetPort || !agentId) {
          return json({ error: "Missing required fields" }, 400);
        }
        if (type !== "tcp" && type !== "udp") return json({ error: "type must be tcp or udp" }, 400);
        if (!db.getAgent(agentId)) return json({ error: "Agent not found" }, 404);

        const id = crypto.randomUUID();
        const row = db.createTunnel(id, name, type, parseInt(listenPort, 10), targetHost, parseInt(targetPort, 10), agentId);
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
        if (!name || !type || !listenPort || !targetHost || !targetPort || !agentId) {
          return json({ error: "Missing required fields" }, 400);
        }
        if (type !== "tcp" && type !== "udp") return json({ error: "type must be tcp or udp" }, 400);
        if (!db.getAgent(agentId)) return json({ error: "Agent not found" }, 404);

        const updated = db.updateTunnel(id, name, type, parseInt(listenPort, 10), targetHost, parseInt(targetPort, 10), agentId);
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

      const deleteAgentMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/delete$/) ||
        (req.method === "DELETE" && url.pathname.match(/^\/api\/agents\/([^/]+)$/));
      if (deleteAgentMatch) {
        const id = deleteAgentMatch[1];
        if (!db.getAgent(id)) return json({ error: "Agent not found" }, 404);
        const agentTunnels = db.listTunnelsForAgent(id);
        for (const t of agentTunnels) db.deleteTunnel(t.id);
        db.deleteAgent(id);
        agentManager.unregister(id);
        await onTunnelsChanged();
        return json({ ok: true });
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
