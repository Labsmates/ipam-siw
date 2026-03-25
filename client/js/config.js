// =============================================================================
// IPAM SIW — config.js  (Configuration système — super admin uniquement)
// =============================================================================

import {
  requireAuth, startInactivityTimer, checkHttps, getUser, getToken, logout,
  get, post, put, del,
  showToast, fmtDate, openModal, closeModal, showConfirm, initTheme, sortSites,
} from './api.js';

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  checkHttps();
  initTheme();
  if (!requireAuth()) return;
  startInactivityTimer();

  const user = getUser();

  // Guard : admins uniquement
  if (user?.role !== 'admin') {
    window.location.replace('/admin.html');
    return;
  }

  document.getElementById('nav-username').textContent = user.username;

  document.getElementById('btn-logout').addEventListener('click', async () => {
    if (await showConfirm({
      title: 'Déconnexion',
      message: 'Voulez-vous vous déconnecter ?',
      confirmText: 'Se déconnecter',
      danger: true,
    })) logout();
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

  // Rafraîchissement auto des services toutes les 10 secondes
  setInterval(loadServices, 10_000);

  // Boutons rafraîchir
  document.getElementById('btn-refresh-services')?.addEventListener('click', loadServices);
  document.getElementById('btn-refresh-sysinfo')?.addEventListener('click', loadSysInfo);
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
    card('Réseau', iconNet,
      info.ips?.length
        ? info.ips.map(ip => [
            `${ip.iface} (${ip.family})`, ip.address, ip.family === 'IPv4' ? '#58a6ff' : 'var(--tx-2)',
          ])
        : [['Interfaces', '—']]
    ),
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

function renderServiceCards(services) {
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
      <div id="logs-${name}" class="log-panel hidden"></div>
    `;
    grid.appendChild(card);
  }

  grid.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => handleServiceAction(btn.dataset.action, btn.dataset.svc));
  });
}

async function handleServiceAction(action, svc) {
  if (action === 'logs') {
    const logEl = document.getElementById(`logs-${svc}`);
    if (!logEl.classList.contains('hidden')) {
      logEl.classList.add('hidden');
      return;
    }
    logEl.classList.remove('hidden');
    logEl.textContent = 'Chargement des logs…';
    try {
      const { logs } = await get(`/api/config/services/${svc}/logs`);
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
    await post(`/api/config/services/${svc}/${action}`);
    const msgs = { start: `Service « ${svc} » démarré`, restart: `Service « ${svc} » redémarré`, stop: `Service « ${svc} » arrêté`, reload: 'Apache rechargé' };
    showToast(msgs[action] || 'OK', 'success');
    // Re-vérifier le statut après 2s (3s pour stop/restart car le service met du temps)
    setTimeout(loadServices, action === 'start' ? 1500 : 3000);
  } catch (e) {
    showToast(`Erreur : ${e.message}`, 'error');
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
  list.innerHTML = dbs.map(db => `
    <div class="db-row">
      <div style="min-width:0;flex:1">
        <div style="font-weight:600;font-size:14px;margin-bottom:4px">${esc(db.name)}</div>
        <div style="font-size:12px;color:var(--tx-3);font-family:monospace">${esc(db.host)}:${db.port} / DB ${db.db}</div>
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
  `).join('');

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
  const db       = document.getElementById('db-index')?.value;

  if (!name) { showToast('Le nom est obligatoire', 'warn'); return; }
  if (!host) { showToast("L'hôte est obligatoire", 'warn'); return; }

  try {
    await post('/api/config/databases', { name, host, port, password, db });
    showToast(`Connexion « ${name} » ajoutée`, 'success');
    document.getElementById('modal-add-db').classList.add('hidden');
    // Réinitialiser le formulaire
    ['db-name', 'db-host', 'db-password'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    document.getElementById('db-port').value  = '6379';
    document.getElementById('db-index').value = '0';
    await loadDatabases();
  } catch (e) {
    showToast(`Erreur : ${e.message}`, 'error');
  }
}
