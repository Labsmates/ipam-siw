// =============================================================================
// IPAM SIW — ipcalc.js  (Calculateur IP — tous les utilisateurs)
// =============================================================================

import {
  requireAuth, startInactivityTimer, checkHttps, getUser, logout,
  get, post, showToast, showConfirm, initTheme, sortSites,
  restoreElevationSession, setupElevationMode,
} from './api.js';

document.addEventListener('DOMContentLoaded', async () => {
  restoreElevationSession();
  checkHttps();
  initTheme();
  if (!requireAuth()) return;
  startInactivityTimer();

  const user = getUser();

  document.getElementById('nav-username').textContent = user.username;
  document.getElementById('nav-role').textContent = user?.username === 'ADMIN' ? 'Super Administrateur' : user?.role === 'admin' ? 'Administrateur' : 'Utilisateur';

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

  setupElevationMode();
  loadSidebar();
  setupIpCalc();
  setupNetTools();
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

function setupIpCalc() {
  const sel = document.getElementById('ipcalc-prefix');
  for (let i = 1; i <= 32; i++) {
    const opt = document.createElement('option');
    opt.value = i; opt.textContent = `/${i}`;
    if (i === 24) opt.selected = true;
    sel.appendChild(opt);
  }

  document.getElementById('btn-ipcalc').addEventListener('click', runIpCalc);
  document.getElementById('ipcalc-ip').addEventListener('keydown', e => { if (e.key === 'Enter') runIpCalc(); });
}

function ipToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return NaN;
  return parts.reduce((acc, p) => {
    const n = parseInt(p, 10);
    if (isNaN(n) || n < 0 || n > 255) return NaN;
    return (acc * 256 + n);
  }, 0);
}

function intToIp(n) {
  return [n >>> 24 & 0xFF, n >>> 16 & 0xFF, n >>> 8 & 0xFF, n & 0xFF].join('.');
}

function runIpCalc() {
  const raw    = document.getElementById('ipcalc-ip').value.trim();
  const prefix = parseInt(document.getElementById('ipcalc-prefix').value, 10);

  // Accepter "192.168.1.0" ou "192.168.1.0/24"
  const ipStr = raw.includes('/') ? raw.split('/')[0] : raw;
  const ipInt = ipToInt(ipStr);

  if (isNaN(ipInt) || prefix < 0 || prefix > 32) {
    showToast('Adresse IP invalide', 'warn');
    return;
  }

  const maskInt      = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0;
  const networkInt   = (ipInt & maskInt) >>> 0;
  const broadcastInt = (networkInt | (~maskInt >>> 0)) >>> 0;
  const totalIPs     = Math.pow(2, 32 - prefix);
  const usableHosts  = prefix >= 31 ? totalIPs : Math.max(0, totalIPs - 2);
  const gatewayInt   = prefix >= 31 ? networkInt : networkInt + 1;
  const ipMaxInt     = prefix >= 31 ? broadcastInt : broadcastInt - 1;
  const wildcardInt  = (~maskInt) >>> 0;

  const network   = intToIp(networkInt);
  const broadcast = intToIp(broadcastInt);
  const gateway   = intToIp(gatewayInt);
  const ipMin     = gateway;
  const ipMax     = intToIp(ipMaxInt);
  const mask      = intToIp(maskInt);
  const wildcard  = intToIp(wildcardInt);

  document.getElementById('ipcalc-cidr-label').textContent  = `${network}/${prefix}`;
  document.getElementById('ipcalc-mask-label').textContent   = `Masque : ${mask}`;
  document.getElementById('ipcalc-hosts-label').textContent  = usableHosts.toLocaleString('fr');

  function card(id, label, value, color) {
    document.getElementById(id).innerHTML = `
      <div style="font-size:11px;color:var(--tx-3);margin-bottom:6px">${label}</div>
      <div style="font-size:18px;font-weight:700;color:${color || 'var(--tx-1)'};font-family:'JetBrains Mono','Courier New',monospace;display:flex;align-items:center;justify-content:space-between;gap:8px">
        <span>${esc(String(value))}</span>
        <button onclick="navigator.clipboard.writeText('${value}').then(()=>window._showToast&&window._showToast('Copié','success'))" style="background:none;border:none;cursor:pointer;color:var(--tx-3);padding:2px 4px;border-radius:4px;font-size:11px;flex-shrink:0" title="Copier">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
      </div>
    `;
  }

  card('ipcalc-card-network',   'Adresse réseau',         network,                '#58a6ff');
  card('ipcalc-card-gateway',   'Passerelle (1ère IP)',    gateway,                '#3fb950');
  card('ipcalc-card-ipmin',     'IP minimum',             ipMin,                  '#3fb950');
  card('ipcalc-card-ipmax',     'IP maximum',             ipMax,                  '#d29922');
  card('ipcalc-card-broadcast', 'Broadcast',              broadcast,              '#f85149');
  card('ipcalc-card-total',     'IP totales',             totalIPs.toLocaleString('fr'), 'var(--tx-1)');
  card('ipcalc-card-mask',      'Masque de sous-réseau',  mask,                   'var(--tx-2)');
  card('ipcalc-card-wildcard',  'Masque inverse',         wildcard,               'var(--tx-2)');

  document.getElementById('ipcalc-result').classList.remove('hidden');
  // Rendre disponible le lien "Utiliser le réseau calculé" dans le scan
  document.getElementById('nt-scan-use-calc').style.display = 'inline';
}

// Expose showToast globally for onclick handlers in innerHTML
window._showToast = showToast;

// =============================================================================
// Outils réseau — Ping / Traceroute / Scan
// =============================================================================

function setupNetTools() {
  // ── Tabs ──────────────────────────────────────────────────────────────────
  const tabs   = ['ping', 'traceroute', 'scan', 'nmap', 'nc'];
  const tabEls = tabs.map(t => document.getElementById(`nt-tab-${t}`));
  const panels = tabs.map(t => document.getElementById(`nt-panel-${t}`));

  function activateTab(idx) {
    tabEls.forEach((el, i) => el.classList.toggle('active', i === idx));
    panels.forEach((el, i) => el.classList.toggle('hidden', i !== idx));
  }
  tabEls.forEach((el, i) => el.addEventListener('click', () => activateTab(i)));

  // ── Helpers ───────────────────────────────────────────────────────────────
  function setLoading(btnId, outputId, loading, label) {
    const btn = document.getElementById(btnId);
    const out = document.getElementById(outputId);
    if (loading) {
      btn.disabled = true;
      btn.textContent = 'En cours…';
      out.classList.remove('hidden');
      out.textContent = 'Exécution en cours…';
    } else {
      btn.disabled = false;
      btn.innerHTML = label;
    }
  }

  function showOutput(outputId, text, success) {
    const out = document.getElementById(outputId);
    out.classList.remove('hidden');
    out.style.borderColor = success === false ? '#f8514940' : success === true ? '#3fb95040' : 'var(--brd)';
    out.textContent = text;
  }

  const TARGET_RE = /^[a-zA-Z0-9][\w.\-]{0,252}$/;
  function checkTarget(val, label) {
    if (!val || !TARGET_RE.test(val)) { showToast(`${label} : IP ou FQDN invalide`, 'warn'); return false; }
    return true;
  }
  // Validation IP stricte pour le scan (IP uniquement)
  const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
  function checkIP(val, label) {
    if (!val || !IP_RE.test(val)) { showToast(`${label} : IP invalide`, 'warn'); return false; }
    return true;
  }

  // ── Ping ──────────────────────────────────────────────────────────────────
  const pingIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 8 12 12 14 14"/></svg> Ping`;
  document.getElementById('nt-btn-ping').addEventListener('click', async () => {
    const target = document.getElementById('nt-ping-target').value.trim();
    if (!checkTarget(target, 'Ping')) return;
    setLoading('nt-btn-ping', 'nt-ping-output', true);
    try {
      const data = await post('/api/nettools/ping', { target });
      showOutput('nt-ping-output', data.output, data.success);
    } catch (e) {
      showOutput('nt-ping-output', `Erreur : ${e.message}`, false);
    }
    setLoading('nt-btn-ping', 'nt-ping-output', false, pingIcon);
  });
  document.getElementById('nt-ping-target').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('nt-btn-ping').click();
  });

  // ── Traceroute ────────────────────────────────────────────────────────────
  const trIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg> Traceroute`;
  document.getElementById('nt-btn-tr').addEventListener('click', async () => {
    const target = document.getElementById('nt-tr-target').value.trim();
    if (!checkTarget(target, 'Traceroute')) return;
    setLoading('nt-btn-tr', 'nt-tr-output', true);
    try {
      const data = await post('/api/nettools/traceroute', { target });
      showOutput('nt-tr-output', data.output, data.success);
    } catch (e) {
      showOutput('nt-tr-output', `Erreur : ${e.message}`, false);
    }
    setLoading('nt-btn-tr', 'nt-tr-output', false, trIcon);
  });
  document.getElementById('nt-tr-target').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('nt-btn-tr').click();
  });

  // ── Scan réseau ───────────────────────────────────────────────────────────
  const scanSel = document.getElementById('nt-scan-prefix');
  for (let i = 22; i <= 30; i++) {
    const opt = document.createElement('option');
    opt.value = i; opt.textContent = `/${i}`;
    if (i === 24) opt.selected = true;
    scanSel.appendChild(opt);
  }

  const scanIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg> Scanner`;

  // Modal bypass key helpers
  const modal      = document.getElementById('modal-bypass-key');
  const keyInput   = document.getElementById('bypass-key-input');
  const keyError   = document.getElementById('bypass-key-error');
  const btnConfirm = document.getElementById('btn-bypass-confirm');
  const btnCancel  = document.getElementById('btn-bypass-cancel');

  function openBypassModal() {
    keyInput.value = '';
    keyError.style.display = 'none';
    modal.style.display = 'flex';
    setTimeout(() => keyInput.focus(), 50);
  }
  function closeBypassModal() {
    modal.style.display = 'none';
  }
  btnCancel.addEventListener('click', closeBypassModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeBypassModal(); });
  keyInput.addEventListener('input', () => {
    keyInput.value = keyInput.value.toUpperCase();
  });

  async function runScanWithKey(bypass_key) {
    const network = document.getElementById('nt-scan-network').value.trim();
    const prefix  = parseInt(document.getElementById('nt-scan-prefix').value);
    setLoading('nt-btn-scan', 'nt-scan-output', true);
    const hosts = Math.pow(2, 32 - prefix) - 2;
    document.getElementById('nt-scan-output').textContent =
      `Scan de ${network}/${prefix} (${hosts} hôtes) en cours…`;
    try {
      const data = await post('/api/nettools/scan', { network, prefix, bypass_key });
      closeBypassModal();
      const lines = [
        `Réseau : ${network}/${prefix}  |  ${data.responding} / ${data.total} hôtes répondent\n`,
        '─'.repeat(50),
        ...(data.alive.length
          ? data.alive.map(ip => `  ✓  ${ip}`)
          : ['  Aucun hôte ne répond.']),
      ];
      showOutput('nt-scan-output', lines.join('\n'), data.responding > 0);
    } catch (e) {
      // Clé invalide → rester dans le modal avec message d'erreur
      if (e.message.includes('bypass') || e.message.includes('invalide') || e.message.includes('403')) {
        keyError.textContent = e.message;
        keyError.style.display = 'block';
        keyInput.select();
      } else {
        closeBypassModal();
        showOutput('nt-scan-output', `Erreur : ${e.message}`, false);
      }
    }
    setLoading('nt-btn-scan', 'nt-scan-output', false, scanIcon);
  }

  btnConfirm.addEventListener('click', async () => {
    const key = keyInput.value.trim();
    if (!key) { keyError.textContent = 'Veuillez saisir la clé de bypass.'; keyError.style.display = 'block'; return; }
    keyError.style.display = 'none';
    btnConfirm.disabled = true; btnConfirm.textContent = 'Vérification…';
    await runScanWithKey(key);
    btnConfirm.disabled = false;
    btnConfirm.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg> Lancer le scan`;
  });
  keyInput.addEventListener('keydown', e => { if (e.key === 'Enter') btnConfirm.click(); });

  document.getElementById('nt-btn-scan').addEventListener('click', () => {
    const network = document.getElementById('nt-scan-network').value.trim();
    if (!checkIP(network, 'Scan')) return;
    openBypassModal();
  });

  // Lien "Utiliser le réseau calculé" — rempli quand le calculateur a un résultat
  document.getElementById('nt-scan-use-calc').addEventListener('click', () => {
    const cidr = document.getElementById('ipcalc-cidr-label')?.textContent;
    if (!cidr) return;
    const [net, pfx] = cidr.split('/');
    document.getElementById('nt-scan-network').value = net;
    const opt = document.getElementById('nt-scan-prefix');
    const p   = parseInt(pfx);
    if (p >= 22 && p <= 30) opt.value = p;
    else showToast(`/${pfx} hors plage /22–/30 pour le scan`, 'warn');
  });

  // ── Nmap ──────────────────────────────────────────────────────────────────
  const nmapIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M8 11h6M11 8v6"/></svg> Nmap`;
  document.getElementById('nt-btn-nmap').addEventListener('click', async () => {
    const target = document.getElementById('nt-nmap-target').value.trim();
    const ports  = document.getElementById('nt-nmap-ports').value.trim();
    if (!checkTarget(target, 'Nmap')) return;
    setLoading('nt-btn-nmap', 'nt-nmap-output', true);
    try {
      const data = await post('/api/nettools/nmap', { target, ports });
      showOutput('nt-nmap-output', data.output, data.success);
    } catch (e) {
      showOutput('nt-nmap-output', `Erreur : ${e.message}`, false);
    }
    setLoading('nt-btn-nmap', 'nt-nmap-output', false, nmapIcon);
  });
  document.getElementById('nt-nmap-target').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('nt-btn-nmap').click();
  });

  // ── Netcat ────────────────────────────────────────────────────────────────
  const ncIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg> Tester`;
  document.getElementById('nt-btn-nc').addEventListener('click', async () => {
    const target = document.getElementById('nt-nc-target').value.trim();
    const port   = document.getElementById('nt-nc-port').value.trim();
    if (!checkTarget(target, 'NC')) return;
    if (!port || isNaN(parseInt(port, 10))) { showToast('NC : port invalide', 'warn'); return; }
    setLoading('nt-btn-nc', 'nt-nc-output', true);
    try {
      const data = await post('/api/nettools/nc', { target, port: parseInt(port, 10) });
      showOutput('nt-nc-output', data.output || (data.success ? `Port ${port} ouvert sur ${target}` : `Port ${port} fermé ou inaccessible sur ${target}`), data.success);
    } catch (e) {
      showOutput('nt-nc-output', `Erreur : ${e.message}`, false);
    }
    setLoading('nt-btn-nc', 'nt-nc-output', false, ncIcon);
  });
  document.getElementById('nt-nc-port').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('nt-btn-nc').click();
  });
}

