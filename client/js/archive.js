// =============================================================================
// IPAM SIW — archive.js  (hostname release history)
// =============================================================================

import {
  requireAuth, startInactivityTimer, checkHttps, getUser, logout,
  get, del, delBody, showToast, sortSites, showConfirm, initTheme,
  restoreElevationSession, setupElevationMode,
} from './api.js';

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

let allReleases = [];
let isSuperAdmin = false;

document.addEventListener('DOMContentLoaded', async () => {
  restoreElevationSession();
  checkHttps(); initTheme();
  if (!requireAuth()) return;
  startInactivityTimer();

  const user = getUser();
  document.getElementById('nav-username').textContent = user?.username || '';
  document.getElementById('nav-role').textContent = user?.username === 'ADMIN' ? 'Super Administrateur' : user?.role === 'admin' ? 'Administrateur' : user?.role === 'viewer' ? 'Lecteur' : 'Utilisateur';
  document.getElementById('btn-logout').addEventListener('click', async () => {
    if (await showConfirm({ title: 'Déconnexion', message: 'Voulez-vous vous déconnecter ?', confirmText: 'Se déconnecter', danger: true })) logout();
  });
  setupElevationMode();
  loadSidebar();

  isSuperAdmin = user?.username === 'ADMIN' || user?.elevated === 'sa';

  // Export button — visible to all
  document.getElementById('btn-export-archive')?.addEventListener('click', exportCsv);

  // Super admin controls
  if (isSuperAdmin) {
    document.getElementById('archive-admin-controls')?.classList.remove('hidden');
    document.getElementById('btn-clear-archive')?.addEventListener('click', clearAllArchive);
  }

  document.getElementById('search-input').addEventListener('input', renderFiltered);
  await loadArchive();
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
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${s.name}</span>
        </a>`).join('');
    }
    render('');
    search?.addEventListener('input', e => render(e.target.value.trim()));
  } catch { /* sidebar non critique */ }
}

async function loadArchive() {
  try {
    const data = await get('/api/logs/archive?limit=2000');
    allReleases = data.releases || [];

    document.getElementById('archive-loading').style.display = 'none';
    document.getElementById('archive-content').classList.remove('hidden');

    document.getElementById('archive-subtitle').textContent =
      `${allReleases.length} libération(s) enregistrée(s) — les plus récentes en premier`;

    renderFiltered();
  } catch (err) {
    showToast(err.message, 'error');
    document.getElementById('archive-loading').querySelector('p').textContent = `Erreur : ${err.message}`;
  }
}

function renderFiltered() {
  const q = document.getElementById('search-input').value.trim().toLowerCase();
  const filtered = q
    ? allReleases.filter(r =>
        r.hostname?.toLowerCase().includes(q) ||
        r.ip?.toLowerCase().includes(q) ||
        r.username?.toLowerCase().includes(q) ||
        r.comment?.toLowerCase().includes(q)
      )
    : allReleases;

  document.getElementById('counter').textContent =
    filtered.length !== allReleases.length
      ? `${filtered.length} / ${allReleases.length} résultat(s)`
      : `${allReleases.length} entrée(s)`;

  const tbody = document.getElementById('archive-tbody');
  const empty = document.getElementById('archive-empty');

  if (!filtered.length) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  tbody.innerHTML = filtered.map((r, i) => {
    const bg = i % 2 === 1 ? 'background:var(--bg-3);' : '';
    const deleteBtn = isSuperAdmin
      ? `<button class="btn-del-entry" data-raw="${esc(r._raw)}" title="Supprimer cette entrée" style="background:none;border:none;color:#f85149;cursor:pointer;padding:3px 6px;border-radius:5px;opacity:.6;transition:opacity .15s" onmouseenter="this.style.opacity='1'" onmouseleave="this.style.opacity='.6'"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg></button>`
      : '';
    return `
      <tr style="${bg}border-bottom:1px solid var(--brd);">
        <td style="padding:11px 16px;font-size:13px;font-family:'Consolas','Courier New',monospace;color:var(--tx-1);">${esc(r.hostname)}</td>
        <td style="padding:11px 16px;font-size:13px;font-family:'Consolas','Courier New',monospace;color:var(--tx-3);">${esc(r.ip)}</td>
        <td style="padding:11px 16px;font-size:13px;color:var(--tx-3);white-space:nowrap;">${fmtDate(r.created_at)}</td>
        <td style="padding:11px 16px;">
          <span style="display:inline-block;background:#58a6ff18;border:1px solid #58a6ff44;color:#58a6ff;border-radius:5px;padding:2px 9px;font-size:12px;font-weight:600;">${esc(r.username)}</span>
        </td>
        <td style="padding:11px 16px;font-size:13px;color:var(--tx-3);max-width:240px;">${r.comment ? `<span title="${esc(r.comment)}" style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.comment)}</span>` : '<span style="color:var(--tx-4)">—</span>'}</td>
        ${isSuperAdmin ? `<td style="padding:6px 12px;white-space:nowrap;">${deleteBtn}</td>` : ''}
      </tr>
    `;
  }).join('');

  // Wire individual delete buttons
  if (isSuperAdmin) {
    tbody.querySelectorAll('.btn-del-entry').forEach(btn => {
      btn.addEventListener('click', () => deleteEntry(btn.dataset.raw));
    });
  }
}

async function deleteEntry(raw) {
  if (!await showConfirm({ title: 'Supprimer cette entrée', message: 'Supprimer définitivement cette ligne d\'archive ?', confirmText: 'Supprimer', danger: true })) return;
  try {
    await delBody('/api/logs/entry', { raw });
    allReleases = allReleases.filter(r => r._raw !== raw);
    document.getElementById('archive-subtitle').textContent =
      `${allReleases.length} libération(s) enregistrée(s) — les plus récentes en premier`;
    renderFiltered();
    showToast('Entrée supprimée', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

async function clearAllArchive() {
  if (!await showConfirm({ title: 'Vider l\'archive', message: 'Supprimer définitivement toutes les entrées de libération ? Cette action est irréversible.', confirmText: 'Vider l\'archive', danger: true })) return;
  try {
    await del('/api/logs/archive');
    allReleases = [];
    document.getElementById('archive-subtitle').textContent = '0 libération(s) enregistrée(s)';
    renderFiltered();
    showToast('Archive vidée', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

function exportCsv() {
  if (!allReleases.length) { showToast('Aucune donnée à exporter', 'warn'); return; }
  const q = document.getElementById('search-input').value.trim().toLowerCase();
  const rows = q
    ? allReleases.filter(r =>
        r.hostname?.toLowerCase().includes(q) ||
        r.ip?.toLowerCase().includes(q) ||
        r.username?.toLowerCase().includes(q) ||
        r.comment?.toLowerCase().includes(q)
      )
    : allReleases;

  const csvEsc = v => `"${String(v || '').replace(/"/g, '""')}"`;
  const lines = [
    ['Hostname', 'Adresse IP', 'Date', 'Utilisateur', 'Commentaire'].map(csvEsc).join(','),
    ...rows.map(r => [r.hostname, r.ip, fmtDate(r.created_at), r.username, r.comment || ''].map(csvEsc).join(',')),
  ];
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `archive-liberations-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
