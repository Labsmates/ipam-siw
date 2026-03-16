import express from 'express';
import {
  createAccountRequest, listAccountRequests, getAccountRequest, deleteAccountRequest,
  createUserWithHash, addLog,
} from '../redis.mjs';
import { requireAuth, requireAdmin } from '../middleware/auth.mjs';

const router = express.Router();

const USERNAME_RE = /^[PX][A-Z]{3}\d{3}$/;

// POST /api/account_requests — public, no auth required
router.post('/', async (req, res) => {
  try {
    const { full_name, username, password } = req.body || {};
    if (!full_name?.trim())
      return res.status(400).json({ error: 'Nom et prénom requis' });
    if (!username?.trim())
      return res.status(400).json({ error: 'Identifiant requis' });
    if (!password || password.length < 8)
      return res.status(400).json({ error: 'Mot de passe : minimum 8 caractères' });

    const uname = username.trim().toUpperCase();
    if (!USERNAME_RE.test(uname))
      return res.status(400).json({ error: "Format invalide. L'identifiant doit commencer par P ou X, suivi de 3 lettres et 3 chiffres (ex: PJFY579)" });

    const req2 = await createAccountRequest(full_name.trim(), uname, password);
    res.json({ ok: true, id: req2.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/account_requests — admin only
router.get('/', requireAuth, requireAdmin, async (_req, res) => {
  try { res.json({ requests: await listAccountRequests() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/account_requests/:id/approve — admin only
router.post('/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  try {
    const r = await getAccountRequest(req.params.id);
    if (!r) return res.status(404).json({ error: 'Demande introuvable' });

    const user = await createUserWithHash(r.username, r.pw_hash, 'user', r.full_name);
    await deleteAccountRequest(req.params.id);
    await addLog(req.user.username, 'APPROVE_ACCOUNT',
      `Compte « ${r.username} » (${r.full_name}) approuvé (rôle : utilisateur)`, 'ok');
    res.json({ ok: true, id: user.id });
  } catch (e) {
    if (e.code === 'CONFLICT') return res.status(409).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/account_requests/:id — admin rejects
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const r = await getAccountRequest(req.params.id);
    if (!r) return res.status(404).json({ error: 'Demande introuvable' });
    await deleteAccountRequest(req.params.id);
    await addLog(req.user.username, 'REJECT_ACCOUNT',
      `Demande de compte « ${r.username} » (${r.full_name}) refusée`, 'warn');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
