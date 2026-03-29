import express from 'express';
import { getLogs, clearLogs, clearArchiveLogs, deleteLogEntry } from '../redis.mjs';
import { requireAuth, requireAdmin, requireSuperAdmin } from '../middleware/auth.mjs';

const router = express.Router();

// GET /api/logs/archive (all authenticated users) — hostname release history
router.get('/archive', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 2000, 5000);
    const all = await getLogs(limit);
    const releases = all
      .filter(l => l.action === 'RELEASE_IP')
      .map(l => {
        try {
          const d = JSON.parse(l.details);
          return {
            username:   l.username,
            ip:         d.ip,
            hostname:   d.hostname,
            comment:    d.comment || '',
            created_at: l.created_at,
            _raw:       l._raw,
          };
        } catch { return null; }
      })
      .filter(Boolean);
    res.json({ releases });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/logs/archive — effacer toutes les entrées de libération (super admin only)
router.delete('/archive', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const count = await clearArchiveLogs();
    res.json({ ok: true, count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/logs (admin)
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 500, 5000);
    res.json({ logs: await getLogs(limit) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/logs/entry — supprimer un log individuel (super admin only)
router.delete('/entry', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { raw } = req.body || {};
    if (!raw) return res.status(400).json({ error: 'Entrée manquante' });
    const removed = await deleteLogEntry(raw);
    if (!removed) return res.status(404).json({ error: 'Entrée introuvable' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/logs — effacer tous les logs (super admin only)
router.delete('/', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    await clearLogs();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
