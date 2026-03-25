// =============================================================================
// IPAM SIW — ipcalc.js  (Calculateur IP — tous les utilisateurs)
// =============================================================================

import {
  requireAuth, startInactivityTimer, checkHttps, getUser, logout,
  get, showToast, showConfirm, initTheme, sortSites,
} from './api.js';

document.addEventListener('DOMContentLoaded', async () => {
  checkHttps();
  initTheme();
  if (!requireAuth()) return;
  startInactivityTimer();

  const user = getUser();

  document.getElementById('nav-username').textContent = user.username;
  document.getElementById('nav-role').textContent     = user.role === 'admin' ? 'Administrateur' : 'Utilisateur';

  // Liens admin visibles pour les admins seulement
  if (user?.role === 'admin') {
    document.getElementById('nav-admin-link')?.classList.remove('hidden');
    document.getElementById('nav-config-link')?.classList.remove('hidden');
  }

  document.getElementById('btn-logout').addEventListener('click', async () => {
    if (await showConfirm({
      title: 'Déconnexion',
      message: 'Voulez-vous vous déconnecter ?',
      confirmText: 'Se déconnecter',
      danger: true,
    })) logout();
  });

  loadSidebar();
  setupIpCalc();
});

async function loadSidebar() {
  try {
    const data   = await get('/api/sites');
    const sites  = sortSites(data.sites || []);
    const list   = document.getElementById('site-list');
    const search = document.getElementById('sidebar-search');

    function render(q) {
      const filtered = q ? sites.filter(s => s.name.toLowerCase().includes(q.toLowerCase())) : sites;
      list.innerHTML = filtered.map(s => `
        <a href="/site.html?id=${s.id}" style="padding:9px 16px;display:flex;align-items:center;justify-content:space-between;font-size:13px;color:var(--tx-2);text-decoration:none;border-left:2px solid transparent;transition:all .1s" onmouseenter="this.style.background='var(--bg-3)';this.style.color='var(--tx-1)'" onmouseleave="this.style.background='';this.style.color='var(--tx-2)'">
          <span>${esc(s.name)}</span>
          <span style="font-size:11px;color:var(--tx-3)">${s.vlan_count ?? 0} VLAN</span>
        </a>
      `).join('');
    }

    render('');
    search?.addEventListener('input', e => render(e.target.value));
  } catch (_) {}
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setupIpCalc() {
  const sel = document.getElementById('ipcalc-prefix');
  for (let i = 1; i <= 32; i++) {
    const opt = document.createElement('option');
    opt.value = i; opt.textContent = `/${i}`;
    if (i === 24) opt.selected = true;
    sel.appendChild(opt);
  }

  document.getElementById('btn-ipcalc').addEventListener('click', runIpCalc);
  document.getElementById('ipcalc-ip').addEventListener('keydown', e => { if (e.key === 'Enter') runIpCalc(); });
}

function ipToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return NaN;
  return parts.reduce((acc, p) => {
    const n = parseInt(p, 10);
    if (isNaN(n) || n < 0 || n > 255) return NaN;
    return (acc * 256 + n);
  }, 0);
}

function intToIp(n) {
  return [n >>> 24 & 0xFF, n >>> 16 & 0xFF, n >>> 8 & 0xFF, n & 0xFF].join('.');
}

function runIpCalc() {
  const raw    = document.getElementById('ipcalc-ip').value.trim();
  const prefix = parseInt(document.getElementById('ipcalc-prefix').value, 10);

  // Accepter "192.168.1.0" ou "192.168.1.0/24"
  const ipStr = raw.includes('/') ? raw.split('/')[0] : raw;
  const ipInt = ipToInt(ipStr);

  if (isNaN(ipInt) || prefix < 0 || prefix > 32) {
    showToast('Adresse IP invalide', 'warn');
    return;
  }

  const maskInt      = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0;
  const networkInt   = (ipInt & maskInt) >>> 0;
  const broadcastInt = (networkInt | (~maskInt >>> 0)) >>> 0;
  const totalIPs     = Math.pow(2, 32 - prefix);
  const usableHosts  = prefix >= 31 ? totalIPs : Math.max(0, totalIPs - 2);
  const gatewayInt   = prefix >= 31 ? networkInt : networkInt + 1;
  const ipMaxInt     = prefix >= 31 ? broadcastInt : broadcastInt - 1;
  const wildcardInt  = (~maskInt) >>> 0;

  const network   = intToIp(networkInt);
  const broadcast = intToIp(broadcastInt);
  const gateway   = intToIp(gatewayInt);
  const ipMin     = gateway;
  const ipMax     = intToIp(ipMaxInt);
  const mask      = intToIp(maskInt);
  const wildcard  = intToIp(wildcardInt);

  document.getElementById('ipcalc-cidr-label').textContent  = `${network}/${prefix}`;
  document.getElementById('ipcalc-mask-label').textContent   = `Masque : ${mask}`;
  document.getElementById('ipcalc-hosts-label').textContent  = usableHosts.toLocaleString('fr');

  function card(id, label, value, color) {
    document.getElementById(id).innerHTML = `
      <div style="font-size:11px;color:var(--tx-3);margin-bottom:6px">${label}</div>
      <div style="font-size:18px;font-weight:700;color:${color || 'var(--tx-1)'};font-family:'JetBrains Mono','Courier New',monospace;display:flex;align-items:center;justify-content:space-between;gap:8px">
        <span>${esc(String(value))}</span>
        <button onclick="navigator.clipboard.writeText('${value}').then(()=>window._showToast&&window._showToast('Copié','success'))" style="background:none;border:none;cursor:pointer;color:var(--tx-3);padding:2px 4px;border-radius:4px;font-size:11px;flex-shrink:0" title="Copier">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
      </div>
    `;
  }

  card('ipcalc-card-network',   'Adresse réseau',         network,                '#58a6ff');
  card('ipcalc-card-gateway',   'Passerelle (1ère IP)',    gateway,                '#3fb950');
  card('ipcalc-card-ipmin',     'IP minimum',             ipMin,                  '#3fb950');
  card('ipcalc-card-ipmax',     'IP maximum',             ipMax,                  '#d29922');
  card('ipcalc-card-broadcast', 'Broadcast',              broadcast,              '#f85149');
  card('ipcalc-card-total',     'IP totales',             totalIPs.toLocaleString('fr'), 'var(--tx-1)');
  card('ipcalc-card-mask',      'Masque de sous-réseau',  mask,                   'var(--tx-2)');
  card('ipcalc-card-wildcard',  'Masque inverse',         wildcard,               'var(--tx-2)');

  document.getElementById('ipcalc-result').classList.remove('hidden');
}

// Expose showToast globally for onclick handlers in innerHTML
window._showToast = showToast;
