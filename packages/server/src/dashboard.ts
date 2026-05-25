import { COOKIE_NAMES } from '@privatefrp/shared';
import type { ServerRuntimeConfig } from '@privatefrp/shared';
import type { ControlPlane } from './control';

function jsonResponse(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status: init?.status ?? 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init?.headers || {})
    }
  });
}

function textResponse(text: string, init?: ResponseInit): Response {
  return new Response(text, {
    status: init?.status ?? 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      ...(init?.headers || {})
    }
  });
}

export class DashboardServer {
  private readonly sockets = new Set<any>();
  private server: any = null;

  constructor(
    private readonly config: ServerRuntimeConfig,
    private readonly control: ControlPlane,
    private readonly assetBasePath: string
  ) {}

  start(): void {
    this.server = Bun.serve({
      hostname: this.config.host,
      port: this.config.dashboardPort,
      fetch: (req, server) => this.handleRequest(req, server),
      websocket: this.websocket
    });
    console.log(`[dashboard] http://${this.config.host}:${this.config.dashboardPort}`);
  }

  stop(): void {
    try {
      this.server?.stop?.();
    } catch (err) {
      console.error('[dashboard] error stopping server', err);
    }
    for (const s of this.sockets) {
      try { s.close?.(); } catch {}
    }
    this.sockets.clear();
  }

  notify(): void {
    const payload = JSON.stringify({ reqId: 'broadcast', ok: true, data: { refreshedAt: Date.now() } });
    for (const socket of this.sockets) {
      try {
        socket.send(payload);
      } catch {
        this.sockets.delete(socket);
      }
    }
  }

  private async handleRequest(req: Request, server: any): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/ws/dashboard') {
      const upgraded = server.upgrade(req, { data: {} });
      return upgraded ? new Response(null, { status: 101 }) : textResponse('upgrade failed', { status: 400 });
    }

    if (url.pathname === '/' || url.pathname === '/agents.html') {
      return await this.serveHtml('agents.html');
    }
    if (url.pathname === '/tunnels.html') {
      return await this.serveHtml('tunnels.html');
    }
    if (url.pathname === '/login') {
      return req.method === 'GET' ? await this.serveHtml('login.html') : await this.handleLogin(req);
    }
    if (url.pathname === '/logout' && req.method === 'POST') {
      return new Response(null, {
        status: 302,
        headers: {
          location: '/login',
          'set-cookie': `${COOKIE_NAMES.DASHBOARD_SESSION}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
        }
      });
    }
    if (url.pathname === '/styles.css') {
      return this.serveTextAsset('styles.css', 'text/css; charset=utf-8');
    }
    if (url.pathname === '/common.js') {
      return this.serveTextAsset('common.js', 'application/javascript; charset=utf-8');
    }

    if (url.pathname.startsWith('/api/')) {
      return this.handleApi(req, url);
    }

    return textResponse('not found', { status: 404 });
  }

  private async handleLogin(req: Request): Promise<Response> {
    const form = await req.formData();
    const username = String(form.get('username') || '');
    const password = String(form.get('password') || '');
    if (username !== this.config.dashboardUsername || password !== this.config.dashboardPassword) {
      return await this.serveHtml('login.html', {
        loginError: 'Invalid username or password',
        status: 401
      });
    }

    return new Response(null, {
      status: 302,
      headers: {
        location: '/agents.html',
        'set-cookie': `${COOKIE_NAMES.DASHBOARD_SESSION}=session; Path=/; HttpOnly; SameSite=Lax`
      }
    });
  }

  private async handleApi(req: Request, url: URL): Promise<Response> {
    if (!this.isAuthorized(req)) {
      return jsonResponse({ error: 'unauthorized' }, { status: 401 });
    }

    if (url.pathname === '/api/agents' && req.method === 'GET') {
      return jsonResponse(this.control.getAgents());
    }
    if (url.pathname === '/api/tunnels' && req.method === 'GET') {
      return jsonResponse(this.control.getTunnels());
    }
    if (url.pathname === '/api/agents/register' && req.method === 'POST') {
      const name = url.searchParams.get('name') || 'New Agent';
      const created = this.control.registerAgent(name);
      return jsonResponse(created);
    }
    if (url.pathname.match(/^\/api\/agents\/[^/]+\/enabled$/) && req.method === 'POST') {
      return await this.handleAgentEnabled(req, url);
    }
    if (url.pathname.match(/^\/api\/agents\/[^/]+\/delete$/) && req.method === 'POST') {
      const agentId = url.pathname.split('/')[3] || '';
      this.control.deleteAgent(agentId);
      return jsonResponse({ ok: true });
    }
    if (url.pathname === '/api/tunnels' && req.method === 'POST') {
      return await this.handleCreateTunnel(req);
    }
    if (url.pathname.match(/^\/api\/tunnels\/[^/]+$/) && req.method === 'PATCH') {
      return await this.handleUpdateTunnel(req, url);
    }
    if (url.pathname.match(/^\/api\/tunnels\/[^/]+\/enabled$/) && req.method === 'POST') {
      return await this.handleTunnelEnabled(req, url);
    }
    if (url.pathname.match(/^\/api\/tunnels\/[^/]+\/delete$/) && req.method === 'POST') {
      const tunnelId = url.pathname.split('/')[3] || '';
      this.control.deleteTunnel(tunnelId);
      return jsonResponse({ ok: true });
    }
    if (url.pathname.match(/^\/api\/tunnels\/[^/]+$/) && req.method === 'DELETE') {
      const tunnelId = url.pathname.split('/')[3] || '';
      this.control.deleteTunnel(tunnelId);
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: 'not found' }, { status: 404 });
  }

  private async handleAgentEnabled(req: Request, url: URL): Promise<Response> {
    const agentId = url.pathname.split('/')[3] || '';
    const body = await req.json().catch(() => ({}));
    this.control.updateAgent(agentId, { enabled: Boolean((body as { enabled?: boolean }).enabled) });
    return jsonResponse({ ok: true });
  }

  private async handleCreateTunnel(req: Request): Promise<Response> {
    const body = await req.json();
    const tunnel = this.control.createTunnel({
      name: String((body as any).name || 'unnamed'),
      type: String((body as any).type || 'tcp') as any,
      listenPort: Number((body as any).listenPort),
      targetHost: String((body as any).targetHost || '127.0.0.1'),
      targetPort: Number((body as any).targetPort),
      agentId: (body as any).agentId ? String((body as any).agentId) : null,
      enabled: true
    });
    return jsonResponse(tunnel, { status: 201 });
  }

  private async handleUpdateTunnel(req: Request, url: URL): Promise<Response> {
    const tunnelId = url.pathname.split('/')[3] || '';
    const body = await req.json();
    const patch: Partial<Omit<import('@privatefrp/shared').TunnelRecord, 'id' | 'createdAt'>> = {};
    if (body.name !== undefined) patch.name = String(body.name);
    if (body.type !== undefined) patch.type = String(body.type) as any;
    if (body.listenPort !== undefined) patch.listenPort = Number(body.listenPort);
    if (body.targetHost !== undefined) patch.targetHost = String(body.targetHost);
    if (body.targetPort !== undefined) patch.targetPort = Number(body.targetPort);
    if (body.agentId !== undefined) patch.agentId = body.agentId ? String(body.agentId) : null;
    const tunnel = this.control.updateTunnel(tunnelId, patch);
    return tunnel ? jsonResponse(tunnel) : jsonResponse({ error: 'not found' }, { status: 404 });
  }

  private async handleTunnelEnabled(req: Request, url: URL): Promise<Response> {
    const tunnelId = url.pathname.split('/')[3] || '';
    const body = await req.json().catch(() => ({}));
    const tunnel = this.control.setTunnelEnabled(tunnelId, Boolean((body as { enabled?: boolean }).enabled));
    return tunnel ? jsonResponse(tunnel) : jsonResponse({ error: 'not found' }, { status: 404 });
  }

  private isAuthorized(req: Request): boolean {
    const cookie = req.headers.get('cookie') || '';
    return cookie.includes(`${COOKIE_NAMES.DASHBOARD_SESSION}=`);
  }

  private async serveHtml(fileName: string, options: { loginError?: string; status?: number } = {}): Promise<Response> {
    const path = `${this.assetBasePath}/web/${fileName}`;
    const text = await Bun.file(path).text();
    const withPublicIp = text.replace(/YOUR_PUBLIC_IP/g, this.config.dashboardPublicIp || this.config.publicHost);
    const withError = options.loginError
      ? withPublicIp.replace('<!-- <div class="alert alert-error">Invalid username or password</div> -->', `<div class="alert alert-error">${options.loginError}</div>`)
      : withPublicIp;
    return new Response(withError, {
      status: options.status ?? 200,
      headers: { 'content-type': 'text/html; charset=utf-8' }
    });
  }

  private serveTextAsset(fileName: string, contentType: string): Response {
    const path = `${this.assetBasePath}/web/${fileName}`;
    return new Response(Bun.file(path).stream(), {
      headers: { 'content-type': contentType }
    });
  }

  websocket = {
    open: (socket: any) => {
      this.sockets.add(socket);
      socket.send(JSON.stringify({ reqId: 'boot', ok: true, data: { ready: true } }));
    },
    close: (socket: any) => {
      this.sockets.delete(socket);
    },
    message: (socket: any, message: string | Buffer) => {
      let request: { reqId?: string; type?: string; payload?: unknown } | null = null;
      try {
        request = JSON.parse(String(message));
      } catch {
        return;
      }

      if (!request) return;

      const reqId = String(request.reqId || '');
      if (!reqId) return;
      if (!this.isSocketAuthorized(socket)) {
        socket.send(JSON.stringify({ reqId, ok: false, error: 'unauthorized' }));
        return;
      }

      try {
        if (request.type === 'agents') {
          socket.send(JSON.stringify({ reqId, ok: true, data: this.control.getAgents() }));
          return;
        }
        if (request.type === 'tunnels') {
          socket.send(JSON.stringify({ reqId, ok: true, data: this.control.getTunnels() }));
          return;
        }
        if (request.type === 'status') {
          socket.send(JSON.stringify({ reqId, ok: true, data: { dashboardPort: this.config.dashboardPort, agentPort: this.config.agentPort } }));
          return;
        }
        socket.send(JSON.stringify({ reqId, ok: false, error: 'unknown request' }));
      } catch (error) {
        socket.send(JSON.stringify({ reqId, ok: false, error: error instanceof Error ? error.message : 'request failed' }));
      }
    }
  };

  private isSocketAuthorized(_socket: any): boolean {
    return true;
  }
}