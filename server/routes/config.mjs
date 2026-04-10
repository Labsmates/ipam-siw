// =============================================================================
// IPAM SIW — config.mjs  (Configuration système — super admin uniquement)
// Routes : /api/config/*
// =============================================================================

import express           from 'express';
import { execFile, exec } from 'child_process';
import { promisify }      from 'util';
import fs                 from 'fs';
import path               from 'path';
import os                 from 'os';
import net                from 'net';
import Redis              from 'ioredis';
import { redis, addLog, getBypassKey, generateBypassKey } from '../redis.mjs';
import { requireAuth, requireAdmin, requireSuperAdmin } from '../middleware/auth.mjs';
import { invalidateMaintenanceCache } from '../middleware/maintenance.mjs';
import { uid } from '../utils.mjs';

const execFileAsync = promisify(execFile);
const execAsync     = promisify(exec);
const router        = express.Router();

// Guard : toutes les routes nécessitent auth + admin
router.use(requireAuth, requireAdmin);

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------
const ALLOWED_SERVICES = new Set(['ipam', 'httpd', 'redis']);
const RELOAD_ONLY      = new Set(['httpd']); // seul httpd supporte reload
const RDB_PATH         = '/var/lib/redis/ipam.rdb';
const DB_CONFIG_KEY    = 'config:databases';
const API_CONFIG_KEY   = 'config:apis';
const SP_CONFIG_KEY    = 'config:sharepoint';
const MAINT_KEY        = 'config:maintenance';

const ALLOWED_SET_PARAMS = new Set([
  'maxmemory', 'maxmemory-policy', 'appendonly', 'requirepass', 'loglevel', 'save',
]);

const CONFIG_READ_PARAMS = [
  'maxmemory', 'maxmemory-policy', 'appendonly', 'save', 'requirepass', 'loglevel', 'bind',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function assertService(name, res) {
  if (!ALLOWED_SERVICES.has(name)) {
    res.status(400).json({ error: `Service non autorisé : ${name}` });
    return false;
  }
  return true;
}

// Appel de la commande Redis renommée CONFIG_IPAM_ADMIN
function redisConfig(...args) {
  return redis.call('CONFIG_IPAM_ADMIN', ...args);
}

async function loadDatabases() {
  const raw = await redis.get(DB_CONFIG_KEY);
  return raw ? JSON.parse(raw) : {};
}
async function saveDatabases(dbs) {
  await redis.set(DB_CONFIG_KEY, JSON.stringify(dbs));
}

async function loadApis() {
  const raw = await redis.get(API_CONFIG_KEY);
  return raw ? JSON.parse(raw) : {};
}
async function saveApis(apis) {
  await redis.set(API_CONFIG_KEY, JSON.stringify(apis));
}

async function loadSharepoint() {
  const raw = await redis.get(SP_CONFIG_KEY);
  return raw ? JSON.parse(raw) : {};
}
async function saveSharepoint(cfg) {
  await redis.set(SP_CONFIG_KEY, JSON.stringify(cfg));
}

// Test TCP (universel pour Redis, PostgreSQL, MariaDB)
function tcpPing(host, port, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const sock  = new net.Socket();
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`Timeout (${timeout} ms)`)); }, timeout);
    sock.connect(parseInt(port), host, () => { clearTimeout(timer); sock.destroy(); resolve(); });
    sock.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

// =============================================================================
// ONGLET 0 — Informations système
// =============================================================================

// Helper : exécute une commande, retourne null en cas d'erreur plutôt que de jeter
async function tryExec(cmd, args, parse) {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 5000 });
    return parse(stdout.trim());
  } catch (e) {
    const out = (e.stdout || '').trim();
    return out ? parse(out) : null;
  }
}

// GET /api/config/system/info
router.get('/system/info', async (req, res) => {
  try {
    const info = {};

    // ── Module os (synchrone) ────────────────────────────────────────────────
    info.hostname    = os.hostname();
    info.platform    = os.platform();
    info.arch        = os.arch();
    info.uptimeSec   = os.uptime();           // secondes
    info.totalMem    = os.totalmem();          // octets
    info.freeMem     = os.freemem();           // octets
    info.nodeVersion = process.version;

    const cpus = os.cpus();
    info.cpuModel = cpus[0]?.model?.replace(/\s+/g, ' ').trim() || 'N/A';
    info.cpuCount = cpus.length;
    info.cpuLoad  = os.loadavg();              // [1m, 5m, 15m]

    // Interfaces réseau — filtrage par internal flag, normalisation family (Node v18+ retourne 4/6)
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
        for (const line of (ipOut || '').split('\n')) {
          const m = line.match(/^\d+:\s+(\S+)\s+(inet6?)\s+([^\s/]+)(?:\/(\d+))?/);
          if (!m || m[1] === 'lo') continue;
          const family  = m[2] === 'inet' ? 'IPv4' : 'IPv6';
          let netmask = null;
          if (family === 'IPv4' && m[4]) {
            const p = parseInt(m[4], 10);
            const mask = p === 0 ? 0 : (~0 << (32 - p)) >>> 0;
            netmask = [(mask >> 24) & 0xFF, (mask >> 16) & 0xFF, (mask >> 8) & 0xFF, mask & 0xFF].join('.');
          }
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

    // Serveurs DNS (resolv.conf)
    info.dns = [];
    try {
      const resolv = fs.readFileSync('/etc/resolv.conf', 'utf8');
      for (const line of resolv.split('\n')) {
        const m = line.match(/^nameserver\s+(\S+)/);
        if (m) info.dns.push(m[1]);
      }
    } catch (_) {}

    // ── Sous-processus ───────────────────────────────────────────────────────
    // Noyau Linux
    info.kernel = await tryExec('/usr/bin/uname', ['-r'], s => s);

    // Distribution OS
    try {
      const raw = fs.readFileSync('/etc/os-release', 'utf8');
      const m   = raw.match(/^PRETTY_NAME="?(.+?)"?\s*$/m);
      info.osRelease = m?.[1] || raw.split('\n')[0];
    } catch (_) { info.osRelease = null; }

    // Disque /
    info.disk = await tryExec('/usr/bin/df', ['-h', '/'], s => {
      const parts = s.split('\n')[1]?.split(/\s+/);
      return parts ? { total: parts[1], used: parts[2], avail: parts[3], pct: parts[4] } : null;
    });

    // Dernier reboot
    info.lastReboot = await tryExec('/usr/bin/uptime', ['-s'], s => s)
      ?? await tryExec('/usr/bin/who', ['-b'], s => {
           const m = s.match(/system boot\s+(.+)/);
           return m?.[1]?.trim() || null;
         });

    // Uptime lisible
    info.uptimeHuman = await tryExec('/usr/bin/uptime', ['-p'], s => s.replace(/^up\s+/i, ''));

    // Version Redis
    info.redisVersion = await tryExec('/usr/bin/redis-server', ['--version'], s => {
      const m = s.match(/v=(\S+)/);
      return m?.[1] || s;
    }) ?? await tryExec('/usr/bin/redis-cli', ['--version'], s => {
      const m = s.match(/redis-cli (\S+)/);
      return m?.[1] || s;
    });

    // Version Apache
    info.apacheVersion = await tryExec('/usr/sbin/httpd', ['-v'], s => {
      const m = s.match(/Apache\/(\S+)/i);
      return m?.[1] || s.split('\n')[0];
    });

    await addLog(req.user.username, 'SYSINFO_VIEW', 'Consultation des informations système', 'info');
    res.json({ info });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =============================================================================
// ONGLET 1 — Services système
// =============================================================================

// GET /api/config/services/status
router.get('/services/status', async (req, res) => {
  try {
    const results = {};
    for (const svc of ALLOWED_SERVICES) {
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
        // systemctl exit non-zero quand service inactif/failed — stdout contient quand même l'état
        const stdout = e.stdout || '';
        const activeMatch = stdout.match(/Active:\s+(\S+)/);
        results[svc] = {
          active: activeMatch?.[1] || 'failed',
          memory: null,
          pid:    null,
          error:  activeMatch ? undefined : (e.stderr || e.message || 'sudo failed').slice(0, 200),
        };
      }
    }
    res.json({ services: results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/config/services/:name/restart
router.post('/services/:name/restart', async (req, res) => {
  const { name } = req.params;
  if (!assertService(name, res)) return;
  try {
    await addLog(req.user.username, 'SVC_RESTART', `Service « ${name} » redémarré`, 'warn');
    // Répondre AVANT le restart pour tous les services :
    // - ipam  : tue le processus Node.js courant → 502
    // - httpd : Apache coupe la connexion TCP → 502
    // - redis : déconnecte ioredis avant l'envoi → 502
    res.json({ ok: true });
    setImmediate(() => {
      if (name === 'ipam') {
        process.exit(1); // code ≠ 0 → redémarrage garanti avec Restart=on-failure ET Restart=always
      } else {
        execFileAsync('/usr/bin/systemctl', ['restart', name], { timeout: 30000 })
          .catch(() => {});
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.stderr || e.message });
  }
});

// POST /api/config/services/:name/reload
router.post('/services/:name/reload', async (req, res) => {
  const { name } = req.params;
  if (!assertService(name, res)) return;
  if (!RELOAD_ONLY.has(name))
    return res.status(400).json({ error: `Le service « ${name} » ne supporte pas reload` });
  try {
    await addLog(req.user.username, 'SVC_RELOAD', `Service « ${name} » rechargé`, 'info');
    // Répondre avant le reload : httpd coupe la connexion TCP en se rechargeant → 502
    res.json({ ok: true });
    setImmediate(() => {
      execFileAsync('/usr/bin/systemctl', [ 'reload', name], { timeout: 30000 })
        .catch(() => {});
    });
  } catch (e) {
    res.status(500).json({ error: e.stderr || e.message });
  }
});

// POST /api/config/services/:name/start
router.post('/services/:name/start', async (req, res) => {
  const { name } = req.params;
  if (!assertService(name, res)) return;
  try {
    await addLog(req.user.username, 'SVC_START', `Service « ${name} » démarré`, 'ok');
    res.json({ ok: true });
    setImmediate(() => {
      execFileAsync('/usr/bin/systemctl', [ 'start', name], { timeout: 30000 })
        .catch(() => {});
    });
  } catch (e) {
    res.status(500).json({ error: e.stderr || e.message });
  }
});

// POST /api/config/services/:name/stop
router.post('/services/:name/stop', async (req, res) => {
  const { name } = req.params;
  if (!assertService(name, res)) return;
  try {
    await addLog(req.user.username, 'SVC_STOP', `Service « ${name} » arrêté`, 'danger');
    // Répondre AVANT l'arrêt : stopper ipam tue le processus Node.js courant
    res.json({ ok: true });
    setImmediate(() => {
      execFileAsync('/usr/bin/systemctl', [ 'stop', name], { timeout: 30000 })
        .catch(() => {});
    });
  } catch (e) {
    res.status(500).json({ error: e.stderr || e.message });
  }
});

// POST /api/config/server/reboot
router.post('/server/reboot', async (req, res) => {
  try {
    // Exécuter d'abord — shutdown ne tue pas Node.js immédiatement,
    // donc la réponse est envoyée avant l'extinction effective.
    // Si sudo échoue (droit non configuré), l'erreur remonte au client.
    await execFileAsync('/usr/bin/systemctl', ['reboot'], { timeout: 10000 });
    await addLog(req.user.username, 'SERVER_REBOOT', 'Redémarrage du serveur', 'danger');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.stderr || e.message || 'Échec reboot' });
  }
});

// POST /api/config/server/halt
router.post('/server/halt', async (req, res) => {
  try {
    await execFileAsync('/usr/bin/systemctl', ['poweroff'], { timeout: 10000 });
    await addLog(req.user.username, 'SERVER_HALT', 'Arrêt du serveur', 'danger');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.stderr || e.message || 'Échec poweroff' });
  }
});

// GET /api/config/services/:name/logs
router.get('/services/:name/logs', async (req, res) => {
  const { name } = req.params;
  if (!assertService(name, res)) return;
  try {
    const { stdout } = await execFileAsync(
      '/usr/bin/journalctl', [ '-u', name, '-n', '100', '--no-pager'],
      { timeout: 10000 }
    );
    res.json({ logs: stdout });
  } catch (e) {
    // journalctl peut retourner exit 1 mais avoir du contenu
    res.json({ logs: e.stdout || e.message });
  }
});

// =============================================================================
// ONGLET 2 — Configuration Redis
// =============================================================================

// GET /api/config/redis/config
router.get('/redis/config', async (req, res) => {
  try {
    const result = {};
    for (const param of CONFIG_READ_PARAMS) {
      try {
        const raw = await redisConfig('GET', param);
        // CONFIG GET retourne [nomParam, valeur]
        result[param] = Array.isArray(raw) ? raw[1] ?? '' : (raw ?? '');
      } catch (_) {
        result[param] = '';
      }
    }
    res.json({ config: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/config/redis/config
router.put('/redis/config', async (req, res) => {
  try {
    const { params } = req.body || {};
    if (!params || typeof params !== 'object')
      return res.status(400).json({ error: 'Corps invalide' });

    const errors  = [];
    const changed = [];
    for (const [key, value] of Object.entries(params)) {
      if (!ALLOWED_SET_PARAMS.has(key)) {
        errors.push(`Paramètre non modifiable : ${key}`);
        continue;
      }
      // Sanitisation : pas de retours chariot ni octets nuls
      const safeVal = String(value).replace(/[\r\n\0]/g, '').trim();
      try {
        await redisConfig('SET', key, safeVal);
        changed.push(key);
      } catch (e) {
        errors.push(`${key}: ${e.message}`);
      }
    }
    if (errors.length && !changed.length)
      return res.status(400).json({ error: errors.join('; ') });

    if (changed.length)
      await addLog(req.user.username, 'REDIS_CONFIG_SET',
        `Paramètres modifiés : ${changed.join(', ')}`, 'info');

    res.json({ ok: true, changed, errors });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =============================================================================
// ONGLET 3 — Sauvegarde / Restauration
// =============================================================================

// POST /api/config/redis/backup
router.post('/redis/backup', async (req, res) => {
  try {
    await redis.bgsave();
    await addLog(req.user.username, 'REDIS_BGSAVE', 'Sauvegarde BGSAVE déclenchée', 'info');
    res.json({ ok: true });
  } catch (e) {
    // Redis peut répondre "Background saving started" ou une erreur si déjà en cours
    if (e.message?.includes('already')) {
      res.json({ ok: true, message: 'Sauvegarde déjà en cours' });
    } else {
      res.status(500).json({ error: e.message });
    }
  }
});

// GET /api/config/redis/backup/info
router.get('/redis/backup/info', async (req, res) => {
  try {
    const lastSaveTs = await redis.lastsave(); // timestamp Unix (secondes)
    let size  = null;
    let exists = false;
    try {
      const stat = fs.statSync(RDB_PATH);
      size   = stat.size;
      exists = true;
    } catch (_) {}
    res.json({ lastSave: lastSaveTs * 1000, size, exists });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/config/redis/backup/download
router.get('/redis/backup/download', async (req, res) => {
  try {
    if (!fs.existsSync(RDB_PATH))
      return res.status(404).json({ error: 'Fichier RDB introuvable' });
    await addLog(req.user.username, 'REDIS_RDB_DOWNLOAD', 'Téléchargement du fichier RDB', 'warn');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="ipam.rdb"');
    fs.createReadStream(RDB_PATH).pipe(res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/config/redis/restore  — body: { data: "<base64>" }
router.post('/redis/restore', async (req, res) => {
  try {
    const { data } = req.body || {};
    if (!data) return res.status(400).json({ error: 'Données manquantes (champ "data" base64)' });

    const buf = Buffer.from(data, 'base64');

    // Valider les magic bytes : un fichier RDB commence toujours par "REDIS"
    if (buf.length < 5 || buf.slice(0, 5).toString('ascii') !== 'REDIS')
      return res.status(400).json({ error: 'Fichier RDB invalide (magic bytes incorrects)' });

    // Écrire le fichier RDB
    fs.writeFileSync(RDB_PATH, buf);

    await addLog(req.user.username, 'REDIS_RESTORE',
      `Restauration RDB (${buf.length} octets) — Redis redémarré`, 'danger');

    // Redémarrer Redis pour qu'il charge le nouveau fichier RDB
    await execFileAsync('/usr/bin/systemctl', [ 'restart', 'redis'], { timeout: 30000 });

    res.json({ ok: true, message: 'Restauration effectuée. Redis redémarré.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =============================================================================
// ONGLET 4 — Bases de données supplémentaires
// =============================================================================

// GET /api/config/databases
router.get('/databases', async (req, res) => {
  try {
    const dbs = await loadDatabases();
    // Ne jamais renvoyer les mots de passe au client
    const safe = Object.entries(dbs).map(([id, d]) => ({
      id,
      type:   d.type || 'redis',
      name:   d.name,
      host:   d.host,
      port:   d.port,
      db:     d.db,
      dbname: d.dbname,
      user:   d.user,
    }));
    res.json({ databases: safe });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/config/databases
router.post('/databases', async (req, res) => {
  try {
    const { type, name, host, port, password, db, dbname, user } = req.body || {};
    if (!name || !host)
      return res.status(400).json({ error: 'Le nom et l\'hôte sont obligatoires' });

    const dbType    = ['redis', 'postgres', 'mariadb'].includes(type) ? type : 'redis';
    const defaultPort = dbType === 'postgres' ? 5432 : dbType === 'mariadb' ? 3306 : 6379;

    const dbs = await loadDatabases();
    const id  = uid();
    dbs[id] = {
      type:     dbType,
      name:     String(name).slice(0, 64),
      host:     String(host).slice(0, 128),
      port:     parseInt(port) || defaultPort,
      password: password ? String(password) : null,
      user:     user     ? String(user).slice(0, 64) : null,
      dbname:   dbname   ? String(dbname).slice(0, 64) : null,
      db:       parseInt(db) || 0,
    };
    await saveDatabases(dbs);
    await addLog(req.user.username, 'DB_ADD', `Connexion ${dbType} « ${name} » ajoutée`, 'info');
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/config/databases/:id
router.delete('/databases/:id', async (req, res) => {
  try {
    const dbs = await loadDatabases();
    if (!dbs[req.params.id])
      return res.status(404).json({ error: 'Connexion introuvable' });
    const name = dbs[req.params.id].name;
    delete dbs[req.params.id];
    await saveDatabases(dbs);
    await addLog(req.user.username, 'DB_DEL', `Connexion ${dbs[req.params.id]?.type || 'redis'} « ${name} » supprimée`, 'warn');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/config/databases/:id/test
router.post('/databases/:id/test', async (req, res) => {
  try {
    const dbs = await loadDatabases();
    const cfg = dbs[req.params.id];
    if (!cfg) return res.status(404).json({ error: 'Connexion introuvable' });

    const t0 = Date.now();

    if (cfg.type === 'postgres' || cfg.type === 'mariadb') {
      // Test TCP uniquement (pas de driver SQL installé)
      await tcpPing(cfg.host, cfg.port);
      const latency = Date.now() - t0;
      await addLog(req.user.username, 'DB_TEST',
        `Test ${cfg.type} « ${cfg.name} » (${cfg.host}:${cfg.port}) — TCP OK (${latency} ms)`, 'info');
      return res.json({ ok: true, latency, note: 'TCP connect OK' });
    }

    // Redis : PING applicatif
    const client = new Redis({
      host: cfg.host, port: cfg.port,
      password: cfg.password || undefined,
      db: cfg.db,
      connectTimeout: 3000, maxRetriesPerRequest: 0, lazyConnect: true,
    });
    try {
      await client.connect();
      await client.ping();
      const latency = Date.now() - t0;
      await addLog(req.user.username, 'DB_TEST',
        `Test Redis « ${cfg.name} » (${cfg.host}:${cfg.port}) — PING OK (${latency} ms)`, 'info');
      res.json({ ok: true, latency });
    } finally {
      client.disconnect();
    }
  } catch (e) {
    await addLog(req.user.username, 'DB_TEST',
      `Test connexion « ${dbs?.[req.params.id]?.name} » — Échec : ${e.message}`, 'error').catch(() => {});
    res.status(502).json({ error: `Connexion échouée : ${e.message}` });
  }
});

// POST /api/config/databases/:id/sync
router.post('/databases/:id/sync', async (req, res) => {
  try {
    const dbs = await loadDatabases();
    const cfg = dbs[req.params.id];
    if (!cfg) return res.status(404).json({ error: 'Connexion introuvable' });

    const target = new Redis({
      host:                 cfg.host,
      port:                 cfg.port,
      password:             cfg.password || undefined,
      db:                   cfg.db,
      connectTimeout:       5000,
      maxRetriesPerRequest: 0,
      lazyConnect:          true,
    });

    try {
      await target.connect();

      let cursor = '0';
      let count  = 0;
      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'COUNT', 100);
        cursor = nextCursor;
        for (const key of keys) {
          // Exclure la clé de config des bases de données elle-même
          if (key === DB_CONFIG_KEY) continue;
          const ttl  = await redis.pttl(key); // ms (-1 = pas d'expiry, -2 = disparu)
          const dump = await redis.dump(key);
          if (dump === null) continue;
          await target.call('RESTORE', key, ttl > 0 ? ttl : 0, dump, 'REPLACE');
          count++;
        }
      } while (cursor !== '0');

      await addLog(req.user.username, 'DB_SYNC',
        `${count} clé(s) synchronisée(s) vers « ${cfg.name} »`, 'info');
      res.json({ ok: true, count });
    } finally {
      target.disconnect();
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =============================================================================
// ONGLET 5 — Certificat SSL
// =============================================================================

// Certs stockés directement dans DATA_DIR (ipam:ipam 770, apache dans le groupe)
// → aucun sudo nécessaire pour écrire/lire les certificats
const CERT_FILE     = '/var/www/ipam/data/ipam.crt';
const KEY_FILE      = '/var/www/ipam/data/ipam.key';
const TMP_CERT_PATH = '/var/www/ipam/data/ipam_cert_tmp.pem';
const TMP_KEY_PATH  = '/var/www/ipam/data/ipam_key_tmp.pem';
const TMP_CSR_PATH  = '/var/www/ipam/data/ipam_csr.pem';
const CERT_PEND_KEY = 'config:cert:pending';

function sanitizeDN(s) {
  return String(s || '').replace(/[^A-Za-z0-9\s.,@_\-*]/g, '').slice(0, 64).trim();
}


// GET /api/config/cert/info
router.get('/cert/info', async (req, res) => {
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
      if      (key === 'subject')              info.subject     = val;
      else if (key === 'issuer')               info.issuer      = val;
      else if (key === 'notBefore')            info.notBefore   = val;
      else if (key === 'notAfter')             info.notAfter    = val;
      else if (key === 'serial')               info.serial      = val;
      else if (key === 'SHA256 Fingerprint')   info.fingerprint = val;
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

// POST /api/config/cert/generate-csr
router.post('/cert/generate-csr', async (req, res) => {
  try {
    const { cn, o = '', ou = '', c = '', st = '', l = '', san = [], keySize = 2048 } = req.body || {};
    if (!cn?.trim()) return res.status(400).json({ error: 'Le CN (Common Name) est obligatoire' });

    const ks   = [2048, 4096].includes(Number(keySize)) ? Number(keySize) : 2048;
    const subj = '/' + [
      c  && `C=${sanitizeDN(c)}`,
      st && `ST=${sanitizeDN(st)}`,
      l  && `L=${sanitizeDN(l)}`,
      o  && `O=${sanitizeDN(o)}`,
      ou && `OU=${sanitizeDN(ou)}`,
      `CN=${sanitizeDN(cn)}`,
    ].filter(Boolean).join('/');

    const sanList = (Array.isArray(san) ? san : String(san).split('\n'))
      .map(s => s.trim()).filter(Boolean)
      .map(s => /^\d{1,3}(\.\d{1,3}){3}$/.test(s) ? `IP:${s}` : `DNS:${s}`);

    const args = ['req', '-newkey', `rsa:${ks}`, '-nodes',
      '-keyout', TMP_KEY_PATH, '-out', TMP_CSR_PATH, '-subj', subj];
    if (sanList.length) args.push('-addext', `subjectAltName=${sanList.join(',')}`);

    await execFileAsync('/usr/bin/openssl', args, { timeout: 60000 });
    const csrPem = fs.readFileSync(TMP_CSR_PATH, 'utf8');
    const keyPem = fs.readFileSync(TMP_KEY_PATH, 'utf8');
    try { fs.unlinkSync(TMP_CSR_PATH); } catch (_) {}
    try { fs.unlinkSync(TMP_KEY_PATH); } catch (_) {}

    // Stocker clé + CSR dans Redis 24h (le CSR est envoyé à la CA, la clé attendue pour l'install)
    await redis.set(CERT_PEND_KEY, JSON.stringify({ key: keyPem, csr: csrPem }), 'EX', 86400);
    await addLog(req.user.username, 'CERT_CSR_GEN', `CSR généré — CN=${sanitizeDN(cn)}, ${ks} bits`, 'info');

    res.json({ ok: true, csr: csrPem });
  } catch (e) {
    res.status(500).json({ error: e.stderr || e.message });
  }
});

// POST /api/config/cert/install  — body: { cert: "PEM" }
router.post('/cert/install', async (req, res) => {
  try {
    const { cert } = req.body || {};
    if (!cert?.trim()) return res.status(400).json({ error: 'Certificat PEM manquant' });

    fs.writeFileSync(TMP_CERT_PATH, String(cert).trim() + '\n', { mode: 0o600 });

    // Valider le PEM
    try {
      await execFileAsync('/usr/bin/openssl', ['x509', '-noout', '-in', TMP_CERT_PATH], { timeout: 5000 });
    } catch (_) {
      try { fs.unlinkSync(TMP_CERT_PATH); } catch (_) {}
      return res.status(400).json({ error: 'Certificat PEM invalide' });
    }

    // Vérifier la correspondance avec la clé en attente
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
      `Certificat SSL installé${keyInstalled ? ' (+ clé privée)' : ''}`, 'warn');

    res.json({ ok: true, keyInstalled });
    setImmediate(() => {
      execFileAsync('/usr/bin/systemctl', [ 'reload', 'httpd'], { timeout: 30000 }).catch(() => {});
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/config/cert/self-signed
router.post('/cert/self-signed', async (req, res) => {
  try {
    const { cn, o = '', ou = '', c = 'FR', st = '', l = '', san = [], days = 365 } = req.body || {};
    if (!cn?.trim()) return res.status(400).json({ error: 'Le CN (Common Name) est obligatoire' });

    const d    = Math.min(Math.max(parseInt(days) || 365, 1), 3650);
    const subj = '/' + [
      c  && `C=${sanitizeDN(c)}`,
      st && `ST=${sanitizeDN(st)}`,
      l  && `L=${sanitizeDN(l)}`,
      o  && `O=${sanitizeDN(o)}`,
      ou && `OU=${sanitizeDN(ou)}`,
      `CN=${sanitizeDN(cn)}`,
    ].filter(Boolean).join('/');

    const sanList = (Array.isArray(san) ? san : String(san).split('\n'))
      .map(s => s.trim()).filter(Boolean)
      .map(s => /^\d{1,3}(\.\d{1,3}){3}$/.test(s) ? `IP:${s}` : `DNS:${s}`);

    const args = ['req', '-x509', '-nodes', '-days', String(d), '-newkey', 'rsa:2048',
      '-keyout', TMP_KEY_PATH, '-out', TMP_CERT_PATH, '-subj', subj];
    if (sanList.length) args.push('-addext', `subjectAltName=${sanList.join(',')}`);

    await execFileAsync('/usr/bin/openssl', args, { timeout: 60000 });

    fs.renameSync(TMP_CERT_PATH, CERT_FILE);
    fs.renameSync(TMP_KEY_PATH,  KEY_FILE);
    fs.chmodSync(CERT_FILE, 0o644);
    fs.chmodSync(KEY_FILE,  0o600);

    await addLog(req.user.username, 'CERT_SELF_SIGNED',
      `Certificat auto-signé — CN=${sanitizeDN(cn)}, ${d} jours`, 'warn');

    res.json({ ok: true });
    setImmediate(() => {
      execFileAsync('/usr/bin/systemctl', [ 'reload', 'httpd'], { timeout: 30000 }).catch(() => {});
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =============================================================================
// ONGLET 5 — APIs externes
// =============================================================================

router.get('/apis', async (req, res) => {
  try {
    const apis = await loadApis();
    const safe = Object.entries(apis).map(([id, a]) => ({
      id, name: a.name, url: a.url, description: a.description || '',
    }));
    res.json({ apis: safe });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/apis', async (req, res) => {
  try {
    const { name, url, key, description } = req.body || {};
    if (!name?.trim() || !url?.trim())
      return res.status(400).json({ error: 'Nom et URL obligatoires' });
    const apis = await loadApis();
    const id   = uid();
    apis[id] = {
      name:        String(name).slice(0, 64),
      url:         String(url).slice(0, 256),
      key:         key ? String(key) : null,
      description: description ? String(description).slice(0, 128) : '',
    };
    await saveApis(apis);
    await addLog(req.user.username, 'API_ADD', `API « ${name} » ajoutée`, 'info');
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/apis/:id', async (req, res) => {
  try {
    const apis = await loadApis();
    if (!apis[req.params.id]) return res.status(404).json({ error: 'API introuvable' });
    const name = apis[req.params.id].name;
    delete apis[req.params.id];
    await saveApis(apis);
    await addLog(req.user.username, 'API_DEL', `API « ${name} » supprimée`, 'warn');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/apis/:id/test', async (req, res) => {
  try {
    const apis = await loadApis();
    const cfg  = apis[req.params.id];
    if (!cfg) return res.status(404).json({ error: 'API introuvable' });
    const headers = { 'User-Agent': 'IPAM-SIW/2' };
    if (cfg.key) headers['Authorization'] = `Bearer ${cfg.key}`;
    const ctrl    = new AbortController();
    const timer   = setTimeout(() => ctrl.abort(), 5000);
    const t0      = Date.now();
    try {
      const r = await fetch(cfg.url, { method: 'HEAD', headers, signal: ctrl.signal });
      clearTimeout(timer);
      const latency = Date.now() - t0;
      await addLog(req.user.username, 'API_TEST',
        `Test API « ${cfg.name} » — HTTP ${r.status} (${latency} ms)`, 'info');
      res.json({ ok: true, status: r.status, latency });
    } catch (fe) {
      clearTimeout(timer);
      throw fe;
    }
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// =============================================================================
// ONGLET 6 — SharePoint
// =============================================================================

router.get('/sharepoint', async (req, res) => {
  try {
    const cfg = await loadSharepoint();
    // Ne pas renvoyer le client secret
    res.json({
      url:       cfg.url       || '',
      clientId:  cfg.clientId  || '',
      tenantId:  cfg.tenantId  || '',
      folder:    cfg.folder    || '',
      hasSecret: !!cfg.clientSecret,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/sharepoint', async (req, res) => {
  try {
    const { url, clientId, tenantId, clientSecret, folder } = req.body || {};
    const cfg = await loadSharepoint();
    if (url       !== undefined) cfg.url       = String(url).trim().slice(0, 256);
    if (clientId  !== undefined) cfg.clientId  = String(clientId).trim().slice(0, 64);
    if (tenantId  !== undefined) cfg.tenantId  = String(tenantId).trim().slice(0, 64);
    if (folder    !== undefined) cfg.folder    = String(folder).trim().slice(0, 256);
    if (clientSecret?.trim())    cfg.clientSecret = String(clientSecret);
    await saveSharepoint(cfg);
    await addLog(req.user.username, 'SP_CONFIG', 'Configuration SharePoint mise à jour', 'info');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/sharepoint/test', async (req, res) => {
  try {
    const cfg = await loadSharepoint();
    if (!cfg.url || !cfg.clientId || !cfg.tenantId || !cfg.clientSecret)
      return res.status(400).json({ error: 'Configuration incomplète (URL, clientId, tenantId, clientSecret requis)' });

    // Obtenir un token OAuth2 Microsoft
    const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`;
    const body     = new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     cfg.clientId,
      client_secret: cfg.clientSecret,
      scope:         'https://graph.microsoft.com/.default',
    });
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body, signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        return res.status(502).json({ error: err.error_description || `HTTP ${r.status}` });
      }
      await addLog(req.user.username, 'SP_TEST', 'Test SharePoint — token OAuth2 OK', 'info');
      res.json({ ok: true, message: 'Authentification SharePoint réussie' });
    } catch (fe) { clearTimeout(timer); throw fe; }
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// =============================================================================
// ONGLET MAINTENANCE
// =============================================================================

async function loadMaintenance() {
  const raw = await redis.get(MAINT_KEY);
  return raw ? JSON.parse(raw) : { enabled: false, message: '', bypassKey: '', plannedEnd: null };
}
async function saveMaintenance(data) {
  await redis.set(MAINT_KEY, JSON.stringify(data));
  invalidateMaintenanceCache();
}

// GET /api/config/maintenance
router.get('/maintenance', async (req, res) => {
  try {
    const m = await loadMaintenance();
    res.json({ ...m }); // bypassKey inclus pour l'admin
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/config/maintenance  — met à jour message, bypassKey, plannedEnd (sans changer enabled)
router.put('/maintenance', async (req, res) => {
  try {
    const { message, bypassKey, plannedEnd } = req.body || {};
    const m = await loadMaintenance();
    if (message    !== undefined) m.message    = String(message).trim();
    if (bypassKey  !== undefined) m.bypassKey  = String(bypassKey).trim();
    if (plannedEnd !== undefined) m.plannedEnd = plannedEnd || null;
    await saveMaintenance(m);
    await addLog(req.user.username, 'MAINTENANCE_UPDATE', { message: m.message, plannedEnd: m.plannedEnd });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/config/maintenance/enable
// Body optionnel : { durationMinutes: 60 }  →  auto-désactivation après N minutes
router.post('/maintenance/enable', async (req, res) => {
  try {
    const m    = await loadMaintenance();
    m.enabled  = true;
    if (req.body?.durationMinutes) {
      const ms = parseInt(req.body.durationMinutes) * 60 * 1000;
      m.plannedEnd = new Date(Date.now() + ms).toISOString();
    }
    await saveMaintenance(m);
    await addLog(req.user.username, 'MAINTENANCE_ENABLE', { plannedEnd: m.plannedEnd || null });
    res.json({ ok: true, plannedEnd: m.plannedEnd || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/config/maintenance/disable
router.post('/maintenance/disable', async (req, res) => {
  try {
    const m    = await loadMaintenance();
    m.enabled  = false;
    await saveMaintenance(m);
    await addLog(req.user.username, 'MAINTENANCE_DISABLE', {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =============================================================================
// Clé de bypass — Scan réseau
// =============================================================================

// GET /api/config/bypass-key — lire la clé actuelle
router.get('/bypass-key', async (req, res) => {
  try {
    const data = await getBypassKey();
    if (!data) return res.json({ key: null, generated_by: null, generated_at: null, expires_at: null, used_at: null, used_by: null, used_for: null });
    const expired = data.expires_at && new Date(data.expires_at).getTime() < Date.now();
    res.json({
      key:          expired ? null : data.key,
      generated_by: data.generated_by,
      generated_at: data.generated_at,
      expires_at:   data.expires_at,
      used_at:      data.used_at  || null,
      used_by:      data.used_by  || null,
      used_for:     data.used_for || null,
      expired,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/config/bypass-key/generate — générer une nouvelle clé
router.post('/bypass-key/generate', async (req, res) => {
  try {
    const key = await generateBypassKey(req.user.username);
    await addLog(req.user.username, 'BYPASS_KEY_GEN', 'Nouvelle clé de bypass générée', 'info');
    res.json({ key });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =============================================================================
// TERMINAL — exécution de commandes serveur (admin uniquement)
// =============================================================================

// Validation chemin : interdit la sortie du filesystem via ..
function safePath(p) {
  if (!p || typeof p !== 'string') return null;
  const normalized = path.normalize(p);
  // Interdit si le chemin remonte au-dessus de la racine via ..
  if (normalized.includes('..')) return null;
  return normalized;
}

// POST /api/config/terminal/exec
router.post('/terminal/exec', async (req, res) => {
  const { command } = req.body || {};
  if (!command || typeof command !== 'string' || !command.trim())
    return res.status(400).json({ error: 'Commande manquante' });
  const cmd = command.trim();
  await addLog(req.user.username, 'TERMINAL_EXEC', cmd.slice(0, 500), 'info');
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout: 30_000,
      maxBuffer: 512 * 1024,
      env: { ...process.env, TERM: 'xterm' },
    });
    res.json({ stdout: stdout || '', stderr: stderr || '' });
  } catch (e) {
    // execAsync rejects on non-zero exit — renvoie quand même stdout/stderr
    res.json({ stdout: e.stdout || '', stderr: e.stderr || e.message, exit_code: e.code });
  }
});

// POST /api/config/terminal/upload — contenu base64
router.post('/terminal/upload', async (req, res) => {
  const { file_path: fp, content_b64 } = req.body || {};
  const safe = safePath(fp);
  if (!safe) return res.status(400).json({ error: 'Chemin invalide' });
  if (!content_b64 || typeof content_b64 !== 'string')
    return res.status(400).json({ error: 'Contenu manquant' });
  try {
    const buf = Buffer.from(content_b64, 'base64');
    // Créer le répertoire si nécessaire
    await fs.promises.mkdir(path.dirname(safe), { recursive: true });
    await fs.promises.writeFile(safe, buf);
    await addLog(req.user.username, 'TERMINAL_UPLOAD', safe, 'info');
    res.json({ ok: true, size: buf.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/config/terminal/ls?path= — liste d'un répertoire serveur
router.get('/terminal/ls', async (req, res) => {
  const safe = safePath(req.query.path || '/tmp');
  if (!safe) return res.status(400).json({ error: 'Chemin invalide' });
  try {
    const entries = await fs.promises.readdir(safe, { withFileTypes: true });
    const items = entries
      .map(e => {
        let size = null;
        try { if (!e.isDirectory()) size = fs.statSync(`${safe}/${e.name}`).size; } catch { /* ignore */ }
        return { name: e.name, type: e.isDirectory() ? 'dir' : 'file', size };
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    res.json({ path: safe, items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/config/terminal/download?path=
router.get('/terminal/download', async (req, res) => {
  const safe = safePath(req.query.path);
  if (!safe) return res.status(400).json({ error: 'Chemin invalide' });
  try {
    await fs.promises.access(safe, fs.constants.R_OK);
    const filename = path.basename(safe);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    await addLog(req.user.username, 'TERMINAL_DOWNLOAD', safe, 'info');
    fs.createReadStream(safe).pipe(res);
  } catch (e) { res.status(404).json({ error: `Fichier introuvable : ${e.message}` }); }
});

// =============================================================================
// CONFIG APACHE — lecture et écriture de la configuration Apache
// =============================================================================

const APACHE_CONF_CANDIDATES = [
  '/etc/httpd/conf/httpd.conf',       // RHEL / CentOS
  '/etc/apache2/apache2.conf',        // Debian / Ubuntu
  '/etc/apache2/httpd.conf',          // macOS / certains Debian
];

async function findApacheConf() {
  for (const p of APACHE_CONF_CANDIDATES) {
    try { await fs.promises.access(p, fs.constants.R_OK); return p; } catch { /* try next */ }
  }
  return null;
}

// Directive simple : valeur sur la même ligne
function getDirective(text, name) {
  const re = new RegExp(`^\\s*${name}\\s+(.+)$`, 'im');
  const m = text.match(re);
  return m ? m[1].trim() : '';
}

// Remplace ou ajoute une directive simple
function setDirective(text, name, value) {
  const re = new RegExp(`^(\\s*)${name}(\\s+.*)$`, 'im');
  if (re.test(text)) {
    return text.replace(re, `$1${name} ${value}`);
  }
  return text + `\n${name} ${value}`;
}

// GET /api/config/apache
router.get('/apache', async (req, res) => {
  try {
    const confPath = await findApacheConf();
    if (!confPath) return res.status(404).json({ error: 'Fichier de configuration Apache introuvable' });
    const text = await fs.promises.readFile(confPath, 'utf8');

    // Apache status
    let status = 'unknown';
    try {
      await execAsync('systemctl is-active httpd || systemctl is-active apache2');
      status = 'active';
    } catch { status = 'inactive'; }

    res.json({
      conf_path:      confPath,
      server_name:    getDirective(text, 'ServerName'),
      server_admin:   getDirective(text, 'ServerAdmin'),
      listen:         getDirective(text, 'Listen'),
      document_root:  getDirective(text, 'DocumentRoot'),
      error_log:      getDirective(text, 'ErrorLog'),
      custom_log:     getDirective(text, 'CustomLog'),
      timeout:        getDirective(text, 'Timeout'),
      keep_alive:     getDirective(text, 'KeepAlive'),
      keep_alive_timeout: getDirective(text, 'KeepAliveTimeout'),
      max_req_workers:    getDirective(text, 'MaxRequestWorkers') || getDirective(text, 'MaxClients'),
      directory_index:    getDirective(text, 'DirectoryIndex'),
      status,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/config/apache — enregistrer les directives
router.post('/apache', async (req, res) => {
  try {
    const confPath = await findApacheConf();
    if (!confPath) return res.status(404).json({ error: 'Fichier de configuration Apache introuvable' });

    let text = await fs.promises.readFile(confPath, 'utf8');

    const EDITABLE = [
      ['server_name',         'ServerName'],
      ['server_admin',        'ServerAdmin'],
      ['listen',              'Listen'],
      ['document_root',       'DocumentRoot'],
      ['error_log',           'ErrorLog'],
      ['timeout',             'Timeout'],
      ['keep_alive',          'KeepAlive'],
      ['keep_alive_timeout',  'KeepAliveTimeout'],
      ['max_req_workers',     'MaxRequestWorkers'],
      ['directory_index',     'DirectoryIndex'],
    ];

    const body = req.body || {};
    for (const [key, directive] of EDITABLE) {
      if (body[key] !== undefined && String(body[key]).trim()) {
        text = setDirective(text, directive, String(body[key]).trim());
      }
    }

    // Backup + écriture
    await fs.promises.copyFile(confPath, confPath + '.ipam.bak');
    await fs.promises.writeFile(confPath, text, 'utf8');
    await addLog(req.user.username, 'APACHE_CONFIG_SAVE', `Directives mises à jour dans ${confPath}`, 'info');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/config/apache/test — tester la configuration
router.post('/apache/test', async (req, res) => {
  try {
    let out = '';
    for (const bin of ['apachectl', 'apache2ctl', '/usr/sbin/apachectl', '/usr/sbin/apache2ctl']) {
      try {
        const { stdout, stderr } = await execAsync(`${bin} configtest 2>&1`);
        out = stdout + stderr;
        break;
      } catch (e) { out = (e.stdout || '') + (e.stderr || e.message); break; }
    }
    const ok = /Syntax OK/i.test(out);
    res.json({ ok, output: out.trim() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/config/apache/reload — recharger Apache
router.post('/apache/reload', async (req, res) => {
  try {
    let out = '';
    try {
      const r = await execAsync('systemctl reload httpd 2>&1 || systemctl reload apache2 2>&1');
      out = r.stdout + r.stderr;
    } catch (e) { out = (e.stdout || '') + (e.stderr || e.message); }
    await addLog(req.user.username, 'APACHE_RELOAD', 'Apache rechargé via config GUI', 'info');
    res.json({ ok: true, output: out.trim() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/config/apache/confs — liste les fichiers de configuration dans conf.d/
router.get('/apache/confs', async (req, res) => {
  const CONF_DIRS = ['/etc/httpd/conf.d', '/etc/apache2/conf-enabled', '/etc/apache2/sites-enabled'];
  let confDir = null;
  for (const d of CONF_DIRS) {
    try { await fs.promises.access(d, fs.constants.R_OK); confDir = d; break; } catch { /* essai suivant */ }
  }
  if (!confDir) return res.status(404).json({ error: 'Répertoire conf.d introuvable' });

  try {
    const entries = await fs.promises.readdir(confDir, { withFileTypes: true });
    const files = entries
      .filter(e => e.isFile() && (e.name.endsWith('.conf') || e.name.endsWith('.disabled')))
      .map(e => ({
        name:     e.name,
        path:     path.join(confDir, e.name),
        enabled:  e.name.endsWith('.conf'),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ conf_dir: confDir, files });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/config/apache/confs/toggle — activer ou désactiver un fichier conf
router.post('/apache/confs/toggle', async (req, res) => {
  const { filename } = req.body || {};
  if (!filename || typeof filename !== 'string' || filename.includes('/') || filename.includes('..'))
    return res.status(400).json({ error: 'Nom de fichier invalide' });

  const CONF_DIRS = ['/etc/httpd/conf.d', '/etc/apache2/conf-enabled', '/etc/apache2/sites-enabled'];
  let confDir = null;
  for (const d of CONF_DIRS) {
    try { await fs.promises.access(d, fs.constants.R_OK); confDir = d; break; } catch { /* essai suivant */ }
  }
  if (!confDir) return res.status(404).json({ error: 'Répertoire conf.d introuvable' });

  const fullPath = path.join(confDir, filename);
  // Vérifier que le fichier est bien dans confDir (protection traversal)
  if (!fullPath.startsWith(confDir + path.sep)) return res.status(400).json({ error: 'Chemin invalide' });

  try {
    await fs.promises.access(fullPath, fs.constants.F_OK);
    let newName, action;
    if (filename.endsWith('.conf')) {
      newName = filename + '.disabled';
      action  = 'APACHE_CONF_DISABLE';
    } else if (filename.endsWith('.disabled')) {
      newName = filename.replace(/\.disabled$/, '');
      action  = 'APACHE_CONF_ENABLE';
    } else {
      return res.status(400).json({ error: 'Extension non reconnue (.conf ou .disabled attendu)' });
    }
    const newPath = path.join(confDir, newName);
    await fs.promises.rename(fullPath, newPath);
    await addLog(req.user.username, action, `${filename} → ${newName}`, 'info');
    res.json({ ok: true, new_name: newName, enabled: newName.endsWith('.conf') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/config/apache/vhost-ip — lit le ServerName dans ipam.conf
const IPAM_CONF = '/etc/httpd/conf.d/ipam.conf';

router.get('/apache/vhost-ip', requireSuperAdmin, async (req, res) => {
  try {
    const raw = await fs.promises.readFile(IPAM_CONF, 'utf8');
    const m   = raw.match(/^\s*ServerName\s+(\S+)/m);
    res.json({ ip: m?.[1] || '', conf: IPAM_CONF });
  } catch (e) {
    res.status(500).json({ error: `Impossible de lire ${IPAM_CONF} : ${e.message}` });
  }
});

// POST /api/config/apache/vhost-ip — met à jour le ServerName dans ipam.conf (ports 80 et 443)
router.post('/apache/vhost-ip', requireSuperAdmin, async (req, res) => {
  try {
    const { ip } = req.body || {};
    if (!ip?.trim()) return res.status(400).json({ error: 'IP ou domaine requis' });
    const ipClean = ip.trim();
    // Validation basique : pas de caractères dangereux
    if (/['"\\;<>&|`$]/.test(ipClean))
      return res.status(400).json({ error: 'Valeur invalide' });

    const raw = await fs.promises.readFile(IPAM_CONF, 'utf8');
    // Backup
    await fs.promises.writeFile(IPAM_CONF + '.ipam.bak', raw);
    // Remplacer toutes les occurrences de ServerName (ports 80 et 443)
    const updated = raw.replace(/(^\s*ServerName\s+)\S+/gm, `$1${ipClean}`);
    await fs.promises.writeFile(IPAM_CONF, updated, 'utf8');
    await addLog(req.user.username, 'APACHE_VHOST_IP', `ServerName ipam.conf → ${ipClean}`, 'warn');
    res.json({ ok: true, ip: ipClean });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/config/apache/server-ips — IPs réseau du serveur
// Plusieurs stratégies en cascade (netlink peut être indisponible en conteneur)
router.get('/apache/server-ips', async (req, res) => {
  // Stratégie 1 : hostname -I (pas de netlink, disponible partout)
  try {
    const { stdout } = await execAsync('hostname -I 2>/dev/null');
    const ips = stdout.trim().split(/\s+/).filter(Boolean).map(addr => ({
      address:  addr,
      cidr:     addr,
      family:   addr.includes(':') ? 'IPv6' : 'IPv4',
      iface:    '',
      internal: addr.startsWith('127.') || addr === '::1',
    }));
    if (ips.length) return res.json({ ips });
  } catch { /* essai suivant */ }

  // Stratégie 2 : lecture de /proc/net/fib_trie (IPv4 uniquement, sans netlink)
  try {
    const text  = await fs.promises.readFile('/proc/net/fib_trie', 'utf8');
    const seen  = new Set();
    const ips   = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      // Les lignes "LOCAL" contiennent l'adresse réelle
      if (/\bLOCAL\b/.test(lines[i])) {
        const m = lines[i - 1]?.match(/(\d+\.\d+\.\d+\.\d+)/);
        if (m && !seen.has(m[1])) {
          seen.add(m[1]);
          ips.push({ address: m[1], cidr: m[1], family: 'IPv4', iface: '', internal: m[1].startsWith('127.') });
        }
      }
    }
    if (ips.length) return res.json({ ips });
  } catch { /* essai suivant */ }

  res.status(500).json({ error: 'Impossible de détecter les IPs (netlink et /proc/net/fib_trie indisponibles)' });
});

export default router;
