// =============================================================================
// IPAM SIW — bypass.mjs  (Élévation temporaire via clé de bypass)
// POST /api/bypass/elevate  — accessible à tous les utilisateurs authentifiés
// =============================================================================

import { Router } from 'express';
import jwt         from 'jsonwebtoken';
import { requireAuth }              from '../middleware/auth.mjs';
import { getJwtSecret, validateAndUseBypassKey, addLog } from '../redis.mjs';

const router = Router();

// Seuls les identifiants commençant par P ou X (hors ADMIN) peuvent s'élever.
const PX_RE = /^[PX]/i;

// POST /api/bypass/elevate
// type = 'sa'  → admin (P/X) → super admin pendant 1h
// type = 'adm' → user  (P/X) → accès Configuration système uniquement pendant 1h
router.post('/elevate', requireAuth, async (req, res) => {
  const { key, type } = req.body;
  const { username, role } = req.user;

  if (!['sa', 'adm'].includes(type))
    return res.status(400).json({ error: 'Type invalide (sa ou adm)' });

  // Vérification identifiant P ou X
  if (!PX_RE.test(username))
    return res.status(403).json({ error: 'Élévation réservée aux identifiants P ou X' });

  // Mode SA : admins uniquement (pas le super-admin ADMIN qui n'en a pas besoin)
  if (type === 'sa' && role !== 'admin')
    return res.status(403).json({ error: 'Mode SA réservé aux administrateurs' });
  if (type === 'sa' && username === 'ADMIN')
    return res.status(400).json({ error: 'Le super-admin n\'a pas besoin de Mode SA' });

  // Mode Adm : utilisateurs uniquement
  if (type === 'adm' && role !== 'user')
    return res.status(403).json({ error: 'Mode Adm réservé aux utilisateurs' });

  try {
    await validateAndUseBypassKey(key, username, type);
  } catch (e) {
    return res.status(403).json({ error: e.message });
  }

  const secret = await getJwtSecret();

  // Mode SA  → role:'admin' + elevated:'sa'  (accès super-admin)
  // Mode Adm → role:'user'  + elevated:'adm' (accès config sys uniquement, pas admin complet)
  const elevatedUser = {
    id:       req.user.id,
    username,
    role:     type === 'sa' ? 'admin' : 'user',
    elevated: type,
  };
  const token      = jwt.sign(elevatedUser, secret, { expiresIn: '1h' });
  const expires_at = new Date(Date.now() + 3600_000).toISOString();

  const label = type === 'sa' ? 'Super Admin' : 'Config Sys';
  await addLog(username, `ELEVATE_${type.toUpperCase()}`,
    `Élévation ${label} activée (1h)`, 'info');

  res.json({ token, user: elevatedUser, expires_at });
});

export default router;
