import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../redis.mjs';

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Non authentifié' });
  try {
    const secret = await getJwtSecret();
    req.user = jwt.verify(header.slice(7), secret);
    next();
  } catch {
    res.status(401).json({ error: 'Token invalide ou expiré' });
  }
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Accès refusé — rôle administrateur requis' });
  next();
}

export function requireSuperAdmin(req, res, next) {
  if (req.user?.username !== 'ADMIN')
    return res.status(403).json({ error: 'Accès refusé — super administrateur uniquement' });
  next();
}
