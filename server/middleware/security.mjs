// =============================================================================
// IPAM SIW — Middlewares de sécurité serveur
// =============================================================================

// ---------------------------------------------------------------------------
// En-têtes HTTP de sécurité
// ---------------------------------------------------------------------------
export function securityHeaders(_req, res, next) {
  // Empêche le chargement dans un iframe (clickjacking)
  res.setHeader('X-Frame-Options', 'DENY');
  // Empêche le MIME sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Protection XSS basique pour anciens navigateurs
  res.setHeader('X-XSS-Protection', '1; mode=block');
  // Limite les informations envoyées au site référent
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Désactive caméra, micro, géoloc
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // CSP : scripts/styles depuis le même domaine uniquement (inline autorisé car nécessaire)
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
  next();
}

// ---------------------------------------------------------------------------
// Rate limiting sur /api/login — 10 tentatives max / 15 min / IP
// (stockage en mémoire, reset automatique)
// ---------------------------------------------------------------------------
const MAX_ATTEMPTS = 10;
const WINDOW_MS    = 15 * 60 * 1000; // 15 minutes
const _attempts    = new Map();

// Nettoyage toutes les 5 minutes pour éviter les fuites mémoire
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of _attempts) {
    if (now > entry.resetAt) _attempts.delete(ip);
  }
}, 5 * 60 * 1000);

export function loginRateLimit(req, res, next) {
  const ip  = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  let entry = _attempts.get(ip);

  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
    _attempts.set(ip, entry);
  }

  entry.count++;

  if (entry.count > MAX_ATTEMPTS) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    res.setHeader('Retry-After', retryAfter);
    return res.status(429).json({
      error: `Trop de tentatives de connexion. Réessayez dans ${Math.ceil(retryAfter / 60)} minute(s).`,
    });
  }

  // Expose une fonction de reset pour la réinitialiser après succès
  res.locals.resetLoginRate = () => _attempts.delete(ip);
  next();
}
