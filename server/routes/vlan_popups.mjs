// =============================================================================
// IPAM SIW — vlan_popups.mjs  (Popups affichés à la réservation d'une IP)
// Message configurable par tag de VLAN (METIER, ADMIN, PROCEF, …), tous sites.
// Routes : /api/vlan-popups
//   GET  /  — lecture (tous les utilisateurs authentifiés)
//   PUT  /  — ajout / modif / suppression d'un tag (admin uniquement)
// =============================================================================

import express from 'express';
import { redis, addLog } from '../redis.mjs';
import { requireAuth, requireAdmin } from '../middleware/auth.mjs';

const router = express.Router();
router.use(requireAuth);

const KEY = 'config:vlan_popups';

async function load() {
  const raw = await redis.get(KEY);
  const obj = raw ? JSON.parse(raw) : {};
  return (obj && typeof obj === 'object') ? obj : {};
}

// GET /api/vlan-popups → { popups: { ADMIN: "…", METIER: "…" } }
router.get('/', async (req, res) => {
  try {
    const all = await load();
    const popups = {};
    for (const [tag, msg] of Object.entries(all)) {
      if (typeof msg === 'string' && msg.trim()) popups[tag] = msg;
    }
    res.json({ popups });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/vlan-popups  body { tag, message } — admin.
// message vide => suppression du tag.
router.put('/', requireAdmin, async (req, res) => {
  try {
    const tag = String(req.body?.tag || '').trim().toUpperCase();
    if (!tag) return res.status(400).json({ error: 'tag requis' });
    const message = typeof req.body?.message === 'string' ? req.body.message.slice(0, 10000) : '';
    const all = await load();
    if (message.trim()) all[tag] = message;
    else delete all[tag];
    await redis.set(KEY, JSON.stringify(all));
    await addLog(req.user.username, 'VLAN_POPUP_UPDATE', { tag, enabled: !!message.trim() });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
