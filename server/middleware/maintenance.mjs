// =============================================================================
// IPAM SIW — middleware/maintenance.mjs
// Intercepte toutes les requêtes quand le mode maintenance est actif.
// Bypass : ?bypass=KEY  →  pose un cookie HttpOnly 8h  →  redirige sans param.
// =============================================================================

import path     from 'path';
import { fileURLToPath } from 'url';
import { redis } from '../redis.mjs';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.join(__dirname, '../../client');
const MAINT_KEY  = 'config:maintenance';

// Cache mémoire court (5 s) pour éviter un HGET Redis à chaque requête
let _cache   = null;
let _cacheTs = 0;
const CACHE_TTL = 5_000;

async function getConfig() {
  const now = Date.now();
  if (_cache !== null && now - _cacheTs < CACHE_TTL) return _cache;
  try {
    const raw = await redis.get(MAINT_KEY);
    _cache   = raw ? JSON.parse(raw) : { enabled: false };
    _cacheTs = now;
  } catch (_) {
    _cache = { enabled: false };
  }
  return _cache;
}

/** Invalider le cache après un toggle depuis l'API */
export function invalidateMaintenanceCache() {
  _cache   = null;
  _cacheTs = 0;
}

/** Parser les cookies de la requête sans dépendance externe */
function parseCookies(req) {
  const cookies = {};
  const hdr = req.headers.cookie;
  if (!hdr) return cookies;
  hdr.split(';').forEach(part => {
    const [k, ...v] = part.trim().split('=');
    if (k) cookies[k.trim()] = decodeURIComponent(v.join('='));
  });
  return cookies;
}

export async function maintenanceMiddleware(req, res, next) {
  // Toujours laisser passer : endpoint public de statut
  if (req.path === '/api/maintenance/status') return next();

  // Toujours laisser passer : routes admin de configuration (pour activer/désactiver)
  if (req.path.startsWith('/api/config/maintenance')) return next();

  const m = await getConfig();
  if (!m.enabled) return next();

  // ── Vérification du bypass ─────────────────────────────────────────────────
  const bypassKey = m.bypassKey || '';
  if (bypassKey) {
    const queryBypass  = req.query?.bypass;
    const cookieBypass = parseCookies(req).ipam_bypass;

    if (queryBypass === bypassKey) {
      // Poser le cookie et rediriger sans le paramètre (URL propre)
      res.setHeader('Set-Cookie',
        `ipam_bypass=${bypassKey}; HttpOnly; SameSite=Lax; Max-Age=${8 * 3600}; Path=/`);
      const remaining = { ...req.query };
      delete remaining.bypass;
      const qs = new URLSearchParams(remaining).toString();
      return res.redirect(302, req.path + (qs ? `?${qs}` : ''));
    }

    if (cookieBypass === bypassKey) return next();
  }

  // ── Maintenance active, pas de bypass ─────────────────────────────────────
  if (req.path.startsWith('/api/')) {
    return res.status(503).json({
      error:       'Site en maintenance',
      maintenance: true,
      message:     m.message || '',
    });
  }

  // Servir la page de maintenance (503)
  res.status(503).sendFile(path.join(CLIENT_DIR, 'maintenance.html'));
}
