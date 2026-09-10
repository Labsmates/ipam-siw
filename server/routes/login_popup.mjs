// =============================================================================
// IPAM SIW — login_popup.mjs  (Popup de connexion configurable)
// Routes : /api/login-popup
//   GET  /  — lecture (tous les utilisateurs authentifiés)
//   PUT  /  — édition (admin uniquement)
// =============================================================================

import express from 'express';
import { redis, addLog } from '../redis.mjs';
import { sha256 } from '../utils.mjs';
import { requireAuth, requireAdmin } from '../middleware/auth.mjs';

const router = express.Router();
router.use(requireAuth);

const KEY = 'config:login_popup';

async function load() {
  const raw  = await redis.get(KEY);
  const data = raw ? JSON.parse(raw) : {};
  return {
    enabled:    data.enabled === true,
    message:    typeof data.message === 'string' ? data.message : '',
    updated_at: data.updated_at || null,
  };
}

// GET /api/login-popup — état + version (hash du message, sert à réinitialiser
// la case « ne plus afficher » côté client dès que le texte change).
router.get('/', async (req, res) => {
  try {
    const d      = await load();
    const active = d.enabled && d.message.trim().length > 0;
    res.json({
      enabled: active,
      message: active ? d.message : '',
      version: active ? sha256(d.message).slice(0, 12) : '',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/login-popup — admin uniquement
router.put('/', requireAdmin, async (req, res) => {
  try {
    const { enabled, message } = req.body || {};
    const msg  = typeof message === 'string' ? message.slice(0, 10000) : '';
    const data = { enabled: enabled === true, message: msg, updated_at: new Date().toISOString() };
    await redis.set(KEY, JSON.stringify(data));
    await addLog(req.user.username, 'LOGIN_POPUP_UPDATE', { enabled: data.enabled, length: msg.length });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
