// =============================================================================
// IPAM SIW — nettools.mjs  (Ping, Traceroute, Scan réseau)
// Accessible à tous les utilisateurs authentifiés.
// =============================================================================

import { Router } from 'express';
import { spawn  } from 'child_process';
import { requireAuth } from '../middleware/auth.mjs';

const router = Router();

// Validation IP ou FQDN — aucune injection possible car spawn sans shell
const IP_RE   = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const FQDN_RE = /^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*$/;

function isValidIP(ip) {
  if (!ip || typeof ip !== 'string') return false;
  const m = IP_RE.exec(ip.trim());
  return !!(m && m.slice(1).every(n => parseInt(n) <= 255));
}

function isValidTarget(target) {
  if (!target || typeof target !== 'string') return false;
  const t = target.trim();
  if (t.length > 253) return false;
  return isValidIP(t) || FQDN_RE.test(t);
}

// Exécution sécurisée — spawn sans shell, timeout imposé
function run(cmd, args, timeoutMs = 30_000) {
  return new Promise(resolve => {
    let out = '', err = '';
    const proc = spawn(cmd, args, { timeout: timeoutMs });
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('close', code => resolve({ output: out || err, code }));
    proc.on('error', e   => resolve({
      output: `Commande introuvable : ${cmd}\n${e.message}\n` +
              (cmd === 'traceroute' ? 'Installez-la : dnf install traceroute' : ''),
      code: -1,
    }));
  });
}

function ipToInt(ip) { return ip.split('.').reduce((a, n) => a * 256 + parseInt(n), 0); }
function intToIp(n)  { return [(n>>>24)&0xFF,(n>>>16)&0xFF,(n>>>8)&0xFF,n&0xFF].join('.'); }

// ── POST /api/nettools/ping ───────────────────────────────────────────────────
router.post('/ping', requireAuth, async (req, res) => {
  const { target } = req.body;
  if (!isValidTarget(target)) return res.status(400).json({ error: 'IP ou FQDN invalide' });
  const { output, code } = await run('ping', ['-c', '4', '-W', '2', target.trim()]);
  res.json({ output, success: code === 0 });
});

// ── POST /api/nettools/traceroute ─────────────────────────────────────────────
router.post('/traceroute', requireAuth, async (req, res) => {
  const { target } = req.body;
  if (!isValidTarget(target)) return res.status(400).json({ error: 'IP ou FQDN invalide' });
  const { output, code } = await run(
    'traceroute', ['-n', '-w', '2', '-m', '20', target.trim()], 90_000
  );
  res.json({ output, success: code === 0 });
});

// ── POST /api/nettools/scan ───────────────────────────────────────────────────
// Limite : /22 → /30 (max 1022 hôtes) pour éviter les scans excessifs
router.post('/scan', requireAuth, async (req, res) => {
  const { network, prefix } = req.body;
  if (!isValidIP(network)) return res.status(400).json({ error: 'Réseau invalide' });
  const p = parseInt(prefix);
  if (isNaN(p) || p < 22 || p > 30)
    return res.status(400).json({ error: 'Préfixe doit être entre /22 et /30' });

  const maskInt  = (0xFFFFFFFF << (32 - p)) >>> 0;
  const netInt   = (ipToInt(network.trim()) & maskInt) >>> 0;
  const bcastInt = (netInt | (~maskInt >>> 0)) >>> 0;

  const ips = [];
  for (let i = netInt + 1; i < bcastInt; i++) ips.push(intToIp(i));

  // Pings en parallèle — lots de 50 avec timeout 1 s
  const BATCH = 50;
  const alive = [];
  for (let i = 0; i < ips.length; i += BATCH) {
    const batch   = ips.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(ip =>
        run('ping', ['-c', '1', '-W', '1', ip], 3_000)
          .then(({ code }) => ({ ip, alive: code === 0 }))
      )
    );
    alive.push(...results.filter(r => r.alive).map(r => r.ip));
  }

  res.json({ alive, total: ips.length, responding: alive.length });
});

export default router;
