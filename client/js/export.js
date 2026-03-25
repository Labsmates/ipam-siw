// =============================================================================
// IPAM SIW — export.js  (Excel export for all authenticated users)
// =============================================================================

import {
  requireAuth, startInactivityTimer, checkHttps, getUser, logout,
  get, showToast, sortSites, showConfirm, initTheme,
} from './api.js';

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  checkHttps(); initTheme();
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
    document.getElementById('nav-config-link')?.classList.remove('hidden');
  }

  // Load site list then setup export UI + sidebar
  try {
    const data = await get('/api/sites');
    const allSites = sortSites(data.sites || []);
    setupExport(allSites);
    loadSidebar(allSites);
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------
function loadSidebar(sites) {
  const list   = document.getElementById('site-list');
  const search = document.getElementById('sidebar-search');
  if (!list) return;

  function render(q) {
    const filtered = q ? sites.filter(s => s.name.toLowerCase().includes(q.toLowerCase())) : sites;
    list.innerHTML = filtered.map(s => `
      <a href="/site.html?id=${s.id}" style="padding:9px 16px;display:flex;align-items:center;justify-content:space-between;font-size:13px;color:var(--tx-2);text-decoration:none;border-left:2px solid transparent;transition:all .1s" onmouseenter="this.style.background='var(--bg-3)';this.style.color='var(--tx-1)'" onmouseleave="this.style.background='';this.style.color='var(--tx-2)'">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${s.name}</span>
      </a>`).join('');
  }
  render('');
  search?.addEventListener('input', e => render(e.target.value.trim()));
}

// ---------------------------------------------------------------------------
// Export UI
// ---------------------------------------------------------------------------
function setupExport(allSites) {
  const listEl    = document.getElementById('export-site-list');
  const searchEl  = document.getElementById('export-search');
  const countEl   = document.getElementById('export-selection-count');
  const btnAll    = document.getElementById('btn-select-all');
  const btnNone   = document.getElementById('btn-deselect-all');
  const btnExport = document.getElementById('btn-do-export');

  function renderExportList(q = '') {
    const filtered = q ? allSites.filter(s => s.name.toLowerCase().includes(q.toLowerCase())) : allSites;
    listEl.innerHTML = filtered.map(s => `
      <label class="export-site-item">
        <input type="checkbox" class="export-cb" data-id="${s.id}" data-name="${esc(s.name)}"
               style="accent-color:#58a6ff;width:14px;height:14px;-ms-flex-negative:0;flex-shrink:0">
        <span style="font-size:13px;color:var(--tx-1);-webkit-box-flex:1;-ms-flex:1;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.name)}</span>
        <span style="font-size:11px;color:var(--tx-4);-ms-flex-negative:0;flex-shrink:0">${s.total || 0} IPs</span>
      </label>
    `).join('');
    listEl.querySelectorAll('.export-cb').forEach(cb => cb.addEventListener('change', updateCount));
    updateCount();
  }

  function updateCount() {
    const n = listEl.querySelectorAll('.export-cb:checked').length;
    countEl.textContent = `${n} site${n !== 1 ? 's' : ''} sélectionné${n !== 1 ? 's' : ''}`;
  }

  searchEl.addEventListener('input', e => renderExportList(e.target.value.trim()));

  btnAll.addEventListener('click', () => {
    listEl.querySelectorAll('.export-cb').forEach(cb => { cb.checked = true; });
    updateCount();
  });
  btnNone.addEventListener('click', () => {
    listEl.querySelectorAll('.export-cb').forEach(cb => { cb.checked = false; });
    updateCount();
  });

  btnExport.addEventListener('click', async () => {
    const selected = [...listEl.querySelectorAll('.export-cb:checked')];
    if (!selected.length) { showToast('Sélectionnez au moins un site', 'warn'); return; }

    const format       = document.querySelector('input[name="export-format"]:checked')?.value || 'multi';
    const filterStatus = document.getElementById('export-filter-status').value;
    const colVlan      = document.getElementById('col-vlan').checked;
    const colNetwork   = document.getElementById('col-network').checked;
    const colHostname  = document.getElementById('col-hostname').checked;
    const colStatus    = document.getElementById('col-status').checked;
    const colGateway   = document.getElementById('col-gateway').checked;

    btnExport.disabled = true;
    btnExport.textContent = `Chargement… (0/${selected.length})`;

    try {
      const wb = XLSX.utils.book_new();

      if (format === 'single') {
        const header = buildHeader({ colVlan, colNetwork, colHostname, colStatus, colGateway, single: true });
        const rows   = [header];

        for (let i = 0; i < selected.length; i++) {
          const cb       = selected[i];
          const siteId   = cb.dataset.id;
          const siteName = cb.dataset.name;
          btnExport.textContent = `Chargement… (${i + 1}/${selected.length})`;

          const data = await get(`/api/sites/${encodeURIComponent(siteId)}`);
          appendRows(rows, data, siteName, filterStatus, { colVlan, colNetwork, colHostname, colStatus, colGateway, single: true });
        }

        const ws = XLSX.utils.aoa_to_sheet(rows);
        styleSheet(ws);
        XLSX.utils.book_append_sheet(wb, ws, 'Export IPAM');

      } else {
        for (let i = 0; i < selected.length; i++) {
          const cb       = selected[i];
          const siteId   = cb.dataset.id;
          const siteName = cb.dataset.name;
          btnExport.textContent = `Chargement… (${i + 1}/${selected.length})`;

          const data = await get(`/api/sites/${encodeURIComponent(siteId)}`);
          const header = buildHeader({ colVlan, colNetwork, colHostname, colStatus, colGateway, single: false });
          const rows   = [header];
          appendRows(rows, data, siteName, filterStatus, { colVlan, colNetwork, colHostname, colStatus, colGateway, single: false });

          const ws = XLSX.utils.aoa_to_sheet(rows);
          styleSheet(ws);
          const sheetName = siteName.substring(0, 31);
          XLSX.utils.book_append_sheet(wb, ws, sheetName);
        }
      }

      const date = new Date().toISOString().slice(0, 10);
      XLSX.writeFile(wb, `IPAM_Export_${date}.xlsx`);
      showToast(`Export réussi — ${selected.length} site(s)`, 'success');

    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btnExport.disabled = false;
      btnExport.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Télécharger`;
    }
  });

  renderExportList();
}

// ---------------------------------------------------------------------------
// Helpers (same as admin.js)
// ---------------------------------------------------------------------------
function buildHeader({ colVlan, colNetwork, colHostname, colStatus, colGateway, single }) {
  const h = [];
  if (single)       h.push('Site');
  if (colVlan)      h.push('VLAN ID');
  if (colNetwork)   h.push('Réseau');
  h.push('Adresse IP');
  if (colHostname)  h.push('Hostname');
  if (colStatus)    h.push('Statut');
  if (colGateway)   h.push('Gateway');
  return h;
}

function appendRows(rows, data, siteName, filterStatus, opts) {
  const vlans = data.vlans || [];
  const ips   = data.ips   || [];

  const vlanMap = {};
  vlans.forEach(v => { vlanMap[String(v.id)] = v; });

  for (const ip of ips) {
    if (filterStatus !== 'all' && ip.status !== filterStatus) continue;
    const vlan = vlanMap[String(ip.vlan_id)] || {};
    const row  = [];
    if (opts.single)      row.push(siteName);
    if (opts.colVlan)     row.push(vlan.vlan_id || '');
    if (opts.colNetwork)  row.push(vlan.network || '');
    row.push(ip.ip_address || '');
    if (opts.colHostname) row.push(ip.hostname || '');
    if (opts.colStatus)   row.push(ip.status || '');
    if (opts.colGateway)  row.push(vlan.gateway || '');
    rows.push(row);
  }
}

function styleSheet(ws) {
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  const cols = [];
  for (let c = range.s.c; c <= range.e.c; c++) cols.push({ wch: 22 });
  ws['!cols'] = cols;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
