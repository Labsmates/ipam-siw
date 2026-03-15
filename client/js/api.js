// =============================================================================
// IPAM SIW — api.js  (shared utilities, fetch wrapper, JWT, UI helpers)
// =============================================================================

'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const INACTIVITY_MS   = 20 * 60 * 1000; // 20 minutes
const TOKEN_KEY       = 'ipam_jwt';
const USER_KEY        = 'ipam_user';
const LOGIN_PAGE      = '/index.html';
const DASHBOARD_PAGE  = '/dashboard.html';

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------
export function getToken()  { return sessionStorage.getItem(TOKEN_KEY); }
export function getUser()   {
  try { return JSON.parse(sessionStorage.getItem(USER_KEY)); } catch (_) { return null; }
}
export function setSession(token, user) {
  sessionStorage.setItem(TOKEN_KEY, token);
  sessionStorage.setItem(USER_KEY, JSON.stringify(user));
}
export function clearSession() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(USER_KEY);
}

// ---------------------------------------------------------------------------
// Redirect helpers
// ---------------------------------------------------------------------------
export function requireAuth() {
  if (!getToken()) { window.location.replace(LOGIN_PAGE); return false; }
  return true;
}
export function logout() {
  clearSession();
  window.location.replace(LOGIN_PAGE);
}

// ---------------------------------------------------------------------------
// Fetch wrapper
// ---------------------------------------------------------------------------
export async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const opts = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);

  let res;
  try {
    res = await fetch(path, opts);
  } catch (e) {
    throw new Error('Erreur réseau — serveur inaccessible');
  }

  if (res.status === 401) { logout(); return; }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

export const get  = (path)       => api('GET',    path);
export const post = (path, body) => api('POST',   path, body);
export const put  = (path, body) => api('PUT',    path, body);
export const del  = (path)       => api('DELETE', path);
export const patch = (path, body) => api('PATCH', path, body);

// ---------------------------------------------------------------------------
// Inactivity timer
// ---------------------------------------------------------------------------
let _inactivityTimer = null;

function _resetTimer() {
  clearTimeout(_inactivityTimer);
  _inactivityTimer = setTimeout(() => {
    showToast('Session expirée — inactivité de 20 minutes', 'warn');
    setTimeout(logout, 2000);
  }, INACTIVITY_MS);
}

export function startInactivityTimer() {
  ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'].forEach(ev => {
    document.addEventListener(ev, _resetTimer, { passive: true });
  });
  // Logout when tab hidden > 20 minutes
  let hiddenAt = null;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenAt = Date.now();
    } else if (hiddenAt && Date.now() - hiddenAt >= INACTIVITY_MS) {
      logout();
    } else {
      hiddenAt = null;
    }
  });
  _resetTimer();
}

// ---------------------------------------------------------------------------
// HTTP vs HTTPS warning banner
// ---------------------------------------------------------------------------
export function checkHttps() {
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    const banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#b45309;color:#fff;text-align:center;padding:8px;font-size:13px;font-weight:600;-webkit-font-smoothing:antialiased;';
    banner.textContent = '⚠  Connexion non chiffrée (HTTP) — vos données transitent en clair. Utilisez HTTPS.';
    document.body.prepend(banner);
  }
}

// ---------------------------------------------------------------------------
// Toast notifications
// ---------------------------------------------------------------------------
let _toastContainer = null;
function _getContainer() {
  if (!_toastContainer) {
    _toastContainer = document.createElement('div');
    _toastContainer.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9999;display:-webkit-box;display:-ms-flexbox;display:flex;-webkit-box-orient:vertical;-webkit-box-direction:normal;-ms-flex-direction:column;flex-direction:column;gap:8px;max-width:340px;';
    document.body.appendChild(_toastContainer);
  }
  return _toastContainer;
}

const TOAST_COLORS = {
  success : { bg: '#1a3d2b', border: '#3fb950', icon: '✓' },
  error   : { bg: '#3d1a1a', border: '#f85149', icon: '✕' },
  warn    : { bg: '#3d2e0e', border: '#d29922', icon: '⚠' },
  info    : { bg: '#0d2240', border: '#58a6ff', icon: 'ℹ' },
};

export function showToast(message, type = 'info', duration = 4000) {
  const c = TOAST_COLORS[type] || TOAST_COLORS.info;
  const el = document.createElement('div');
  el.style.cssText = `
    display:-webkit-box;display:-ms-flexbox;display:flex;
    -webkit-box-align:start;-ms-flex-align:start;align-items:flex-start;gap:10px;
    padding:12px 16px;border-radius:8px;
    background:${c.bg};border:1px solid ${c.border};
    color:#e6edf3;font-size:13.5px;line-height:1.45;
    -webkit-box-shadow:0 4px 20px rgba(0,0,0,.5);box-shadow:0 4px 20px rgba(0,0,0,.5);
    -webkit-animation:toast-in .2s ease;animation:toast-in .2s ease;
    opacity:1;-webkit-transition:opacity .3s ease;transition:opacity .3s ease;
  `;
  el.innerHTML = `<span style="color:${c.border};font-weight:700;flex-shrink:0">${c.icon}</span><span>${message}</span>`;

  if (!document.querySelector('#toast-keyframes')) {
    const style = document.createElement('style');
    style.id = 'toast-keyframes';
    style.textContent = '@-webkit-keyframes toast-in{from{-webkit-transform:translateY(12px);transform:translateY(12px);opacity:0}to{-webkit-transform:translateY(0);transform:translateY(0);opacity:1}}@keyframes toast-in{from{-webkit-transform:translateY(12px);transform:translateY(12px);opacity:0}to{-webkit-transform:translateY(0);transform:translateY(0);opacity:1}}';
    document.head.appendChild(style);
  }

  _getContainer().appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 350);
  }, duration);
}

// ---------------------------------------------------------------------------
// Site sorting helper — DSIBA first, CREC second, others third (each group α)
// ---------------------------------------------------------------------------
export function sortSites(sites) {
  const group = name => {
    const n = name.toUpperCase();
    if (n.includes('DSIBA')) return 0;
    if (n.includes('CREC'))  return 1;
    return 2;
  };
  return [...sites].sort((a, b) => {
    const ga = group(a.name), gb = group(b.name);
    if (ga !== gb) return ga - gb;
    return a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' });
  });
}

// ---------------------------------------------------------------------------
// IP sorting helper
// ---------------------------------------------------------------------------
export function sortIPs(ips) {
  return [...ips].sort((a, b) => {
    const pa = (a.ip_address || a).split('.').map(Number);
    const pb = (b.ip_address || b).split('.').map(Number);
    for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
    return 0;
  });
}

// ---------------------------------------------------------------------------
// CIDR helper — generate all host IPs in a network
// ---------------------------------------------------------------------------
export function cidrToIPs(cidr) {
  const [network, bits] = cidr.split('/');
  const prefix = parseInt(bits, 10);
  if (isNaN(prefix) || prefix < 8 || prefix > 31) throw new Error('Préfixe CIDR invalide (8-31)');
  const parts = network.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => p < 0 || p > 255)) throw new Error('Adresse IP invalide');
  const base = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
  const mask = 0xFFFFFFFF << (32 - prefix);
  const net  = base & mask;
  const bcast = net | (~mask >>> 0);
  const hosts = [];
  // Skip network address and broadcast
  for (let i = net + 1; i < bcast; i++) {
    hosts.push([
      (i >>> 24) & 0xFF,
      (i >>> 16) & 0xFF,
      (i >>> 8)  & 0xFF,
       i         & 0xFF,
    ].join('.'));
  }
  return hosts;
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  children.flat().forEach(c => e.append(typeof c === 'string' ? document.createTextNode(c) : c));
  return e;
}

export function qs(sel, root = document) { return root.querySelector(sel); }
export function qsa(sel, root = document) { return [...root.querySelectorAll(sel)]; }

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------
const STATUS_STYLE = {
  'Libre'    : 'background:#0d2e1a;color:#3fb950;border:1px solid #2a5f38',
  'Utilisé'  : 'background:#2e0d0d;color:#f85149;border:1px solid #6b2020',
  'Réservée' : 'background:#2e2000;color:#d29922;border:1px solid #5c4200',
};
export function statusBadge(status) {
  const s = STATUS_STYLE[status] || 'background:#1c2128;color:#8b949e;border:1px solid #30363d';
  return `<span style="${s};display:inline-block;padding:2px 10px;border-radius:999px;font-size:11.5px;font-weight:600;">${status}</span>`;
}

// ---------------------------------------------------------------------------
// Format date
// ---------------------------------------------------------------------------
export function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// Modal helpers
// ---------------------------------------------------------------------------
export function openModal(id) { document.getElementById(id)?.classList.remove('hidden'); }
export function closeModal(id) { document.getElementById(id)?.classList.add('hidden'); }

// Close modals when clicking outside
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-overlay')) {
    e.target.closest('.modal-overlay')?.classList.add('hidden');
  }
});
