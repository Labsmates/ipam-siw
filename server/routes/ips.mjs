import express from 'express';
import { getIp, updateIp, addLog } from '../redis.mjs';
import { requireAuth } from '../middleware/auth.mjs';

const router = express.Router();

// PUT /api/ips/:id — modifier statut et/ou hostname
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { status, hostname } = req.body || {};
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
        JSON.stringify({ ip: ip.ip_address, hostname: ip.hostname }), 'info');
    }
    res.json({ ok: true });
  } catch (e) {
    if (e.message === 'Statut invalide') return res.status(400).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

export default router;
