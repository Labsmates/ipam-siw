// =============================================================================
// IPAM SIW — bypass.mjs  (Élévation temporaire en super admin via mot de passe)
// POST /api/bypass/elevate  — accessible à tous les administrateurs authentifiés
// =============================================================================

import { Router }   from 'express';
import jwt           from 'jsonwebtoken';
import { execFile }  from 'child_process';
import { promisify } from 'util';
import fs            from 'fs';
import os            from 'os';
import { requireAuth }                                                       from '../middleware/auth.mjs';
import { redis, getJwtSecret, validateAndUseBypassKey, addLog, getUserByUsername } from '../redis.mjs';
import { sha256 } from '../utils.mjs';

const execFileAsync  = promisify(execFile);
const SVC_ALLOWED    = ['ipam', 'httpd', 'redis'];

// Chemins certificats (identiques à config.mjs)
const CERT_FILE     = '/var/www/ipam/data/ipam.crt';
const KEY_FILE      = '/var/www/ipam/data/ipam.key';
const TMP_CERT_PATH = '/var/www/ipam/data/ipam_cert_tmp.pem';
const TMP_KEY_PATH  = '/var/www/ipam/data/ipam_key_tmp.pem';
const CERT_PEND_KEY = 'config:cert:pending';

const router = Router();

// Seuls les identifiants commençant par P ou X (hors ADMIN) peuvent s'élever.
const PX_RE = /^[PX]/i;

// Helper : exécute une commande, retourne null en cas d'erreur
async function tryExec(cmd, args, parse) {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 5000 });
    return parse(stdout.trim());
  } catch (e) {
    const out = (e.stdout || '').trim();
    return out ? parse(out) : null;
  }
}

// Convertit un préfixe CIDR (ex: 24) en masque IPv4 (ex: "255.255.255.0")
function cidrToNetmask(prefix) {
  const p = parseInt(prefix, 10);
  if (isNaN(p) || p < 0 || p > 32) return null;
  const mask = p === 0 ? 0 : (~0 << (32 - p)) >>> 0;
  return [(mask >> 24) & 0xFF, (mask >> 16) & 0xFF, (mask >> 8) & 0xFF, mask & 0xFF].join('.');
}

// POST /api/bypass/elevate
// admin → super admin pendant 10 min (authentification par mot de passe)
router.post('/elevate', requireAuth, async (req, res) => {
  try {
    const { password } = req.body || {};
    const { username, role } = req.user;

    if (role !== 'admin')
      return res.status(403).json({ error: 'Mode SA réservé aux administrateurs' });
    if (username === 'ADMIN')
      return res.status(400).json({ error: 'Le super-admin n\'a pas besoin de Mode SA' });
    if (!password)
      return res.status(400).json({ error: 'Mot de passe requis' });

    // Vérification du mot de passe de l'administrateur
    const user = await getUserByUsername(username);
    if (!user || user.pw_hash !== sha256(password)) {
      await addLog(username, 'ELEVATE_SA_FAIL', 'Tentative élévation SA — mot de passe incorrect', 'warn');
      return res.status(403).json({ error: 'Mot de passe incorrect' });
    }

    const secret = await getJwtSecret();
    const elevatedUser = { userId: req.user.userId, username, role: 'admin', elevated: 'sa' };
    const token      = jwt.sign(elevatedUser, secret, { expiresIn: '10m' });
    const expires_at = new Date(Date.now() + 600_000).toISOString();

    await addLog(username, 'ELEVATE_SA', 'Élévation Super Admin activée (10 min)', 'info');
    res.json({ token, user: elevatedUser, expires_at });
  } catch (e) {
    console.error('[ELEVATE_SA]', e);
    res.status(500).json({ error: 'Erreur serveur : ' + e.message });
  }
});

// POST /api/bypass/services-access
// utilisateur P/X → accès onglet Services pendant 15 min (clé usage unique)
router.post('/services-access', requireAuth, async (req, res) => {
  const { key } = req.body;
  const { username, role } = req.user;

  if (!PX_RE.test(username))
    return res.status(403).json({ error: 'Accès réservé aux identifiants P ou X' });
  if (role !== 'user')
    return res.status(403).json({ error: 'Accès Services réservé aux utilisateurs P/X' });

  try {
    await validateAndUseBypassKey(key, username, 'services');
  } catch (e) {
    await addLog(username, 'BYPASS_KEY_FAIL', `Tentative accès Services échouée : ${e.message}`, 'warn');
    return res.status(403).json({ error: e.message });
  }

  const secret = await getJwtSecret();
  const servicesUser = { id: req.user.id, username, role: 'user', elevated: 'services' };
  const token      = jwt.sign(servicesUser, secret, { expiresIn: '15m' });
  const expires_at = new Date(Date.now() + 15 * 60_000).toISOString();

  await addLog(username, 'SERVICES_ACCESS', 'Accès Services activé (15 min)', 'info');
  res.json({ ok: true, token, expires_at });
});

// POST /api/bypass/cert-access
// utilisateur P/X → accès installation certificat pendant 15 min (clé usage unique)
router.post('/cert-access', requireAuth, async (req, res) => {
  const { key } = req.body;
  const { username, role } = req.user;

  if (!PX_RE.test(username))
    return res.status(403).json({ error: 'Accès réservé aux identifiants P ou X' });
  if (role !== 'user')
    return res.status(403).json({ error: 'Accès Certificat réservé aux utilisateurs P/X' });

  try {
    await validateAndUseBypassKey(key, username, 'cert');
  } catch (e) {
    await addLog(username, 'BYPASS_KEY_FAIL', `Tentative accès Certificat échouée : ${e.message}`, 'warn');
    return res.status(403).json({ error: e.message });
  }

  const secret = await getJwtSecret();
  const certUser   = { id: req.user.id, username, role: 'user', elevated: 'cert' };
  const token      = jwt.sign(certUser, secret, { expiresIn: '15m' });
  const expires_at = new Date(Date.now() + 15 * 60_000).toISOString();

  await addLog(username, 'CERT_ACCESS', 'Accès Certificat activé (15 min)', 'info');
  res.json({ ok: true, token, expires_at });
});

const RELOAD_ONLY_BYPASS = new Set(['httpd']);

function assertSvc(svc, res) {
  if (!SVC_ALLOWED.includes(svc)) { res.status(400).json({ error: 'Service non autorisé' }); return false; }
  return true;
}

// GET /api/bypass/services/status
// utilisateur P/X avec token elevated:'services' → statut des services
router.get('/services/status', requireAuth, async (req, res) => {
  if (req.user.elevated !== 'services')
    return res.status(403).json({ error: 'Token services requis' });

  const results = {};
  for (const svc of SVC_ALLOWED) {
    try {
      const { stdout } = await execFileAsync(
        '/usr/bin/systemctl', ['status', svc],
        { timeout: 5000 }
      );
      const activeMatch = stdout.match(/Active:\s+(\S+)/);
      const memMatch    = stdout.match(/Memory:\s+(\S+)/);
      const pidMatch    = stdout.match(/Main PID:\s+(\d+)/);
      results[svc] = {
        active: activeMatch?.[1] || 'unknown',
        memory: memMatch?.[1]    || null,
        pid:    pidMatch?.[1]    || null,
      };
    } catch (e) {
      const stdout = e.stdout || '';
      const activeMatch = stdout.match(/Active:\s+(\S+)/);
      results[svc] = {
        active: activeMatch?.[1] || 'failed',
        memory: null,
        pid:    null,
      };
    }
  }

  res.json({ services: results });
});

// GET /api/bypass/services/:svc/logs
router.get('/services/:svc/logs', requireAuth, async (req, res) => {
  if (req.user.elevated !== 'services') return res.status(403).json({ error: 'Token services requis' });
  const { svc } = req.params;
  if (!assertSvc(svc, res)) return;
  try {
    const { stdout } = await execFileAsync('/usr/bin/journalctl', ['-u', svc, '-n', '100', '--no-pager'], { timeout: 10000 });
    res.json({ logs: stdout });
  } catch (e) {
    res.json({ logs: e.stdout || e.message });
  }
});

// POST /api/bypass/services/:svc/start
router.post('/services/:svc/start', requireAuth, async (req, res) => {
  if (req.user.elevated !== 'services') return res.status(403).json({ error: 'Token services requis' });
  const { svc } = req.params;
  if (!assertSvc(svc, res)) return;
  try {
    await addLog(req.user.username, 'SVC_START', `Service « ${svc} » démarré`, 'ok');
    res.json({ ok: true });
    setImmediate(() => execFileAsync('/usr/bin/systemctl', ['start', svc], { timeout: 30000 }).catch(() => {}));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/bypass/services/:svc/stop
router.post('/services/:svc/stop', requireAuth, async (req, res) => {
  if (req.user.elevated !== 'services') return res.status(403).json({ error: 'Token services requis' });
  const { svc } = req.params;
  if (!assertSvc(svc, res)) return;
  try {
    await addLog(req.user.username, 'SVC_STOP', `Service « ${svc} » arrêté`, 'danger');
    res.json({ ok: true });
    setImmediate(() => execFileAsync('/usr/bin/systemctl', ['stop', svc], { timeout: 30000 }).catch(() => {}));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/bypass/services/:svc/restart
router.post('/services/:svc/restart', requireAuth, async (req, res) => {
  if (req.user.elevated !== 'services') return res.status(403).json({ error: 'Token services requis' });
  const { svc } = req.params;
  if (!assertSvc(svc, res)) return;
  try {
    await addLog(req.user.username, 'SVC_RESTART', `Service « ${svc} » redémarré`, 'warn');
    res.json({ ok: true });
    setImmediate(() => {
      if (svc === 'ipam') { process.exit(0); }
      else { execFileAsync('/usr/bin/systemctl', ['restart', svc], { timeout: 30000 }).catch(() => {}); }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/bypass/services/:svc/reload
router.post('/services/:svc/reload', requireAuth, async (req, res) => {
  if (req.user.elevated !== 'services') return res.status(403).json({ error: 'Token services requis' });
  const { svc } = req.params;
  if (!assertSvc(svc, res)) return;
  if (!RELOAD_ONLY_BYPASS.has(svc)) return res.status(400).json({ error: `Le service « ${svc} » ne supporte pas reload` });
  try {
    await addLog(req.user.username, 'SVC_RELOAD', `Service « ${svc} » rechargé`, 'info');
    res.json({ ok: true });
    setImmediate(() => execFileAsync('/usr/bin/systemctl', ['reload', svc], { timeout: 30000 }).catch(() => {}));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/bypass/cert/info
// utilisateur P/X (role:user) → infos certificat en lecture seule
router.get('/cert/info', requireAuth, async (req, res) => {
  const { username, role } = req.user;
  if (!PX_RE.test(username) || role !== 'user')
    return res.status(403).json({ error: 'Accès réservé aux utilisateurs P ou X' });

  try {
    if (!fs.existsSync(CERT_FILE)) return res.json({ info: null });

    const { stdout } = await execFileAsync('/usr/bin/openssl', [
      'x509', '-noout', '-subject', '-issuer', '-dates',
      '-serial', '-fingerprint', '-sha256', '-in', CERT_FILE,
    ], { timeout: 5000 });

    const info = {};
    for (const line of stdout.split('\n')) {
      const idx = line.indexOf('=');
      if (idx < 0) continue;
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      if      (key === 'subject')            info.subject     = val;
      else if (key === 'issuer')             info.issuer      = val;
      else if (key === 'notBefore')          info.notBefore   = val;
      else if (key === 'notAfter')           info.notAfter    = val;
      else if (key === 'serial')             info.serial      = val;
      else if (key === 'SHA256 Fingerprint') info.fingerprint = val;
    }

    let san = null;
    try {
      const { stdout: s } = await execFileAsync('/usr/bin/openssl', [
        'x509', '-noout', '-ext', 'subjectAltName', '-in', CERT_FILE,
      ], { timeout: 5000 });
      const m = s.match(/Subject Alternative Name:[^\n]*\n\s*(.+)/);
      san = m?.[1]?.trim() || null;
    } catch (_) {}

    const notAfterDate = info.notAfter ? new Date(info.notAfter) : null;
    info.daysLeft   = notAfterDate ? Math.floor((notAfterDate - Date.now()) / 86400000) : null;
    info.san        = san;
    info.hasPending = (await redis.exists(CERT_PEND_KEY)) > 0;

    res.json({ info });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/bypass/cert/install
// utilisateur P/X avec token elevated:'cert' → installe le certificat signé
router.post('/cert/install', requireAuth, async (req, res) => {
  if (req.user.elevated !== 'cert')
    return res.status(403).json({ error: 'Token cert requis' });

  try {
    const { cert } = req.body || {};
    if (!cert?.trim()) return res.status(400).json({ error: 'Certificat PEM manquant' });

    fs.writeFileSync(TMP_CERT_PATH, String(cert).trim() + '\n', { mode: 0o600 });

    try {
      await execFileAsync('/usr/bin/openssl', ['x509', '-noout', '-in', TMP_CERT_PATH], { timeout: 5000 });
    } catch (_) {
      try { fs.unlinkSync(TMP_CERT_PATH); } catch (_) {}
      return res.status(400).json({ error: 'Certificat PEM invalide' });
    }

    let keyInstalled = false;
    const pendingRaw = await redis.get(CERT_PEND_KEY);
    if (pendingRaw) {
      try {
        const { key: keyPem } = JSON.parse(pendingRaw);
        fs.writeFileSync(TMP_KEY_PATH, keyPem, { mode: 0o600 });
        const { stdout: cm } = await execFileAsync('/usr/bin/openssl',
          ['x509', '-noout', '-modulus', '-in', TMP_CERT_PATH], { timeout: 5000 });
        const { stdout: km } = await execFileAsync('/usr/bin/openssl',
          ['rsa',  '-noout', '-modulus', '-in', TMP_KEY_PATH],  { timeout: 5000 });
        if (cm.trim() !== km.trim()) {
          try { fs.unlinkSync(TMP_CERT_PATH); fs.unlinkSync(TMP_KEY_PATH); } catch (_) {}
          return res.status(400).json({ error: 'Le certificat ne correspond pas à la clé privée générée par ce serveur' });
        }
        keyInstalled = true;
      } catch (e) {
        try { fs.unlinkSync(TMP_KEY_PATH); } catch (_) {}
        if (e.message?.includes('correspond')) return res.status(400).json({ error: e.message });
      }
    }

    fs.renameSync(TMP_CERT_PATH, CERT_FILE);
    fs.chmodSync(CERT_FILE, 0o644);

    if (keyInstalled) {
      fs.renameSync(TMP_KEY_PATH, KEY_FILE);
      fs.chmodSync(KEY_FILE, 0o600);
      await redis.del(CERT_PEND_KEY);
    }

    await addLog(req.user.username, 'CERT_INSTALL',
      `Certificat SSL installé${keyInstalled ? ' (+ clé privée)' : ''} via bypass`, 'warn');

    res.json({ ok: true, keyInstalled });
    setImmediate(() => {
      execFileAsync('/usr/bin/systemctl', ['reload', 'httpd'], { timeout: 30000 }).catch(() => {});
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/bypass/system/info
// utilisateur P/X (role:user) → informations système en lecture seule (pas de clé bypass requise)
router.get('/system/info', requireAuth, async (req, res) => {
  const { username, role } = req.user;
  if (!PX_RE.test(username) || role !== 'user')
    return res.status(403).json({ error: 'Accès réservé aux utilisateurs P ou X' });

  try {
    const info = {};

    info.hostname    = os.hostname();
    info.platform    = os.platform();
    info.arch        = os.arch();
    info.uptimeSec   = os.uptime();
    info.totalMem    = os.totalmem();
    info.freeMem     = os.freemem();
    info.nodeVersion = process.version;

    const cpus = os.cpus();
    info.cpuModel = cpus[0]?.model?.replace(/\s+/g, ' ').trim() || 'N/A';
    info.cpuCount = cpus.length;
    info.cpuLoad  = os.loadavg();

    // Interfaces réseau — os.networkInterfaces() avec fallback ip(8)
    info.ips = [];
    try {
      const nets = os.networkInterfaces();
      for (const [iface, addrs] of Object.entries(nets)) {
        for (const a of addrs) {
          if (a.internal) continue;
          const family = a.family === 4 ? 'IPv4' : a.family === 6 ? 'IPv6' : String(a.family);
          info.ips.push({ iface, address: a.address, family, netmask: a.netmask || null });
        }
      }
    } catch (_) {}

    // Fallback via `ip addr` si os.networkInterfaces() a échoué ou retourné vide
    if (!info.ips.length) {
      let ipOut = null;
      for (const bin of ['/usr/sbin/ip', '/usr/bin/ip', '/sbin/ip', '/bin/ip']) {
        ipOut = await tryExec(bin, ['-o', 'addr', 'show'], s => s);
        if (ipOut) break;
      }
      if (ipOut) {
        for (const line of ipOut.split('\n')) {
          const m = line.match(/^\d+:\s+(\S+)\s+(inet6?)\s+([^\s/]+)(?:\/(\d+))?/);
          if (!m || m[1] === 'lo') continue;
          const family  = m[2] === 'inet' ? 'IPv4' : 'IPv6';
          const netmask = (family === 'IPv4' && m[4]) ? cidrToNetmask(m[4]) : null;
          info.ips.push({ iface: m[1], address: m[3], family, netmask });
        }
      }
    }

    // Gateway par défaut — essayer plusieurs chemins
    info.gateway = null;
    for (const bin of ['/usr/sbin/ip', '/usr/bin/ip', '/sbin/ip', '/bin/ip']) {
      info.gateway = await tryExec(bin, ['route', 'show', 'default'], s => {
        const m = s.match(/default via (\S+)/);
        return m?.[1] || null;
      });
      if (info.gateway) break;
    }

    // DNS
    info.dns = [];
    try {
      const resolv = fs.readFileSync('/etc/resolv.conf', 'utf8');
      for (const line of resolv.split('\n')) {
        const m = line.match(/^nameserver\s+(\S+)/);
        if (m) info.dns.push(m[1]);
      }
    } catch (_) {}

    info.kernel = await tryExec('/usr/bin/uname', ['-r'], s => s);

    try {
      const raw = fs.readFileSync('/etc/os-release', 'utf8');
      const m   = raw.match(/^PRETTY_NAME="?(.+?)"?\s*$/m);
      info.osRelease = m?.[1] || raw.split('\n')[0];
    } catch (_) { info.osRelease = null; }

    info.disk = await tryExec('/usr/bin/df', ['-h', '/'], s => {
      const parts = s.split('\n')[1]?.split(/\s+/);
      return parts ? { total: parts[1], used: parts[2], avail: parts[3], pct: parts[4] } : null;
    });

    info.lastReboot  = await tryExec('/usr/bin/uptime', ['-s'], s => s)
      ?? await tryExec('/usr/bin/who', ['-b'], s => {
           const m = s.match(/system boot\s+(.+)/);
           return m?.[1]?.trim() || null;
         });

    info.uptimeHuman = await tryExec('/usr/bin/uptime', ['-p'], s => s.replace(/^up\s+/i, ''));

    info.redisVersion = await tryExec('/usr/bin/redis-server', ['--version'], s => {
      const m = s.match(/v=(\S+)/);
      return m?.[1] || s;
    }) ?? await tryExec('/usr/bin/redis-cli', ['--version'], s => {
      const m = s.match(/redis-cli (\S+)/);
      return m?.[1] || s;
    });

    info.apacheVersion = await tryExec('/usr/sbin/httpd', ['-v'], s => {
      const m = s.match(/Apache\/(\S+)/i);
      return m?.[1] || s.split('\n')[0];
    });

    res.json({ info });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
