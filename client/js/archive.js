// =============================================================================
// IPAM SIW — archive.js  (hostname release history)
// =============================================================================

import {
  requireAuth, startInactivityTimer, checkHttps, getUser, logout,
  get, showToast,
} from './api.js';

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

let allReleases = [];

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

  document.getElementById('search-input').addEventListener('input', renderFiltered);

  await loadArchive();
});

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
        r.username?.toLowerCase().includes(q)
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
    const bg = i % 2 === 1 ? 'background:#1c2128;' : '';
    return `
      <tr style="${bg}border-bottom:1px solid #21262d;">
        <td style="padding:11px 16px;font-size:13px;font-family:'Consolas','Courier New',monospace;color:#e6edf3;">${esc(r.hostname)}</td>
        <td style="padding:11px 16px;font-size:13px;font-family:'Consolas','Courier New',monospace;color:#8b949e;">${esc(r.ip)}</td>
        <td style="padding:11px 16px;font-size:13px;color:#8b949e;white-space:nowrap;">${fmtDate(r.created_at)}</td>
        <td style="padding:11px 16px;">
          <span style="display:inline-block;background:#58a6ff18;border:1px solid #58a6ff44;color:#58a6ff;border-radius:5px;padding:2px 9px;font-size:12px;font-weight:600;">${esc(r.username)}</span>
        </td>
      </tr>
    `;
  }).join('');
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
