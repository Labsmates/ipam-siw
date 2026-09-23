// =============================================================================
// IPAM SIW — archive.js  (hostname release history)
// =============================================================================

import {
  requireAuth, startInactivityTimer, checkHttps, getUser, logout,
  get, post, showToast, sortSites, showConfirm, initTheme, initSidebarCollapse, loadMigrationBadge, loadSiteOsBadges,
  restoreElevationSession, setupElevationMode,
} from './api.js?v=46cd70e';

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
let page = 1;
const PER_PAGE = 50;

document.addEventListener('DOMContentLoaded', async () => {
  restoreElevationSession();
  checkHttps(); initTheme(); initSidebarCollapse(); loadMigrationBadge(); loadSiteOsBadges();
  if (!requireAuth()) return;
  startInactivityTimer();

  const user = getUser();
  document.getElementById('nav-username').textContent = user?.username || '';
  document.getElementById('nav-role').textContent = user?.username === 'ADMIN' ? 'Super Administrateur' : user?.role === 'admin' ? 'Administrateur' : user?.role === 'viewer' ? 'Lecteur' : 'Utilisateur';
  document.getElementById('btn-logout').addEventListener('click', async () => {
    if (await showConfirm({ title: 'Déconnexion', message: 'Voulez-vous vous déconnecter ?', confirmText: 'Se déconnecter', danger: true })) logout();
  });
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
  setupElevationMode();
  loadSidebar();

  // Export button — visible to all
  document.getElementById('btn-export-archive')?.addEventListener('click', exportCsv);

  document.getElementById('search-input').addEventListener('input', () => { page = 1; renderFiltered(); });
  document.getElementById('site-filter').addEventListener('change', () => { page = 1; renderFiltered(); });
  document.getElementById('btn-prev')?.addEventListener('click', () => { page--; renderFiltered(); });
  document.getElementById('btn-next')?.addEventListener('click', () => { page++; renderFiltered(); });
  await populateSiteFilter();
  await loadArchive();
});

async function populateSiteFilter() {
  try {
    const data = await get('/api/sites');
    const sites = sortSites(data.sites || []);
    const select = document.getElementById('site-filter');
    const params = new URLSearchParams(location.search);
    const preselect = params.get('site') || '';
    select.insertAdjacentHTML('beforeend',
      sites.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join(''));
    if (preselect && sites.some(s => String(s.id) === preselect)) select.value = preselect;
  } catch { /* filtre non critique */ }
}

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

function getFiltered() {
  const siteId = document.getElementById('site-filter').value;
  const q = document.getElementById('search-input').value.trim().toLowerCase();
  let rows = siteId ? allReleases.filter(r => String(r.site_id) === siteId) : allReleases;
  if (q) {
    rows = rows.filter(r =>
      r.hostname?.toLowerCase().includes(q) ||
      r.ip?.toLowerCase().includes(q) ||
      r.username?.toLowerCase().includes(q) ||
      r.comment?.toLowerCase().includes(q) ||
      r.site_name?.toLowerCase().includes(q)
    );
  }
  return rows;
}

function renderFiltered() {
  const filtered = getFiltered();
  const siteId = document.getElementById('site-filter').value;

  // Colonne Site utile uniquement en vue "Tous les sites"
  document.getElementById('th-site').style.display = siteId ? 'none' : '';

  document.getElementById('counter').textContent =
    filtered.length !== allReleases.length
      ? `${filtered.length} / ${allReleases.length} résultat(s)`
      : `${allReleases.length} entrée(s)`;

  const tbody = document.getElementById('archive-tbody');
  const empty = document.getElementById('archive-empty');

  const pages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  if (page > pages) page = pages;
  if (page < 1) page = 1;
  const slice = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  const pageInfo = document.getElementById('archive-page-info');
  if (pageInfo) pageInfo.textContent = filtered.length ? `Page ${page} / ${pages}` : '';
  const btnPrev = document.getElementById('btn-prev');
  const btnNext = document.getElementById('btn-next');
  if (btnPrev) btnPrev.disabled = page <= 1;
  if (btnNext) btnNext.disabled = page >= pages;

  if (!filtered.length) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  const siteFilterActive = !!document.getElementById('site-filter').value;
  tbody.innerHTML = slice.map((r, i) => {
    const bg = i % 2 === 1 ? 'background:var(--bg-3);' : '';
    return `
      <tr style="${bg}border-bottom:1px solid var(--brd);">
        ${siteFilterActive ? '' : `<td style="padding:11px 16px;font-size:13px;color:var(--tx-2);">${esc(r.site_name)}</td>`}
        <td style="padding:11px 16px;font-size:13px;font-family:'Consolas','Courier New',monospace;color:var(--tx-1);">${esc(r.hostname)}</td>
        <td style="padding:11px 16px;font-size:13px;font-family:'Consolas','Courier New',monospace;color:var(--tx-3);">${esc(r.ip)}</td>
        <td style="padding:11px 16px;font-size:13px;color:var(--tx-3);white-space:nowrap;">${fmtDate(r.created_at)}</td>
        <td style="padding:11px 16px;">
          <span style="display:inline-block;background:#58a6ff18;border:1px solid #58a6ff44;color:#58a6ff;border-radius:5px;padding:2px 9px;font-size:12px;font-weight:600;">${esc(r.username)}</span>
        </td>
        <td style="padding:11px 16px;font-size:13px;color:var(--tx-3);max-width:240px;">${r.comment ? `<span title="${esc(r.comment)}" style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.comment)}</span>` : '<span style="color:var(--tx-4)">—</span>'}</td>
      </tr>
    `;
  }).join('');
}

function exportCsv() {
  if (!allReleases.length) { showToast('Aucune donnée à exporter', 'warn'); return; }
  const rows = getFiltered();

  const csvEsc = v => `"${String(v || '').replace(/"/g, '""')}"`;
  const lines = [
    ['Site', 'Hostname', 'Adresse IP', 'Date', 'Utilisateur', 'Commentaire'].map(csvEsc).join(','),
    ...rows.map(r => [r.site_name, r.hostname, r.ip, fmtDate(r.created_at), r.username, r.comment || ''].map(csvEsc).join(',')),
  ];
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `archive-liberations-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
