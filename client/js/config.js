// =============================================================================
// IPAM SIW — config.js  (Configuration système — super admin uniquement)
// =============================================================================

import {
  requireAuth, startInactivityTimer, checkHttps, getUser, getToken, logout,
  get, post, put, del,
  showToast, fmtDate, openModal, closeModal, showConfirm, initTheme, sortSites,
  restoreElevationSession, setupElevationMode,
} from './api.js';

// ---------------------------------------------------------------------------
// Token bypass services (utilisateurs P/X) — permet d'utiliser les routes
// /api/bypass/services/* avec le token élevé dans handleServiceAction.
// ---------------------------------------------------------------------------
let _bypassServicesToken = null;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  restoreElevationSession();
  checkHttps();
  initTheme();
  if (!requireAuth()) return;
  startInactivityTimer();

  const user = getUser();

  setupElevationMode();

  const PX_RE    = /^[PX]/i;
  const isUserPX = user?.role === 'user' && PX_RE.test(user?.username || '');

  // Guard : admin OU utilisateur P/X (accès restreint)
  if (user?.role !== 'admin' && !isUserPX) {
    window.location.replace('/site.html');
    return;
  }

  document.getElementById('nav-username').textContent = user.username;
  // Rôle affiché dans la sidebar
  document.getElementById('nav-role').textContent =
    user?.username === 'ADMIN' ? 'Super Administrateur' :
    user?.role === 'admin'     ? 'Administrateur' :
                                 'Utilisateur';

  // Mode utilisateur P/X — accès restreint (Services uniquement)
  if (isUserPX) {
    setupUserPXConfig(user);
    return;
  }

  document.getElementById('btn-logout').addEventListener('click', async () => {
    if (await showConfirm({
      title: 'Déconnexion',
      message: 'Voulez-vous vous déconnecter ?',
      confirmText: 'Se déconnecter',
      danger: true,
    })) logout();
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

  // Sidebar sites
  loadConfigSidebar();

  // Système de tabs
  const tabs  = document.querySelectorAll('.admin-tab');
  const panes = document.querySelectorAll('.admin-pane');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t  => setTabActive(t, false));
      panes.forEach(p => p.classList.add('hidden'));
      setTabActive(tab, true);
      const pane = document.getElementById(`pane-${tab.dataset.tab}`);
      if (pane) pane.classList.remove('hidden');
    });
  });

  // Activer le premier onglet (cacher tous les panes, afficher le premier)
  if (tabs.length) {
    panes.forEach(p => p.classList.add('hidden'));
    setTabActive(tabs[0], true);
    document.getElementById(`pane-${tabs[0].dataset.tab}`)?.classList.remove('hidden');
  }

  // Chargements initiaux
  await loadSysInfo();
  await loadServices();
  setupRedisConfigTab();
  setupBackupTab();
  setupCertTab();
  setupDatabasesTab();
  setupApisTab();
  setupSharepointTab();
  setupMaintenanceTab();
  setupTerminalTab();
  setupApacheConfigTab();

  // Rafraîchissement auto des services toutes les 10 secondes
  setInterval(loadServices, 10_000);

  // Boutons rafraîchir
  document.getElementById('btn-refresh-services')?.addEventListener('click', loadServices);
  document.getElementById('btn-refresh-sysinfo')?.addEventListener('click', loadSysInfo);

  // Boutons actions serveur (reboot / halt)
  document.getElementById('btn-server-reboot')?.addEventListener('click', () => serverAction('reboot'));
  document.getElementById('btn-server-halt')?.addEventListener('click',   () => serverAction('halt'));
});

function setTabActive(tab, active) {
  tab.style.color            = active ? '#58a6ff' : 'var(--tx-3)';
  tab.style.borderBottomColor = active ? '#58a6ff' : 'transparent';
  tab.style.background        = active ? '#0d2240' : 'transparent';
}

async function loadConfigSidebar() {
  try {
    const data  = await get('/api/sites');
    const sites = sortSites(data.sites || []);
    const list  = document.getElementById('site-list');
    const search = document.getElementById('sidebar-search');

    function render(q) {
      const filtered = q ? sites.filter(s => s.name.toLowerCase().includes(q.toLowerCase())) : sites;
      list.innerHTML = filtered.map(s => `
        <a href="/site.html?id=${s.id}" class="site-item" style="padding:9px 16px;display:flex;align-items:center;justify-content:space-between;font-size:13px;color:var(--tx-2);text-decoration:none;border-left:2px solid transparent;transition:all .1s" onmouseenter="this.style.background='var(--bg-3)';this.style.color='var(--tx-1)'" onmouseleave="this.style.background='';this.style.color='var(--tx-2)'">
          <span>${esc(s.name)}</span>
          <span style="font-size:11px;color:var(--tx-3)">${s.vlan_count ?? 0} VLAN</span>
        </a>
      `).join('');
    }

    render('');
    search?.addEventListener('input', e => render(e.target.value));
  } catch (_) {}
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// =============================================================================
// ONGLET 0 — Informations système
// =============================================================================

async function loadSysInfo() {
  try {
    const { info } = await get('/api/config/system/info');
    renderSysInfo(info);
  } catch (e) {
    document.getElementById('sysinfo-grid').innerHTML =
      `<div style="color:#f85149;font-size:13px">${esc(e.message)}</div>`;
  }
}

function renderSysInfo(info) {
  const grid = document.getElementById('sysinfo-grid');

  function fmtBytes(b) {
    if (b == null) return '—';
    if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' Go';
    return (b / 1048576).toFixed(0) + ' Mo';
  }

  function fmtUptime(sec) {
    if (!sec) return '—';
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const parts = [];
    if (d) parts.push(`${d}j`);
    if (h) parts.push(`${h}h`);
    parts.push(`${m}min`);
    return parts.join(' ');
  }

  function card(title, icon, rows) {
    const rowsHtml = rows.map(([label, value, color]) => `
      <div style="display:flex;justify-content:space-between;align-items:baseline;padding:7px 0;border-bottom:1px solid var(--brd)">
        <span style="font-size:12px;color:var(--tx-3);flex-shrink:0;padding-right:12px">${label}</span>
        <span style="font-size:12px;color:${color || 'var(--tx-1)'};font-weight:500;text-align:right;font-family:${/^\d/.test(String(value)) ? "'JetBrains Mono','Courier New',monospace" : 'inherit'};word-break:break-all">${esc(String(value ?? '—'))}</span>
      </div>
    `).join('');
    return `
      <div style="background:var(--bg-2);border:1px solid var(--brd);border-radius:12px;padding:20px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px">
          <span style="color:#58a6ff">${icon}</span>
          <span style="font-size:13px;font-weight:600;color:var(--tx-1)">${title}</span>
        </div>
        ${rowsHtml}
      </div>
    `;
  }

  const iconServer  = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>';
  const iconCpu     = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="2" x2="9" y2="4"/><line x1="15" y1="2" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="22"/><line x1="15" y1="20" x2="15" y2="22"/><line x1="2" y1="9" x2="4" y2="9"/><line x1="2" y1="15" x2="4" y2="15"/><line x1="20" y1="9" x2="22" y2="9"/><line x1="20" y1="15" x2="22" y2="15"/></svg>';
  const iconNet     = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';
  const iconStack   = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>';

  const usedMem    = info.totalMem - info.freeMem;
  const pctMem     = info.totalMem ? Math.round(usedMem / info.totalMem * 100) : 0;
  const load       = info.cpuLoad || [0, 0, 0];

  const cards = [
    card('Système', iconServer, [
      ['Hostname',       info.hostname],
      ['OS',             info.osRelease],
      ['Noyau',          info.kernel],
      ['Plateforme',     info.platform ? `${info.platform} / ${info.arch}` : null],
      ['Dernier reboot', info.lastReboot],
      ['Uptime',         info.uptimeHuman || fmtUptime(info.uptimeSec)],
    ]),
    card('Ressources', iconCpu, [
      ['CPU',            `${info.cpuCount}× ${info.cpuModel}`],
      ['Charge (1/5/15m)', load.map(l => l.toFixed(2)).join(' / ')],
      ['RAM totale',     fmtBytes(info.totalMem)],
      ['RAM utilisée',   `${fmtBytes(usedMem)} (${pctMem}%)`, pctMem > 85 ? '#f85149' : pctMem > 65 ? '#d29922' : '#3fb950'],
      ['RAM libre',      fmtBytes(info.freeMem)],
      ['Disque /total',  info.disk?.total ?? '—'],
      ['Disque /utilisé', info.disk ? `${info.disk.used} (${info.disk.pct})` : '—',
        info.disk?.pct && parseInt(info.disk.pct) > 85 ? '#f85149' : parseInt(info.disk?.pct) > 65 ? '#d29922' : '#3fb950'],
      ['Disque /libre',  info.disk?.avail ?? '—'],
    ]),
    card('Réseau', iconNet, (() => {
      const rows = [];
      if (info.ips?.length) {
        for (const ip of info.ips) {
          rows.push([`${ip.iface} (${ip.family})`, ip.address, ip.family === 'IPv4' ? '#58a6ff' : 'var(--tx-2)']);
          if (ip.netmask) rows.push([`  Masque`, ip.netmask]);
        }
      } else {
        rows.push(['Interfaces', '—']);
      }
      if (info.gateway) rows.push(['Passerelle', info.gateway, '#3fb950']);
      if (info.dns?.length) rows.push(['DNS', info.dns.join(', ')]);
      return rows;
    })()),
    card('Logiciels', iconStack, [
      ['Node.js',  info.nodeVersion],
      ['Redis',    info.redisVersion],
      ['Apache',   info.apacheVersion],
    ]),
  ];

  grid.innerHTML = cards.join('');
}

// =============================================================================
// ONGLET 1 — Services
// =============================================================================
const SVC_META = {
  ipam:  {
    label: 'Service IPAM',
    icon:  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>',
  },
  httpd: {
    label: 'Apache HTTPD',
    icon:  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  },
  redis: {
    label: 'Redis',
    icon:  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
  },
};

async function loadServices() {
  try {
    const { services } = await get('/api/config/services/status');
    renderServiceCards(services);
    document.getElementById('svc-last-refresh').textContent =
      `Mis à jour : ${new Date().toLocaleTimeString('fr-FR')}`;
  } catch (e) {
    showToast(`Erreur services : ${e.message}`, 'error');
  }
}

function dotClass(active) {
  if (active === 'active')   return 'dot-active';
  if (active === 'failed')   return 'dot-failed';
  if (active === 'inactive') return 'dot-inactive';
  return 'dot-unknown';
}

function statusLabel(active) {
  if (active === 'active')   return { text: 'Actif',    color: '#3fb950' };
  if (active === 'failed')   return { text: 'Échoué',   color: '#f85149' };
  if (active === 'inactive') return { text: 'Inactif',  color: '#8b949e' };
  return { text: active || 'Inconnu', color: '#d29922' };
}

function renderServiceCards(services, readonly = false) {
  const grid = document.getElementById('services-grid');
  if (!services || !Object.keys(services).length) {
    grid.innerHTML = '<div style="color:var(--tx-3);font-size:13px">Aucun service disponible.</div>';
    return;
  }
  grid.innerHTML = '';
  for (const [name, info] of Object.entries(services)) {
    const meta   = SVC_META[name] || { label: name, icon: '' };
    const sl     = statusLabel(info.active);
    const card   = document.createElement('div');
    card.className = 'svc-card';
    card.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="color:var(--tx-3)">${meta.icon}</div>
          <span style="font-weight:600;font-size:14px">${esc(meta.label)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <span class="dot ${dotClass(info.active)}"></span>
          <span style="font-size:12px;font-weight:500;color:${sl.color}">${sl.text}</span>
        </div>
      </div>
      ${info.pid    ? `<div style="font-size:12px;color:var(--tx-3);margin-bottom:4px">PID : <span style="color:var(--tx-2);font-family:monospace">${esc(info.pid)}</span></div>` : ''}
      ${info.memory ? `<div style="font-size:12px;color:var(--tx-3);margin-bottom:4px">Mémoire : <span style="color:var(--tx-2)">${esc(info.memory)}</span></div>` : ''}
      ${readonly ? '' : `
      <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">
        ${info.active !== 'active' ? `
        <button class="btn btn-sm" style="background:#0d2a1a;color:#3fb950;border:1px solid #1b4d2e" data-action="start" data-svc="${name}">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          Démarrer
        </button>` : ''}
        <button class="btn btn-warn btn-sm" data-action="restart" data-svc="${name}">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-.18-6.5"/></svg>
          Redémarrer
        </button>
        ${info.active === 'active' ? `
        <button class="btn btn-d btn-sm" data-action="stop" data-svc="${name}">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
          Arrêter
        </button>` : ''}
        ${name === 'httpd' && info.active === 'active' ? `<button class="btn btn-g btn-sm" data-action="reload" data-svc="${name}"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.87"/></svg> Recharger</button>` : ''}
        <button class="btn btn-g btn-sm" data-action="logs" data-svc="${name}">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg>
          Logs
        </button>
      </div>
      <div id="logs-${name}" class="log-panel hidden"></div>`}
    `;
    grid.appendChild(card);
  }

  if (!readonly) {
    grid.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => handleServiceAction(btn.dataset.action, btn.dataset.svc));
    });
  }
}

async function handleServiceAction(action, svc) {
  const isBypass = !!_bypassServicesToken;

  if (action === 'logs') {
    const logEl = document.getElementById(`logs-${svc}`);
    if (!logEl.classList.contains('hidden')) {
      logEl.classList.add('hidden');
      return;
    }
    logEl.classList.remove('hidden');
    logEl.textContent = 'Chargement des logs…';
    try {
      let logs;
      if (isBypass) {
        const resp = await fetch(`/api/bypass/services/${svc}/logs`, {
          headers: { Authorization: `Bearer ${_bypassServicesToken}` },
        });
        if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.error || 'Erreur'); }
        ({ logs } = await resp.json());
      } else {
        ({ logs } = await get(`/api/config/services/${svc}/logs`));
      }
      logEl.textContent = logs || '(aucun log)';
      logEl.scrollTop   = logEl.scrollHeight;
    } catch (e) {
      logEl.textContent = `Erreur : ${e.message}`;
    }
    return;
  }

  const labels = {
    start:   { title: `Démarrer ${svc}`,    msg: `Démarrer le service « ${svc} » ?`,                                              confirm: 'Démarrer',   danger: false },
    restart: { title: `Redémarrer ${svc}`,  msg: `Redémarrer le service « ${svc} » ? Il sera brièvement indisponible.`,           confirm: 'Redémarrer', danger: true  },
    stop:    { title: `Arrêter ${svc}`,     msg: `Arrêter le service « ${svc} » ?\n\nAttention : ${svc === 'ipam' ? 'l\'application IPAM sera inaccessible jusqu\'au prochain démarrage.' : svc === 'httpd' ? 'le site web sera inaccessible.' : 'Redis sera arrêté, les données en mémoire non sauvegardées seront perdues.'}`, confirm: 'Arrêter', danger: true },
    reload:  { title: `Recharger ${svc}`,   msg: `Recharger la configuration d'Apache ?`,                                         confirm: 'Recharger',  danger: false },
  };

  const l = labels[action];
  if (!l) return;

  if (!await showConfirm({ title: l.title, message: l.msg, confirmText: l.confirm, danger: l.danger })) return;

  try {
    if (isBypass) {
      const resp = await fetch(`/api/bypass/services/${svc}/${action}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${_bypassServicesToken}` },
      });
      if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.error || 'Erreur'); }
    } else {
      await post(`/api/config/services/${svc}/${action}`);
    }
    const msgs = { start: `Service « ${svc} » démarré`, restart: `Service « ${svc} » redémarré`, stop: `Service « ${svc} » arrêté`, reload: 'Apache rechargé' };
    showToast(msgs[action] || 'OK', 'success');
    const delay = action === 'start' ? 1500 : 3000;
    if (isBypass) {
      setTimeout(() => loadServicesForUser(_bypassServicesToken).catch(() => {}), delay);
    } else {
      setTimeout(loadServices, delay);
    }
  } catch (e) {
    showToast(`Erreur : ${e.message}`, 'error');
  }
}

async function serverAction(action) {
  const isReboot = action === 'reboot';
  const confirmed = await showConfirm({
    title:       isReboot ? 'Redémarrer le serveur' : 'Arrêter le serveur',
    message:     isReboot
      ? 'Le serveur va redémarrer dans 1 minute.\n\nTous les utilisateurs connectés seront déconnectés. L\'application sera indisponible le temps du redémarrage.'
      : 'Le serveur va s\'arrêter dans 1 minute.\n\nTous les utilisateurs connectés seront déconnectés. L\'application sera inaccessible jusqu\'à un redémarrage manuel du serveur.',
    confirmText: isReboot ? 'Redémarrer dans 1 min' : 'Arrêter dans 1 min',
    danger:      true,
  });
  if (!confirmed) return;

  const btn = document.getElementById(isReboot ? 'btn-server-reboot' : 'btn-server-halt');
  if (btn) { btn.disabled = true; btn.textContent = isReboot ? 'Redémarrage dans 1 min…' : 'Arrêt dans 1 min…'; }

  try {
    await post(`/api/config/server/${action}`);
    showToast(
      isReboot ? 'Le serveur va redémarrer dans 1 minute' : 'Le serveur va s\'arrêter dans 1 minute',
      'success'
    );
  } catch (e) {
    showToast(`Erreur : ${e.message}`, 'error');
    if (btn) { btn.disabled = false; btn.textContent = isReboot ? 'Redémarrer le serveur' : 'Arrêter le serveur'; }
  }
}

// =============================================================================
// ONGLET 2 — Configuration Redis
// =============================================================================
const REDIS_CFG_META = [
  { key: 'maxmemory',        label: 'maxmemory',        hint: 'Ex : 256mb, 0 = illimité',            warn: false },
  { key: 'maxmemory-policy', label: 'maxmemory-policy', hint: 'allkeys-lru, noeviction, volatile-lru…', warn: false },
  { key: 'appendonly',       label: 'appendonly',        hint: 'yes / no',                             warn: false },
  { key: 'save',             label: 'save',              hint: 'Ex : 900 1 300 10',                   warn: false },
  { key: 'requirepass',      label: 'requirepass',       hint: 'Laisser vide pour désactiver',        warn: false },
  { key: 'loglevel',         label: 'loglevel',          hint: 'debug, verbose, notice, warning',      warn: false },
  { key: 'bind',             label: 'bind',              hint: 'Modifier avec précaution !',           warn: true  },
];

function setupRedisConfigTab() {
  document.querySelector('[data-tab="redis-config"]')?.addEventListener('click', loadRedisConfig);
  document.getElementById('btn-save-redis-cfg')?.addEventListener('click', saveRedisConfig);
}

async function loadRedisConfig() {
  const form = document.getElementById('redis-cfg-form');
  form.innerHTML = '<div style="color:var(--tx-3);font-size:13px">Chargement…</div>';
  try {
    const { config } = await get('/api/config/redis/config');
    form.innerHTML = '';
    for (const meta of REDIS_CFG_META) {
      const row = document.createElement('div');
      row.className = 'cfg-row';
      const inputId = `cfg-${meta.key.replace(/-/g, '_')}`;
      row.innerHTML = `
        <label class="cfg-label" for="${inputId}" title="${esc(meta.hint)}" style="${meta.warn ? 'color:#d29922' : ''}">${esc(meta.label)}</label>
        <input class="inp" id="${inputId}" value="${esc(config[meta.key] ?? '')}" placeholder="${esc(meta.hint)}" style="flex:1${meta.warn ? ';color:#d29922;border-color:#d2992240' : ''}">
      `;
      form.appendChild(row);
    }
  } catch (e) {
    form.innerHTML = `<div style="color:#f85149;font-size:13px">Erreur : ${esc(e.message)}</div>`;
    showToast(`Erreur config Redis : ${e.message}`, 'error');
  }
}

async function saveRedisConfig() {
  const params = {};
  for (const meta of REDIS_CFG_META) {
    const inputId = `cfg-${meta.key.replace(/-/g, '_')}`;
    const el      = document.getElementById(inputId);
    if (el) params[meta.key] = el.value.trim();
  }
  try {
    const result = await put('/api/config/redis/config', { params });
    if (result.errors?.length) {
      showToast(`Partiellement sauvegardé. Erreurs : ${result.errors.join(' | ')}`, 'warn');
    } else {
      showToast('Configuration Redis sauvegardée', 'success');
    }
  } catch (e) {
    showToast(`Erreur : ${e.message}`, 'error');
  }
}

// =============================================================================
// ONGLET 3 — Sauvegarde / Restauration
// =============================================================================
function setupBackupTab() {
  document.querySelector('[data-tab="backup"]')?.addEventListener('click', loadBackupInfo);
  document.getElementById('btn-bgsave')?.addEventListener('click', triggerBgsave);
  document.getElementById('btn-download-rdb')?.addEventListener('click', downloadRdb);
  document.getElementById('btn-restore-rdb')?.addEventListener('click', handleRestoreClick);
}

async function loadBackupInfo() {
  try {
    const { lastSave, size, exists } = await get('/api/config/redis/backup/info');
    document.getElementById('backup-last-save').textContent =
      lastSave ? fmtDate(new Date(lastSave).toISOString()) : 'Jamais';
    document.getElementById('backup-size').textContent =
      size != null ? formatBytes(size) : 'Inconnu';
    const existsEl = document.getElementById('backup-exists');
    existsEl.textContent = exists ? 'Oui' : 'Non';
    existsEl.style.color = exists ? '#3fb950' : '#f85149';
  } catch (e) {
    showToast(`Erreur info sauvegarde : ${e.message}`, 'error');
  }
}

async function triggerBgsave() {
  try {
    await post('/api/config/redis/backup');
    showToast('Sauvegarde BGSAVE lancée en arrière-plan', 'success');
    setTimeout(loadBackupInfo, 2500);
  } catch (e) {
    showToast(e.message, 'error');
  }
}

async function downloadRdb() {
  try {
    const token = getToken();
    const res   = await fetch('/api/config/redis/backup/download', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error);
    }
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'ipam.rdb';
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    showToast(`Téléchargement impossible : ${e.message}`, 'error');
  }
}

async function handleRestoreClick() {
  const confirmed = await showConfirm({
    title:       'Restaurer depuis un fichier RDB',
    message:     'ATTENTION : cette opération remplace toutes les données Redis et redémarre le service. Action irréversible.',
    confirmText: 'Restaurer',
    danger:      true,
  });
  if (!confirmed) return;

  const input    = document.createElement('input');
  input.type     = 'file';
  input.accept   = '.rdb,application/octet-stream';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async () => {
      const bytes  = new Uint8Array(reader.result);
      // Convertir en base64 par blocs pour éviter stack overflow sur gros fichiers
      let binary = '';
      const chunkSize = 8192;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      }
      const b64 = btoa(binary);
      try {
        const result = await post('/api/config/redis/restore', { data: b64 });
        showToast(result.message || 'Restauration effectuée. Redis redémarré.', 'success');
        await loadBackupInfo();
      } catch (e) {
        showToast(`Erreur : ${e.message}`, 'error');
      }
    };
    reader.readAsArrayBuffer(file);
  };
  input.click();
}

function formatBytes(bytes) {
  if (bytes < 1024)             return `${bytes} o`;
  if (bytes < 1024 * 1024)      return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} Mo`;
}

// =============================================================================
// ONGLET 5 — Certificat SSL
// =============================================================================

async function loadCertInfo() {
  const block = document.getElementById('cert-info-block');
  try {
    const { info } = await get('/api/config/cert/info');
    if (!info) {
      block.innerHTML = '<div style="color:var(--tx-3);font-size:13px">Aucun certificat trouvé.</div>';
      return;
    }

    const dl = info.daysLeft;
    const badgeColor = dl == null ? '#8b949e' : dl < 0 ? '#f85149' : dl < 30 ? '#d29922' : '#3fb950';
    const badgeText  = dl == null ? 'Inconnu' : dl < 0 ? `Expiré depuis ${Math.abs(dl)}j` : dl < 30 ? `Expire dans ${dl}j` : `Valide — ${dl} jours restants`;

    const row = (label, value) => value ? `
      <div style="display:flex;justify-content:space-between;align-items:baseline;padding:7px 0;border-bottom:1px solid var(--brd)">
        <span style="font-size:12px;color:var(--tx-3);flex-shrink:0;padding-right:16px">${label}</span>
        <span style="font-size:12px;color:var(--tx-1);font-weight:500;text-align:right;word-break:break-all;font-family:'JetBrains Mono','Courier New',monospace">${esc(value)}</span>
      </div>` : '';

    block.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap">
        <span style="background:${badgeColor}20;color:${badgeColor};border:1px solid ${badgeColor}50;border-radius:999px;padding:4px 12px;font-size:12px;font-weight:600">${badgeText}</span>
        ${info.hasPending ? '<span style="background:#58a6ff20;color:#58a6ff;border:1px solid #58a6ff50;border-radius:999px;padding:4px 12px;font-size:12px">CSR en attente d\'installation</span>' : ''}
      </div>
      ${row('Sujet',       info.subject)}
      ${row('Émetteur',    info.issuer)}
      ${row('Valide du',   info.notBefore)}
      ${row('Expire le',   info.notAfter)}
      ${row('SAN',         info.san)}
      ${row('Numéro de série', info.serial)}
      ${row('Empreinte SHA256', info.fingerprint)}
    `;
  } catch (e) {
    block.innerHTML = `<div style="color:#f85149;font-size:13px">${esc(e.message)}</div>`;
  }
}

function setupCertTab() {
  loadCertInfo();
  document.getElementById('btn-refresh-cert')?.addEventListener('click', loadCertInfo);

  // ── Générer CSR ─────────────────────────────────────────────────────────────
  document.getElementById('btn-gen-csr')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-gen-csr');
    const san = (document.getElementById('csr-san').value || '')
      .split('\n').map(s => s.trim()).filter(Boolean);
    btn.disabled = true; btn.textContent = 'Génération…';
    try {
      const { csr } = await post('/api/config/cert/generate-csr', {
        cn:      document.getElementById('csr-cn').value,
        o:       document.getElementById('csr-o').value,
        ou:      document.getElementById('csr-ou').value,
        c:       document.getElementById('csr-c').value,
        st:      document.getElementById('csr-st').value,
        l:       document.getElementById('csr-l').value,
        san,
        keySize: document.getElementById('csr-keysize').value,
      });
      document.getElementById('csr-output').value = csr;
      document.getElementById('csr-result').classList.remove('hidden');
      showToast('CSR généré — clé privée conservée 24h sur le serveur', 'success');
      loadCertInfo();
    } catch (e) { showToast(e.message, 'error'); }
    finally { btn.disabled = false; btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> Générer la clé et le CSR'; }
  });

  document.getElementById('btn-copy-csr')?.addEventListener('click', () => {
    navigator.clipboard.writeText(document.getElementById('csr-output').value)
      .then(() => showToast('CSR copié', 'success'))
      .catch(() => showToast('Échec de la copie', 'error'));
  });

  document.getElementById('btn-download-csr')?.addEventListener('click', () => {
    const csr = document.getElementById('csr-output').value;
    if (!csr) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csr], { type: 'text/plain' }));
    a.download = 'ipam.csr';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // ── Installer certificat signé ────────────────────────────────────────────
  document.getElementById('btn-install-cert')?.addEventListener('click', async () => {
    const cert = document.getElementById('cert-install-pem').value.trim();
    if (!cert) { showToast('Collez le certificat PEM', 'warn'); return; }
    if (!await showConfirm({
      title: 'Installer le certificat',
      message: 'Le certificat sera installé et Apache rechargé. Continuer ?',
      confirmText: 'Installer',
    })) return;
    const btn = document.getElementById('btn-install-cert');
    btn.disabled = true; btn.textContent = 'Installation…';
    try {
      const { keyInstalled } = await post('/api/config/cert/install', { cert });
      showToast(`Certificat installé${keyInstalled ? ' (+ clé privée)' : ''}. Apache rechargé.`, 'success');
      document.getElementById('cert-install-pem').value = '';
      loadCertInfo();
    } catch (e) { showToast(e.message, 'error'); }
    finally { btn.disabled = false; btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> Installer et recharger Apache'; }
  });

  // ── Certificat auto-signé ─────────────────────────────────────────────────
  document.getElementById('btn-self-signed')?.addEventListener('click', async () => {
    const cn = document.getElementById('ss-cn').value.trim();
    if (!cn) { showToast('Le CN est obligatoire', 'warn'); return; }
    if (!await showConfirm({
      title: 'Certificat auto-signé',
      message: `Remplace le certificat et la clé privée actuels.\nCN : ${cn}\nDurée : ${document.getElementById('ss-days').value} jours\n\nContinuer ?`,
      confirmText: 'Générer et installer',
      danger: true,
    })) return;
    const btn = document.getElementById('btn-self-signed');
    btn.disabled = true; btn.textContent = 'Génération…';
    try {
      const san = (document.getElementById('ss-san').value || '')
        .split('\n').map(s => s.trim()).filter(Boolean);
      await post('/api/config/cert/self-signed', {
        cn,
        o:    document.getElementById('ss-o').value,
        days: document.getElementById('ss-days').value,
        san,
      });
      showToast('Certificat auto-signé installé. Apache rechargé.', 'success');
      loadCertInfo();
    } catch (e) { showToast(e.message, 'error'); }
    finally {
      btn.disabled = false;
      btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> Générer et installer le certificat auto-signé';
    }
  });
}

// =============================================================================
// ONGLET 4 — Bases de données
// =============================================================================
function setupDatabasesTab() {
  document.querySelector('[data-tab="databases"]')?.addEventListener('click', loadDatabases);
  document.getElementById('btn-add-db')?.addEventListener('click', () =>
    document.getElementById('modal-add-db').classList.remove('hidden')
  );
  document.getElementById('btn-confirm-add-db')?.addEventListener('click', addDatabase);

  // Adapter le formulaire selon le type sélectionné
  document.getElementById('db-type')?.addEventListener('change', () => {
    const type = document.getElementById('db-type').value;
    const portEl  = document.getElementById('db-port');
    const idxWrap = document.getElementById('db-field-index');
    const dbWrap  = document.getElementById('db-field-dbname');
    if (type === 'postgres') { portEl.value = '5432'; idxWrap.style.display = 'none'; dbWrap.style.display = ''; }
    else if (type === 'mariadb') { portEl.value = '3306'; idxWrap.style.display = 'none'; dbWrap.style.display = ''; }
    else { portEl.value = '6379'; idxWrap.style.display = ''; dbWrap.style.display = 'none'; }
  });
  // État initial
  document.getElementById('db-field-dbname').style.display = 'none';
}

async function loadDatabases() {
  try {
    const { databases } = await get('/api/config/databases');
    renderDatabases(databases);
  } catch (e) {
    showToast(`Erreur bases de données : ${e.message}`, 'error');
  }
}

function renderDatabases(dbs) {
  const list = document.getElementById('db-list');
  if (!dbs?.length) {
    list.innerHTML = `
      <div style="text-align:center;color:var(--tx-3);padding:48px 0;border:1px dashed var(--brd);border-radius:10px">
        <svg style="margin-bottom:10px;opacity:.4" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
        <div style="font-size:13px">Aucune connexion configurée</div>
        <div style="font-size:12px;margin-top:4px">Cliquez sur « Ajouter » pour configurer une instance Redis supplémentaire.</div>
      </div>
    `;
    return;
  }
  const typeColor = { redis: '#e05d44', postgres: '#336791', mariadb: '#c0765a' };
  const typeLabel = { redis: 'Redis', postgres: 'PostgreSQL', mariadb: 'MariaDB' };
  list.innerHTML = dbs.map(db => {
    const t   = db.type || 'redis';
    const col = typeColor[t] || '#8b949e';
    const sub = t === 'redis'
      ? `${esc(db.host)}:${db.port} / DB ${db.db ?? 0}`
      : `${esc(db.host)}:${db.port}${db.dbname ? ' / ' + esc(db.dbname) : ''}${db.user ? ' — ' + esc(db.user) : ''}`;
    return `
    <div class="db-row">
      <div style="min-width:0;flex:1">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <span style="font-weight:600;font-size:14px">${esc(db.name)}</span>
          <span style="font-size:11px;font-weight:600;padding:1px 7px;border-radius:4px;background:${col}20;color:${col};border:1px solid ${col}40">${typeLabel[t] || t}</span>
        </div>
        <div style="font-size:12px;color:var(--tx-3);font-family:monospace">${sub}</div>
      </div>
      <div style="display:flex;gap:8px;flex-shrink:0">
        <button class="btn btn-g btn-sm" data-dbaction="test" data-id="${esc(db.id)}">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          Tester
        </button>
        <button class="btn btn-g btn-sm" data-dbaction="sync" data-id="${esc(db.id)}">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
          Synchroniser
        </button>
        <button class="btn btn-d btn-sm" data-dbaction="del" data-id="${esc(db.id)}">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
          Supprimer
        </button>
      </div>
    </div>
  `;
  }).join('');

  list.querySelectorAll('[data-dbaction]').forEach(btn => {
    btn.addEventListener('click', () => handleDbAction(btn.dataset.dbaction, btn.dataset.id));
  });
}

async function handleDbAction(action, id) {
  if (action === 'del') {
    if (!await showConfirm({
      title:       'Supprimer la connexion',
      message:     'Confirmer la suppression de cette connexion Redis ?',
      confirmText: 'Supprimer',
      danger:      true,
    })) return;
    try {
      await del(`/api/config/databases/${id}`);
      showToast('Connexion supprimée', 'success');
      await loadDatabases();
    } catch (e) {
      showToast(e.message, 'error');
    }
    return;
  }

  if (action === 'test') {
    try {
      const { latency } = await post(`/api/config/databases/${id}/test`);
      showToast(`Connexion réussie — PING OK${latency != null ? ` (${latency} ms)` : ''}`, 'success');
    } catch (e) {
      showToast(e.message, 'error');
    }
    return;
  }

  if (action === 'sync') {
    if (!await showConfirm({
      title:       'Synchroniser vers cette base',
      message:     'Toutes les clés Redis seront copiées vers cette instance. Les données existantes seront écrasées.',
      confirmText: 'Synchroniser',
      danger:      false,
    })) return;
    try {
      const { count } = await post(`/api/config/databases/${id}/sync`);
      showToast(`${count} clé(s) synchronisée(s)`, 'success');
    } catch (e) {
      showToast(`Erreur de synchronisation : ${e.message}`, 'error');
    }
  }
}

async function addDatabase() {
  const name     = document.getElementById('db-name')?.value.trim();
  const host     = document.getElementById('db-host')?.value.trim();
  const port     = document.getElementById('db-port')?.value;
  const password = document.getElementById('db-password')?.value;
  const type     = document.getElementById('db-type')?.value || 'redis';
  const db       = document.getElementById('db-index')?.value;
  const user     = document.getElementById('db-user')?.value.trim();
  const dbname   = document.getElementById('db-dbname')?.value.trim();

  if (!name) { showToast('Le nom est obligatoire', 'warn'); return; }
  if (!host) { showToast("L'hôte est obligatoire", 'warn'); return; }

  const payload = { name, host, port, password, type };
  if (type === 'redis') {
    payload.db = db;
  } else {
    if (user)   payload.user   = user;
    if (dbname) payload.dbname = dbname;
  }

  try {
    await post('/api/config/databases', payload);
    showToast(`Connexion « ${name} » ajoutée`, 'success');
    document.getElementById('modal-add-db').classList.add('hidden');
    // Réinitialiser le formulaire
    ['db-name', 'db-host', 'db-password', 'db-user', 'db-dbname'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    document.getElementById('db-type').value  = 'redis';
    document.getElementById('db-port').value  = '6379';
    document.getElementById('db-index').value = '0';
    document.getElementById('db-field-dbname').style.display = 'none';
    document.getElementById('db-field-index').style.display  = '';
    await loadDatabases();
  } catch (e) {
    showToast(`Erreur : ${e.message}`, 'error');
  }
}

// =============================================================================
// ONGLET MAINTENANCE
// =============================================================================
let _maintEnabled = false;

function setupMaintenanceTab() {
  document.querySelector('[data-tab="maintenance"]')?.addEventListener('click', loadMaintenanceConfig);
  document.getElementById('btn-save-maint')?.addEventListener('click', saveMaintenanceConfig);
  document.getElementById('btn-toggle-maint')?.addEventListener('click', toggleMaintenance);
  document.getElementById('btn-regen-bypass')?.addEventListener('click', regenBypassKey);
  document.getElementById('btn-clear-end')?.addEventListener('click', () => {
    document.getElementById('maint-planned-end').value = '';
  });
  document.getElementById('btn-copy-bypass')?.addEventListener('click', () => {
    const v = document.getElementById('maint-bypass-key').value;
    if (!v) { showToast('Aucune clé à copier', 'warn'); return; }
    navigator.clipboard.writeText(window.location.origin + '/?bypass=' + v)
      .then(() => showToast('URL de bypass copiée', 'success'))
      .catch(() => showToast('Échec de la copie', 'error'));
  });
  // Mettre à jour l'aperçu URL quand la clé change (via regen)
  document.getElementById('maint-bypass-key')?.addEventListener('input', updateBypassPreview);
}

async function loadMaintenanceConfig() {
  try {
    const m = await get('/api/config/maintenance');
    _maintEnabled = !!m.enabled;
    document.getElementById('maint-message').value      = m.message    || '';
    document.getElementById('maint-bypass-key').value   = m.bypassKey  || '';
    if (m.plannedEnd) {
      // datetime-local attend "YYYY-MM-DDTHH:MM"
      const d = new Date(m.plannedEnd);
      const pad = n => String(n).padStart(2, '0');
      document.getElementById('maint-planned-end').value =
        `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } else {
      document.getElementById('maint-planned-end').value = '';
    }
    updateToggleButton();
    updateBypassPreview();
  } catch (e) {
    showToast(`Erreur maintenance : ${e.message}`, 'error');
  }
}

function updateToggleButton() {
  const btn = document.getElementById('btn-toggle-maint');
  if (!btn) return;
  if (_maintEnabled) {
    btn.className = 'btn btn-maint-on';
    btn.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
      Désactiver la maintenance`;
  } else {
    btn.className = 'btn btn-maint-off';
    btn.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      Activer la maintenance`;
  }
}

function updateBypassPreview() {
  const key = document.getElementById('maint-bypass-key')?.value;
  const el  = document.getElementById('bypass-url-preview');
  if (!el) return;
  el.textContent = key
    ? `${window.location.origin}/?bypass=${key}`
    : '';
}

function regenBypassKey() {
  const key = ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
  document.getElementById('maint-bypass-key').value = key;
  updateBypassPreview();
  showToast('Nouvelle clé générée — pensez à sauvegarder', 'warn');
}

async function toggleMaintenance() {
  const action  = _maintEnabled ? 'disable' : 'enable';
  const willOn  = !_maintEnabled;
  const confirmed = await showConfirm({
    title:       willOn ? 'Activer la maintenance' : 'Désactiver la maintenance',
    message:     willOn
      ? 'Le site sera inaccessible pour tous les utilisateurs (sauf bypass). Continuer ?'
      : 'Le site redeviendra accessible. Continuer ?',
    confirmText: willOn ? 'Activer' : 'Désactiver',
    danger:      willOn,
  });
  if (!confirmed) return;
  try {
    await post(`/api/config/maintenance/${action}`);
    _maintEnabled = willOn;
    updateToggleButton();
    showToast(willOn ? 'Maintenance activée' : 'Maintenance désactivée', willOn ? 'warn' : 'success');
  } catch (e) {
    showToast(`Erreur : ${e.message}`, 'error');
  }
}

async function saveMaintenanceConfig() {
  const message   = document.getElementById('maint-message')?.value.trim();
  const bypassKey = document.getElementById('maint-bypass-key')?.value.trim();
  const endRaw    = document.getElementById('maint-planned-end')?.value;
  const plannedEnd = endRaw ? new Date(endRaw).toISOString() : null;

  try {
    await put('/api/config/maintenance', { message, bypassKey, plannedEnd });
    showToast('Configuration maintenance sauvegardée', 'success');
    updateBypassPreview();
  } catch (e) {
    showToast(`Erreur : ${e.message}`, 'error');
  }
}

// =============================================================================
// ONGLET 6 — APIs externes
// =============================================================================
function setupApisTab() {
  document.querySelector('[data-tab="apis"]')?.addEventListener('click', loadApis);
  document.getElementById('btn-add-api')?.addEventListener('click', () =>
    document.getElementById('modal-add-api').classList.remove('hidden')
  );
  document.getElementById('btn-confirm-add-api')?.addEventListener('click', addApi);
}

async function loadApis() {
  try {
    const { apis } = await get('/api/config/apis');
    renderApis(apis);
  } catch (e) {
    showToast(`Erreur APIs : ${e.message}`, 'error');
  }
}

function renderApis(apis) {
  const list = document.getElementById('api-list');
  if (!list) return;
  if (!apis?.length) {
    list.innerHTML = `
      <div style="text-align:center;color:var(--tx-3);padding:48px 0;border:1px dashed var(--brd);border-radius:10px">
        <svg style="margin-bottom:10px;opacity:.4" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
        <div style="font-size:13px">Aucune API configurée</div>
        <div style="font-size:12px;margin-top:4px">Cliquez sur « Ajouter » pour configurer une API externe.</div>
      </div>
    `;
    return;
  }
  list.innerHTML = apis.map(api => `
    <div class="db-row">
      <div style="min-width:0;flex:1">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <span style="font-weight:600;font-size:14px">${esc(api.name)}</span>
          ${api.hasKey ? '<span style="font-size:11px;padding:1px 7px;border-radius:4px;background:#58a6ff20;color:#58a6ff;border:1px solid #58a6ff40">Clé API</span>' : ''}
        </div>
        <div style="font-size:12px;color:var(--tx-3);font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(api.url)}</div>
        ${api.description ? `<div style="font-size:12px;color:var(--tx-3);margin-top:2px">${esc(api.description)}</div>` : ''}
      </div>
      <div style="display:flex;gap:8px;flex-shrink:0">
        <button class="btn btn-g btn-sm" data-apiaction="test" data-id="${esc(api.id)}">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          Tester
        </button>
        <button class="btn btn-d btn-sm" data-apiaction="del" data-id="${esc(api.id)}">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
          Supprimer
        </button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('[data-apiaction]').forEach(btn => {
    btn.addEventListener('click', () => handleApiAction(btn.dataset.apiaction, btn.dataset.id));
  });
}

async function handleApiAction(action, id) {
  if (action === 'del') {
    if (!await showConfirm({
      title:       'Supprimer l\'API',
      message:     'Confirmer la suppression de cette configuration API ?',
      confirmText: 'Supprimer',
      danger:      true,
    })) return;
    try {
      await del(`/api/config/apis/${id}`);
      showToast('API supprimée', 'success');
      await loadApis();
    } catch (e) {
      showToast(e.message, 'error');
    }
    return;
  }

  if (action === 'test') {
    try {
      const { status, latency } = await post(`/api/config/apis/${id}/test`);
      showToast(`API accessible — HTTP ${status}${latency != null ? ` (${latency} ms)` : ''}`, 'success');
    } catch (e) {
      showToast(`Erreur : ${e.message}`, 'error');
    }
  }
}

async function addApi() {
  const name        = document.getElementById('api-name')?.value.trim();
  const url         = document.getElementById('api-url')?.value.trim();
  const key         = document.getElementById('api-key')?.value;
  const description = document.getElementById('api-description')?.value.trim();

  if (!name) { showToast('Le nom est obligatoire', 'warn'); return; }
  if (!url)  { showToast("L'URL est obligatoire", 'warn'); return; }

  try {
    await post('/api/config/apis', { name, url, key, description });
    showToast(`API « ${name} » ajoutée`, 'success');
    document.getElementById('modal-add-api').classList.add('hidden');
    ['api-name', 'api-url', 'api-key', 'api-description'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    await loadApis();
  } catch (e) {
    showToast(`Erreur : ${e.message}`, 'error');
  }
}

// =============================================================================
// ONGLET 7 — SharePoint
// =============================================================================
function setupSharepointTab() {
  document.querySelector('[data-tab="sharepoint"]')?.addEventListener('click', loadSharepoint);
  document.getElementById('btn-save-sp')?.addEventListener('click', saveSharepoint);
  document.getElementById('btn-test-sp')?.addEventListener('click', testSharepoint);
}

async function loadSharepoint() {
  try {
    const data = await get('/api/config/sharepoint');
    const fields = ['sp-url', 'sp-client-id', 'sp-tenant-id', 'sp-folder'];
    fields.forEach(id => {
      const key = id.replace('sp-', '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const el  = document.getElementById(id);
      if (el) el.value = data[key] || '';
    });
    // Le secret n'est jamais renvoyé (placeholder uniquement)
    const secretEl = document.getElementById('sp-secret');
    if (secretEl) {
      secretEl.placeholder = data.hasSecret ? '(défini — laisser vide pour conserver)' : 'Secret client';
      secretEl.value = '';
    }
  } catch (e) {
    showToast(`Erreur SharePoint : ${e.message}`, 'error');
  }
}

async function saveSharepoint() {
  const fields = {
    url:      document.getElementById('sp-url')?.value.trim(),
    clientId: document.getElementById('sp-client-id')?.value.trim(),
    tenantId: document.getElementById('sp-tenant-id')?.value.trim(),
    folder:   document.getElementById('sp-folder')?.value.trim(),
  };
  const secret = document.getElementById('sp-secret')?.value;
  if (secret) fields.secret = secret;

  if (!fields.url)      { showToast("L'URL SharePoint est obligatoire", 'warn'); return; }
  if (!fields.clientId) { showToast('Le Client ID est obligatoire', 'warn'); return; }
  if (!fields.tenantId) { showToast('Le Tenant ID est obligatoire', 'warn'); return; }

  try {
    await put('/api/config/sharepoint', fields);
    showToast('Configuration SharePoint sauvegardée', 'success');
    await loadSharepoint();
  } catch (e) {
    showToast(`Erreur : ${e.message}`, 'error');
  }
}

async function testSharepoint() {
  const btn = document.getElementById('btn-test-sp');
  if (btn) { btn.disabled = true; btn.textContent = 'Test en cours…'; }
  try {
    const { ok, message } = await post('/api/config/sharepoint/test');
    if (ok) showToast(message || 'Authentification SharePoint réussie', 'success');
    else    showToast(message || 'Échec de l\'authentification', 'error');
  } catch (e) {
    showToast(`Erreur : ${e.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Tester la connexion';
    }
  }
}

// =============================================================================
// Mode utilisateur P/X — accès restreint (onglet Services uniquement via bypass)
// =============================================================================

const SERVICES_ACCESS_KEY = 'ipam_services_access';

function getServicesAccess() {
  try {
    const s = JSON.parse(sessionStorage.getItem(SERVICES_ACCESS_KEY) || 'null');
    if (!s) return null;
    if (s.expires < Date.now()) { sessionStorage.removeItem(SERVICES_ACCESS_KEY); return null; }
    return s;
  } catch { return null; }
}

// =============================================================================
// TERMINAL
// =============================================================================
function setupTerminalTab() {
  const outputEl = document.getElementById('term-output');
  const cmdEl    = document.getElementById('term-cmd');

  // Historique commandes (flèches haut/bas)
  const history = []; let histIdx = -1;
  cmdEl?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); execCmd(); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); if (histIdx < history.length - 1) { histIdx++; cmdEl.value = history[histIdx]; } return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); if (histIdx > 0) { histIdx--; cmdEl.value = history[histIdx]; } else { histIdx = -1; cmdEl.value = ''; } }
  });

  document.getElementById('btn-term-exec')?.addEventListener('click', execCmd);
  document.getElementById('btn-term-clear')?.addEventListener('click', () => { if (outputEl) outputEl.textContent = ''; });

  async function execCmd() {
    const cmd = cmdEl?.value.trim();
    if (!cmd || !outputEl) return;
    history.unshift(cmd); histIdx = -1;
    const btn = document.getElementById('btn-term-exec');
    btn.disabled = true;
    const sep = outputEl.textContent ? '\n' : '';
    outputEl.textContent += `${sep}$ ${cmd}\n`;
    outputEl.scrollTop = outputEl.scrollHeight;
    try {
      const d = await post('/api/config/terminal/exec', { command: cmd });
      if (d.stdout) outputEl.textContent += d.stdout;
      if (d.stderr) outputEl.textContent += d.stderr;
    } catch (e) {
      outputEl.textContent += `[Erreur] ${e.message}\n`;
    } finally {
      btn.disabled = false;
      outputEl.scrollTop = outputEl.scrollHeight;
      cmdEl.value = '';
      cmdEl.focus();
    }
  }

  // ── Upload ──────────────────────────────────────────────────────────────────
  const fileInput = document.getElementById('term-upload-file');
  const uploadBar = document.getElementById('term-upload-bar');

  document.getElementById('btn-term-pick')?.addEventListener('click', () => fileInput?.click());

  fileInput?.addEventListener('change', () => {
    const f = fileInput.files[0];
    if (!f) return;
    document.getElementById('term-pick-name').textContent = f.name;
    const cur = document.getElementById('term-upload-path').value;
    // Ne remplace que si vide ou si c'était un chemin auto-généré précédent
    if (!cur || cur.startsWith('/tmp/')) {
      document.getElementById('term-upload-path').value = `/tmp/${f.name}`;
    } else {
      // Remplace juste le nom de fichier à la fin du chemin existant
      document.getElementById('term-upload-path').value = cur.replace(/\/[^/]*$/, '') + '/' + f.name;
    }
    document.getElementById('term-upload-status').textContent = '';
    uploadBar.style.display = 'flex';
  });

  // Parcourir pour choisir le dossier de destination (disponible avant ou après le choix du fichier)
  document.getElementById('btn-term-upload-browse')?.addEventListener('click', () => {
    openFileBrowserForDir(dir => {
      const f = fileInput?.files[0];
      const filename = f ? f.name : (document.getElementById('term-upload-path').value.split('/').pop() || 'fichier');
      document.getElementById('term-upload-path').value = dir.replace(/\/$/, '') + '/' + filename;
      document.getElementById('term-upload-status').textContent = '';
      if (f) uploadBar.style.display = 'flex';
    });
  });

  document.getElementById('btn-term-upload-cancel')?.addEventListener('click', () => {
    uploadBar.style.display = 'none';
    fileInput.value = '';
    document.getElementById('term-pick-name').textContent = 'Aucun fichier sélectionné';
  });

  document.getElementById('btn-term-upload')?.addEventListener('click', async () => {
    const f    = fileInput?.files[0];
    const dest = document.getElementById('term-upload-path').value.trim();
    const statusEl = document.getElementById('term-upload-status');
    if (!f || !dest) return;
    const btn = document.getElementById('btn-term-upload');
    btn.disabled = true; btn.textContent = '…';
    try {
      const b64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(f);
      });
      const data = await post('/api/config/terminal/upload', { file_path: dest, content_b64: b64 });
      statusEl.style.color = '#3fb950';
      statusEl.textContent = `✓ ${data.size} o`;
      showToast(`Fichier uploadé → ${dest}`, 'success');
      setTimeout(() => { uploadBar.style.display = 'none'; fileInput.value = ''; }, 1500);
    } catch (e) {
      statusEl.style.color = '#f85149';
      statusEl.textContent = `Erreur`;
      showToast(e.message, 'error');
    } finally { btn.disabled = false; btn.textContent = 'Envoyer'; }
  });

  // ── Explorateur / Téléchargement ────────────────────────────────────────────
  document.getElementById('btn-term-browse')?.addEventListener('click', () => openFileBrowser());

  async function downloadFile(p) {
    try {
      const res = await fetch(`/api/config/terminal/download?path=${encodeURIComponent(p)}`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `Erreur ${res.status}`); }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = p.split('/').pop() || 'fichier';
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { showToast(e.message, 'error'); }
  }

  // Explorateur générique — mode 'download' (sélectionner un fichier) ou 'dir' (sélectionner un dossier)
  function _openFileBrowser({ mode = 'download', startPath = '/', onSelect = null } = {}) {
    const modal      = document.getElementById('modal-filebrowser');
    const listEl     = document.getElementById('fb-list');
    const pathInput  = document.getElementById('fb-path-input');
    const selectedEl = document.getElementById('fb-selected-path');
    const dlBtn      = document.getElementById('fb-btn-download');
    const upBtn      = document.getElementById('fb-btn-up');
    const goBtn      = document.getElementById('fb-btn-go');

    let currentPath = startPath;

    // Réinitialiser l'état du modal (évite pollution entre ouvertures)
    selectedEl.value = mode === 'dir' ? startPath : '';
    dlBtn.disabled   = mode === 'dir' ? false : true;
    dlBtn.innerHTML  = mode === 'dir'
      ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg> Choisir ce dossier'
      : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Télécharger';

    // Remplacer les handlers par onclick (pas d'accumulation de listeners)
    goBtn.onclick  = () => { const p = pathInput.value.trim(); if (p) browse(p); };
    pathInput.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); const p = pathInput.value.trim(); if (p) browse(p); } };
    upBtn.onclick  = () => { const parent = currentPath.replace(/\/?[^/]+\/?$/, '') || '/'; if (parent !== currentPath) browse(parent); };
    dlBtn.onclick  = async () => {
      if (mode === 'dir') {
        modal.classList.add('hidden');
        onSelect?.(currentPath);
      } else {
        const p = selectedEl.value;
        if (!p) return;
        modal.classList.add('hidden');
        await downloadFile(p);
      }
    };

    modal.classList.remove('hidden');
    browse(startPath);

    async function browse(p) {
      currentPath = p;
      pathInput.value = p;
      if (mode === 'dir') { selectedEl.value = p; dlBtn.disabled = false; }
      listEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--tx-3);font-size:13px">Chargement…</div>';
      try {
        const data = await get(`/api/config/terminal/ls?path=${encodeURIComponent(p)}`);
        const items = mode === 'dir' ? data.items.filter(i => i.type === 'dir') : data.items;
        if (!items.length) {
          listEl.innerHTML = `<div style="padding:20px;text-align:center;color:var(--tx-3);font-size:13px;font-style:italic">${mode === 'dir' ? 'Aucun sous-dossier' : 'Répertoire vide'}</div>`;
          return;
        }
        listEl.innerHTML = items.map(item => {
          const isDir = item.type === 'dir';
          const icon = isDir
            ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#58a6ff" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`
            : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--tx-3)" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>`;
          const sizeStr = item.size != null ? `<span style="font-size:11px;color:var(--tx-4)">${fmtSize(item.size)}</span>` : '';
          return `<div class="fb-entry" data-name="${esc2(item.name)}" data-type="${item.type}"
            style="display:flex;align-items:center;gap:10px;padding:8px 14px;cursor:pointer;border-bottom:1px solid var(--brd);font-size:13px;transition:background .1s"
            onmouseenter="this.style.background='var(--bg-3)'" onmouseleave="this.style.background=''">
            ${icon}
            <span style="flex:1;color:${isDir ? 'var(--tx-1)' : 'var(--tx-2)'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc2(item.name)}</span>
            ${sizeStr}
            ${mode === 'download' && !isDir ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#3fb950" stroke-width="2" style="flex-shrink:0"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>` : ''}
          </div>`;
        }).join('');
        listEl.querySelectorAll('.fb-entry').forEach(el => {
          el.addEventListener('click', () => {
            const full = currentPath.replace(/\/+$/, '') + '/' + el.dataset.name;
            if (el.dataset.type === 'dir') { browse(full); }
            else if (mode === 'download') {
              selectedEl.value = full; dlBtn.disabled = false;
              listEl.querySelectorAll('.fb-entry').forEach(e => e.style.background = '');
              el.style.background = '#58a6ff18';
            }
          });
        });
      } catch (e) { listEl.innerHTML = `<div style="padding:20px;text-align:center;color:#f85149;font-size:13px">${e.message}</div>`; }
    }
  }

  function openFileBrowser(startPath = '/') {
    _openFileBrowser({ mode: 'download', startPath });
  }

  function openFileBrowserForDir(onSelect) {
    _openFileBrowser({ mode: 'dir', startPath: '/', onSelect });
  }

  function fmtSize(b) { return b < 1024 ? `${b} o` : b < 1048576 ? `${(b/1024).toFixed(1)} Ko` : `${(b/1048576).toFixed(1)} Mo`; }
  function esc2(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
}

// =============================================================================
// CONFIG APACHE
// =============================================================================
function setupApacheConfigTab() {
  document.querySelector('[data-tab="apache"]')?.addEventListener('click', () => {
    loadApacheConfig();
    loadApacheConfs();
    loadApacheServerIps();
    loadVhostIp();
  });
  document.getElementById('btn-apache-refresh')?.addEventListener('click', loadApacheConfig);
  document.getElementById('btn-apache-save')?.addEventListener('click', saveApacheConfig);
  document.getElementById('btn-apache-test')?.addEventListener('click', testApacheConfig);
  document.getElementById('btn-apache-reload')?.addEventListener('click', reloadApache);
  document.getElementById('btn-apache-confs-refresh')?.addEventListener('click', loadApacheConfs);
  document.getElementById('btn-apache-ips-refresh')?.addEventListener('click', loadApacheServerIps);
  document.getElementById('btn-vhost-ip-save')?.addEventListener('click', saveVhostIp);
}

async function loadVhostIp() {
  const cur = document.getElementById('vhost-ip-current');
  const inp = document.getElementById('vhost-ip-input');
  if (!cur) return;
  cur.textContent = '…';
  try {
    const d = await get('/api/config/apache/vhost-ip');
    cur.textContent = d.ip || '(non défini)';
    if (inp) inp.placeholder = d.ip || 'ex : 192.168.1.50';
  } catch (e) {
    cur.textContent = '—';
  }
}

async function saveVhostIp() {
  const inp = document.getElementById('vhost-ip-input');
  const status = document.getElementById('vhost-ip-status');
  const btn = document.getElementById('btn-vhost-ip-save');
  const ip = inp?.value.trim();
  if (!ip) { showToast('Saisir une IP ou un domaine', 'warn'); return; }
  btn.disabled = true; btn.textContent = 'Enregistrement…';
  status.textContent = '';
  try {
    const d = await post('/api/config/apache/vhost-ip', { ip });
    document.getElementById('vhost-ip-current').textContent = d.ip;
    inp.value = '';
    status.style.color = '#3fb950';
    status.textContent = `ServerName mis à jour → ${esc(d.ip)}. Rechargez Apache pour appliquer.`;
    showToast(`ServerName → ${d.ip}`, 'success');
  } catch (e) {
    status.style.color = '#f85149';
    status.textContent = e.message;
    showToast(e.message, 'error');
  }
  btn.disabled = false; btn.textContent = 'Appliquer';
}

async function loadApacheServerIps() {
  const el = document.getElementById('apache-ips-list');
  if (!el) return;
  try {
    const d = await get('/api/config/apache/server-ips');
    if (!d.ips.length) { el.innerHTML = '<span style="color:var(--tx-3);font-style:italic">Aucune IP trouvée</span>'; return; }
    el.innerHTML = d.ips.map(ip => `
      <div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--brd)">
        <span style="font-size:10px;padding:2px 6px;border-radius:4px;background:${ip.internal ? 'var(--bg-3)' : '#58a6ff22'};color:${ip.internal ? 'var(--tx-3)' : '#58a6ff'};flex-shrink:0">${ip.internal ? 'lo' : ip.family}</span>
        <code style="font-family:'JetBrains Mono','Courier New',monospace;font-size:12px;color:${ip.internal ? 'var(--tx-3)' : 'var(--tx-1)'};flex:1">${esc(ip.cidr)}</code>
        <span style="font-size:11px;color:var(--tx-3)">${esc(ip.iface)}</span>
      </div>
    `).join('');
  } catch (e) {
    el.innerHTML = `<span style="color:#f85149">${esc(e.message)}</span>`;
  }
}

async function loadApacheConfs() {
  const el = document.getElementById('apache-confs-list');
  if (!el) return;
  el.innerHTML = '<span style="color:var(--tx-3);font-style:italic">Chargement…</span>';
  try {
    const d = await get('/api/config/apache/confs');
    if (!d.files.length) { el.innerHTML = '<span style="color:var(--tx-3);font-style:italic">Aucun fichier trouvé dans ' + esc(d.conf_dir) + '</span>'; return; }
    el.innerHTML = d.files.map(f => `
      <div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--brd)">
        <span style="width:8px;height:8px;border-radius:50%;background:${f.enabled ? '#3fb950' : '#8b949e'};flex-shrink:0"></span>
        <code style="font-family:'JetBrains Mono','Courier New',monospace;font-size:12px;color:${f.enabled ? 'var(--tx-1)' : 'var(--tx-3)'};flex:1;text-decoration:${f.enabled ? 'none' : 'line-through'}">${esc(f.name)}</code>
        <button class="btn btn-sm ${f.enabled ? 'btn-warn' : 'btn-g'}" data-conf-toggle="${esc(f.name)}" style="font-size:11px;min-width:80px">
          ${f.enabled ? 'Désactiver' : 'Activer'}
        </button>
      </div>
    `).join('');
    el.querySelectorAll('[data-conf-toggle]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const filename = btn.dataset.confToggle;
        const enabling = btn.textContent.trim() === 'Activer';
        if (!await showConfirm({
          title: enabling ? 'Activer le fichier' : 'Désactiver le fichier',
          message: `${enabling ? 'Activer' : 'Désactiver'} "${filename}" dans conf.d ?\nPensez à recharger Apache ensuite.`,
          confirmText: enabling ? 'Activer' : 'Désactiver',
          danger: !enabling,
        })) return;
        btn.disabled = true; btn.textContent = '…';
        try {
          await post('/api/config/apache/confs/toggle', { filename });
          showToast(`${filename} ${enabling ? 'activé' : 'désactivé'}`, 'success');
          loadApacheConfs();
        } catch (e) { showToast(e.message, 'error'); btn.disabled = false; }
      });
    });
  } catch (e) {
    el.innerHTML = `<span style="color:#f85149">${esc(e.message)}</span>`;
  }
}

async function loadApacheConfig() {
  const status = document.getElementById('apache-save-status');
  if (status) { status.textContent = 'Chargement…'; status.style.color = 'var(--tx-3)'; }
  try {
    const d = await get('/api/config/apache');
    document.getElementById('apache-conf-path').textContent = d.conf_path || '';
    document.getElementById('ap-server-name').value       = d.server_name       || '';
    document.getElementById('ap-server-admin').value      = d.server_admin      || '';
    document.getElementById('ap-listen').value            = d.listen             || '';
    document.getElementById('ap-document-root').value     = d.document_root     || '';
    document.getElementById('ap-error-log').value         = d.error_log         || '';
    document.getElementById('ap-custom-log').value        = d.custom_log        || '';
    document.getElementById('ap-timeout').value           = d.timeout           || '';
    document.getElementById('ap-keep-alive').value        = d.keep_alive        || '';
    document.getElementById('ap-keep-alive-timeout').value = d.keep_alive_timeout || '';
    document.getElementById('ap-max-req-workers').value   = d.max_req_workers   || '';
    document.getElementById('ap-directory-index').value   = d.directory_index   || '';
    if (status) { status.textContent = `Apache : ${d.status}`; status.style.color = d.status === 'active' ? '#3fb950' : '#f85149'; }
  } catch (e) {
    if (status) { status.textContent = `Erreur : ${e.message}`; status.style.color = '#f85149'; }
    showToast(e.message, 'error');
  }
}

async function saveApacheConfig() {
  const btn    = document.getElementById('btn-apache-save');
  const status = document.getElementById('apache-save-status');
  btn.disabled = true; btn.textContent = 'Enregistrement…';
  try {
    await post('/api/config/apache', {
      server_name:         document.getElementById('ap-server-name').value,
      server_admin:        document.getElementById('ap-server-admin').value,
      listen:              document.getElementById('ap-listen').value,
      document_root:       document.getElementById('ap-document-root').value,
      error_log:           document.getElementById('ap-error-log').value,
      timeout:             document.getElementById('ap-timeout').value,
      keep_alive:          document.getElementById('ap-keep-alive').value,
      keep_alive_timeout:  document.getElementById('ap-keep-alive-timeout').value,
      max_req_workers:     document.getElementById('ap-max-req-workers').value,
      directory_index:     document.getElementById('ap-directory-index').value,
    });
    showToast('Configuration Apache enregistrée (backup .ipam.bak créé)', 'success');
    if (status) { status.textContent = 'Enregistré'; status.style.color = '#3fb950'; }
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Enregistrer`;
  }
}

async function testApacheConfig() {
  const btn = document.getElementById('btn-apache-test');
  const out = document.getElementById('apache-test-output');
  btn.disabled = true; btn.textContent = '…';
  try {
    const d = await post('/api/config/apache/test', {});
    out.textContent = d.output || '(pas de sortie)';
    out.classList.remove('hidden');
    out.style.borderColor = d.ok ? '#3fb95055' : '#f8514955';
    out.style.color = d.ok ? '#3fb950' : '#f85149';
    showToast(d.ok ? 'Syntaxe OK' : 'Erreur de syntaxe', d.ok ? 'success' : 'error');
  } catch (e) { showToast(e.message, 'error'); }
  finally { btn.disabled = false; btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> Tester la config`; }
}

async function reloadApache() {
  if (!await showConfirm({ title: 'Recharger Apache', message: 'Recharger la configuration Apache ? Le service sera brièvement indisponible.', confirmText: 'Recharger', danger: false })) return;
  const btn = document.getElementById('btn-apache-reload');
  btn.disabled = true; btn.textContent = '…';
  try {
    const d = await post('/api/config/apache/reload', {});
    showToast('Apache rechargé', 'success');
    if (d.output) {
      const out = document.getElementById('apache-test-output');
      out.textContent = d.output;
      out.classList.remove('hidden');
      out.style.color = 'var(--tx-2)';
      out.style.borderColor = 'var(--brd)';
    }
  } catch (e) { showToast(e.message, 'error'); }
  finally { btn.disabled = false; btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-.18-6.5"/></svg> Recharger Apache`; }
}

function setupUserPXConfig(user) {
  document.getElementById('btn-logout')?.addEventListener('click', async () => {
    if (await showConfirm({ title: 'Déconnexion', message: 'Voulez-vous vous déconnecter ?', confirmText: 'Se déconnecter', danger: true })) logout();
  });

  loadConfigSidebar();

  // Griser tous les onglets sauf Informations, Services et Certificat SSL
  const LOCKED_TABS = new Set(['redis-config', 'backup', 'maintenance', 'databases', 'apis', 'sharepoint', 'terminal', 'apache']);
  document.querySelectorAll('.admin-tab').forEach(tab => {
    if (LOCKED_TABS.has(tab.dataset.tab)) {
      tab.disabled = true;
      tab.style.cssText += ';opacity:.3;cursor:not-allowed;pointer-events:none';
    }
  });

  // Cacher tous les panes
  document.querySelectorAll('.admin-pane').forEach(p => p.classList.add('hidden'));

  // Onglet Informations — accessible directement
  const sysinfoTab = document.querySelector('.admin-tab[data-tab="sysinfo"]');
  sysinfoTab?.addEventListener('click', () => {
    document.querySelectorAll('.admin-tab').forEach(t => setTabActive(t, false));
    setTabActive(sysinfoTab, true);
    document.querySelectorAll('.admin-pane').forEach(p => p.classList.add('hidden'));
    document.getElementById('pane-sysinfo')?.classList.remove('hidden');
    loadSysInfoForUser();
  });

  // Onglet Certificat SSL — visible en lecture, installer requiert clé bypass
  let _certTabSetup = false;
  const certTab = document.querySelector('.admin-tab[data-tab="cert"]');
  certTab?.addEventListener('click', () => {
    document.querySelectorAll('.admin-tab').forEach(t => setTabActive(t, false));
    setTabActive(certTab, true);
    document.querySelectorAll('.admin-pane').forEach(p => p.classList.add('hidden'));
    document.getElementById('pane-cert')?.classList.remove('hidden');
    if (!_certTabSetup) { _certTabSetup = true; setupCertTabForUser(); }
    else loadCertInfoForUser();
  });

  // Onglet Services — clé bypass requise
  const servicesTab = document.querySelector('.admin-tab[data-tab="services"]');
  servicesTab?.addEventListener('click', () => {
    document.querySelectorAll('.admin-tab').forEach(t => setTabActive(t, false));
    setTabActive(servicesTab, true);
    if (getServicesAccess()) showServicesPane();
    else openServicesKeyModal();
  });

  // Afficher Informations par défaut
  if (sysinfoTab) setTabActive(sysinfoTab, true);
  document.getElementById('pane-sysinfo')?.classList.remove('hidden');
  loadSysInfoForUser();
}

function renderServicesLocked() {
  const pane = document.getElementById('pane-services');
  if (!pane) return;
  document.querySelectorAll('.admin-pane').forEach(p => p.classList.add('hidden'));
  let ph = document.getElementById('services-locked-ph');
  if (!ph) {
    ph = document.createElement('div');
    ph.id = 'services-locked-ph';
    pane.parentNode.insertBefore(ph, pane);
  }
  ph.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px 32px;text-align:center';
  ph.innerHTML = `
    <div style="width:56px;height:56px;background:#58a6ff18;border:1px solid #58a6ff40;border-radius:14px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:18px">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#58a6ff" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
    </div>
    <div style="font-size:16px;font-weight:700;color:var(--tx-1);margin-bottom:8px">Accès restreint</div>
    <div style="font-size:13px;color:var(--tx-3);margin-bottom:24px;max-width:340px">L'accès aux Services requiert une clé de bypass à usage unique valable 15 minutes.</div>
    <button id="btn-open-services-key" class="btn" style="background:#58a6ff;color:#0d1117;font-weight:600;padding:10px 22px">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      Saisir la clé de bypass
    </button>`;
  document.getElementById('btn-open-services-key')?.addEventListener('click', openServicesKeyModal);
}

function showServicesPane() {
  document.getElementById('services-locked-ph')?.remove();
  const pane = document.getElementById('pane-services');
  if (!pane) return;
  document.querySelectorAll('.admin-pane').forEach(p => p.classList.add('hidden'));
  pane.classList.remove('hidden');
  const access = getServicesAccess();
  if (access) {
    const mins = Math.max(1, Math.round((access.expires - Date.now()) / 60000));
    let banner = document.getElementById('services-access-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'services-access-banner';
      banner.style.cssText = 'background:#0d2240;border:1px solid #1f4080;color:#58a6ff;border-radius:8px;padding:8px 14px;font-size:12px;margin-bottom:14px;display:flex;align-items:center;gap:8px';
      pane.insertBefore(banner, pane.firstChild);
    }
    banner.textContent = `⏱ Accès Services actif — expire dans ${mins} min`;
  }
  if (access?.token) {
    loadServicesForUser(access.token).catch(err => showToast(err.message, 'error'));
    setInterval(() => loadServicesForUser(access.token).catch(() => {}), 10_000);
  }
}

async function loadServicesForUser(token) {
  _bypassServicesToken = token;
  const grid = document.getElementById('services-grid');
  if (grid) grid.innerHTML = '<p style="color:var(--tx-3);font-size:13px">Chargement…</p>';

  const resp = await fetch('/api/bypass/services/status', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || 'Erreur chargement services');
  }
  const { services } = await resp.json();
  renderServiceCards(services, false);
}

async function loadSysInfoForUser() {
  try {
    const { info } = await fetch('/api/bypass/system/info', {
      headers: { Authorization: `Bearer ${getToken()}` },
    }).then(async r => {
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || 'Erreur'); }
      return r.json();
    });
    renderSysInfo(info);
  } catch (e) {
    const grid = document.getElementById('sysinfo-grid');
    if (grid) grid.innerHTML = `<div style="color:var(--tx-3);font-size:13px">Erreur : ${esc(e.message)}</div>`;
  }
}

// =============================================================================
// Mode utilisateur P/X — onglet Certificat SSL
// =============================================================================

const CERT_ACCESS_KEY = 'ipam_cert_access';

function getCertAccess() {
  try {
    const s = JSON.parse(sessionStorage.getItem(CERT_ACCESS_KEY) || 'null');
    if (!s) return null;
    if (s.expires < Date.now()) { sessionStorage.removeItem(CERT_ACCESS_KEY); return null; }
    return s;
  } catch { return null; }
}

async function loadCertInfoForUser() {
  const block = document.getElementById('cert-info-block');
  if (!block) return;
  try {
    const resp = await fetch('/api/bypass/cert/info', {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.error || 'Erreur'); }
    const { info } = await resp.json();
    if (!info) {
      block.innerHTML = '<div style="color:var(--tx-3);font-size:13px">Aucun certificat trouvé.</div>';
      return;
    }
    const dl = info.daysLeft;
    const badgeColor = dl == null ? '#8b949e' : dl < 0 ? '#f85149' : dl < 30 ? '#d29922' : '#3fb950';
    const badgeText  = dl == null ? 'Inconnu' : dl < 0 ? `Expiré depuis ${Math.abs(dl)}j` : dl < 30 ? `Expire dans ${dl}j` : `Valide — ${dl} jours restants`;
    const row = (label, value) => value ? `
      <div style="display:flex;justify-content:space-between;align-items:baseline;padding:7px 0;border-bottom:1px solid var(--brd)">
        <span style="font-size:12px;color:var(--tx-3);flex-shrink:0;padding-right:16px">${label}</span>
        <span style="font-size:12px;color:var(--tx-1);font-weight:500;text-align:right;word-break:break-all;font-family:'JetBrains Mono','Courier New',monospace">${esc(value)}</span>
      </div>` : '';
    block.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap">
        <span style="background:${badgeColor}20;color:${badgeColor};border:1px solid ${badgeColor}50;border-radius:999px;padding:4px 12px;font-size:12px;font-weight:600">${badgeText}</span>
        ${info.hasPending ? '<span style="background:#58a6ff20;color:#58a6ff;border:1px solid #58a6ff50;border-radius:999px;padding:4px 12px;font-size:12px">CSR en attente d\'installation</span>' : ''}
      </div>
      ${row('Sujet',       info.subject)}
      ${row('Émetteur',    info.issuer)}
      ${row('Valide du',   info.notBefore)}
      ${row('Expire le',   info.notAfter)}
      ${row('SAN',         info.san)}
      ${row('Numéro de série', info.serial)}
      ${row('Empreinte SHA256', info.fingerprint)}
    `;
  } catch (e) {
    if (block) block.innerHTML = `<div style="color:#f85149;font-size:13px">${esc(e.message)}</div>`;
  }
}

function setupCertTabForUser() {
  loadCertInfoForUser();
  document.getElementById('btn-refresh-cert')?.addEventListener('click', loadCertInfoForUser);

  // Désactiver le bouton auto-signé (non autorisé)
  const btnSelfSigned = document.getElementById('btn-self-signed');
  if (btnSelfSigned) {
    btnSelfSigned.disabled = true;
    btnSelfSigned.style.cssText += ';opacity:.3;cursor:not-allowed;pointer-events:none';
    btnSelfSigned.title = 'Non autorisé pour les utilisateurs P/X';
  }

  // Installer certificat — requiert clé bypass cert
  const btnInstall = document.getElementById('btn-install-cert');
  if (btnInstall) {
    // Cloner pour supprimer les listeners existants éventuels
    const clone = btnInstall.cloneNode(true);
    btnInstall.parentNode.replaceChild(clone, btnInstall);
    clone.addEventListener('click', async () => {
      const access = getCertAccess();
      if (!access) { openCertKeyModal(); return; }
      const cert = document.getElementById('cert-install-pem')?.value.trim();
      if (!cert) { showToast('Collez le certificat PEM', 'warn'); return; }
      if (!await showConfirm({
        title: 'Installer le certificat',
        message: 'Le certificat sera installé et Apache rechargé. Continuer ?',
        confirmText: 'Installer',
      })) return;
      clone.disabled = true; clone.textContent = 'Installation…';
      try {
        const resp = await fetch('/api/bypass/cert/install', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access.token}` },
          body: JSON.stringify({ cert }),
        });
        if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.error || 'Erreur'); }
        const { keyInstalled } = await resp.json();
        showToast(`Certificat installé${keyInstalled ? ' (+ clé privée)' : ''}. Apache rechargé.`, 'success');
        document.getElementById('cert-install-pem').value = '';
        loadCertInfoForUser();
      } catch (e) { showToast(e.message, 'error'); }
      finally {
        clone.disabled = false;
        clone.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> Installer et recharger Apache';
      }
    });
  }
}

function openCertKeyModal() {
  let modal = document.getElementById('modal-cert-key');
  if (!modal) { modal = document.createElement('div'); modal.id = 'modal-cert-key'; document.body.appendChild(modal); }
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center';
  modal.innerHTML = `
    <div style="background:var(--bg-2);border:1px solid var(--brd);border-radius:14px;padding:28px 32px;width:100%;max-width:400px;box-shadow:0 20px 60px rgba(0,0,0,.5)">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
        <div style="width:34px;height:34px;background:#3fb950;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        </div>
        <h3 style="font-size:15px;font-weight:700;margin:0;color:var(--tx-1)">Accès Certificat SSL</h3>
      </div>
      <p style="color:var(--tx-3);font-size:13px;margin:0 0 18px">Clé à usage unique — valable 15 minutes après validation.</p>
      <div style="margin-bottom:14px">
        <input id="cert-key-input" class="inp" type="text" placeholder="XXXX-XXXX-XXXX" autocomplete="off"
          style="font-family:'JetBrains Mono','Courier New',monospace;font-size:16px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;text-align:center">
      </div>
      <div id="cert-key-error" style="display:none;background:#f8514918;border:1px solid #f8514940;border-radius:7px;padding:8px 12px;font-size:12px;color:#f85149;margin-bottom:14px"></div>
      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button id="btn-cert-cancel" class="btn" style="background:var(--bg-4);border:1px solid var(--brd);color:var(--tx-2)">Annuler</button>
        <button id="btn-cert-confirm" class="btn" style="background:#3fb950;color:#0d1117;font-weight:600">Valider</button>
      </div>
    </div>`;
  const keyInput = modal.querySelector('#cert-key-input');
  const errBox   = modal.querySelector('#cert-key-error');
  const btnOk    = modal.querySelector('#btn-cert-confirm');
  keyInput.addEventListener('input', () => { keyInput.value = keyInput.value.toUpperCase(); });
  keyInput.addEventListener('keydown', e => { if (e.key === 'Enter') btnOk.click(); });
  modal.querySelector('#btn-cert-cancel').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  setTimeout(() => keyInput.focus(), 50);
  btnOk.addEventListener('click', async () => {
    const key = keyInput.value.trim();
    if (!key) { errBox.textContent = 'Saisissez la clé de bypass.'; errBox.style.display = 'block'; return; }
    errBox.style.display = 'none';
    btnOk.disabled = true; btnOk.textContent = 'Vérification…';
    try {
      const resp = await fetch('/api/bypass/cert-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ key }),
      });
      if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.error || 'Erreur'); }
      const data = await resp.json();
      sessionStorage.setItem(CERT_ACCESS_KEY, JSON.stringify({ token: data.token, expires: new Date(data.expires_at).getTime() }));
      modal.remove();
      // Déclencher l'installation maintenant que la clé est validée
      document.getElementById('btn-install-cert')?.click();
    } catch (e) {
      errBox.textContent = e.message;
      errBox.style.display = 'block';
      keyInput.select();
      btnOk.disabled = false; btnOk.textContent = 'Valider';
    }
  });
}

function openServicesKeyModal() {
  let modal = document.getElementById('modal-services-key');
  if (!modal) { modal = document.createElement('div'); modal.id = 'modal-services-key'; document.body.appendChild(modal); }
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center';
  modal.innerHTML = `
    <div style="background:var(--bg-2);border:1px solid var(--brd);border-radius:14px;padding:28px 32px;width:100%;max-width:400px;box-shadow:0 20px 60px rgba(0,0,0,.5)">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
        <div style="width:34px;height:34px;background:#58a6ff;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        </div>
        <h3 style="font-size:15px;font-weight:700;margin:0;color:var(--tx-1)">Accès Services</h3>
      </div>
      <p style="color:var(--tx-3);font-size:13px;margin:0 0 18px">Clé à usage unique — valable 15 minutes après validation.</p>
      <div style="margin-bottom:14px">
        <input id="services-key-input" class="inp" type="text" placeholder="XXXX-XXXX-XXXX" autocomplete="off"
          style="font-family:'JetBrains Mono','Courier New',monospace;font-size:16px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;text-align:center">
      </div>
      <div id="services-key-error" style="display:none;background:#f8514918;border:1px solid #f8514940;border-radius:7px;padding:8px 12px;font-size:12px;color:#f85149;margin-bottom:14px"></div>
      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button id="btn-svc-cancel" class="btn" style="background:var(--bg-4);border:1px solid var(--brd);color:var(--tx-2)">Annuler</button>
        <button id="btn-svc-confirm" class="btn" style="background:#58a6ff;color:#0d1117;font-weight:600">Valider</button>
      </div>
    </div>`;
  const keyInput = modal.querySelector('#services-key-input');
  const errBox   = modal.querySelector('#services-key-error');
  const btnOk    = modal.querySelector('#btn-svc-confirm');
  keyInput.addEventListener('input', () => { keyInput.value = keyInput.value.toUpperCase(); });
  keyInput.addEventListener('keydown', e => { if (e.key === 'Enter') btnOk.click(); });
  modal.querySelector('#btn-svc-cancel').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  setTimeout(() => keyInput.focus(), 50);
  btnOk.addEventListener('click', async () => {
    const key = keyInput.value.trim();
    if (!key) { errBox.textContent = 'Saisissez la clé de bypass.'; errBox.style.display = 'block'; return; }
    errBox.style.display = 'none';
    btnOk.disabled = true; btnOk.textContent = 'Vérification…';
    try {
      const data = await post('/api/bypass/services-access', { key });
      sessionStorage.setItem(SERVICES_ACCESS_KEY, JSON.stringify({ token: data.token, expires: new Date(data.expires_at).getTime() }));
      modal.remove();
      showServicesPane();
    } catch (e) {
      errBox.textContent = e.message;
      errBox.style.display = 'block';
      keyInput.select();
      btnOk.disabled = false; btnOk.textContent = 'Valider';
    }
  });
}
