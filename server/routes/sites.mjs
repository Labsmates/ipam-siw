import express from 'express';
import { createSite, getSite, listSitesWithStats, getSiteData,
         renameSite, deleteSite, createVlan, importIps, cleanupBroadcastIps, addLog } from '../redis.mjs';
import { requireAuth, requireAdmin } from '../middleware/auth.mjs';

const router = express.Router();

// GET /api/sites
router.get('/', requireAuth, async (_req, res) => {
  try { res.json({ sites: await listSitesWithStats() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/sites/:id  — detail plat pour le frontend site.js
router.get('/:id([0-9]+)', requireAuth, async (req, res) => {
  try {
    const data = await getSiteData(req.params.id);
    if (!data) return res.status(404).json({ error: 'Site introuvable' });
    res.json({ ...data.site, vlans: data.vlans, ips: data.ips });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/sites/:id/data
router.get('/:id/data', requireAuth, async (req, res) => {
  try {
    const data = await getSiteData(req.params.id);
    if (!data) return res.status(404).json({ error: 'Site introuvable' });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/sites (admin)
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const name = (req.body?.name || '').trim().toUpperCase();
    if (!name) return res.status(400).json({ error: 'Nom requis' });
    const site = await createSite(name);
    await addLog(req.user.username, 'ADD_SITE', `Site « ${name} » créé`, 'ok');
    res.json(site);
  } catch (e) {
    if (e.code === 'CONFLICT') return res.status(409).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/sites/:id (admin)
router.put('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const newName = (req.body?.name || '').trim().toUpperCase();
    if (!newName) return res.status(400).json({ error: 'Nom requis' });
    const old = await getSite(req.params.id);
    if (!old) return res.status(404).json({ error: 'Site introuvable' });
    await renameSite(req.params.id, newName);
    await addLog(req.user.username, 'RENAME_SITE', `Site « ${old.name} » → « ${newName} »`, 'info');
    res.json({ ok: true, name: newName });
  } catch (e) {
    if (e.code === 'CONFLICT') return res.status(409).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/sites/:id (admin)
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const site = await getSite(req.params.id);
    if (!site) return res.status(404).json({ error: 'Site introuvable' });
    await deleteSite(req.params.id);
    await addLog(req.user.username, 'DEL_SITE', `Site « ${site.name} » supprimé`, 'danger');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/sites/:id/vlans (admin)
router.post('/:id/vlans', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { vlan_id, network, mask, gateway, ips = [] } = req.body || {};
    if (!vlan_id) return res.status(400).json({ error: 'VLAN ID requis' });
    const site = await getSite(req.params.id);
    if (!site) return res.status(404).json({ error: 'Site introuvable' });
    const result = await createVlan(req.params.id, String(vlan_id), network, mask, gateway, ips);
    await addLog(req.user.username, 'ADD_VLAN',
      `VLAN ${vlan_id} ajouté sur « ${site.name} » (${network || '—'}, ${result.added} IPs)`, 'ok');
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/sites/:id/ips/import
router.post('/:id/ips/import', requireAuth, async (req, res) => {
  try {
    const rows = req.body?.rows;
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'Aucune donnée' });
    const updated = await importIps(req.params.id, rows);
    await addLog(req.user.username, 'IMPORT', `${updated} IP(s) importée(s) sur site #${req.params.id}`, 'ok');
    res.json({ ok: true, updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/sites/cleanup-broadcast (admin)
router.post('/cleanup-broadcast', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await cleanupBroadcastIps();
    await addLog(req.user.username, 'CLEANUP', `${result.deleted} IP(s) broadcast supprimée(s)`, 'ok');
    res.json({ ok: true, deleted: result.deleted, report: result.report });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
