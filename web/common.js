// Shared dashboard JavaScript
(() => {
  const wsProtocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = wsProtocol + '://' + location.host + '/ws/dashboard';
  const LOGIN_URL = '/login';
  const PUBLIC_IP = document.body?.dataset.publicIp || '';
  let ws = null;
  let connectPromise = null;
  let reqSeq = 0;
  let redirectingToLogin = false;
  let authCheckPromise = null;
  const pending = new Map();

  function normalizeErrorText(value) {
    return String(value || '').trim().toLowerCase();
  }

  function isUnauthorizedText(value) {
    const text = normalizeErrorText(value);
    return text.includes('unauthorized') || text.includes('auth failed') || text.includes('forbidden');
  }

  function redirectToLogin() {
    if (redirectingToLogin) return;
    redirectingToLogin = true;
    try {
      location.replace(LOGIN_URL);
    } catch {
      location.href = LOGIN_URL;
    }
  }

  async function checkAuthAndRedirect() {
    if (redirectingToLogin) return true;
    if (authCheckPromise) return authCheckPromise;

    authCheckPromise = (async () => {
      try {
        const res = await fetch('/api/agents', {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (res.status === 401) {
          redirectToLogin();
          return true;
        }
      } catch {
        // Ignore network failures: only redirect on explicit unauthorized.
      } finally {
        authCheckPromise = null;
      }
      return false;
    })();

    return authCheckPromise;
  }

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
          const errText = String(msg.error || 'WebSocket request failed');
          if (isUnauthorizedText(errText)) {
            void checkAuthAndRedirect();
          }
          entry.reject(new Error(errText));
          return;
        }

        entry.resolve(msg.data);
      };

      socket.onerror = () => {
        if (connectPromise) {
          connectPromise = null;
          reject(new Error('WebSocket connection failed'));
        }
        void checkAuthAndRedirect();
      };

      socket.onclose = () => {
        ws = null;
        rejectAllPending('WebSocket disconnected');
        void checkAuthAndRedirect();
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

  const copyPublicIpBtn = document.getElementById('copy-public-ip-btn');
  if (copyPublicIpBtn && PUBLIC_IP) {
    copyPublicIpBtn.addEventListener('click', async () => {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(PUBLIC_IP);
        } else {
          const el = document.createElement('textarea');
          el.value = PUBLIC_IP;
          document.body.appendChild(el);
          el.select();
          document.execCommand('copy');
          el.remove();
        }
        window.showToast('Public IP copied', 'success');
      } catch {
        window.showToast('Failed to copy public IP');
      }
    });
  }
})();

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
