import express from 'express';
import { getVlan, updateVlan, deleteVlan, addLog } from '../redis.mjs';
import { requireAuth, requireAdmin } from '../middleware/auth.mjs';

const router = express.Router();

// PUT /api/vlans/:id (admin)
router.put('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const vlan = await getVlan(req.params.id);
    if (!vlan) return res.status(404).json({ error: 'VLAN introuvable' });
    await updateVlan(req.params.id, req.body || {});
    await addLog(req.user.username, 'UPDATE_VLAN', `VLAN ${vlan.vlan_id} mis à jour`, 'info');
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'CONFLICT') return res.status(409).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/vlans/:id (admin)
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const vlan = await getVlan(req.params.id);
    if (!vlan) return res.status(404).json({ error: 'VLAN introuvable' });
    await deleteVlan(req.params.id);
    await addLog(req.user.username, 'DEL_VLAN', `VLAN ${vlan.vlan_id} supprimé`, 'danger');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
