// =============================================================================
// IPAM SIW — dashboard.js  (site list with stats)
// =============================================================================

import {
  requireAuth, startInactivityTimer, checkHttps, getUser, logout,
  get, post, showToast, sortSites, showConfirm, initTheme, setupGlobalIpSearch,
} from './api.js';

document.addEventListener('DOMContentLoaded', async () => {
  checkHttps();
  initTheme();
  if (!requireAuth()) return;
  startInactivityTimer();

  // Nav user info
  const user = getUser();
  document.getElementById('nav-username').textContent = user?.username || '';
  document.getElementById('nav-role').textContent = user?.role === 'admin' ? 'Administrateur' : user?.role === 'viewer' ? 'Lecteur' : 'Utilisateur';
  document.getElementById('btn-logout').addEventListener('click', async () => {
    if (await showConfirm({ title: 'Déconnexion', message: 'Voulez-vous vous déconnecter ?', confirmText: 'Se déconnecter', danger: true })) logout();
  });

  // Viewers don't belong on dashboard.html — send them to site.html
  if (user?.role === 'viewer') { window.location.replace('/site.html'); return; }

  // Admin link visibility
  if (user?.role === 'admin') {
    document.getElementById('nav-admin-link').classList.remove('hidden');
    document.getElementById('nav-config-link')?.classList.remove('hidden');
  }

  loadSidebar();

  // Password change modal
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

  // Search box
  const searchEl = document.getElementById('search-site');
  searchEl.addEventListener('input', () => renderSites(allSites));

  // Load sites
  const container = document.getElementById('sites-grid');
  const emptyEl   = document.getElementById('empty-state');
  let allSites = [];

  async function loadSites() {
    container.innerHTML = '<p style="color:#8b949e;padding:32px;">Chargement…</p>';
    try {
      const data = await get('/api/sites');
      allSites = data.sites || [];
      renderSites(allSites);
    } catch (err) {
      showToast(err.message, 'error');
      container.innerHTML = `<p style="color:#f85149;padding:32px;">${err.message}</p>`;
    }
  }

  function renderSites(sites) {
    const q = (searchEl.value || '').trim().toLowerCase();
    const sorted = sortSites(sites);
    const filtered = q ? sorted.filter(s => s.name.toLowerCase().includes(q)) : sorted;

    document.getElementById('site-count').textContent = `${filtered.length} site${filtered.length !== 1 ? 's' : ''}`;

    if (!filtered.length) {
      container.innerHTML = '';
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');

    container.innerHTML = filtered.map(s => {
      const total  = s.total  || 0;
      const libre  = s.libre  || 0;
      const utilise = s.utilise || 0;
      const reserve = s.reserve || 0;
      const pctUtilise = total ? Math.round((utilise + reserve) / total * 100) : 0;
      const pctLibre   = total ? Math.round(libre / total * 100) : 0;

      return `
        <a href="/site.html?id=${encodeURIComponent(s.id)}" class="site-card" style="
          display:block;text-decoration:none;
          background:var(--bg-2);border:1px solid var(--brd);border-radius:12px;
          padding:24px;cursor:pointer;
          -webkit-transition:border-color .15s,-webkit-transform .15s,box-shadow .15s;
          transition:border-color .15s,transform .15s,box-shadow .15s;
        "
        onmouseenter="this.style.borderColor='#58a6ff';this.style.webkitTransform='translateY(-2px)';this.style.transform='translateY(-2px)';this.style.boxShadow='0 8px 24px rgba(88,166,255,.12)'"
        onmouseleave="this.style.borderColor='var(--brd)';this.style.webkitTransform='';this.style.transform='';this.style.boxShadow=''">
          <div style="display:-webkit-box;display:-ms-flexbox;display:flex;-webkit-box-pack:justify;-ms-flex-pack:justify;justify-content:space-between;-webkit-box-align:start;-ms-flex-align:start;align-items:flex-start;margin-bottom:16px;">
            <h3 style="color:var(--tx-1);font-size:15px;font-weight:700;margin:0;letter-spacing:-.01em;">${esc(s.name)}</h3>
            <span style="color:#58a6ff;font-size:12px;background:#0d2240;border:1px solid #1f4080;padding:2px 8px;border-radius:999px;">${s.vlan_count || 0} VLAN${(s.vlan_count || 0) !== 1 ? 's' : ''}</span>
          </div>

          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px;">
            <div style="text-align:center;background:var(--bg-1);border-radius:8px;padding:10px 6px;">
              <div style="color:var(--tx-1);font-size:18px;font-weight:700;">${total.toLocaleString('fr')}</div>
              <div style="color:var(--tx-3);font-size:11px;margin-top:2px;">Total</div>
            </div>
            <div style="text-align:center;background:#0d2e1a;border-radius:8px;padding:10px 6px;">
              <div style="color:#3fb950;font-size:18px;font-weight:700;">${libre.toLocaleString('fr')}</div>
              <div style="color:#3fb950;font-size:11px;margin-top:2px;opacity:.7">Libres</div>
            </div>
            <div style="text-align:center;background:#2e0d0d;border-radius:8px;padding:10px 6px;">
              <div style="color:#f85149;font-size:18px;font-weight:700;">${(utilise + reserve).toLocaleString('fr')}</div>
              <div style="color:#f85149;font-size:11px;margin-top:2px;opacity:.7">Occupées</div>
            </div>
          </div>

          <div style="height:6px;background:var(--brd);border-radius:999px;overflow:hidden;">
            <div style="height:100%;width:${pctUtilise}%;background:-webkit-linear-gradient(left,#f85149,#d29922);background:linear-gradient(90deg,#f85149,#d29922);border-radius:999px;-webkit-transition:width .4s ease;transition:width .4s ease;"></div>
          </div>
          <div style="display:-webkit-box;display:-ms-flexbox;display:flex;-webkit-box-pack:justify;-ms-flex-pack:justify;justify-content:space-between;margin-top:6px;">
            <span style="color:var(--tx-3);font-size:11px;">${pctLibre}% libres</span>
            <span style="color:var(--tx-3);font-size:11px;">${pctUtilise}% occupées</span>
          </div>
        </a>
      `;
    }).join('');
  }

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  await loadSites();
  setupGlobalIpSearch('search-ip-global', 'ip-global-dropdown');
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
