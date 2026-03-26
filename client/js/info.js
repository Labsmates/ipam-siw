// =============================================================================
// IPAM SIW — info.js  (Informations réseau — lecture tous, édition admin)
// =============================================================================

import {
  requireAuth, startInactivityTimer, checkHttps, getUser, logout,
  get, post, put, del, showToast, sortSites, showConfirm, initTheme,
} from './api.js';

let isAdmin   = false;
let infosData = null;
let allSites  = [];

// Champ en cours d'édition (un seul à la fois)
let activeEdit = null;

// Mode modal : 'add' ou 'edit'
let modalMode   = 'add';
let editSiteId  = null;

// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  checkHttps(); initTheme();
  if (!requireAuth()) return;
  startInactivityTimer();

  const user = getUser();
  document.getElementById('nav-username').textContent = user?.username || '';
  document.getElementById('nav-role').textContent =
    user?.role === 'admin' ? 'Administrateur' : user?.role === 'viewer' ? 'Lecteur' : 'Utilisateur';

  document.getElementById('btn-logout').addEventListener('click', async () => {
    if (await showConfirm({ title: 'Déconnexion', message: 'Voulez-vous vous déconnecter ?', confirmText: 'Se déconnecter', danger: true }))
      logout();
  });

  if (user?.role === 'admin') {
    document.getElementById('nav-admin-link').classList.remove('hidden');
    document.getElementById('nav-config-link')?.classList.remove('hidden');
  }
  if (user?.username === 'ADMIN') {
    document.getElementById('nav-config-link')?.classList.remove('hidden');
  }

  isAdmin = user?.role === 'admin';

  // Révéler les contrôles admin
  if (isAdmin) {
    document.querySelectorAll('.admin-only').forEach(el => el.classList.remove('hidden'));
  }

  // Chargement parallèle
  await Promise.all([loadInfos(), loadSitesData()]);

  setupInlineEdits();
  setupDomainAdd();
  setupCodeModal();

  // Changement de mot de passe
  document.getElementById('btn-change-pw')?.addEventListener('click', () => {
    document.getElementById('modal-change-pw').classList.remove('hidden');
  });
  document.getElementById('btn-cancel-change-pw')?.addEventListener('click', () => {
    document.getElementById('modal-change-pw').classList.add('hidden');
  });
  document.getElementById('form-change-pw')?.addEventListener('submit', async e => {
    e.preventDefault();
    const current  = document.getElementById('cpw-current').value;
    const newpw    = document.getElementById('cpw-new').value;
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

  // Thème
  const themeBtn = document.getElementById('btn-theme');
  const { getTheme, toggleTheme } = await import('./api.js');
  function updateThemeBtn() {
    const t = getTheme();
    themeBtn.innerHTML = t === 'dark'
      ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
      : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    themeBtn.title = t === 'dark' ? 'Passer en mode clair' : 'Passer en mode sombre';
  }
  updateThemeBtn();
  themeBtn.addEventListener('click', () => { toggleTheme(); updateThemeBtn(); });

  loadSidebar();
});

// ---------------------------------------------------------------------------
// Chargement des infos
// ---------------------------------------------------------------------------
async function loadInfos() {
  try {
    infosData = await get('/api/infos');
    renderInfos();
  } catch (e) {
    showToast(e.message, 'error');
  }
}

async function loadSitesData() {
  try {
    const data = await get('/api/sites');
    allSites = sortSites(data.sites || []);
  } catch (_) { /* non critique */ }
}

function renderInfos() {
  if (!infosData) return;
  setVal('dns1',      infosData.dns1);
  setVal('dns2',      infosData.dns2);
  setVal('dns_dc',    infosData.dns_dc);
  setVal('route_psm', infosData.route_psm);
  renderDomains();
  renderCodes();
}

function setVal(key, value) {
  document.getElementById(`val-${key}`).textContent = value || '—';
}

// ---------------------------------------------------------------------------
// Édition inline
// ---------------------------------------------------------------------------
function setupInlineEdits() {
  const FIELDS = ['dns1', 'dns2', 'dns_dc', 'route_psm'];

  for (const key of FIELDS) {
    const editBtn   = document.getElementById(`btn-edit-${key}`);
    const cancelBtn = document.getElementById(`btn-cancel-${key}`);
    const saveBtn   = document.getElementById(`btn-save-${key}`);
    const input     = document.getElementById(`inp-${key}`);

    if (!editBtn) continue;

    editBtn.addEventListener('click', () => openEdit(key));
    cancelBtn.addEventListener('click', () => closeEdit(key));
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  saveField(key);
      if (e.key === 'Escape') closeEdit(key);
    });
    saveBtn.addEventListener('click', () => saveField(key));
  }
}

function openEdit(key) {
  if (activeEdit && activeEdit !== key) closeEdit(activeEdit);
  activeEdit = key;

  const currentVal = infosData?.[key] || '';
  document.getElementById(`inp-${key}`).value = currentVal;
  document.getElementById(`display-${key}`).style.display = 'none';
  document.getElementById(`edit-${key}`).classList.remove('hidden');
  document.getElementById(`inp-${key}`).focus();
}

function closeEdit(key) {
  document.getElementById(`display-${key}`).style.display = '';
  document.getElementById(`edit-${key}`).classList.add('hidden');
  if (activeEdit === key) activeEdit = null;
}

async function saveField(key) {
  const value = document.getElementById(`inp-${key}`).value.trim();
  if (!value) { showToast('Valeur ne peut pas être vide', 'warn'); return; }

  const btn = document.getElementById(`btn-save-${key}`);
  btn.disabled = true;
  try {
    await put('/api/infos', { [key]: value });
    infosData[key] = value;
    setVal(key, value);
    closeEdit(key);
    showToast('Mis à jour', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Domaines
// ---------------------------------------------------------------------------
function renderDomains() {
  const list    = document.getElementById('domains-list');
  const domains = infosData?.domains || [];

  if (!domains.length) {
    list.innerHTML = '<div style="color:var(--tx-3);font-size:13px;padding:4px 0 8px">Aucun domaine défini</div>';
    return;
  }

  list.innerHTML = domains.map((d, i) => `
    <div class="domain-row" style="display:-webkit-box;display:-ms-flexbox;display:flex;-webkit-box-align:center;-ms-flex-align:center;align-items:center;gap:6px;padding:5px 0;border-bottom:1px solid var(--brd)">
      <div id="dom-display-${i}" style="display:-webkit-box;display:-ms-flexbox;display:flex;-webkit-box-align:center;-ms-flex-align:center;align-items:center;gap:6px;-webkit-box-flex:1;-ms-flex:1;flex:1">
        <span style="font-family:monospace;font-size:13px;color:var(--tx-1);-webkit-box-flex:1;-ms-flex:1;flex:1">${esc(d)}</span>
        ${isAdmin ? `
          <button class="edit-icon dom-edit-btn" data-idx="${i}" data-domain="${esc(d)}" title="Modifier">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="btn btn-d btn-sm dom-del-btn" data-idx="${i}" data-domain="${esc(d)}" title="Supprimer">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
          </button>
        ` : ''}
      </div>
      <div id="dom-edit-${i}" class="hidden" style="display:-webkit-box;display:-ms-flexbox;display:flex;-webkit-box-align:center;-ms-flex-align:center;align-items:center;gap:6px;-webkit-box-flex:1;-ms-flex:1;flex:1">
        <input class="inp dom-edit-inp" data-idx="${i}" data-domain="${esc(d)}" value="${esc(d)}"
               style="padding:5px 8px;font-size:13px;font-family:monospace;-webkit-box-flex:1;-ms-flex:1;flex:1" maxlength="100">
        <button class="btn btn-p btn-sm dom-save-btn" data-idx="${i}" data-domain="${esc(d)}">✓</button>
        <button class="btn btn-g btn-sm dom-cancel-btn" data-idx="${i}">✗</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.dom-edit-btn').forEach(btn =>
    btn.addEventListener('click', () => openDomainEdit(+btn.dataset.idx)));
  list.querySelectorAll('.dom-cancel-btn').forEach(btn =>
    btn.addEventListener('click', () => closeDomainEdit(+btn.dataset.idx)));
  list.querySelectorAll('.dom-save-btn').forEach(btn =>
    btn.addEventListener('click', () => saveDomain(+btn.dataset.idx, btn.dataset.domain)));
  list.querySelectorAll('.dom-edit-inp').forEach(inp =>
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter')  saveDomain(+inp.dataset.idx, inp.dataset.domain);
      if (e.key === 'Escape') closeDomainEdit(+inp.dataset.idx);
    }));
  list.querySelectorAll('.dom-del-btn').forEach(btn =>
    btn.addEventListener('click', () => deleteDomain(btn.dataset.domain)));

}

function setupDomainAdd() {
  document.getElementById('btn-add-domain')?.addEventListener('click', () => {
    document.getElementById('domain-add-row').classList.remove('hidden');
    document.getElementById('inp-new-domain').focus();
  });
  document.getElementById('btn-cancel-new-domain')?.addEventListener('click', closeAddDomain);
  document.getElementById('btn-save-new-domain')?.addEventListener('click', addDomain);
  document.getElementById('inp-new-domain')?.addEventListener('keydown', e => {
    if (e.key === 'Enter')  addDomain();
    if (e.key === 'Escape') closeAddDomain();
  });
}

function openDomainEdit(idx) {
  document.getElementById(`dom-display-${idx}`).style.display = 'none';
  document.getElementById(`dom-edit-${idx}`).classList.remove('hidden');
  document.getElementById(`dom-edit-${idx}`).querySelector('.dom-edit-inp').focus();
}

function closeDomainEdit(idx) {
  document.getElementById(`dom-display-${idx}`).style.display = '';
  document.getElementById(`dom-edit-${idx}`).classList.add('hidden');
}

function closeAddDomain() {
  document.getElementById('domain-add-row').classList.add('hidden');
  document.getElementById('inp-new-domain').value = '';
}

async function saveDomain(idx, oldDomain) {
  const inp = document.querySelector(`#dom-edit-${idx} .dom-edit-inp`);
  const val = inp.value.trim().toLowerCase();
  if (!val) { showToast('Valeur vide', 'warn'); return; }
  try {
    await put(`/api/infos/domains/${encodeURIComponent(oldDomain)}`, { newDomain: val });
    showToast('Domaine modifié', 'success');
    await loadInfos();
  } catch (e) { showToast(e.message, 'error'); }
}

async function addDomain() {
  const val = document.getElementById('inp-new-domain').value.trim().toLowerCase();
  if (!val) { showToast('Entrez un domaine', 'warn'); return; }
  try {
    await post('/api/infos/domains', { domain: val });
    showToast('Domaine ajouté', 'success');
    closeAddDomain();
    await loadInfos();
  } catch (e) { showToast(e.message, 'error'); }
}

async function deleteDomain(domain) {
  if (!await showConfirm({
    title:       'Supprimer le domaine',
    message:     `Supprimer "${domain}" ?`,
    confirmText: 'Supprimer',
    danger:      true,
  })) return;
  try {
    await del(`/api/infos/domains/${encodeURIComponent(domain)}`);
    showToast('Domaine supprimé', 'success');
    await loadInfos();
  } catch (e) { showToast(e.message, 'error'); }
}

// ---------------------------------------------------------------------------
// Codes Site
// ---------------------------------------------------------------------------
function renderCodes() {
  const list  = document.getElementById('codes-list');
  const codes = infosData?.site_codes || [];

  if (!codes.length) {
    list.innerHTML = '<div style="color:var(--tx-3);font-size:13px;padding:16px 16px 8px">Aucun code site défini</div>';
    return;
  }

  list.innerHTML = codes.map(c => `
    <div class="code-row" data-site-id="${esc(c.site_id)}">
      <span style="font-family:monospace;font-size:14px;font-weight:700;color:#58a6ff;min-width:90px;letter-spacing:.04em">${esc(c.code)}</span>
      <span style="-webkit-box-flex:1;-ms-flex:1;flex:1;font-size:13px;color:var(--tx-2)">${esc(c.site_name)}</span>
      ${isAdmin ? `
        <button class="btn btn-g btn-sm code-edit-btn" data-site-id="${esc(c.site_id)}" data-code="${esc(c.code)}" data-name="${esc(c.site_name)}" title="Modifier">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="btn btn-d btn-sm code-del-btn" data-site-id="${esc(c.site_id)}" data-name="${esc(c.site_name)}" title="Supprimer">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
        </button>
      ` : ''}
    </div>
  `).join('');

  // Délégation d'événements
  list.querySelectorAll('.code-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      openCodeModal('edit', btn.dataset.siteId, btn.dataset.code, btn.dataset.name);
    });
  });
  list.querySelectorAll('.code-del-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteCode(btn.dataset.siteId, btn.dataset.name));
  });
}

// ---------------------------------------------------------------------------
// Modal code site
// ---------------------------------------------------------------------------
function setupCodeModal() {
  document.getElementById('btn-add-code')?.addEventListener('click', () => openCodeModal('add'));
  document.getElementById('btn-cancel-code').addEventListener('click', closeCodeModal);
  document.getElementById('btn-submit-code').addEventListener('click', submitCode);
  document.getElementById('modal-code-input').addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase();
  });
  // Fermer si clic hors de la modal-box
  document.getElementById('modal-code').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-code')) closeCodeModal();
  });
}

function openCodeModal(mode, siteId = null, code = '', siteName = '') {
  modalMode  = mode;
  editSiteId = siteId;

  const assignedIds = new Set((infosData?.site_codes || []).map(c => c.site_id));
  const select      = document.getElementById('modal-site-select');

  // Peupler le sélecteur
  select.innerHTML = '<option value="">— Sélectionner un site —</option>';
  for (const s of allSites) {
    const alreadyUsed = assignedIds.has(s.id) && s.id !== siteId;
    const opt = document.createElement('option');
    opt.value        = s.id;
    opt.dataset.name = s.name;
    opt.textContent  = s.name + (alreadyUsed ? ' (code déjà défini)' : '');
    opt.disabled     = alreadyUsed;
    if (alreadyUsed) opt.style.color = 'var(--tx-4)';
    select.appendChild(opt);
  }

  document.getElementById('modal-code-input').value = code;
  document.getElementById('modal-code-title').textContent =
    mode === 'edit' ? 'Modifier le code site' : 'Ajouter un code site';

  if (mode === 'edit') {
    select.value    = siteId;
    select.disabled = true;
  } else {
    select.disabled = false;
  }

  document.getElementById('modal-code').classList.remove('hidden');
  setTimeout(() => document.getElementById('modal-code-input').focus(), 50);
}

function closeCodeModal() {
  document.getElementById('modal-code').classList.add('hidden');
  document.getElementById('modal-code-input').value = '';
  document.getElementById('modal-site-select').value = '';
  editSiteId = null;
}

async function submitCode() {
  const select = document.getElementById('modal-site-select');
  const code   = document.getElementById('modal-code-input').value.trim().toUpperCase();
  const siteId = modalMode === 'edit' ? editSiteId : select.value;

  if (!siteId)  { showToast('Sélectionnez un site', 'warn'); return; }
  if (!code)    { showToast('Entrez un code', 'warn'); return; }

  const siteName = modalMode === 'edit'
    ? (infosData?.site_codes?.find(c => c.site_id === siteId)?.site_name || '')
    : (select.options[select.selectedIndex]?.dataset.name || '');
  const btn = document.getElementById('btn-submit-code');
  btn.disabled = true;
  try {
    if (modalMode === 'edit') {
      await put(`/api/infos/site-codes/${encodeURIComponent(siteId)}`, { code });
    } else {
      await post('/api/infos/site-codes', { site_id: siteId, site_name: siteName, code });
    }
    showToast(modalMode === 'edit' ? 'Code modifié' : 'Code ajouté', 'success');
    closeCodeModal();
    await loadInfos();
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function deleteCode(siteId, siteName) {
  if (!await showConfirm({
    title:       'Supprimer le code site',
    message:     `Supprimer le code site de "${siteName}" ?`,
    confirmText: 'Supprimer',
    danger:      true,
  })) return;

  try {
    await del(`/api/infos/site-codes/${encodeURIComponent(siteId)}`);
    showToast('Code supprimé', 'success');
    await loadInfos();
  } catch (e) {
    showToast(e.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------
function loadSidebar() {
  const list   = document.getElementById('site-list');
  const search = document.getElementById('sidebar-search');
  if (!list) return;

  function render(q) {
    const filtered = q ? allSites.filter(s => s.name.toLowerCase().includes(q.toLowerCase())) : allSites;
    list.innerHTML = filtered.map(s => `
      <a href="/site.html?id=${s.id}" style="padding:9px 16px;display:flex;align-items:center;font-size:13px;color:var(--tx-2);text-decoration:none;border-left:2px solid transparent;transition:all .1s" onmouseenter="this.style.background='var(--bg-3)';this.style.color='var(--tx-1)'" onmouseleave="this.style.background='';this.style.color='var(--tx-2)'">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${s.name}</span>
      </a>`).join('');
  }
  render('');
  search?.addEventListener('input', e => render(e.target.value.trim()));
}

// ---------------------------------------------------------------------------
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
