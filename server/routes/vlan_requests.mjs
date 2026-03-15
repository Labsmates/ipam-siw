import express from 'express';
import {
  getSite, createVlan, addLog,
  createVlanRequest, listVlanRequests, getVlanRequest, deleteVlanRequest,
} from '../redis.mjs';
import { requireAuth, requireAdmin } from '../middleware/auth.mjs';
import { cidrToIPs } from '../utils.mjs';

const router = express.Router();

// POST /api/vlan_requests — any authenticated user submits a request
router.post('/', requireAuth, async (req, res) => {
  try {
    const { site_id, vlan_id, network, mask, gateway } = req.body || {};
    if (!site_id || !vlan_id) return res.status(400).json({ error: 'site_id et vlan_id requis' });
    const site = await getSite(site_id);
    if (!site) return res.status(404).json({ error: 'Site introuvable' });
    const req2 = await createVlanRequest(site_id, site.name, String(vlan_id), network, mask, gateway, req.user.username);
    await addLog(req.user.username, 'REQUEST_VLAN',
      `Demande VLAN ${vlan_id} sur « ${site.name} » (${network || '—'})`, 'info');
    res.json({ ok: true, id: req2.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/vlan_requests — admin only
router.get('/', requireAuth, requireAdmin, async (_req, res) => {
  try { res.json({ requests: await listVlanRequests() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/vlan_requests/:id/approve — admin only
router.post('/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  try {
    const r = await getVlanRequest(req.params.id);
    if (!r) return res.status(404).json({ error: 'Demande introuvable' });

    // Generate IPs if CIDR
    let ipList = [];
    if (r.network && r.network.includes('/')) {
      try { ipList = cidrToIPs(r.network); } catch (_) { /* skip bad CIDR */ }
    }

    const result = await createVlan(r.site_id, r.vlan_id, r.network, r.mask, r.gateway, ipList);
    await deleteVlanRequest(req.params.id);
    await addLog(req.user.username, 'APPROVE_VLAN',
      `VLAN ${r.vlan_id} approuvé sur « ${r.site_name} » (demandé par ${r.username}, ${result.added} IPs)`, 'ok');
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/vlan_requests/:id — admin rejects
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const r = await getVlanRequest(req.params.id);
    if (!r) return res.status(404).json({ error: 'Demande introuvable' });
    await deleteVlanRequest(req.params.id);
    await addLog(req.user.username, 'REJECT_VLAN',
      `VLAN ${r.vlan_id} refusé sur « ${r.site_name} » (demandé par ${r.username})`, 'warn');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
