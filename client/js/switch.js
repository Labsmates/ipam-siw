import {
  requireAuth, getUser, logout, initTheme, startInactivityTimer,
  get, post, put, del, showToast, sortSites,
} from '/js/api.js';

// ── State ─────────────────────────────────────────────────────────────────────
let user      = null;
let sites     = [];
let isAdmin   = false;
// { siteId: [{id, name, model, ip, ports:[]}] }
let switchMap = {};
// Track open accordions
let openSites = new Set();
// Server hostnames for combobox
let serverHostnames = [];

// ── Init ──────────────────────────────────────────────────────────────────────
if (!requireAuth()) throw new Error('not authenticated');
user    = getUser();
isAdmin = user?.role === 'admin';

initTheme();
startInactivityTimer();

document.getElementById('nav-username').textContent = user?.username || '';
document.getElementById('nav-role').textContent     = user?.role === 'admin' ? 'Administrateur' : (user?.role === 'viewer' ? 'Lecteur' : 'Utilisateur');
document.getElementById('btn-logout').addEventListener('click', logout);

if (isAdmin) {
  document.getElementById('btn-add-switch').classList.remove('hidden');
  document.getElementById('nav-admin-link').classList.remove('hidden');
  document.getElementById('nav-config-link').classList.remove('hidden');
}

// Modal change pw
document.getElementById('btn-change-pw').addEventListener('click', () => {
  document.getElementById('modal-change-pw').classList.remove('hidden');
});
['btn-cancel-change-pw', 'btn-cancel-change-pw2'].forEach(id =>
  document.getElementById(id)?.addEventListener('click', () =>
    document.getElementById('modal-change-pw').classList.add('hidden')
  )
);
document.getElementById('form-change-pw').addEventListener('submit', async e => {
  e.preventDefault();
  const cur  = document.getElementById('cpw-current').value;
  const nw   = document.getElementById('cpw-new').value;
  const conf = document.getElementById('cpw-confirm').value;
  const err  = document.getElementById('cpw-error');
  err.style.display = 'none';
  if (nw !== conf) { err.textContent = 'Les mots de passe ne correspondent pas'; err.style.display = 'block'; return; }
  try {
    await put('/api/account/password', { current: cur, newPassword: nw });
    document.getElementById('modal-change-pw').classList.add('hidden');
    document.getElementById('form-change-pw').reset();
    showToast('Mot de passe modifié', 'success');
  } catch (ex) { err.textContent = ex.message; err.style.display = 'block'; }
});

// ── Load data ─────────────────────────────────────────────────────────────────
async function load() {
  try {
    const [sitesData, serversData] = await Promise.all([
      get('/api/sites'),
      get('/api/switches/servers').catch(() => ({ servers: [] })),
    ]);
    serverHostnames = serversData.servers || [];
    const data = { sites: sitesData.sites };
    sites = sortSites(data.sites || []);

    document.getElementById('summary').textContent =
      `${sites.length} site${sites.length > 1 ? 's' : ''}`;

    if (!sites.length) {
      document.getElementById('empty-state').classList.remove('hidden');
      return;
    }

    populateSiteSelect();
    await renderAll();
  } catch (e) {
    showToast(e.message, 'error');
    document.getElementById('sites-container').innerHTML =
      `<div style="padding:32px;color:#f85149;background:#f8514912;border:1px solid #f8514930;border-radius:8px;font-size:13px;font-family:monospace">
        Erreur de chargement : ${e.message}
      </div>`;
  }
}

function populateSiteSelect() {
  const sel = document.getElementById('sw-site');
  sel.innerHTML = '<option value="">— Choisir un site —</option>';
  sites.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    sel.appendChild(opt);
  });
}

async function renderAll() {
  const container = document.getElementById('sites-container');
  container.innerHTML = '';

  for (const site of sites) {
    if (!switchMap[site.id]) {
      try {
        const data = await get(`/api/switches/site/${site.id}`);
        const switches = data.switches || [];
        for (const sw of switches) {
          const pd = await get(`/api/switches/${sw.id}/ports`);
          sw.ports = pd.ports || [];
        }
        switchMap[site.id] = switches;
      } catch (_) {
        switchMap[site.id] = [];
      }
    }
    container.appendChild(buildSiteSection(site));
  }
}

// ── Render helpers ────────────────────────────────────────────────────────────
function buildSiteSection(site) {
  const switches = switchMap[site.id] || [];
  const isOpen   = openSites.has(site.id);

  const section = document.createElement('div');
  section.className = 'site-section';
  section.dataset.siteId = site.id;

  // Header
  const header = document.createElement('div');
  header.className = 'site-header';
  header.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;min-width:0">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#58a6ff" stroke-width="2" style="flex-shrink:0"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
      <span style="font-size:14px;font-weight:700;color:var(--tx-1)">${esc(site.name)}</span>
      <span style="font-size:11px;color:var(--tx-3);background:var(--bg-4);border:1px solid var(--brd);border-radius:4px;padding:2px 7px">${switches.length} switch${switches.length !== 1 ? 's' : ''}</span>
    </div>
    <div style="display:flex;align-items:center;gap:8px">
      ${isAdmin ? `<button class="btn-sm btn-add-sw-site" data-site-id="${site.id}" data-site-name="${esc(site.name)}" style="font-size:12px">+ Switch</button>` : ''}
      <svg class="chevron${isOpen ? ' open' : ''}" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--tx-3)" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
    </div>
  `;

  // Body
  const body = document.createElement('div');
  body.className = 'site-body';
  body.style.display = isOpen ? 'block' : 'none';

  if (!switches.length) {
    body.innerHTML = `<p style="color:var(--tx-3);font-size:13px;margin:12px 0 4px">Aucun switch configuré sur ce site.</p>`;
  } else {
    switches.forEach(sw => body.appendChild(buildSwitchCard(sw)));
  }

  header.addEventListener('click', e => {
    if (e.target.closest('.btn-add-sw-site')) return;
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : 'block';
    header.querySelector('.chevron').classList.toggle('open', !open);
    if (!open) openSites.add(site.id); else openSites.delete(site.id);
  });

  // "Add switch" per-site button
  header.querySelectorAll('.btn-add-sw-site').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openSwitchModal(null, site.id);
    });
  });

  section.appendChild(header);
  section.appendChild(body);
  return section;
}

function buildSwitchCard(sw) {
  const card = document.createElement('div');
  card.className = 'switch-card';
  card.dataset.switchId = sw.id;

  const meta = [sw.model, sw.ip].filter(Boolean).join(' — ');

  card.innerHTML = `
    <div class="switch-header">
      <div style="display:flex;align-items:center;gap:8px;min-width:0">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3fb950" stroke-width="2" style="flex-shrink:0"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/><line x1="18" y1="6" x2="18.01" y2="6"/><line x1="18" y1="18" x2="18.01" y2="18"/></svg>
        <span style="font-size:13px;font-weight:600;color:var(--tx-1)">${esc(sw.name)}</span>
        ${meta ? `<span style="font-size:11px;color:var(--tx-3)">${esc(meta)}</span>` : ''}
      </div>
      ${isAdmin ? `
      <div style="display:flex;gap:6px">
        <button class="btn-sm btn-edit-sw" data-sw-id="${sw.id}" title="Modifier">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="btn-sm btn-add-port" data-sw-id="${sw.id}" data-sw-name="${esc(sw.name)}" title="Ajouter un port" style="color:#58a6ff;border-color:#58a6ff40">+ Port</button>
        <button class="btn-danger btn-del-sw" data-sw-id="${sw.id}" data-sw-name="${esc(sw.name)}" title="Supprimer">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
        </button>
      </div>` : ''}
    </div>
    <div class="port-list">
      ${buildPortTable(sw)}
    </div>
  `;

  if (isAdmin) {
    card.querySelector('.btn-edit-sw').addEventListener('click', () => openSwitchModal(sw));
    card.querySelector('.btn-add-port').addEventListener('click', () => openPortModal(sw.id, sw.name, null));
    card.querySelector('.btn-del-sw').addEventListener('click', () => confirmDeleteSwitch(sw));
    card.querySelectorAll('.btn-del-port').forEach(btn => {
      btn.addEventListener('click', () => confirmDeletePort(sw.id, btn.dataset.port));
    });
    card.querySelectorAll('.btn-edit-port').forEach(btn => {
      btn.addEventListener('click', () => openPortModal(sw.id, sw.name, btn.dataset.port, btn.dataset.server, btn.dataset.desc));
    });
  }

  return card;
}

function buildPortTable(sw) {
  if (!sw.ports || !sw.ports.length) {
    return `<p style="color:var(--tx-3);font-size:12px;padding:10px 16px 8px">Aucun port assigné.</p>`;
  }
  const rows = sw.ports.map(p => `
    <tr>
      <td style="font-family:monospace;font-size:12px;color:#58a6ff;width:110px">${esc(p.port)}</td>
      <td style="font-weight:500;color:var(--tx-1)">${esc(p.server)}</td>
      <td style="color:var(--tx-3)">${esc(p.description || '—')}</td>
      ${isAdmin ? `
      <td style="text-align:right;white-space:nowrap;width:90px">
        <button class="btn-sm btn-edit-port" data-port="${esc(p.port)}" data-server="${esc(p.server)}" data-desc="${esc(p.description || '')}" style="margin-right:4px">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="btn-danger btn-del-port" data-port="${esc(p.port)}" style="padding:4px 7px">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>
      </td>` : '<td></td>'}
    </tr>
  `).join('');

  return `
    <table class="port-table">
      <thead>
        <tr>
          <th>Port</th>
          <th>Serveur</th>
          <th>Description</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// ── Refresh helpers ───────────────────────────────────────────────────────────
async function refreshSite(siteId) {
  try {
    const data = await get(`/api/switches/site/${siteId}`);
    const switches = data.switches || [];
    for (const sw of switches) {
      const pd = await get(`/api/switches/${sw.id}/ports`);
      sw.ports = pd.ports || [];
    }
    switchMap[siteId] = switches;
  } catch (_) {}

  const section = document.querySelector(`.site-section[data-site-id="${siteId}"]`);
  if (!section) return;
  const site = sites.find(s => String(s.id) === String(siteId));
  if (!site) return;
  const newSection = buildSiteSection(site);
  section.replaceWith(newSection);
}

// ── Switch modal ──────────────────────────────────────────────────────────────
let _editingSwitchId   = null;
let _editingSitePrefil = null;

function openSwitchModal(sw, prefillSiteId) {
  _editingSwitchId   = sw?.id || null;
  _editingSitePrefil = prefillSiteId || sw?.site_id || null;

  document.getElementById('modal-switch-title').textContent = sw ? 'Modifier le switch' : 'Ajouter un switch';
  document.getElementById('btn-sw-submit').textContent      = sw ? 'Enregistrer' : 'Créer';
  document.getElementById('sw-name').value  = sw?.name  || '';
  document.getElementById('sw-model').value = sw?.model || '';
  document.getElementById('sw-ip').value    = sw?.ip    || '';
  document.getElementById('sw-error').style.display = 'none';

  const sel = document.getElementById('sw-site');
  sel.value = String(_editingSitePrefil || '');
  sel.disabled = !!_editingSwitchId;

  document.getElementById('modal-switch').classList.remove('hidden');
  document.getElementById('sw-name').focus();
}

['btn-cancel-switch', 'btn-cancel-switch2'].forEach(id =>
  document.getElementById(id)?.addEventListener('click', () =>
    document.getElementById('modal-switch').classList.add('hidden')
  )
);

document.getElementById('form-switch').addEventListener('submit', async e => {
  e.preventDefault();
  const siteId = _editingSwitchId
    ? (switchMap[_editingSitePrefil]?.find(s => s.id === _editingSwitchId)?.site_id || _editingSitePrefil)
    : document.getElementById('sw-site').value;

  const body = {
    site_id: siteId,
    name:    document.getElementById('sw-name').value.trim(),
    model:   document.getElementById('sw-model').value.trim(),
    ip:      document.getElementById('sw-ip').value.trim(),
  };
  const err = document.getElementById('sw-error');
  err.style.display = 'none';

  try {
    if (_editingSwitchId) {
      await put(`/api/switches/${_editingSwitchId}`, body);
      showToast('Switch modifié', 'success');
    } else {
      if (!body.site_id) { err.textContent = 'Choisissez un site'; err.style.display = 'block'; return; }
      await post('/api/switches', body);
      showToast('Switch créé', 'success');
    }
    document.getElementById('modal-switch').classList.add('hidden');
    delete switchMap[siteId];
    await refreshSite(siteId);
  } catch (ex) { err.textContent = ex.message; err.style.display = 'block'; }
});

// ── Port modal ────────────────────────────────────────────────────────────────
let _portSwitchId   = null;
let _portEditing    = null;

function openPortModal(switchId, switchName, editPort, editServer, editDesc) {
  _portSwitchId = switchId;
  _portEditing  = editPort || null;

  document.getElementById('modal-port-title').textContent = editPort ? `Modifier le port ${editPort}` : `Port — ${switchName}`;
  document.getElementById('port-number').value  = editPort   || '';
  document.getElementById('port-server').value  = editServer || '';
  document.getElementById('port-desc').value    = editDesc   || '';
  document.getElementById('port-number').disabled = !!editPort;
  document.getElementById('port-error').style.display = 'none';

  closeCombobox();
  document.getElementById('modal-port').classList.remove('hidden');
  document.getElementById(_portEditing ? 'port-server' : 'port-number').focus();
}

['btn-cancel-port', 'btn-cancel-port2'].forEach(id =>
  document.getElementById(id)?.addEventListener('click', () => {
    closeCombobox();
    document.getElementById('modal-port').classList.add('hidden');
  })
);

// ── Combobox serveurs ─────────────────────────────────────────────────────────
let _comboActiveIdx = -1;

function openCombobox(filter) {
  const dd    = document.getElementById('port-server-dropdown');
  const items = filter
    ? serverHostnames.filter(h => h.toUpperCase().includes(filter.toUpperCase()))
    : serverHostnames;

  if (!items.length) {
    dd.innerHTML = `<div class="combobox-empty">Aucun serveur trouvé${filter ? ` pour « ${esc(filter)} »` : ''}</div>`;
  } else {
    dd.innerHTML = items.map((h, i) =>
      `<div class="combobox-item" data-idx="${i}" data-value="${esc(h)}">${esc(h)}</div>`
    ).join('');
    dd.querySelectorAll('.combobox-item').forEach(el => {
      el.addEventListener('mousedown', e => {
        e.preventDefault();
        document.getElementById('port-server').value = el.dataset.value;
        closeCombobox();
      });
    });
  }
  _comboActiveIdx = -1;
  dd.style.display = 'block';
}

function closeCombobox() {
  document.getElementById('port-server-dropdown').style.display = 'none';
  _comboActiveIdx = -1;
}

function moveCombo(dir) {
  const dd    = document.getElementById('port-server-dropdown');
  const items = dd.querySelectorAll('.combobox-item');
  if (!items.length) return;
  items[_comboActiveIdx]?.classList.remove('active');
  _comboActiveIdx = Math.max(0, Math.min(items.length - 1, _comboActiveIdx + dir));
  const active = items[_comboActiveIdx];
  active?.classList.add('active');
  active?.scrollIntoView({ block: 'nearest' });
}

const _serverInput = document.getElementById('port-server');
_serverInput.addEventListener('input', () => {
  if (serverHostnames.length) openCombobox(_serverInput.value);
});
_serverInput.addEventListener('focus', () => {
  if (serverHostnames.length) openCombobox(_serverInput.value);
});
_serverInput.addEventListener('blur', () => {
  setTimeout(closeCombobox, 150);
});
_serverInput.addEventListener('keydown', e => {
  const dd = document.getElementById('port-server-dropdown');
  if (dd.style.display === 'none') return;
  if (e.key === 'ArrowDown')  { e.preventDefault(); moveCombo(1);  return; }
  if (e.key === 'ArrowUp')    { e.preventDefault(); moveCombo(-1); return; }
  if (e.key === 'Escape')     { closeCombobox(); return; }
  if (e.key === 'Enter') {
    const active = dd.querySelector('.combobox-item.active');
    if (active) { e.preventDefault(); _serverInput.value = active.dataset.value; closeCombobox(); }
  }
});

document.getElementById('form-port').addEventListener('submit', async e => {
  e.preventDefault();
  const port   = (_portEditing || document.getElementById('port-number').value).trim();
  const server = document.getElementById('port-server').value.trim();
  const desc   = document.getElementById('port-desc').value.trim();
  const err    = document.getElementById('port-error');
  err.style.display = 'none';

  try {
    await put(`/api/switches/${_portSwitchId}/ports/${encodeURIComponent(port)}`, { server, description: desc });
    showToast('Port enregistré', 'success');
    document.getElementById('modal-port').classList.add('hidden');

    // Find site for this switch and refresh
    const siteId = findSiteForSwitch(_portSwitchId);
    if (siteId) { delete switchMap[siteId]; await refreshSite(siteId); }
  } catch (ex) { err.textContent = ex.message; err.style.display = 'block'; }
});

// ── Delete helpers ────────────────────────────────────────────────────────────
async function confirmDeleteSwitch(sw) {
  if (!confirm(`Supprimer le switch « ${sw.name} » et tous ses ports ?`)) return;
  try {
    await del(`/api/switches/${sw.id}`);
    showToast('Switch supprimé', 'success');
    delete switchMap[sw.site_id];
    await refreshSite(sw.site_id);
  } catch (e) { showToast(e.message, 'error'); }
}

async function confirmDeletePort(switchId, port) {
  if (!confirm(`Supprimer le port « ${port } » ?`)) return;
  try {
    await del(`/api/switches/${switchId}/ports/${encodeURIComponent(port)}`);
    showToast('Port supprimé', 'success');
    const siteId = findSiteForSwitch(switchId);
    if (siteId) { delete switchMap[siteId]; await refreshSite(siteId); }
  } catch (e) { showToast(e.message, 'error'); }
}

// ── Global "add switch" button ─────────────────────────────────────────────
document.getElementById('btn-add-switch').addEventListener('click', () => openSwitchModal(null));

// ── Utility ───────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function findSiteForSwitch(switchId) {
  for (const [siteId, switches] of Object.entries(switchMap)) {
    if (switches.some(sw => String(sw.id) === String(switchId))) return siteId;
  }
  return null;
}

// ── Start ─────────────────────────────────────────────────────────────────────
load();
