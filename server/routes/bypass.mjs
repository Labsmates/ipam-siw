// =============================================================================
// IPAM SIW — bypass.mjs  (Élévation temporaire via clé de bypass)
// POST /api/bypass/elevate  — accessible à tous les utilisateurs authentifiés
// =============================================================================

import { Router } from 'express';
import jwt         from 'jsonwebtoken';
import { requireAuth }              from '../middleware/auth.mjs';
import { getJwtSecret, validateAndUseBypassKey, addLog } from '../redis.mjs';

const router = Router();

// POST /api/bypass/elevate
// type = 'sa'  → admin → super admin (1h)
// type = 'adm' → user  → admin (1h)
router.post('/elevate', requireAuth, async (req, res) => {
  const { key, type } = req.body;

  if (!['sa', 'adm'].includes(type))
    return res.status(400).json({ error: 'Type invalide (sa ou adm)' });
  if (type === 'sa' && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Mode SA réservé aux administrateurs' });
  if (type === 'adm' && req.user.role === 'admin')
    return res.status(400).json({ error: 'Vous êtes déjà administrateur' });

  try {
    await validateAndUseBypassKey(key, req.user.username, type);
  } catch (e) {
    return res.status(403).json({ error: e.message });
  }

  const secret      = await getJwtSecret();
  const elevatedUser = {
    id:       req.user.id,
    username: req.user.username,
    role:     'admin',
    elevated: type,
  };
  const token      = jwt.sign(elevatedUser, secret, { expiresIn: '1h' });
  const expires_at = new Date(Date.now() + 3600_000).toISOString();

  const label = type === 'sa' ? 'Super Admin' : 'Admin';
  await addLog(req.user.username, `ELEVATE_${type.toUpperCase()}`,
    `Élévation ${label} activée (1h)`, 'info');

  res.json({ token, user: elevatedUser, expires_at });
});

export default router;
