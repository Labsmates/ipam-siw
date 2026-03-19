// =============================================================================
// IPAM SIW — site.js  (site detail: VLANs, IP table, reserve/release/import)
// =============================================================================

import {
  requireAuth, startInactivityTimer, checkHttps, getUser, logout,
  get, post, put, del, showToast, sortIPs, sortSites, statusBadge, fmtDate,
  openModal, closeModal, cidrToIPs, showConfirm,
} from './api.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let user       = null;   // set in DOMContentLoaded, used by module-level functions
let siteId     = null;
let siteData   = null;
let currentVlan = 'all'; // 'all' or vlan id
let filterStatus = 'all';
let searchIP   = '';
let page       = 1;
const PER_PAGE = 50;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  checkHttps();
  if (!requireAuth()) return;
  startInactivityTimer();

  const params = new URLSearchParams(location.search);
  siteId = params.get('id');

  user = getUser();
  document.getElementById('nav-username').textContent = user?.username || '';
  document.getElementById('nav-role').textContent = user?.role === 'admin' ? 'Administrateur' : user?.role === 'viewer' ? 'Lecteur' : 'Utilisateur';
  document.getElementById('btn-logout').addEventListener('click', async () => {
    if (await showConfirm({ title: 'Déconnexion', message: 'Voulez-vous vous déconnecter ?', confirmText: 'Se déconnecter', danger: true })) logout();
  });

  if (user?.role === 'admin') {
    document.getElementById('nav-admin-link').classList.remove('hidden');
  }

  // Viewers cannot access archive page — hide that sidebar link
  if (user?.role === 'viewer') {
    document.getElementById('nav-archive-link')?.classList.add('hidden');
  }

  // Populate sidebar
  loadSidebar();

  // Password change modal (accessible to all users)
  document.getElementById('btn-change-pw')?.addEventListener('click', () => {
    document.getElementById('modal-change-pw').classList.remove('hidden');
  });
  document.getElementById('btn-cancel-change-pw')?.addEventListener('click', () => {
    document.getElementById('modal-change-pw').classList.add('hidden');
  });
  document.getElementById('form-change-pw')?.addEventListener('submit', async e => {
    e.preventDefault();
    const current = document.getElementById('cpw-current').value;
    const newpw   = document.getElementById('cpw-new').value;
    const confirm2 = document.getElementById('cpw-confirm').value;
    if (newpw !== confirm2) { showToast('Les mots de passe ne correspondent pas', 'warn'); return; }
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Mise à jour…';
    try {
      await post('/api/me/password', { currentPassword: current, newPassword: newpw });
      showToast('Mot de passe modifié avec succès', 'success');
      document.getElementById('modal-change-pw').classList.add('hidden');
      e.target.reset();
    } catch (err) { showToast(err.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = 'Modifier'; }
  });

  // If no site selected, show welcome state
  if (!siteId) {
    document.getElementById('view-welcome').style.display = 'flex';
    document.getElementById('view-site').style.display = 'none';
    return;
  }

  // Show site view
  document.getElementById('view-welcome').style.display = 'none';
  const viewSite = document.getElementById('view-site');
  viewSite.style.display = 'flex';
  viewSite.style['-webkit-box-orient'] = 'vertical';
  viewSite.style['-ms-flex-direction'] = 'column';
  viewSite.style['flex-direction'] = 'column';

  if (user?.role === 'admin') {
    document.getElementById('admin-actions').classList.remove('hidden');
  } else {
    document.getElementById('user-actions').classList.remove('hidden');
  }

  // Search & filter
  document.getElementById('search-ip').addEventListener('input', e => {
    searchIP = e.target.value.trim();
    page = 1;
    renderTable();
  });
  document.getElementById('filter-status').addEventListener('change', e => {
    filterStatus = e.target.value;
    page = 1;
    renderTable();
  });

  // Modals
  setupModals(user);

  await loadSite();
});

// ---------------------------------------------------------------------------
// Load site data
// ---------------------------------------------------------------------------
async function loadSite() {
  const loadEl  = document.getElementById('tbl-loading');
  const tableEl = document.getElementById('ip-table');
  const emptyEl = document.getElementById('tbl-empty');
  if (loadEl)  loadEl.style.display  = 'flex';
  if (tableEl) tableEl.style.display = 'none';
  if (emptyEl) emptyEl.style.display = 'none';
  try {
    const data = await get(`/api/sites/${encodeURIComponent(siteId)}`);
    siteData = data;
    document.title = `IPAM — ${data.name}`;
    document.getElementById('site-name').textContent = data.name;
    renderStats();
    renderVlanTabs();
    renderTable();
  } catch (err) {
    showToast(err.message, 'error');
    document.getElementById('site-name').textContent = 'Erreur de chargement';
  } finally {
    if (loadEl) loadEl.style.display = 'none';
  }
}

// ---------------------------------------------------------------------------
// Stats bar
// ---------------------------------------------------------------------------
function renderStats() {
  const ips = siteData.ips || [];
  const total   = ips.length;
  const libre   = ips.filter(i => i.status === 'Libre').length;
  const utilise = ips.filter(i => i.status === 'Utilisé').length;
  const reserve = ips.filter(i => i.status === 'Réservée').length;

  document.getElementById('stat-total').textContent   = total.toLocaleString('fr');
  document.getElementById('stat-libre').textContent   = libre.toLocaleString('fr');
  document.getElementById('stat-utilise').textContent = utilise.toLocaleString('fr');
  document.getElementById('stat-reserve').textContent = reserve.toLocaleString('fr');

  const pct = total ? Math.round((utilise + reserve) / total * 100) : 0;
  document.getElementById('progress-bar').style.width = pct + '%';
}

// ---------------------------------------------------------------------------
// VLAN tabs
// ---------------------------------------------------------------------------
function renderVlanTabs() {
  const vlans   = siteData.vlans || [];
  const tabsEl  = document.getElementById('vlan-tabs');
  const infoEl  = document.getElementById('vlan-info');

  const tabs = [
    { id: 'all', label: 'Tous', network: '' },
    ...vlans.map(v => ({ id: v.id, label: `VLAN ${v.vlan_id}`, network: v.network || '' })),
  ];

  tabsEl.innerHTML = tabs.map(t => {
    const networkPart = t.network
      ? ` <span style="font-size:11px;font-weight:400;color:#6e7681;margin-left:4px;">(${t.network})</span>`
      : '';
    const isActive = String(currentVlan) === String(t.id);
    return `<button class="vlan-tab${isActive ? ' on' : ''}" data-id="${t.id}">${t.label}${networkPart}</button>`;
  }).join('');

  tabsEl.querySelectorAll('.vlan-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      currentVlan = btn.dataset.id;
      page = 1;
      renderVlanTabs();
      renderTable();
      // Show VLAN info
      if (currentVlan !== 'all') {
        const v = vlans.find(v => v.id === currentVlan);
        if (v) {
          infoEl.textContent = `Réseau : ${v.network || '—'}  |  Gateway : ${v.gateway || '—'}  |  Masque : ${v.mask || '—'}`;
          infoEl.classList.remove('hidden');
        }
      } else {
        infoEl.classList.add('hidden');
      }
    });
  });
}

// ---------------------------------------------------------------------------
// IP Table
// ---------------------------------------------------------------------------
function getFilteredIPs() {
  let ips = siteData.ips || [];
  if (currentVlan !== 'all') ips = ips.filter(ip => String(ip.vlan_id) === String(currentVlan));
  if (filterStatus !== 'all') ips = ips.filter(ip => ip.status === filterStatus);
  if (searchIP) {
    const q = searchIP.toLowerCase();
    ips = ips.filter(ip =>
      ip.ip_address.includes(searchIP) ||
      (ip.hostname && ip.hostname.toLowerCase().includes(q))
    );
  }
  return sortIPs(ips);
}

function renderTable() {
  const ips    = getFilteredIPs();
  const total  = ips.length;
  const pages  = Math.max(1, Math.ceil(total / PER_PAGE));
  if (page > pages) page = pages;

  const slice   = ips.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const tableEl = document.getElementById('ip-table');
  const emptyEl = document.getElementById('tbl-empty');
  const tbody   = document.getElementById('ip-tbody');

  if (!slice.length) {
    if (tableEl) tableEl.style.display = 'none';
    if (emptyEl) emptyEl.style.display = '-webkit-box';
    if (emptyEl) emptyEl.style.display = 'flex';
    tbody.innerHTML = '';
  } else {
    if (emptyEl) emptyEl.style.display = 'none';
    if (tableEl) tableEl.style.display = '';
    tbody.innerHTML = slice.map(ip => {
      const vlan = (siteData.vlans || []).find(v => String(v.id) === String(ip.vlan_id));
      const vlanLabel = vlan ? `VLAN ${vlan.vlan_id}` : '—';
      const isViewer     = user?.role === 'viewer';
      const canReserve   = !isViewer && ip.status === 'Libre';
      const canRelease   = !isViewer && (ip.status === 'Utilisé' || ip.status === 'Réservée');
      const canToggle    = !isViewer && (ip.status === 'Utilisé' || ip.status === 'Réservée');
      const toggleTarget = ip.status === 'Utilisé' ? 'Réservée' : 'Utilisé';
      const toggleTitle  = ip.status === 'Utilisé' ? 'Passer en Réservée' : 'Passer en Utilisé';

      return `
        <tr style="border-bottom:1px solid #21262d;-webkit-transition:background .1s;transition:background .1s;"
            onmouseenter="this.style.background='#161b22'" onmouseleave="this.style.background=''">
          <td style="padding:10px 16px;color:#e6edf3;font-family:'JetBrains Mono',monospace;font-size:13.5px;">${ip.ip_address}</td>
          <td style="padding:10px 16px;color:#8b949e;font-size:13px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${ip.hostname || '<span style="color:#484f58">—</span>'}</td>
          <td style="padding:10px 16px;">${statusBadge(ip.status)}</td>
          <td style="padding:10px 16px;color:#8b949e;font-size:13px;">${vlanLabel}</td>
          <td style="padding:10px 16px;color:#6e7681;font-size:12px;">${fmtDate(ip.updated_at)}</td>
          <td style="padding:10px 16px;text-align:right;display:-webkit-box;display:-ms-flexbox;display:flex;gap:6px;-webkit-box-pack:end;-ms-flex-pack:end;justify-content:flex-end;">
            ${canReserve ? `<button class="btn btn-sm btn-ok btn-action" data-id="${ip.id}" data-action="reserve">Réserver</button>` : ''}
            ${canRelease ? `<button class="btn btn-sm btn-d btn-action" data-id="${ip.id}" data-action="release">Libérer</button>` : ''}
            ${canToggle ? `<button class="btn btn-sm btn-action" data-id="${ip.id}" data-action="toggle-status" data-target="${toggleTarget}" title="${toggleTitle}"
              style="background:#1c2128;color:#e3b341;border:1px solid #3d3012;">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>` : ''}
            ${!isViewer ? `<button class="btn btn-sm btn-action" data-id="${ip.id}" data-action="rename"
              style="background:#1c2128;color:#8b949e;border:1px solid #30363d;">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>` : ''}
          </td>
        </tr>
      `;
    }).join('');
  }

  // Count + Pagination
  const countEl = document.getElementById('table-count');
  if (countEl) countEl.textContent = total ? `${total.toLocaleString('fr')} adresse${total !== 1 ? 's' : ''}` : '';
  document.getElementById('page-info').textContent = `Page ${page} / ${pages} — ${total.toLocaleString('fr')} IP${total !== 1 ? 's' : ''}`;
  document.getElementById('btn-prev').disabled = page <= 1;
  document.getElementById('btn-next').disabled = page >= pages;

  // Action buttons
  tbody.querySelectorAll('.btn-action').forEach(btn => {
    btn.addEventListener('click', () => {
      const ipObj = (siteData.ips || []).find(i => String(i.id) === btn.dataset.id);
      if (!ipObj) return;
      if (btn.dataset.action === 'reserve') openReserveModal(ipObj);
      else if (btn.dataset.action === 'release') openReleaseModal(ipObj);
      else if (btn.dataset.action === 'rename') openRenameModal(ipObj);
      else if (btn.dataset.action === 'toggle-status') toggleStatus(ipObj, btn.dataset.target);
    });
  });
}

// ---------------------------------------------------------------------------
// Reserve modal
// ---------------------------------------------------------------------------
function openReserveModal(ipObj) {
  document.getElementById('reserve-ip-display').textContent = ipObj.ip_address;
  document.getElementById('reserve-ip-id').value = ipObj.id;
  document.getElementById('reserve-hostname').value = ipObj.hostname || '';
  openModal('modal-reserve');
}

// ---------------------------------------------------------------------------
// Release modal
// ---------------------------------------------------------------------------
function openReleaseModal(ipObj) {
  document.getElementById('release-ip-display').textContent = ipObj.ip_address;
  document.getElementById('release-ip-id').value = ipObj.id;
  openModal('modal-release');
}

// ---------------------------------------------------------------------------
// Rename modal
// ---------------------------------------------------------------------------
function openRenameModal(ipObj) {
  document.getElementById('rename-ip-display').textContent = ipObj.ip_address;
  document.getElementById('rename-ip-id').value = ipObj.id;
  document.getElementById('rename-hostname').value = ipObj.hostname || '';
  openModal('modal-rename');
}

// ---------------------------------------------------------------------------
// Toggle status Utilisé ↔ Réservée
// ---------------------------------------------------------------------------
async function toggleStatus(ipObj, targetStatus) {
  if (!await showConfirm({ title: 'Changer le statut', message: `Changer le statut de ${ipObj.ip_address} en « ${targetStatus} » ?`, confirmText: 'Confirmer' })) return;
  try {
    await put(`/api/ips/${encodeURIComponent(ipObj.id)}`, { status: targetStatus });
    showToast(`${ipObj.ip_address} → ${targetStatus}`, 'success');
    localStorage.setItem('ipam-ip-change', Date.now());
    await loadSite();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Setup all modals
// ---------------------------------------------------------------------------
function setupModals(user) {

  // --- Reserve / Use ---
  async function _assignIp(status, triggerBtn, loadingText) {
    const id       = document.getElementById('reserve-ip-id').value;
    const hostname = document.getElementById('reserve-hostname').value.trim();
    triggerBtn.disabled = true; triggerBtn.textContent = loadingText;
    try {
      await put(`/api/ips/${encodeURIComponent(id)}`, { status, hostname });
      showToast(status === 'Réservée' ? 'IP réservée avec succès' : 'IP marquée comme utilisée', 'success');
      localStorage.setItem('ipam-ip-change', Date.now());
      closeModal('modal-reserve');
      document.getElementById('form-reserve').reset();
      await loadSite();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      triggerBtn.disabled = false;
      triggerBtn.textContent = status === 'Réservée' ? 'Réserver' : 'Utiliser';
    }
  }
  document.getElementById('btn-do-reserve').addEventListener('click', function() { _assignIp('Réservée', this, 'Réservation…'); });
  document.getElementById('btn-do-use').addEventListener('click', function() { _assignIp('Utilisé', this, 'En cours…'); });
  document.getElementById('btn-cancel-reserve').addEventListener('click', () => closeModal('modal-reserve'));

  // --- Rename hostname ---
  document.getElementById('form-rename').addEventListener('submit', async e => {
    e.preventDefault();
    const id       = document.getElementById('rename-ip-id').value;
    const hostname = document.getElementById('rename-hostname').value.trim();
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Enregistrement…';
    try {
      await put(`/api/ips/${encodeURIComponent(id)}`, { hostname });
      showToast('Hostname mis à jour', 'success');
      localStorage.setItem('ipam-ip-change', Date.now());
      closeModal('modal-rename');
      e.target.reset();
      await loadSite();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Enregistrer';
    }
  });
  document.getElementById('btn-cancel-rename').addEventListener('click', () => closeModal('modal-rename'));

  // --- Release ---
  document.getElementById('form-release').addEventListener('submit', async e => {
    e.preventDefault();
    const id = document.getElementById('release-ip-id').value;
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Libération…';
    try {
      await put(`/api/ips/${encodeURIComponent(id)}`, { status: 'Libre' });
      showToast('IP libérée', 'success');
      localStorage.setItem('ipam-ip-change', Date.now());
      closeModal('modal-release');
      await loadSite();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Confirmer la libération';
    }
  });
  document.getElementById('btn-cancel-release').addEventListener('click', () => closeModal('modal-release'));

  // --- Request VLAN (utilisateur uniquement, pas viewer) ---
  if (user?.role === 'user') {
    document.getElementById('btn-request-vlan').addEventListener('click', () => openModal('modal-request-vlan'));
    document.getElementById('btn-cancel-request-vlan').addEventListener('click', () => closeModal('modal-request-vlan'));

    document.getElementById('form-request-vlan').addEventListener('submit', async e => {
      e.preventDefault();
      const vlanId  = document.getElementById('req-vlan-id').value.trim();
      const network = document.getElementById('req-vlan-network').value.trim();
      const gateway = document.getElementById('req-vlan-gateway').value.trim();
      const mask    = document.getElementById('req-vlan-mask').value.trim();
      if (!vlanId || !network) { showToast('VLAN ID et réseau CIDR requis', 'warn'); return; }
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = 'Envoi…';
      try {
        await post('/api/vlan_requests', { site_id: siteId, vlan_id: vlanId, network, gateway, mask });
        showToast('Demande envoyée — en attente de validation administrateur', 'success');
        closeModal('modal-request-vlan');
        e.target.reset();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        btn.disabled = false; btn.textContent = 'Envoyer la demande';
      }
    });
  }

  // --- Add VLAN + Import (admin only) ---
  if (user?.role === 'admin') {
    document.getElementById('btn-import')?.addEventListener('click', () => openModal('modal-import'));
    document.getElementById('btn-cancel-import').addEventListener('click', () => closeModal('modal-import'));

    document.getElementById('form-import').addEventListener('submit', async e => {
      e.preventDefault();
      const fileEl = document.getElementById('import-file');
      const btn = e.target.querySelector('button[type=submit]');

      if (!fileEl.files[0]) { showToast('Sélectionnez un fichier Excel', 'warn'); return; }

      btn.disabled = true; btn.textContent = 'Import…';
      try {
        const wb = XLSX.read(await fileEl.files[0].arrayBuffer(), { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rawRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        const importRows = rawRows
          .slice(1)
          .map(r => ({
            ip:       String(r[0] ?? '').trim(),
            hostname: String(r[1] ?? '').trim(),
            vlan:     String(r[2] ?? '').trim(),
          }))
          .filter(r =>
            /^\d{1,3}(\.\d{1,3}){3}$/.test(r.ip) &&
            r.hostname !== '' &&
            r.vlan !== ''
          );

        if (!importRows.length) {
          showToast('Aucune ligne valide — colonnes requises : A = IP, B = Hostname, C = VLAN', 'warn');
          btn.disabled = false; btn.textContent = 'Importer'; return;
        }

        const res = await post(`/api/sites/${encodeURIComponent(siteId)}/ips/import`, {
          rows: importRows.map(r => ({ ip: r.ip, hostname: r.hostname, vlan: r.vlan, status: 'Utilisé' })),
        });
        showToast(`${res.updated} IP(s) importée(s) — statut Utilisé`, 'success');
        closeModal('modal-import');
        e.target.reset();
        await loadSite();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        btn.disabled = false; btn.textContent = 'Importer';
      }
    });
  }

  if (user?.role === 'admin') {
    document.getElementById('btn-add-vlan').addEventListener('click', () => openModal('modal-add-vlan'));
    document.getElementById('btn-cancel-add-vlan').addEventListener('click', () => closeModal('modal-add-vlan'));

    document.getElementById('form-add-vlan').addEventListener('submit', async e => {
      e.preventDefault();
      const vlanId  = document.getElementById('new-vlan-id').value.trim();
      const network = document.getElementById('new-vlan-network').value.trim();
      const gateway = document.getElementById('new-vlan-gateway').value.trim();
      const mask    = document.getElementById('new-vlan-mask').value.trim();
      const btn = e.target.querySelector('button[type=submit]');

      if (!vlanId || !network) { showToast('VLAN ID et réseau CIDR requis', 'warn'); return; }

      let ipList = [];
      if (network.includes('/')) {
        try { ipList = cidrToIPs(network); }
        catch (cidrErr) { showToast(cidrErr.message, 'warn'); return; }
      }

      btn.disabled = true; btn.textContent = ipList.length ? `Création… (${ipList.length} IPs)` : 'Création…';
      try {
        await post(`/api/sites/${encodeURIComponent(siteId)}/vlans`, {
          vlan_id: vlanId, network, gateway, mask, ips: ipList,
        });
        showToast(`VLAN ${vlanId} créé${ipList.length ? ` — ${ipList.length} IPs générées` : ''}`, 'success');
        closeModal('modal-add-vlan');
        e.target.reset();
        await loadSite();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        btn.disabled = false; btn.textContent = 'Créer le VLAN';
      }
    });

  }

  // Pagination
  document.getElementById('btn-prev').addEventListener('click', () => { page--; renderTable(); });
  document.getElementById('btn-next').addEventListener('click', () => { page++; renderTable(); });
}

// ---------------------------------------------------------------------------
// Sidebar population
// ---------------------------------------------------------------------------
async function loadSidebar() {
  try {
    const data = await get('/api/sites');
    const sites = data.sites || [];
    const searchEl = document.getElementById('sidebar-search');
    const listEl   = document.getElementById('site-list');

    function renderList(q = '') {
      const sorted = sortSites(sites);
      const filtered = q ? sorted.filter(s => s.name.toLowerCase().includes(q.toLowerCase())) : sorted;
      listEl.innerHTML = filtered.map(s => {
        const active = s.id === siteId;
        return `<a href="/site.html?id=${encodeURIComponent(s.id)}"
          class="site-item${active ? ' on' : ''}">
          <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-right:8px">${esc(s.name)}</span>
          <span style="font-size:11px;color:${active ? '#58a6ff' : '#484f58'};-ms-flex-negative:0;flex-shrink:0">${s.total || 0}</span>
        </a>`;
      }).join('');
    }

    searchEl?.addEventListener('input', e => renderList(e.target.value.trim()));
    renderList();
  } catch (_) { /* sidebar is non-critical */ }
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

