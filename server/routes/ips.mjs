import express from 'express';
import { getIp, updateIp, deleteIp, searchAllIPs, addLog } from '../redis.mjs';
import { requireAuth } from '../middleware/auth.mjs';

const router = express.Router();

// GET /api/ips/search?q= — recherche globale d'une IP dans tous les sites
router.get('/search', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 3) return res.json({ results: [] });
  try {
    res.json({ results: await searchAllIPs(q) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/ips/:id — modifier statut et/ou hostname
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { status, hostname, comment } = req.body || {};
    if (status === undefined && hostname === undefined)
      return res.status(400).json({ error: 'Statut ou hostname requis' });
    const ip = await getIp(req.params.id);
    if (!ip) return res.status(404).json({ error: 'IP introuvable' });
    await updateIp(req.params.id, { status, hostname });
    const details = [
      status   !== undefined ? `statut → ${status}`            : null,
      hostname !== undefined ? `hostname → "${hostname || ''}"` : null,
    ].filter(Boolean).join(', ');
    await addLog(req.user.username, 'UPDATE_IP', `${ip.ip_address} : ${details}`,
      status === 'Libre' ? 'info' : 'ok');
    // Archive entry when an IP is released and had a hostname
    if (status === 'Libre' && ip.hostname) {
      await addLog(req.user.username, 'RELEASE_IP',
        JSON.stringify({ ip: ip.ip_address, hostname: ip.hostname, comment: (comment || '').slice(0, 300) }), 'info');
    }
    res.json({ ok: true });
  } catch (e) {
    if (e.message === 'Statut invalide') return res.status(400).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/ips/:id — supprime définitivement une IP .255 (broadcast)
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const ip = await getIp(req.params.id);
    if (!ip) return res.status(404).json({ error: 'IP introuvable' });
    if (!ip.ip_address.endsWith('.255'))
      return res.status(403).json({ error: 'Suppression réservée aux adresses .255' });
    await deleteIp(req.params.id);
    await addLog(req.user.username, 'DEL_IP', `${ip.ip_address} supprimée`, 'info');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
