// =============================================================================
// IPAM SIW — stats.js  (server statistics)
// =============================================================================

import {
  requireAuth, startInactivityTimer, checkHttps, getUser, logout,
  get, showToast, sortSites,
} from './api.js';

// ---------------------------------------------------------------------------
// Server role definitions
// ---------------------------------------------------------------------------
const WIN_ROLES = [
  { code: 'FS', label: 'Serveurs de Fichiers' },
  { code: 'AP', label: 'Serveurs Applicatifs' },
  { code: 'AR', label: 'Serveurs RUMBA' },
  { code: 'IS', label: "Serveurs d'Impression" },
  { code: 'TS', label: 'Serveurs de Rebond' },
  { code: 'FI', label: 'Serveurs Impression & Fichiers' },
  { code: 'FZ', label: 'Serveurs Fichiers Z' },
  { code: 'AT', label: 'Serveurs STEI' },
  { code: 'SS', label: 'Serveurs de Sauvegarde' },
  { code: 'LD', label: 'Serveurs Landesk' },
  { code: 'AF', label: 'Serveurs PROCEF' },
  { code: 'PR', label: 'Serveurs de PRA' },
  { code: 'AS', label: 'Serveurs de Socle' },
  { code: 'AA', label: 'Serveurs Rebond SRW' },
];

// Linux roles — only CFT and Nutanix are tracked
const LIN_ROLES = [
  { code: 'XG',   label: 'Serveurs CFT' },
  { code: 'SPHY', label: 'Serveurs Nutanix' },
];

// Domain suffixes are the source of truth for OS classification
const WIN_DOMAIN  = '.dct.adt.local';
// Nutanix nodes use either of these suffixes and start with "SP"
const LIN_DOMAINS = ['.hdcadmin.sf.intra.laposte.fr', '.sf.intra.laposte.fr'];

function classifyHostname(raw) {
  if (!raw) return null;
  const lower = raw.toLowerCase();

  const isWindows = lower.endsWith(WIN_DOMAIN);
  // Match either Linux domain (longest first to avoid partial match)
  const isLinux = LIN_DOMAINS.some(d => lower.endsWith(d));
  if (!isWindows && !isLinux) return null;

  const label = raw.split('.')[0]; // first DNS label, e.g. "758100SN-AP01" or "bxXG01"

  if (isLinux) {
    // Nutanix: hostname starts with "SP" (covers SPHY and other SP* variants)
    if (/^SP/i.test(label)) return { type: 'linux', role: 'SPHY' };
    // CFT: [2-letter prefix] + XG + digits, e.g. bxXG01
    const m = label.match(/^[A-Z]{2}XG\d+$/i);
    if (m) return { type: 'linux', role: 'XG' };
    // All other Linux hostnames are ignored (not tracked)
    return null;
  }

  // Windows: extract role from last dash segment
  // e.g. "758100SN-AP01" → suffix "AP01" → role "AP"
  const lastDash = label.lastIndexOf('-');
  if (lastDash < 0) return null;
  const m = label.slice(lastDash + 1).match(/^([A-Z]{2})\d+$/i);
  if (!m) return null;
  return { type: 'windows', role: m[1].toUpperCase() };
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  checkHttps();
  if (!requireAuth()) return;
  startInactivityTimer();

  const user = getUser();
  document.getElementById('nav-username').textContent = user?.username || '';
  document.getElementById('nav-role').textContent = user?.role === 'admin' ? 'Administrateur' : 'Utilisateur';
  document.getElementById('btn-logout').addEventListener('click', () => {
    if (confirm('Se déconnecter ?')) logout();
  });

  if (user?.role === 'admin') {
    document.getElementById('nav-admin-link').classList.remove('hidden');
  }

  // Auto-refresh when an IP changes in another tab (site.js broadcasts via localStorage)
  let _refreshTimer = null;
  window.addEventListener('storage', e => {
    if (e.key !== 'ipam-ip-change') return;
    clearTimeout(_refreshTimer);
    _refreshTimer = setTimeout(() => loadStats(), 800);
  });

  await loadStats();
});

async function loadStats() {
  const loadingEl = document.getElementById('stats-loading');
  const loadingMsg = document.getElementById('stats-loading-msg');
  const contentEl  = document.getElementById('stats-content');

  loadingEl.style.display = 'flex';
  contentEl.classList.add('hidden');

  try {
    // Fetch site list
    loadingMsg.textContent = 'Récupération de la liste des sites…';
    const data = await get('/api/sites');
    const sites = sortSites(data.sites || []);

    if (!sites.length) {
      loadingMsg.textContent = 'Aucun site trouvé.';
      return;
    }

    // Fetch all site details in parallel
    loadingMsg.textContent = `Analyse de ${sites.length} site(s)…`;
    const details = await Promise.all(
      sites.map(s => get(`/api/sites/${encodeURIComponent(s.id)}`).catch(() => ({ ips: [] })))
    );

    // Classify all hostnames — deduplicate: count each hostname only once
    let winTotal  = 0;
    let linTotal  = 0;
    const winRoleCounts = {};
    const linRoleCounts = {};
    WIN_ROLES.forEach(r => { winRoleCounts[r.code] = 0; });
    LIN_ROLES.forEach(r => { linRoleCounts[r.code] = 0; });
    const seen = new Set();

    for (const site of details) {
      const ips = site.ips || [];
      for (const ip of ips) {
        if (ip.status === 'Libre' || !ip.hostname) continue;
        const key = ip.hostname.split('.')[0].toUpperCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const result = classifyHostname(ip.hostname);
        if (!result) continue;
        if (result.type === 'linux') {
          linTotal++;
          linRoleCounts[result.role] = (linRoleCounts[result.role] || 0) + 1;
        } else if (result.type === 'windows') {
          winTotal++;
          winRoleCounts[result.role] = (winRoleCounts[result.role] || 0) + 1;
        }
      }
    }

    const total = winTotal + linTotal;

    // Update subtitle
    document.getElementById('stats-subtitle').textContent =
      `Analyse de ${sites.length} site(s) — ${total} serveur(s) identifié(s) (IPs Utilisées + Réservées)`;

    // Update counters
    document.getElementById('count-windows').textContent = winTotal.toLocaleString('fr');
    document.getElementById('count-linux').textContent   = linTotal.toLocaleString('fr');
    document.getElementById('count-total').textContent   = total.toLocaleString('fr');

    // Render roles grids
    renderRoles('roles-grid-win', winRoleCounts, winTotal, '#58a6ff', '#1f6feb');
    renderRoles('roles-grid-lin', linRoleCounts, linTotal, '#3fb950', '#26a641');

    // Show content
    loadingEl.style.display = 'none';
    contentEl.classList.remove('hidden');

  } catch (err) {
    showToast(err.message, 'error');
    loadingMsg.textContent = `Erreur : ${err.message}`;
  }
}

function renderRoles(gridId, roleCounts, total, colorA, colorB) {
  const grid = document.getElementById(gridId);
  const knownRoles = gridId.includes('win') ? WIN_ROLES : LIN_ROLES;

  // Known roles first, then any extra codes found in data
  const knownCodes = new Set(knownRoles.map(r => r.code));
  const extraRoles = Object.keys(roleCounts)
    .filter(code => !knownCodes.has(code) && roleCounts[code] > 0)
    .sort()
    .map(code => ({ code, label: 'Rôle ' + code }));

  const allRoles = [...knownRoles, ...extraRoles];
  const maxCount = Math.max(1, ...allRoles.map(r => roleCounts[r.code] || 0));

  grid.innerHTML = allRoles.map((r, i) => {
    const count  = roleCounts[r.code] || 0;
    const pct    = total ? Math.round(count / total * 100) : 0;
    const barW   = Math.round(count / maxCount * 100);
    const col    = i % 2;
    const row    = Math.floor(i / 2);
    const borderT = row > 0 ? 'border-top:1px solid #21262d;' : '';
    const borderR = col === 0 ? 'border-right:1px solid #21262d;' : '';

    return `
      <div style="${borderT}${borderR}-webkit-box-flex:0;-ms-flex:0 0 50%;flex:0 0 50%;min-width:0;padding:16px 20px;box-sizing:border-box;">
        <div style="display:-webkit-box;display:-ms-flexbox;display:flex;-webkit-box-pack:justify;-ms-flex-pack:justify;justify-content:space-between;-webkit-box-align:center;-ms-flex-align:center;align-items:center;margin-bottom:8px;">
          <div>
            <span style="font-size:12px;font-weight:700;color:${colorA};background:${colorA}18;border:1px solid ${colorA}44;padding:1px 7px;border-radius:4px;margin-right:8px;">${esc(r.code)}</span>
            <span style="font-size:13px;color:#e6edf3;">${esc(r.label)}</span>
          </div>
          <div style="text-align:right;-ms-flex-negative:0;flex-shrink:0;margin-left:12px;">
            <span style="font-size:20px;font-weight:700;color:#e6edf3;">${count.toLocaleString('fr')}</span>
            <span style="font-size:11px;color:#484f58;margin-left:4px;">${pct}%</span>
          </div>
        </div>
        <div style="height:4px;background:#21262d;border-radius:999px;overflow:hidden;">
          <div style="height:100%;width:${barW}%;background:-webkit-linear-gradient(left,${colorA},${colorB});background:linear-gradient(90deg,${colorA},${colorB});border-radius:999px;-webkit-transition:width .4s ease;transition:width .4s ease;"></div>
        </div>
      </div>
    `;
  }).join('');
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
