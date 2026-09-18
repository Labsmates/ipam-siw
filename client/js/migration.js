// =============================================================================
// IPAM SIW — migration.js  (Migration Serveurs : ancien host/OS → nouveau host/OS)
// =============================================================================

import {
  requireAuth, startInactivityTimer, checkHttps, getUser, logout,
  get, post, put, del, showToast, sortSites, showConfirm, initTheme, initSidebarCollapse,
  restoreElevationSession, setupElevationMode, setupAdminSectionToggle, openModal, closeModal,
} from './api.js?v=57bc539';

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

let user     = null;
let siteId   = null;
let siteData = null;      // { site, vlans, ips }
let migrations = [];
let osConfig = { old: [], new: [] };
let archivedReleases = []; // [{hostname, ip}] — libérations du site (Archive), pour garder Old Hostname disponible après une libération dans Site IPAM

document.addEventListener('DOMContentLoaded', async () => {
  restoreElevationSession();
  checkHttps();
  initTheme(); initSidebarCollapse();
  if (!requireAuth()) return;
  startInactivityTimer();

  const params = new URLSearchParams(location.search);
  siteId = params.get('id');

  user = getUser();
  document.getElementById('nav-username').textContent = user?.username || '';
  document.getElementById('nav-role').textContent = user?.username === 'ADMIN' ? 'Super Administrateur' : user?.role === 'admin' ? 'Administrateur' : user?.role === 'viewer' ? 'Lecteur' : 'Utilisateur';
  document.getElementById('btn-logout').addEventListener('click', async () => {
    if (await showConfirm({ title: 'Déconnexion', message: 'Voulez-vous vous déconnecter ?', confirmText: 'Se déconnecter', danger: true })) logout();
  });

  setupElevationMode();
  setupAdminSectionToggle();
  loadSidebar();

  if (!siteId) {
    document.getElementById('view-welcome').style.display = 'flex';
    document.getElementById('view-site').style.display = 'none';
    return;
  }
  document.getElementById('view-welcome').style.display = 'none';
  document.getElementById('view-site').style.display = 'flex';

  if (user?.role !== 'viewer') document.getElementById('mig-actions').classList.remove('hidden');

  setupMigrationForm();
  document.getElementById('btn-add-migration')?.addEventListener('click', () => openMigrationModal(null));
  document.getElementById('btn-export-migrations')?.addEventListener('click', exportCsv);

  await loadPage();

  // Arrivée depuis le popup post-Réserver/Utiliser (site.html) : ouvre
  // directement "Ajouter une migration" avec le New Hostname pré-rempli.
  // Le hostname vient d'être réservé/utilisé par l'utilisateur lui-même —
  // on l'ajoute donc à la liste même s'il ne correspond pas au motif de
  // classification Windows 2022 (usage normal de newCandidates()).
  if (params.get('add') === '1' && user?.role !== 'viewer') {
    const presetNewHostname = params.get('new_hostname') || '';
    openMigrationModal(null);
    lockMigrationModalClose();
    if (presetNewHostname && (siteData.ips || []).some(ip => ip.hostname === presetNewHostname)) {
      const newSelect = document.getElementById('mig-new-hostname');
      if (![...newSelect.options].some(o => o.value === presetNewHostname)) {
        newSelect.insertAdjacentHTML('beforeend', `<option value="${esc(presetNewHostname)}">${esc(presetNewHostname)}</option>`);
      }
      newSelect.value = presetNewHostname;
      newSelect.onchange();
    }
    const cleanUrl = new URL(location.href);
    cleanUrl.searchParams.delete('add');
    cleanUrl.searchParams.delete('new_hostname');
    history.replaceState(null, '', cleanUrl);
  }
});

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
        const active = String(s.id) === String(siteId);
        return `<a href="/migration.html?id=${encodeURIComponent(s.id)}" class="site-item${active ? ' on' : ''}">
          <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-right:8px">${esc(s.name)}</span>
        </a>`;
      }).join('');
    }
    searchEl?.addEventListener('input', e => renderList(e.target.value.trim()));
    renderList();
  } catch { /* sidebar non critique */ }
}

// ---------------------------------------------------------------------------
// Classification hostname — mêmes motifs que osLogo()/isInfoExcluded() (site.js)
// ---------------------------------------------------------------------------
function isDeviceExcluded(hostname) {
  const h = (hostname || '').toUpperCase();
  if (!h) return false;
  return h.startsWith('GATEWAY') || h.startsWith('ILO-') || h.startsWith('IDRAC-') || /^(?:SPH|SPY|SQH)/.test(h);
}
function isWin2016(hostname) { return /(?:SN|QN)-[A-Z0-9]{2}/i.test(hostname || ''); }
function isLinuxCft(hostname) { return /XG/i.test(hostname || ''); }
function isWin2022(ip) {
  return ip.os === 'win2022' || /FS22|FS24|FS26|AP89|AP88|AP87|AP75|AP76|AF21|AF22/.test(ip.hostname || '');
}

// Éligible sur tous les VLAN sauf ADMIN, IPs Utilisée/Réservée, hors Gateway/iLO/iDRAC/Nutanix
function eligibleIps() {
  return (siteData.ips || []).filter(ip => {
    if (!ip.hostname || (ip.status !== 'Utilisé' && ip.status !== 'Réservée')) return false;
    if (isDeviceExcluded(ip.hostname)) return false;
    const vlan = (siteData.vlans || []).find(v => String(v.id) === String(ip.vlan_id));
    const tag = (vlan?.description || '').trim().toUpperCase();
    return tag !== 'ADMIN';
  });
}

function usedHostnames() {
  const set = new Set();
  migrations.forEach(m => { if (m.old_hostname) set.add(m.old_hostname); if (m.new_hostname) set.add(m.new_hostname); });
  return set;
}

// Retrouve le tag de VLAN (METIER, ADMIN…) d'une IP en la situant dans les
// réseaux des VLAN actuels du site — utilisé pour les entrées d'Archive, qui
// ne portent pas de vlan_id (l'IP a été libérée, donc retirée de siteData.ips).
function vlanTagForIp(ipAddress) {
  const parts = (ipAddress || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p))) return null;
  const ipInt = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  for (const vlan of siteData.vlans || []) {
    const [netAddr, bitsStr] = (vlan.network || '').split('/');
    const prefix = parseInt(bitsStr, 10);
    const netParts = (netAddr || '').split('.').map(Number);
    if (netParts.length !== 4 || netParts.some(p => isNaN(p)) || isNaN(prefix)) continue;
    const netInt = ((netParts[0] << 24) | (netParts[1] << 16) | (netParts[2] << 8) | netParts[3]) >>> 0;
    const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0;
    if ((ipInt & mask) === (netInt & mask)) return (vlan.description || '').trim().toUpperCase();
  }
  return null;
}

// Libérations archivées éligibles côté OLD — même classification que les IP
// live, VLAN ADMIN exclu (retrouvé par plage réseau), hostname pas déjà repris
// par une IP actuellement vivante (qui prévaut), pas déjà utilisé ailleurs.
function archivedOldCandidates(keepHostname = null) {
  const used = usedHostnames();
  const liveHostnames = new Set((siteData.ips || []).map(ip => ip.hostname).filter(Boolean));
  return archivedReleases
    .filter(r => (isWin2016(r.hostname) || isLinuxCft(r.hostname)) && !isDeviceExcluded(r.hostname))
    .filter(r => vlanTagForIp(r.ip) !== 'ADMIN')
    .filter(r => !liveHostnames.has(r.hostname))
    .filter(r => r.hostname === keepHostname || !used.has(r.hostname))
    .map(r => ({ hostname: r.hostname, ip_address: r.ip, archived: true }));
}

function oldCandidates(keepHostname = null) {
  const used = usedHostnames();
  const live = eligibleIps().filter(ip => (isWin2016(ip.hostname) || isLinuxCft(ip.hostname)) && (ip.hostname === keepHostname || !used.has(ip.hostname)));
  return [...live, ...archivedOldCandidates(keepHostname)];
}
function newCandidates(keepHostname = null) {
  const used = usedHostnames();
  return eligibleIps().filter(ip => isWin2022(ip) && (ip.hostname === keepHostname || !used.has(ip.hostname)));
}

// ---------------------------------------------------------------------------
// Chargement de la page
// ---------------------------------------------------------------------------
async function loadPage() {
  const loadEl    = document.getElementById('mig-loading');
  const contentEl = document.getElementById('mig-content');
  loadEl.style.display = 'flex';
  contentEl.classList.add('hidden');
  try {
    const [siteRes, migRes, osRes, archiveRes] = await Promise.all([
      get(`/api/sites/${encodeURIComponent(siteId)}/data`),
      get(`/api/migrations?site_id=${encodeURIComponent(siteId)}`),
      get('/api/migrations/os-config'),
      get('/api/logs/archive?limit=2000').catch(() => ({ releases: [] })),
    ]);
    siteData   = siteRes;
    migrations = migRes.migrations || [];
    osConfig   = osRes;
    archivedReleases = (archiveRes.releases || [])
      .filter(r => String(r.site_id) === String(siteId) && r.hostname)
      .map(r => ({ hostname: r.hostname, ip: r.ip }));
    document.getElementById('site-name').textContent = siteData.site?.name || '';
    renderTable();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    loadEl.style.display = 'none';
    contentEl.classList.remove('hidden');
  }
}

function exportCsv() {
  if (!migrations.length) { showToast('Aucune migration à exporter', 'warn'); return; }
  const csvEsc = v => `"${String(v || '').replace(/"/g, '""')}"`;
  const lines = [
    ['Old Hostname', 'Old IP', 'Old OS', 'New Hostname', 'New IP', 'New OS', 'Commentaire', 'Resp. Métier', 'Créé par', 'Date création'].map(csvEsc).join(','),
    ...migrations.map(m => [
      m.old_hostname, m.old_ip, m.old_os, m.new_hostname, m.new_ip, m.new_os,
      m.comment, m.resp_metier, m.created_by, fmtDate(m.created_at),
    ].map(csvEsc).join(',')),
  ];
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `migrations-${(siteData.site?.name || siteId).replace(/[^a-z0-9]+/gi, '-')}-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function osBadge(list, value) {
  if (!value) return '<span style="color:var(--tx-5)">—</span>';
  const entry = (list || []).find(e => e.value === value);
  const icon = entry?.icon || 'win2022';
  return `<span style="display:inline-flex;align-items:center;gap:6px;justify-content:center"><img src="/img/os/${esc(icon)}.svg" width="18" height="18" alt="">${esc(value)}</span>`;
}

function renderTable() {
  const tbody = document.getElementById('mig-tbody');
  const table = document.getElementById('mig-table');
  const empty = document.getElementById('mig-empty');

  if (!migrations.length) {
    table.style.display = 'none';
    empty.classList.remove('hidden');
    tbody.innerHTML = '';
    return;
  }
  empty.classList.add('hidden');
  table.style.display = '';

  const isAdmin = user?.role === 'admin';
  const canEdit = user?.role !== 'viewer';

  tbody.innerHTML = migrations.map(m => `
    <tr style="border-bottom:1px solid var(--bg-4)">
      <td style="padding:9px 12px;font-family:'JetBrains Mono',monospace;font-size:13px">${esc(m.old_hostname)}</td>
      <td style="padding:9px 12px;font-family:'JetBrains Mono',monospace;font-size:12.5px;color:var(--tx-3)">${esc(m.old_ip)}</td>
      <td style="padding:9px 12px;text-align:center;font-size:12.5px">${osBadge(osConfig.old, m.old_os)}</td>
      <td style="padding:9px 12px;font-family:'JetBrains Mono',monospace;font-size:13px">${esc(m.new_hostname)}</td>
      <td style="padding:9px 12px;font-family:'JetBrains Mono',monospace;font-size:12.5px;color:var(--tx-3)">${esc(m.new_ip)}</td>
      <td style="padding:9px 12px;text-align:center;font-size:12.5px">${osBadge(osConfig.new, m.new_os)}</td>
      <td style="padding:9px 12px;font-size:13px;color:var(--tx-2);max-width:220px">${esc(m.comment)}</td>
      <td style="padding:9px 12px;font-size:13px;color:var(--tx-2)">${m.resp_metier ? esc(m.resp_metier) : '<span style="color:var(--tx-5)">—</span>'}</td>
      <td style="padding:9px 12px;text-align:right;white-space:nowrap">
        ${canEdit ? `<button class="btn btn-g btn-sm mig-edit" data-id="${m.id}">Modifier</button>` : ''}
        ${isAdmin ? `<button class="btn btn-sm mig-del" data-id="${m.id}" style="background:#3d1a1a;color:#f85149;border:1px solid #6b2020;margin-left:6px" title="Supprimer">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
        </button>` : ''}
      </td>
    </tr>`).join('');

  tbody.querySelectorAll('.mig-edit').forEach(b => b.addEventListener('click', () => {
    const row = migrations.find(m => m.id === parseInt(b.dataset.id));
    if (row) openMigrationModal(row);
  }));
  tbody.querySelectorAll('.mig-del').forEach(b => b.addEventListener('click', () => deleteMigration(parseInt(b.dataset.id))));
}

// ---------------------------------------------------------------------------
// Sélecteur d'OS (boutons icônes, style os-btn)
// ---------------------------------------------------------------------------
function renderOsPickerInto(containerId, hiddenId, list, value, disabled) {
  const el = document.getElementById(containerId);
  el.innerHTML = (list || []).map(e => `
    <button type="button" class="os-btn${e.value === value ? ' sel' : ''}" data-value="${esc(e.value)}" title="${esc(e.value)}"
      style="flex-direction:column;gap:2px;padding:6px 9px">
      <img src="/img/os/${esc(e.icon)}.svg" width="22" height="22" alt="">
      <span style="font-size:10px;color:var(--tx-3)">${esc(e.value)}</span>
    </button>`).join('');
  document.getElementById(hiddenId).value = value || '';
  el.querySelectorAll('.os-btn').forEach(btn => {
    btn.disabled = !!disabled;
    btn.style.opacity = disabled ? '.4' : '';
    btn.style.cursor = disabled ? 'not-allowed' : 'pointer';
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      document.getElementById(hiddenId).value = btn.dataset.value;
      el.querySelectorAll('.os-btn').forEach(b => b.classList.toggle('sel', b === btn));
    });
  });
}

// ---------------------------------------------------------------------------
// Modal Ajouter / Modifier
// ---------------------------------------------------------------------------
// Empêche la fermeture du modal (X, Annuler, clic en arrière-plan) — utilisé
// quand la fiche est ouverte automatiquement depuis le popup post-Réserver/
// Utiliser : l'utilisateur doit finaliser la saisie avant de pouvoir sortir.
// La fermeture programmatique (closeModal() appelé après un enregistrement
// réussi) n'est pas affectée, seuls les boutons et le clic externe le sont.
function lockMigrationModalClose() {
  document.getElementById('modal-migration').classList.add('locked');
  for (const id of ['btn-x-migration', 'btn-cancel-migration']) {
    const btn = document.getElementById(id);
    btn.disabled = true;
    btn.style.opacity = '.35';
    btn.style.cursor = 'not-allowed';
  }
}
function unlockMigrationModalClose() {
  document.getElementById('modal-migration').classList.remove('locked');
  for (const id of ['btn-x-migration', 'btn-cancel-migration']) {
    const btn = document.getElementById(id);
    btn.disabled = false;
    btn.style.opacity = '';
    btn.style.cursor = '';
  }
}

function openMigrationModal(row) {
  const isEdit  = !!row;
  const isAdmin = user?.role === 'admin';
  const lockOldNew = isEdit && !isAdmin; // OLD/NEW verrouillés après création, sauf admin

  unlockMigrationModalClose();
  document.getElementById('mig-modal-title').textContent = isEdit ? 'Modifier la migration' : 'Ajouter une migration';
  document.getElementById('mig-id').value = row?.id || '';

  const oldSelect = document.getElementById('mig-old-hostname');
  const newSelect = document.getElementById('mig-new-hostname');
  const oldCands = oldCandidates(row?.old_hostname);
  const newCands = newCandidates(row?.new_hostname);
  oldSelect.innerHTML = '<option value="">—</option>' + oldCands.map(ip => `<option value="${esc(ip.hostname)}">${esc(ip.hostname)}${ip.archived ? ' (archivé)' : ''}</option>`).join('');
  newSelect.innerHTML = '<option value="">—</option>' + newCands.map(ip => `<option value="${esc(ip.hostname)}">${esc(ip.hostname)}</option>`).join('');
  oldSelect.value = row?.old_hostname || '';
  newSelect.value = row?.new_hostname || '';
  oldSelect.disabled = lockOldNew;
  newSelect.disabled = lockOldNew;

  document.getElementById('mig-old-ip-display').textContent = row?.old_ip || '—';
  document.getElementById('mig-new-ip-display').textContent = row?.new_ip || '—';
  oldSelect.onchange = () => {
    const ip = (siteData.ips || []).find(i => i.hostname === oldSelect.value);
    const archived = archivedReleases.find(r => r.hostname === oldSelect.value);
    document.getElementById('mig-old-ip-display').textContent = ip?.ip_address || archived?.ip || '—';
  };
  newSelect.onchange = () => {
    const ip = (siteData.ips || []).find(i => i.hostname === newSelect.value);
    document.getElementById('mig-new-ip-display').textContent = ip?.ip_address || '—';
  };

  renderOsPickerInto('mig-old-os-picker', 'mig-old-os', osConfig.old, row?.old_os || '', lockOldNew);
  renderOsPickerInto('mig-new-os-picker', 'mig-new-os', osConfig.new, row?.new_os || '', lockOldNew);

  document.getElementById('mig-comment').value = row?.comment || '';
  document.getElementById('mig-resp-metier').value = row?.resp_metier || '';

  openModal('modal-migration');
}

function setupMigrationForm() {
  document.getElementById('form-migration').addEventListener('submit', async e => {
    e.preventDefault();
    const id      = document.getElementById('mig-id').value;
    const isEdit  = !!id;
    const isAdmin = user?.role === 'admin';

    const comment = document.getElementById('mig-comment').value.trim();
    if (!comment) { showToast('Le commentaire est obligatoire', 'warn'); return; }
    const resp_metier = document.getElementById('mig-resp-metier').value.trim();

    const payload = { comment, resp_metier };
    if (!isEdit || isAdmin) {
      const old_hostname = document.getElementById('mig-old-hostname').value;
      const new_hostname = document.getElementById('mig-new-hostname').value;
      const old_os = document.getElementById('mig-old-os').value;
      const new_os = document.getElementById('mig-new-os').value;
      if (!old_hostname || !new_hostname) { showToast('Sélectionnez l\'ancien et le nouveau serveur', 'warn'); return; }
      if (!old_os || !new_os) { showToast('Sélectionnez l\'ancien et le nouvel OS', 'warn'); return; }
      Object.assign(payload, { old_hostname, new_hostname, old_os, new_os });
      if (!isEdit) payload.site_id = siteId;
    }

    if (!await showConfirm({
      title: isEdit ? 'Confirmer la modification' : 'Confirmer la création',
      message: isEdit ? 'Enregistrer les modifications de cette migration ?' : 'Créer cette ligne de migration ?',
      confirmText: 'Confirmer',
    })) return;

    const btn = document.getElementById('btn-save-migration');
    btn.disabled = true; btn.textContent = 'Enregistrement…';
    try {
      if (isEdit) await put(`/api/migrations/${encodeURIComponent(id)}`, payload);
      else await post('/api/migrations', payload);
      showToast('Migration enregistrée', 'success');
      closeModal('modal-migration');
      await loadPage();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Enregistrer';
    }
  });
}

async function deleteMigration(id) {
  if (!await showConfirm({ title: 'Supprimer la migration', message: 'Supprimer définitivement cette ligne de migration ?', confirmText: 'Supprimer', danger: true })) return;
  try {
    await del(`/api/migrations/${encodeURIComponent(id)}`);
    showToast('Migration supprimée', 'success');
    await loadPage();
  } catch (e) { showToast(e.message, 'error'); }
}
