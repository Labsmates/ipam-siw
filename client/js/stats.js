// =============================================================================
// IPAM SIW — stats.js  (server statistics)
// =============================================================================

import {
  requireAuth, startInactivityTimer, checkHttps, getUser, logout,
  get, showToast, sortSites, showConfirm,
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
  { code: 'ZN', label: 'Serveurs Fichier / APP' },
  { code: 'QN', label: 'Serveurs de Qualif' },
  { code: 'AT', label: 'Serveurs STEI' },
  { code: 'SS', label: 'Serveurs de Sauvegarde' },
  { code: 'LD', label: 'Serveurs Landesk' },
  { code: 'AF', label: 'Serveurs PROCEF' },
  { code: 'PR', label: 'Serveurs de PRA' },
  { code: 'AS',    label: 'Serveurs de Socle' },
  { code: 'AA',    label: 'Serveurs Rebond SRW' },
  { code: 'IDRAC', label: 'IDRAC / iLO' },
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
  const label = raw.split('.')[0]; // first DNS label, e.g. "758100ZN-FS01"

  // IDRAC/ILO — détecté par préfixe, indépendant du suffixe de domaine
  // Ex: IDRAC-924700SN-AP01  ou  ILO-924700SN-FS01.dct.adt.local
  if (/^(IDRAC|ILO)-/i.test(label)) return { type: 'windows', role: 'IDRAC' };

  // ZN / QN — détectés par préfixe, indépendant du suffixe de domaine
  // Ex: 758100ZN-FS01.dct.adt.local  ou  924700QN-AP01
  const lastDash = label.lastIndexOf('-');
  if (lastDash >= 0) {
    const prefix = label.slice(0, lastDash);
    if (/ZN$/i.test(prefix)) return { type: 'windows', role: 'ZN' };
    if (/QN$/i.test(prefix)) return { type: 'windows', role: 'QN' };
  }

  // Toutes les autres catégories nécessitent un suffixe de domaine connu
  const isWindows = lower.endsWith(WIN_DOMAIN);
  const isLinux   = LIN_DOMAINS.some(d => lower.endsWith(d));
  if (!isWindows && !isLinux) return null;

  if (isLinux) {
    if (/^SP/i.test(label)) return { type: 'linux', role: 'SPHY' };
    if (label.match(/^[A-Z]{2}XG\d+$/i)) return { type: 'linux', role: 'XG' };
    return null;
  }

  // Windows (.dct.adt.local) — rôle déterminé par les 2 lettres après le dernier tiret
  // Ex: 924700SN-AP01.dct.adt.local → AP,  24700SN-FS01.dct.adt.local → FS
  if (lastDash < 0) return null;
  const suffix = label.slice(lastDash + 1);
  const m = suffix.match(/^([A-Z]{2})\d+$/i);
  if (!m) return null;
  return { type: 'windows', role: m[1].toUpperCase() };
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
// Stored data for re-render on search change
let _statsData = null;
let _searchRoleWin = '';
let _searchRoleLin = '';
let _searchIpSite  = '';

document.addEventListener('DOMContentLoaded', async () => {
  checkHttps();
  if (!requireAuth()) return;
  startInactivityTimer();

  const user = getUser();
  document.getElementById('nav-username').textContent = user?.username || '';
  document.getElementById('nav-role').textContent = user?.role === 'admin' ? 'Administrateur' : user?.role === 'viewer' ? 'Lecteur' : 'Utilisateur';
  document.getElementById('btn-logout').addEventListener('click', async () => {
    if (await showConfirm({ title: 'Déconnexion', message: 'Voulez-vous vous déconnecter ?', confirmText: 'Se déconnecter', danger: true })) logout();
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
    const winRoleCounts    = {};
    const linRoleCounts    = {};
    const winRoleHostnames = {};
    const linRoleHostnames = {};
    WIN_ROLES.forEach(r => { winRoleCounts[r.code] = 0; winRoleHostnames[r.code] = []; });
    LIN_ROLES.forEach(r => { linRoleCounts[r.code] = 0; linRoleHostnames[r.code] = []; });
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
          if (!linRoleHostnames[result.role]) linRoleHostnames[result.role] = [];
          linRoleHostnames[result.role].push(ip.hostname);
        } else if (result.type === 'windows') {
          winTotal++;
          winRoleCounts[result.role] = (winRoleCounts[result.role] || 0) + 1;
          if (!winRoleHostnames[result.role]) winRoleHostnames[result.role] = [];
          winRoleHostnames[result.role].push(ip.hostname);
        }
      }
    }
    // Sort hostname lists alphabetically
    Object.values(winRoleHostnames).forEach(arr => arr.sort());
    Object.values(linRoleHostnames).forEach(arr => arr.sort());

    const total = winTotal + linTotal;

    // Update subtitle
    document.getElementById('stats-subtitle').textContent =
      `Analyse de ${sites.length} site(s) — ${total} serveur(s) identifié(s) (IPs Utilisées + Réservées)`;

    // Update counters
    document.getElementById('count-windows').textContent = winTotal.toLocaleString('fr');
    document.getElementById('count-linux').textContent   = linTotal.toLocaleString('fr');
    document.getElementById('count-total').textContent   = total.toLocaleString('fr');

    // Store for re-render on search change
    _statsData = { sites, details, winRoleCounts, winTotal, linRoleCounts, linTotal, winRoleHostnames, linRoleHostnames };

    // Render roles grids (apply current search filters in case of refresh)
    renderRoles('roles-grid-win', winRoleCounts, winTotal, '#58a6ff', '#1f6feb', _searchRoleWin, winRoleHostnames);
    renderRoles('roles-grid-lin', linRoleCounts, linTotal, '#3fb950', '#26a641', _searchRoleLin, linRoleHostnames);

    // Render IP statistics
    renderIpStats(sites, details, _searchIpSite);

    // Show content
    loadingEl.style.display = 'none';
    contentEl.classList.remove('hidden');

    // Wire search inputs once (first load only)
    if (!_statsData._listenersWired) {
      _statsData._listenersWired = true;
      document.getElementById('search-role-win')?.addEventListener('input', e => {
        _searchRoleWin = e.target.value.trim();
        renderRoles('roles-grid-win', _statsData.winRoleCounts, _statsData.winTotal, '#58a6ff', '#1f6feb', _searchRoleWin, _statsData.winRoleHostnames);
      });
      document.getElementById('search-role-lin')?.addEventListener('input', e => {
        _searchRoleLin = e.target.value.trim();
        renderRoles('roles-grid-lin', _statsData.linRoleCounts, _statsData.linTotal, '#3fb950', '#26a641', _searchRoleLin, _statsData.linRoleHostnames);
      });
      document.getElementById('search-ip-site')?.addEventListener('input', e => {
        _searchIpSite = e.target.value.trim();
        renderIpStats(_statsData.sites, _statsData.details, _searchIpSite);
      });
    }

  } catch (err) {
    showToast(err.message, 'error');
    loadingMsg.textContent = `Erreur : ${err.message}`;
  }
}

function renderRoles(gridId, roleCounts, total, colorA, colorB, filter = '', roleHostnames = {}) {
  const grid = document.getElementById(gridId);
  const knownRoles = gridId.includes('win') ? WIN_ROLES : LIN_ROLES;

  const knownCodes = new Set(knownRoles.map(r => r.code));
  const extraRoles = Object.keys(roleCounts)
    .filter(code => !knownCodes.has(code) && roleCounts[code] > 0)
    .sort()
    .map(code => ({ code, label: 'Rôle ' + code }));

  let allRoles = [...knownRoles, ...extraRoles];

  if (filter) {
    const q = filter.toUpperCase();
    allRoles = allRoles.filter(r => r.code.toUpperCase().includes(q) || r.label.toUpperCase().includes(q));
  }

  if (!allRoles.length) {
    grid.innerHTML = `<div style="padding:24px;color:#8b949e;font-size:13px;text-align:center;">Aucun rôle ne correspond à « ${esc(filter)} »</div>`;
    return;
  }

  const maxCount = Math.max(1, ...allRoles.map(r => roleCounts[r.code] || 0));

  // Mode détail (filtre actif) : pleine largeur + liste des serveurs
  if (filter) {
    grid.innerHTML = allRoles.map((r, i) => {
      const count    = roleCounts[r.code] || 0;
      const pct      = total ? Math.round(count / total * 100) : 0;
      const hostnames = roleHostnames[r.code] || [];
      const borderT  = i > 0 ? 'border-top:1px solid #21262d;' : '';

      const serverChips = hostnames.map(h =>
        `<span style="font-family:'JetBrains Mono',monospace;font-size:11px;color:#c9d1d9;background:#21262d;border:1px solid #30363d;border-radius:4px;padding:2px 8px;white-space:nowrap;">${esc(h)}</span>`
      ).join('');

      return `
        <div style="${borderT}width:100%;padding:16px 20px;box-sizing:border-box;">
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
          <div style="height:4px;background:#21262d;border-radius:999px;overflow:hidden;margin-bottom:${hostnames.length ? '14px' : '0'};">
            <div style="height:100%;width:100%;background:-webkit-linear-gradient(left,${colorA},${colorB});background:linear-gradient(90deg,${colorA},${colorB});border-radius:999px;"></div>
          </div>
          ${hostnames.length ? `
          <div style="display:-webkit-box;display:-ms-flexbox;display:flex;-ms-flex-wrap:wrap;flex-wrap:wrap;gap:6px;">
            ${serverChips}
          </div>` : `<div style="font-size:12px;color:#484f58;font-style:italic;">Aucun serveur trouvé pour ce rôle</div>`}
        </div>
      `;
    }).join('');
    return;
  }

  // Mode résumé (sans filtre) : grille 2 colonnes
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

function renderIpStats(sites, details, siteFilter = '') {
  // ── Global totals — always all sites, not affected by filter ──────────────
  let gTotal = 0, gUtilise = 0, gLibre = 0, gReserve = 0;
  for (const s of sites) {
    gTotal   += s.total   || 0;
    gUtilise += s.utilise || 0;
    gLibre   += s.libre   || 0;
    gReserve += s.reserve || 0;
  }
  document.getElementById('ip-count-total').textContent   = gTotal.toLocaleString('fr');
  document.getElementById('ip-count-utilise').textContent = gUtilise.toLocaleString('fr');
  document.getElementById('ip-count-libre').textContent   = gLibre.toLocaleString('fr');
  document.getElementById('ip-count-reserve').textContent = gReserve.toLocaleString('fr');

  // ── Per-site / per-VLAN breakdown (filtered by site name) ─────────────────
  const grid = document.getElementById('ip-sites-grid');
  const q = siteFilter.toLowerCase();
  const visibleSites = q ? sites.filter(s => s.name.toLowerCase().includes(q)) : sites;

  if (!visibleSites.length) {
    grid.innerHTML = `<div style="padding:32px;color:#8b949e;font-size:13px;text-align:center;">Aucun site ne correspond à « ${esc(siteFilter)} »</div>`;
    return;
  }

  grid.innerHTML = visibleSites.map(site => {
    const idx = sites.indexOf(site);
    const detail = details[idx] || {};
    const vlans  = detail.vlans || [];
    const ips    = detail.ips   || [];

    // vlan db id → VLAN metadata
    const vlanMap = {};
    for (const v of vlans) vlanMap[String(v.id)] = v;

    // Count statuses per VLAN db id
    const vlanStats = {};
    for (const ip of ips) {
      const vid = String(ip.vlan_id);
      if (!vlanStats[vid]) vlanStats[vid] = { total: 0, utilise: 0, libre: 0, reserve: 0 };
      vlanStats[vid].total++;
      if      (ip.status === 'Utilisé')   vlanStats[vid].utilise++;
      else if (ip.status === 'Libre')     vlanStats[vid].libre++;
      else if (ip.status === 'Réservée')  vlanStats[vid].reserve++;
    }

    // Sort VLANs by VLAN number
    const sortedVids = Object.keys(vlanStats)
      .sort((a, b) => Number(vlanMap[a]?.vlan_id || 0) - Number(vlanMap[b]?.vlan_id || 0));

    const sTotal = site.total || 0, sUtil = site.utilise || 0;
    const sLibre = site.libre || 0, sRes  = site.reserve || 0;
    const sPct   = sTotal ? Math.round(sUtil / sTotal * 100) : 0;

    const rows = sortedVids.map(vid => {
      const v   = vlanMap[vid] || {};
      const s   = vlanStats[vid];
      const pct = s.total ? Math.round(s.utilise / s.total * 100) : 0;
      return `
        <tr style="border-bottom:1px solid #21262d;"
            onmouseenter="this.style.background='#161b22'" onmouseleave="this.style.background=''">
          <td style="padding:10px 20px;">
            <span style="font-size:12px;font-weight:700;color:#58a6ff;background:#0d2240;border:1px solid #1f4080;padding:2px 8px;border-radius:4px;white-space:nowrap;">VLAN ${esc(String(v.vlan_id || vid))}</span>
          </td>
          <td style="padding:10px 20px;font-size:12px;color:#8b949e;font-family:'JetBrains Mono',monospace;">${esc(v.network || '—')}</td>
          <td style="padding:10px 20px;font-size:13px;font-weight:700;color:#e6edf3;text-align:right;">${s.total.toLocaleString('fr')}</td>
          <td style="padding:10px 20px;font-size:13px;font-weight:700;color:#f85149;text-align:right;">${s.utilise.toLocaleString('fr')}</td>
          <td style="padding:10px 20px;font-size:13px;font-weight:700;color:#3fb950;text-align:right;">${s.libre.toLocaleString('fr')}</td>
          <td style="padding:10px 20px;font-size:13px;font-weight:700;color:#d29922;text-align:right;">${s.reserve.toLocaleString('fr')}</td>
          <td style="padding:10px 20px;text-align:right;">
            <div style="display:-webkit-inline-box;display:-ms-inline-flexbox;display:inline-flex;-webkit-box-align:center;-ms-flex-align:center;align-items:center;gap:7px;">
              <div style="width:64px;height:5px;background:#21262d;border-radius:999px;overflow:hidden;">
                <div style="height:100%;width:${pct}%;background:-webkit-linear-gradient(left,#f85149,#ff7b72);background:linear-gradient(90deg,#f85149,#ff7b72);border-radius:999px;"></div>
              </div>
              <span style="font-size:11px;color:#484f58;min-width:28px;text-align:right;">${pct}%</span>
            </div>
          </td>
        </tr>`;
    }).join('');

    return `
      <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;overflow:hidden;margin-bottom:14px;">
        <!-- Site header -->
        <div style="padding:14px 20px;background:#1c2128;border-bottom:1px solid #30363d;display:-webkit-box;display:-ms-flexbox;display:flex;-webkit-box-pack:justify;-ms-flex-pack:justify;justify-content:space-between;-webkit-box-align:center;-ms-flex-align:center;align-items:center;-ms-flex-wrap:wrap;flex-wrap:wrap;gap:10px;">
          <span style="font-size:14px;font-weight:700;color:#e6edf3;">${esc(site.name)}</span>
          <div style="display:-webkit-box;display:-ms-flexbox;display:flex;gap:18px;font-size:12px;-ms-flex-wrap:wrap;flex-wrap:wrap;">
            <span style="color:#8b949e;">Total <strong style="color:#e6edf3;">${sTotal.toLocaleString('fr')}</strong></span>
            <span style="color:#f85149;">Utilisé <strong>${sUtil.toLocaleString('fr')}</strong></span>
            <span style="color:#3fb950;">Libre <strong>${sLibre.toLocaleString('fr')}</strong></span>
            <span style="color:#d29922;">Réservée <strong>${sRes.toLocaleString('fr')}</strong></span>
            <span style="color:#484f58;">Taux <strong style="color:#e6edf3;">${sPct}%</strong></span>
          </div>
        </div>
        <!-- VLAN table -->
        <table style="width:100%;border-collapse:collapse;">
          <thead>
            <tr style="background:#0d1117;">
              <th style="padding:8px 20px;font-size:11px;font-weight:600;color:#484f58;text-align:left;border-bottom:1px solid #21262d;white-space:nowrap;">VLAN</th>
              <th style="padding:8px 20px;font-size:11px;font-weight:600;color:#484f58;text-align:left;border-bottom:1px solid #21262d;">Réseau</th>
              <th style="padding:8px 20px;font-size:11px;font-weight:600;color:#8b949e;text-align:right;border-bottom:1px solid #21262d;">Total</th>
              <th style="padding:8px 20px;font-size:11px;font-weight:600;color:#f85149;text-align:right;border-bottom:1px solid #21262d;">Utilisé</th>
              <th style="padding:8px 20px;font-size:11px;font-weight:600;color:#3fb950;text-align:right;border-bottom:1px solid #21262d;">Libre</th>
              <th style="padding:8px 20px;font-size:11px;font-weight:600;color:#d29922;text-align:right;border-bottom:1px solid #21262d;">Réservée</th>
              <th style="padding:8px 20px;font-size:11px;font-weight:600;color:#484f58;text-align:right;border-bottom:1px solid #21262d;">% util.</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }).join('');
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
