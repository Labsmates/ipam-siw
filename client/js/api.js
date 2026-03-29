// =============================================================================
// IPAM SIW — api.js  (shared utilities, fetch wrapper, JWT, UI helpers)
// =============================================================================

'use strict';

// ---------------------------------------------------------------------------
// Navigation accident prevention
// Backspace hors d'un champ éditable → navigateur recule dans l'historique
// Enter sur un bouton non-submit dans un modal → ferme/déclenche par erreur
// ---------------------------------------------------------------------------
document.addEventListener('keydown', e => {
  const el  = document.activeElement;
  const tag = el?.tagName;
  const isEditable = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) && !el.readOnly && !el.disabled;
  const isContentEditable = el?.isContentEditable;

  // Bloquer Backspace si le focus n'est pas dans un champ éditable
  if (e.key === 'Backspace' && !isEditable && !isContentEditable) {
    e.preventDefault();
    return;
  }

  // Bloquer Enter sur les boutons type="button" (évite activation accidentelle)
  if (e.key === 'Enter' && tag === 'BUTTON' && el.type === 'button') {
    e.preventDefault();
  }
}, { capture: true });

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
// Thème sombre / clair
// ---------------------------------------------------------------------------
const THEME_KEY = 'ipam_theme';

const SUN_SVG  = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;
const MOON_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;

export function getTheme() { return localStorage.getItem(THEME_KEY) || 'dark'; }

export function applyTheme(t) {
  document.documentElement.classList.toggle('light', t === 'light');
  localStorage.setItem(THEME_KEY, t);
  const btn = document.getElementById('btn-theme');
  if (btn) {
    btn.innerHTML  = t === 'dark' ? SUN_SVG : MOON_SVG;
    btn.title      = t === 'dark' ? 'Passer en mode clair' : 'Passer en mode sombre';
  }
}

export function toggleTheme() { applyTheme(getTheme() === 'dark' ? 'light' : 'dark'); }

export function initTheme() {
  applyTheme(getTheme());
  document.getElementById('btn-theme')?.addEventListener('click', toggleTheme);
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

  if (res.status === 401) {
    const data = await res.json().catch(() => ({}));
    if (token) { logout(); return; }
    throw new Error(data.error || 'Identifiant ou mot de passe incorrect');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

export const get    = (path)       => api('GET',    path);
export const post   = (path, body) => api('POST',   path, body);
export const put    = (path, body) => api('PUT',    path, body);
export const del    = (path)       => api('DELETE', path);
export const delBody = (path, body) => api('DELETE', path, body);
export const patch  = (path, body) => api('PATCH',  path, body);

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

// ---------------------------------------------------------------------------
// Confirm dialog (replaces browser confirm())
// ---------------------------------------------------------------------------
export function showConfirm({ title = 'Confirmation', message = '', confirmText = 'Confirmer', cancelText = 'Annuler', danger = false } = {}) {
  return new Promise(resolve => {
    const _e = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    if (!document.querySelector('#confirm-keyframes')) {
      const style = document.createElement('style');
      style.id = 'confirm-keyframes';
      style.textContent = '@-webkit-keyframes cfade{from{opacity:0;-webkit-transform:scale(.93) translateY(10px);transform:scale(.93) translateY(10px)}to{opacity:1;-webkit-transform:none;transform:none}}@keyframes cfade{from{opacity:0;transform:scale(.93) translateY(10px)}to{opacity:1;transform:none}}';
      document.head.appendChild(style);
    }

    const confirmStyle = danger
      ? 'background:#f8514918;color:#f85149;border:1px solid #f8514940;'
      : 'background:#58a6ff;color:#0d1117;border:none;';

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;right:0;bottom:0;left:0;background:rgba(0,0,0,.72);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);z-index:9997;display:-webkit-box;display:-ms-flexbox;display:flex;-webkit-box-align:center;-ms-flex-align:center;align-items:center;-webkit-box-pack:center;-ms-flex-pack:center;justify-content:center;padding:24px;';
    overlay.innerHTML = `
      <div style="background:#21262d;border:1px solid #30363d;border-radius:12px;padding:28px;width:420px;max-width:95vw;-webkit-box-shadow:0 20px 60px rgba(0,0,0,.6);box-shadow:0 20px 60px rgba(0,0,0,.6);-webkit-animation:cfade .18s cubic-bezier(.34,1.56,.64,1);animation:cfade .18s cubic-bezier(.34,1.56,.64,1);">
        <h3 style="margin:0 0 10px;font-size:16px;font-weight:700;color:#e6edf3;letter-spacing:-0.01em;">${_e(title)}</h3>
        <p style="margin:0 0 24px;font-size:14px;color:#8b949e;line-height:1.55;">${_e(message)}</p>
        <div style="display:-webkit-box;display:-ms-flexbox;display:flex;gap:10px;-webkit-box-pack:end;-ms-flex-pack:end;justify-content:flex-end;">
          <button id="_sc-cancel" style="padding:8px 18px;border-radius:8px;border:1px solid #30363d;background:#21262d;color:#8b949e;font-size:13px;cursor:pointer;-webkit-transition:all .15s;transition:all .15s;" onmouseenter="this.style.background='#2d333b';this.style.color='#e6edf3'" onmouseleave="this.style.background='#21262d';this.style.color='#8b949e'">${_e(cancelText)}</button>
          <button id="_sc-confirm" style="${confirmStyle}padding:8px 18px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;-webkit-transition:all .15s;transition:all .15s;">${_e(confirmText)}</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    function cleanup(result) { overlay.remove(); resolve(result); }
    overlay.querySelector('#_sc-cancel').addEventListener('click', () => cleanup(false));
    overlay.querySelector('#_sc-confirm').addEventListener('click', () => cleanup(true));
    overlay.addEventListener('click', e => { if (e.target === overlay) cleanup(false); });
  });
}

// Close modals when clicking outside
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-overlay')) {
    e.target.closest('.modal-overlay')?.classList.add('hidden');
  }
});

// =============================================================================
// Recherche IP globale — partagée par dashboard.js et site.js
// =============================================================================
export function setupGlobalIpSearch(inputId, dropdownId) {
  const input    = document.getElementById(inputId);
  const dropdown = document.getElementById(dropdownId);
  if (!input || !dropdown) return;

  const STATUS_COLOR = { 'Libre': '#3fb950', 'Utilisé': '#58a6ff', 'Réservée': '#d29922' };
  function _e(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  let debounce = null;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    const q = input.value.trim();
    if (q.length < 3) {
      dropdown.style.display = 'none';
      dropdown.innerHTML = '';
      return;
    }
    debounce = setTimeout(() => doSearch(q), 280);
  });

  document.addEventListener('click', e => {
    if (!input.contains(e.target) && !dropdown.contains(e.target))
      dropdown.style.display = 'none';
  });
  input.addEventListener('focus', () => {
    if (dropdown.innerHTML) dropdown.style.display = '';
  });

  async function doSearch(q) {
    dropdown.innerHTML = '<div style="padding:12px 16px;color:var(--tx-3);font-size:13px;">Recherche…</div>';
    dropdown.style.display = '';
    try {
      const data    = await get(`/api/ips/search?q=${encodeURIComponent(q)}`);
      const results = data.results || [];
      if (!results.length) {
        dropdown.innerHTML = '<div style="padding:12px 16px;color:var(--tx-3);font-size:13px;">Aucune adresse IP trouvée.</div>';
        return;
      }
      dropdown.innerHTML = results.map(r => {
        const color = STATUS_COLOR[r.status] || 'var(--tx-3)';
        return `<a href="/site.html?id=${encodeURIComponent(r.site_id)}" class="ip-search-row">
          <span style="font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:600;color:var(--tx-1);min-width:120px">${_e(r.ip_address)}</span>
          <span style="font-size:11px;padding:2px 8px;border-radius:999px;background:${color}22;color:${color};border:1px solid ${color}44;white-space:nowrap">${_e(r.status)}</span>
          <span style="font-size:12px;color:var(--tx-4);white-space:nowrap">VLAN ${_e(r.vlan_id)}</span>
          <span style="font-size:12px;font-weight:600;color:var(--tx-2);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_e(r.site_name)}</span>
          ${r.hostname ? `<span style="font-size:11px;color:var(--tx-4);font-family:'JetBrains Mono',monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px">${_e(r.hostname)}</span>` : ''}
        </a>`;
      }).join('');
    } catch (e) {
      dropdown.innerHTML = `<div style="padding:12px 16px;color:#f85149;font-size:13px;">Erreur : ${_e(e.message)}</div>`;
    }
  }
}

// =============================================================================
// Mode SA — élévation temporaire en super admin via clé de bypass (admins P/X)
// =============================================================================
const ELEV_KEY = 'ipam_elevation';

function getElevation() {
  try {
    const e = JSON.parse(localStorage.getItem(ELEV_KEY) || 'null');
    if (!e) return null;
    if (e.expires < Date.now()) { _clearElevation(e); return null; }
    return e;
  } catch { return null; }
}

function _clearElevation(e) {
  if (e?.backup_token) sessionStorage.setItem(TOKEN_KEY, e.backup_token);
  if (e?.backup_user)  sessionStorage.setItem(USER_KEY,  e.backup_user);
  localStorage.removeItem(ELEV_KEY);
}

// Doit être appelé EN PREMIER dans DOMContentLoaded, avant requireAuth/getUser.
// Restaure le token élevé si une élévation active est présente dans localStorage.
export function restoreElevationSession() {
  const elev = getElevation();
  if (!elev) return;
  if (getToken() !== elev.token) {
    sessionStorage.setItem(TOKEN_KEY, elev.token);
    sessionStorage.setItem(USER_KEY, JSON.stringify(elev.user));
  }
}

// Appelé après `const user = getUser()` — configure le bouton Mode SA dans la sidebar.
export function setupElevationMode() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  const elev = getElevation();

  // Rôle original : depuis la sauvegarde si élevé, sinon depuis la session actuelle
  const backupUser   = elev ? (JSON.parse(elev.backup_user || '{}')) : null;
  const originalRole = backupUser?.role || getUser()?.role || 'user';
  const originalName = backupUser?.username || getUser()?.username || '';

  // Identifiants éligibles : commence par P ou X (insensible à la casse), hors ADMIN
  const isSuperAdmin = originalName === 'ADMIN';
  const isPorX       = /^[PX]/i.test(originalName);

  // Liens Administration et Configuration système : visibles pour tous les admins et le super-admin
  if (isSuperAdmin || originalRole === 'admin') {
    document.getElementById('nav-admin-link')?.classList.remove('hidden');
    document.getElementById('nav-config-link')?.classList.remove('hidden');
  }
  // Configuration système : visible aussi pour les utilisateurs P/X (accès restreint)
  if (originalRole === 'user' && isPorX) {
    document.getElementById('nav-config-link')?.classList.remove('hidden');
  }

  // Mode SA : admin P/X uniquement
  const showSA = originalRole === 'admin' && isPorX && !isSuperAdmin && !elev;
  if (!showSA && !elev) return;

  // Style identique aux liens nav (Administration, Configuration système…)
  const NAV_STYLE = 'display:-webkit-box;display:-ms-flexbox;display:flex;-webkit-box-align:center;-ms-flex-align:center;align-items:center;gap:6px;width:100%;padding:8px 12px;border-radius:8px;font-size:13px;font-weight:500;border:1px solid var(--brd);background:var(--bg-4);color:var(--tx-3);cursor:pointer;margin-top:4px;box-sizing:border-box;transition:all .15s;text-align:left;-webkit-box-sizing:border-box;-webkit-transition:all .15s';

  // Point d'ancrage : après nav-config-link
  const refEl = document.getElementById('nav-config-link');
  if (!refEl) return;

  let section = document.getElementById('nav-elevation-section');
  if (!section) {
    section = document.createElement('div');
    section.id = 'nav-elevation-section';
    refEl.parentNode.insertBefore(section, refEl.nextSibling);
  }

  let countdownTimer = null;

  function renderBtn() {
    const e = getElevation();
    if (e) {
      const mins  = Math.max(1, Math.round((e.expires - Date.now()) / 60000));
      const label = 'Mode SA';
      const color = '#8957e5';
      section.innerHTML = `
        <button id="btn-elev-deactivate" style="${NAV_STYLE};border-color:${color}50;color:${color}"
          onmouseenter="this.style.background='var(--bg-hover)'" onmouseleave="this.style.background='var(--bg-4)'">
          <div style="width:7px;height:7px;background:${color};border-radius:50%;flex-shrink:0"></div>
          <span>${label} actif</span>
          <span id="elev-countdown" style="font-size:11px;color:var(--tx-3);margin-left:auto">${mins}min</span>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>`;
      document.getElementById('btn-elev-deactivate').addEventListener('click', async () => {
        if (!await showConfirm({
          title:       'Quitter le mode Super Admin',
          message:     'Voulez-vous désactiver le mode Super Admin ? Vous repasserez en mode Administrateur standard.',
          confirmText: 'Quitter',
          danger:      false,
        })) return;
        _clearElevation(getElevation());
        clearInterval(countdownTimer);
        window.location.reload();
      });
      clearInterval(countdownTimer);
      countdownTimer = setInterval(() => {
        const remaining = getElevation();
        if (!remaining) { clearInterval(countdownTimer); window.location.reload(); return; }
        const m = Math.max(1, Math.round((remaining.expires - Date.now()) / 60000));
        const el = document.getElementById('elev-countdown');
        if (el) el.textContent = `${m}min`;
      }, 30_000);
    } else {
      const type  = 'sa';
      const label = 'Mode SA';
      const color = '#8957e5';
      const icon  = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`;
      section.innerHTML = `
        <button id="btn-elevation-mode" style="${NAV_STYLE};border-color:${color}40;color:${color}"
          onmouseenter="this.style.background='var(--bg-hover)'" onmouseleave="this.style.background='var(--bg-4)'">
          ${icon}
          ${label}
        </button>`;
      document.getElementById('btn-elevation-mode').addEventListener('click', () => openElevModal(type));
    }
  }

  function openElevModal(type) {
    const label = 'Mode SA — Super Admin';
    const color = '#8957e5';
    const desc  = 'Élève vos droits en super administrateur pendant 1 heure.';

    let modal = document.getElementById('modal-elevation');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'modal-elevation';
      document.body.appendChild(modal);
    }
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center';
    modal.innerHTML = `
      <div style="background:var(--bg-2);border:1px solid var(--brd);border-radius:14px;padding:28px 32px;width:100%;max-width:400px;box-shadow:0 20px 60px rgba(0,0,0,.5)">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
          <div style="width:34px;height:34px;background:${color};border-radius:8px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          </div>
          <h3 style="font-size:15px;font-weight:700;margin:0;color:var(--tx-1)">${label}</h3>
        </div>
        <p style="color:var(--tx-3);font-size:13px;margin:0 0 18px">${desc} Saisissez la clé de bypass fournie par votre administrateur.</p>
        <div style="margin-bottom:14px">
          <input id="elev-key-input" class="inp" type="text" placeholder="XXXX-XXXX-XXXX" autocomplete="off"
            style="font-family:'JetBrains Mono','Courier New',monospace;font-size:16px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;text-align:center">
        </div>
        <div id="elev-key-error" style="display:none;background:#f8514918;border:1px solid #f8514940;border-radius:7px;padding:8px 12px;font-size:12px;color:#f85149;margin-bottom:14px"></div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button id="btn-elev-cancel" class="btn" style="background:var(--bg-4);border:1px solid var(--brd);color:var(--tx-2)">Annuler</button>
          <button id="btn-elev-confirm" class="btn" style="background:${color};color:#fff;font-weight:600">Activer</button>
        </div>
      </div>`;

    const keyInput = modal.querySelector('#elev-key-input');
    const errBox   = modal.querySelector('#elev-key-error');
    const btnOk    = modal.querySelector('#btn-elev-confirm');
    const btnCancel= modal.querySelector('#btn-elev-cancel');

    keyInput.addEventListener('input', () => { keyInput.value = keyInput.value.toUpperCase(); });
    keyInput.addEventListener('keydown', e => { if (e.key === 'Enter') btnOk.click(); });
    btnCancel.addEventListener('click', () => { modal.remove(); });
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    setTimeout(() => keyInput.focus(), 50);

    btnOk.addEventListener('click', async () => {
      const key = keyInput.value.trim();
      if (!key) { errBox.textContent = 'Saisissez la clé de bypass.'; errBox.style.display = 'block'; return; }
      errBox.style.display = 'none';
      btnOk.disabled = true; btnOk.textContent = 'Vérification…';
      try {
        const data = await post('/api/bypass/elevate', { key });
        // Sauvegarder la session originale et remplacer par le token élevé
        const backup = { token: data.token, user: data.user, type, expires: new Date(data.expires_at).getTime(),
          backup_token: getToken(), backup_user: sessionStorage.getItem(USER_KEY) };
        localStorage.setItem(ELEV_KEY, JSON.stringify(backup));
        modal.remove();
        window.location.reload();
      } catch (e) {
        errBox.textContent = e.message;
        errBox.style.display = 'block';
        keyInput.select();
        btnOk.disabled = false; btnOk.textContent = 'Activer';
      }
    });
  }

  renderBtn();

  // Si en mode SA actif, forcer l'affichage "Super Administrateur" dans la sidebar
  if (elev) {
    const roleEl = document.getElementById('nav-role');
    if (roleEl) roleEl.textContent = 'Super Administrateur';
  }
}
