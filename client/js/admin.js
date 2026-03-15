// =============================================================================
// IPAM SIW — admin.js  (users, sites, logs, stats)
// =============================================================================

import {
  requireAuth, startInactivityTimer, checkHttps, getUser, logout,
  get, post, put, del, patch, showToast, fmtDate, openModal, closeModal, sortSites,
} from './api.js';

document.addEventListener('DOMContentLoaded', async () => {
  checkHttps();
  if (!requireAuth()) return;
  startInactivityTimer();

  const user = getUser();
  if (user?.role !== 'admin') { window.location.replace('/site.html'); return; }

  document.getElementById('nav-username').textContent = user.username;
  document.getElementById('nav-role').textContent = 'Administrateur';
  document.getElementById('btn-logout').addEventListener('click', () => { if (confirm('Se déconnecter ?')) logout(); });

  // Populate sidebar
  loadAdminSidebar();

  // Tabs
  const tabs = document.querySelectorAll('.admin-tab');
  const panes = document.querySelectorAll('.admin-pane');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => setTabActive(t, false));
      panes.forEach(p => p.classList.add('hidden'));
      setTabActive(tab, true);
      const pane = document.getElementById(`pane-${tab.dataset.tab}`);
      if (pane) pane.classList.remove('hidden');
    });
  });
  function setTabActive(tab, active) {
    tab.style.color = active ? '#58a6ff' : '#8b949e';
    tab.style.borderBottomColor = active ? '#58a6ff' : 'transparent';
    tab.style.background = active ? '#0d2240' : 'transparent';
  }

  // Activate first tab
  if (tabs.length) setTabActive(tabs[0], true);

  // Load initial tab
  await loadUsers();
  setupUserModals();
  setupSiteModals();
  await loadSites();
  await loadLogs();
  await loadVlanRequests();
  setupPasswordChange();
  setupExport();

  // Refresh vlan requests when tab is clicked
  document.querySelectorAll('.admin-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      if (tab.dataset.tab === 'vlan-requests') loadVlanRequests();
    });
  });
  document.getElementById('btn-refresh-vlan-requests')?.addEventListener('click', loadVlanRequests);
});

// =============================================================================
// USERS
// =============================================================================
let allUsers = [];

async function loadUsers() {
  try {
    const data = await get('/api/users');
    allUsers = data.users || [];
    renderUsers();
  } catch (err) { showToast(err.message, 'error'); }
}

const USERNAME_RE = /^[PX][A-Z]{3}\d{3}$/;

function renderUsers() {
  const currentUser = getUser();
  const tbody = document.getElementById('users-tbody');
  if (!allUsers.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#8b949e;padding:32px;">Aucun utilisateur</td></tr>';
    return;
  }
  tbody.innerHTML = allUsers.map(u => `
    <tr style="border-bottom:1px solid #21262d;"
        onmouseenter="this.style.background='#161b22'" onmouseleave="this.style.background=''">
      <td style="padding:12px 16px;color:#e6edf3;font-weight:700;font-family:monospace;letter-spacing:.04em;">${esc(u.username)}</td>
      <td style="padding:12px 16px;color:#c9d1d9;font-size:13px;">${esc(u.full_name || '—')}</td>
      <td style="padding:12px 16px;">
        <span style="${u.role === 'admin' ? 'color:#58a6ff;background:#0d2240;border:1px solid #1f4080' : 'color:#8b949e;background:#1c2128;border:1px solid #30363d'};display:inline-block;padding:2px 10px;border-radius:999px;font-size:11.5px;font-weight:600;">
          ${u.role === 'admin' ? 'Administrateur' : 'Utilisateur'}
        </span>
      </td>
      <td style="padding:12px 16px;color:#6e7681;font-size:12px;">${fmtDate(u.created_at)}</td>
      <td style="padding:12px 16px;text-align:right;display:flex;gap:8px;justify-content:flex-end;">
        <button data-uid="${u.id}" data-uname="${esc(u.username)}" class="btn-reset-pw"
          style="background:#2e2000;color:#d29922;border:1px solid #5c4200;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;">
          Réinitialiser MDP
        </button>
        ${u.id !== currentUser?.id ? `
        <button data-uid="${u.id}" data-uname="${esc(u.username)}" class="btn-del-user"
          style="background:#3d1a1a;color:#f85149;border:1px solid #6b2020;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;">
          Supprimer
        </button>` : ''}
      </td>
    </tr>
  `).join('');

  document.querySelectorAll('.btn-reset-pw').forEach(btn => {
    btn.addEventListener('click', () => openResetPwModal(btn.dataset.uid, btn.dataset.uname));
  });
  document.querySelectorAll('.btn-del-user').forEach(btn => {
    btn.addEventListener('click', () => confirmDeleteUser(btn.dataset.uid, btn.dataset.uname));
  });
}

function setupUserModals() {
  // Create user
  document.getElementById('btn-create-user').addEventListener('click', () => openModal('modal-create-user'));
  document.getElementById('btn-cancel-create-user').addEventListener('click', () => closeModal('modal-create-user'));
  document.getElementById('form-create-user').addEventListener('submit', async e => {
    e.preventDefault();
    const fullName = document.getElementById('new-fullname').value.trim();
    const username = document.getElementById('new-username').value.trim().toUpperCase();
    const password = document.getElementById('new-password').value;
    const role     = document.getElementById('new-role').value;

    if (!fullName) { showToast('Nom et prénom obligatoires', 'warn'); return; }
    if (username !== 'ADMIN' && !USERNAME_RE.test(username)) {
      showToast("Format invalide — commence par P ou X, 3 lettres, 3 chiffres (ex: PJFY579)", 'warn'); return;
    }

    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Création…';
    try {
      await post('/api/users', { username, password, role, full_name: fullName });
      showToast(`Utilisateur "${username}" créé`, 'success');
      closeModal('modal-create-user');
      e.target.reset();
      await loadUsers();
    } catch (err) { showToast(err.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = 'Créer'; }
  });

  // Reset password
  document.getElementById('btn-cancel-reset-pw').addEventListener('click', () => closeModal('modal-reset-pw'));
  document.getElementById('form-reset-pw').addEventListener('submit', async e => {
    e.preventDefault();
    const uid  = document.getElementById('reset-pw-uid').value;
    const pass = document.getElementById('reset-pw-value').value;
    const btn  = e.target.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Mise à jour…';
    try {
      await put(`/api/users/${encodeURIComponent(uid)}/password`, { password: pass });
      showToast('Mot de passe mis à jour', 'success');
      closeModal('modal-reset-pw');
      e.target.reset();
    } catch (err) { showToast(err.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = 'Mettre à jour'; }
  });
}

function openResetPwModal(uid, uname) {
  document.getElementById('reset-pw-uid').value = uid;
  const sub = document.getElementById('reset-pw-subtitle');
  if (sub) sub.textContent = `Réinitialisation du mot de passe de « ${uname} »`;
  document.getElementById('reset-pw-value').value = '';
  openModal('modal-reset-pw');
}

async function confirmDeleteUser(uid, uname) {
  if (!confirm(`Supprimer l'utilisateur "${uname}" ?`)) return;
  try {
    await del(`/api/users/${encodeURIComponent(uid)}`);
    showToast(`Utilisateur "${uname}" supprimé`, 'success');
    await loadUsers();
  } catch (err) { showToast(err.message, 'error'); }
}

// =============================================================================
// SITES
// =============================================================================
let allSites = [];

async function loadSites() {
  try {
    const data = await get('/api/sites');
    allSites = data.sites || [];
    renderSites();
  } catch (err) { showToast(err.message, 'error'); }
}

function renderSites() {
  const tbody = document.getElementById('sites-tbody');
  if (!allSites.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#8b949e;padding:32px;">Aucun site</td></tr>';
    return;
  }
  tbody.innerHTML = allSites.map(s => `
    <tr style="border-bottom:1px solid #21262d;"
        onmouseenter="this.style.background='#161b22'" onmouseleave="this.style.background=''">
      <td style="padding:12px 16px;color:#e6edf3;font-weight:600;">${esc(s.name)}</td>
      <td style="padding:12px 16px;color:#8b949e;">${(s.vlan_count || 0)} VLAN(s)</td>
      <td style="padding:12px 16px;color:#8b949e;">${(s.total || 0).toLocaleString('fr')} IPs</td>
      <td style="padding:12px 16px;text-align:right;display:flex;gap:8px;justify-content:flex-end;">
        <a href="/site.html?id=${encodeURIComponent(s.id)}"
          style="background:#0d2240;color:#58a6ff;border:1px solid #1f4080;border-radius:6px;padding:4px 10px;font-size:12px;text-decoration:none;">
          Voir
        </a>
        <button data-sid="${s.id}" data-sname="${esc(s.name)}" class="btn-rename-site"
          style="background:#21262d;color:#8b949e;border:1px solid #30363d;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;">
          Renommer
        </button>
        <button data-sid="${s.id}" data-sname="${esc(s.name)}" class="btn-del-site"
          style="background:#3d1a1a;color:#f85149;border:1px solid #6b2020;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;">
          Supprimer
        </button>
      </td>
    </tr>
  `).join('');

  document.querySelectorAll('.btn-rename-site').forEach(btn => {
    btn.addEventListener('click', () => openRenameSiteModal(btn.dataset.sid, btn.dataset.sname));
  });
  document.querySelectorAll('.btn-del-site').forEach(btn => {
    btn.addEventListener('click', () => confirmDeleteSite(btn.dataset.sid, btn.dataset.sname));
  });
}

function setupSiteModals() {
  // Create site
  document.getElementById('btn-create-site').addEventListener('click', () => openModal('modal-create-site'));
  document.getElementById('btn-cancel-create-site').addEventListener('click', () => closeModal('modal-create-site'));
  document.getElementById('form-create-site').addEventListener('submit', async e => {
    e.preventDefault();
    const name = document.getElementById('new-site-name').value.trim();
    const btn  = e.target.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Création…';
    try {
      await post('/api/sites', { name });
      showToast(`Site "${name}" créé`, 'success');
      closeModal('modal-create-site');
      e.target.reset();
      await loadSites();
    } catch (err) { showToast(err.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = 'Créer'; }
  });

  // Rename site
  document.getElementById('btn-cancel-rename-site').addEventListener('click', () => closeModal('modal-rename-site'));
  document.getElementById('form-rename-site').addEventListener('submit', async e => {
    e.preventDefault();
    const sid  = document.getElementById('rename-site-id').value;
    const name = document.getElementById('rename-site-name').value.trim();
    const btn  = e.target.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Renommage…';
    try {
      await put(`/api/sites/${encodeURIComponent(sid)}`, { name });
      showToast(`Site renommé en "${name}"`, 'success');
      closeModal('modal-rename-site');
      await loadSites();
    } catch (err) { showToast(err.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = 'Renommer'; }
  });
}

function openRenameSiteModal(sid, sname) {
  document.getElementById('rename-site-id').value = sid;
  document.getElementById('rename-site-name').value = sname;
  openModal('modal-rename-site');
}

async function confirmDeleteSite(sid, sname) {
  if (!confirm(`Supprimer le site "${sname}" et toutes ses données (VLANs, IPs) ?\n\nCette action est IRRÉVERSIBLE.`)) return;
  try {
    await del(`/api/sites/${encodeURIComponent(sid)}`);
    showToast(`Site "${sname}" supprimé`, 'success');
    await loadSites();
  } catch (err) { showToast(err.message, 'error'); }
}

// =============================================================================
// LOGS
// =============================================================================
async function loadLogs() {
  try {
    const data = await get('/api/logs?limit=200');
    const logs = data.logs || [];
    const tbody = document.getElementById('logs-tbody');

    if (!logs.length) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#8b949e;padding:32px;">Aucun journal</td></tr>';
      return;
    }
    tbody.innerHTML = logs.map(l => `
      <tr style="border-bottom:1px solid #21262d;"
          onmouseenter="this.style.background='#161b22'" onmouseleave="this.style.background=''">
        <td style="padding:10px 16px;color:#6e7681;font-size:12px;white-space:nowrap;">${fmtDate(l.created_at)}</td>
        <td style="padding:10px 16px;color:#8b949e;font-size:13px;">${esc(l.username || '—')}</td>
        <td style="padding:10px 16px;color:#e6edf3;font-size:13px;">${esc(l.action || '')}</td>
        <td style="padding:10px 16px;color:#8b949e;font-size:12px;font-family:monospace;">${esc(l.details || '')}</td>
      </tr>
    `).join('');

    // Clear logs button
    document.getElementById('btn-clear-logs').addEventListener('click', async () => {
      if (!confirm('Effacer tous les journaux ?')) return;
      try {
        await del('/api/logs');
        showToast('Journaux effacés', 'success');
        await loadLogs();
      } catch (err) { showToast(err.message, 'error'); }
    });
  } catch (err) { showToast(err.message, 'error'); }
}

// =============================================================================
// PASSWORD CHANGE (own password)
// =============================================================================
function setupPasswordChange() {
  document.getElementById('form-change-pw').addEventListener('submit', async e => {
    e.preventDefault();
    const current = document.getElementById('current-pw').value;
    const newpw   = document.getElementById('new-pw').value;
    const confirm2 = document.getElementById('confirm-pw').value;
    if (newpw !== confirm2) { showToast('Les mots de passe ne correspondent pas', 'warn'); return; }
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Mise à jour…';
    try {
      await post('/api/me/password', { currentPassword: current, newPassword: newpw });
      showToast('Mot de passe modifié avec succès', 'success');
      e.target.reset();
    } catch (err) { showToast(err.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = 'Modifier'; }
  });
}

// =============================================================================
// Sidebar population
// =============================================================================
async function loadAdminSidebar() {
  try {
    const data = await get('/api/sites');
    const sites = data.sites || [];
    const searchEl = document.getElementById('sidebar-search');
    const listEl   = document.getElementById('site-list');

    function renderList(q = '') {
      const sorted = sortSites(sites);
      const filtered = q ? sorted.filter(s => s.name.toLowerCase().includes(q.toLowerCase())) : sorted;
      listEl.innerHTML = filtered.map(s =>
        `<a href="/site.html?id=${encodeURIComponent(s.id)}" class="site-item">
          <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-right:8px">${esc(s.name)}</span>
          <span style="font-size:11px;color:#484f58;-ms-flex-negative:0;flex-shrink:0">${s.total || 0}</span>
        </a>`
      ).join('');
    }

    searchEl?.addEventListener('input', e => renderList(e.target.value.trim()));
    renderList();
  } catch (_) { /* sidebar is non-critical */ }
}

// =============================================================================
// VLAN REQUESTS
// =============================================================================
async function loadVlanRequests() {
  try {
    const data = await get('/api/vlan_requests');
    const requests = data.requests || [];
    renderVlanRequests(requests);

    // Badge on tab
    const badge = document.getElementById('vlan-requests-badge');
    if (badge) {
      if (requests.length) {
        badge.textContent = requests.length;
        badge.classList.remove('hidden');
        badge.style.display = 'inline-block';
      } else {
        badge.classList.add('hidden');
      }
    }
  } catch (err) { showToast(err.message, 'error'); }
}

function renderVlanRequests(requests) {
  const tbody = document.getElementById('vlan-requests-tbody');
  const empty = document.getElementById('vlan-requests-empty');

  if (!requests.length) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  tbody.innerHTML = requests.map(r => `
    <tr style="border-bottom:1px solid #21262d;"
        onmouseenter="this.style.background='#161b22'" onmouseleave="this.style.background=''">
      <td style="padding:11px 16px;font-size:13px;font-weight:600;color:#e6edf3;">${esc(r.site_name)}</td>
      <td style="padding:11px 16px;font-size:13px;color:#58a6ff;font-weight:700;">${esc(r.vlan_id)}</td>
      <td style="padding:11px 16px;font-size:13px;font-family:monospace;color:#e6edf3;">${esc(r.network || '—')}</td>
      <td style="padding:11px 16px;font-size:12px;color:#8b949e;">${esc(r.gateway || '—')} / ${esc(r.mask || '—')}</td>
      <td style="padding:11px 16px;">
        <span style="background:#58a6ff18;border:1px solid #58a6ff44;color:#58a6ff;border-radius:5px;padding:2px 9px;font-size:12px;font-weight:600;">${esc(r.username)}</span>
      </td>
      <td style="padding:11px 16px;font-size:12px;color:#6e7681;white-space:nowrap;">${fmtDate(r.created_at)}</td>
      <td style="padding:11px 16px;text-align:right;display:-webkit-box;display:-ms-flexbox;display:flex;gap:6px;-webkit-box-pack:end;-ms-flex-pack:end;justify-content:flex-end;">
        <button data-rid="${r.id}" class="btn-approve-vlan"
          style="background:#1a3d2b;color:#3fb950;border:1px solid #2a5f38;border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer;">
          ✓ Valider
        </button>
        <button data-rid="${r.id}" class="btn-reject-vlan"
          style="background:#3d1a1a;color:#f85149;border:1px solid #6b2020;border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer;">
          ✕ Refuser
        </button>
      </td>
    </tr>
  `).join('');

  document.querySelectorAll('.btn-approve-vlan').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Valider cette demande de VLAN ?')) return;
      try {
        await post(`/api/vlan_requests/${encodeURIComponent(btn.dataset.rid)}/approve`, {});
        showToast('VLAN créé avec succès', 'success');
        await loadVlanRequests();
      } catch (err) { showToast(err.message, 'error'); }
    });
  });

  document.querySelectorAll('.btn-reject-vlan').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Refuser cette demande de VLAN ?')) return;
      try {
        await del(`/api/vlan_requests/${encodeURIComponent(btn.dataset.rid)}`);
        showToast('Demande refusée', 'info');
        await loadVlanRequests();
      } catch (err) { showToast(err.message, 'error'); }
    });
  });
}

// =============================================================================
// EXPORT EXCEL
// =============================================================================
function setupExport() {
  const listEl   = document.getElementById('export-site-list');
  const searchEl = document.getElementById('export-search');
  const countEl  = document.getElementById('export-selection-count');
  const btnAll   = document.getElementById('btn-select-all');
  const btnNone  = document.getElementById('btn-deselect-all');
  const btnExport = document.getElementById('btn-do-export');

  // Render checkboxes from allSites
  function renderExportList(q = '') {
    const sorted = sortSites(allSites);
    const filtered = q ? sorted.filter(s => s.name.toLowerCase().includes(q.toLowerCase())) : sorted;
    listEl.innerHTML = filtered.map(s => `
      <label style="display:-webkit-box;display:-ms-flexbox;display:flex;-webkit-box-align:center;-ms-flex-align:center;align-items:center;gap:10px;padding:8px 16px;cursor:pointer;-webkit-transition:background .1s;transition:background .1s"
             onmouseenter="this.style.background='#1c2128'" onmouseleave="this.style.background=''">
        <input type="checkbox" class="export-cb" data-id="${s.id}" data-name="${esc(s.name)}"
               style="accent-color:#58a6ff;width:14px;height:14px;-ms-flex-negative:0;flex-shrink:0">
        <span style="font-size:13px;color:#e6edf3;-webkit-box-flex:1;-ms-flex:1;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.name)}</span>
        <span style="font-size:11px;color:#484f58;-ms-flex-negative:0;flex-shrink:0">${s.total || 0} IPs</span>
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

    const format      = document.querySelector('input[name="export-format"]:checked')?.value || 'multi';
    const filterStatus = document.getElementById('export-filter-status').value;
    const colVlan     = document.getElementById('col-vlan').checked;
    const colNetwork  = document.getElementById('col-network').checked;
    const colHostname = document.getElementById('col-hostname').checked;
    const colStatus   = document.getElementById('col-status').checked;
    const colGateway  = document.getElementById('col-gateway').checked;

    btnExport.disabled = true;
    btnExport.textContent = `Chargement… (0/${selected.length})`;

    try {
      const wb = XLSX.utils.book_new();

      if (format === 'single') {
        // Tout en un seul onglet
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
        styleSheet(ws, rows.length);
        XLSX.utils.book_append_sheet(wb, ws, 'Export IPAM');

      } else {
        // Un onglet par site
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
          styleSheet(ws, rows.length);
          const sheetName = siteName.substring(0, 31); // max 31 chars
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

  // Initialiser la liste une fois les sites chargés (allSites peut être vide au moment du setup)
  // On re-render quand l'onglet export est activé
  document.querySelectorAll('.admin-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      if (tab.dataset.tab === 'export') renderExportList(searchEl.value.trim());
    });
  });
}

function buildHeader({ colVlan, colNetwork, colHostname, colStatus, colGateway, single }) {
  const h = [];
  if (single) h.push('Site');
  if (colVlan)     h.push('VLAN ID');
  if (colNetwork)  h.push('Réseau');
  h.push('Adresse IP');
  if (colHostname) h.push('Hostname');
  if (colStatus)   h.push('Statut');
  if (colGateway)  h.push('Gateway');
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
    if (opts.single)     row.push(siteName);
    if (opts.colVlan)    row.push(vlan.vlan_id || '');
    if (opts.colNetwork) row.push(vlan.network || '');
    row.push(ip.ip_address || '');
    if (opts.colHostname) row.push(ip.hostname || '');
    if (opts.colStatus)   row.push(ip.status || '');
    if (opts.colGateway)  row.push(vlan.gateway || '');
    rows.push(row);
  }
}

function styleSheet(ws, nRows) {
  // Largeur des colonnes automatique (estimation)
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  const cols = [];
  for (let c = range.s.c; c <= range.e.c; c++) cols.push({ wch: 22 });
  ws['!cols'] = cols;
}

// =============================================================================
// Helpers
// =============================================================================
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
