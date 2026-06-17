import express from 'express';
import {
  createSwitch, getSwitch, listSwitchesBySite, updateSwitch, deleteSwitch,
  setSwitchPort, deleteSwitchPort, getSwitchPorts,
  getSite, addLog, listServerHostnames,
} from '../redis.mjs';
import { requireAuth, requireAdmin } from '../middleware/auth.mjs';

const router = express.Router();

// GET /api/switches/servers — hostnames filtrés pour la combobox
router.get('/servers', requireAuth, async (_req, res) => {
  try {
    const servers = await listServerHostnames();
    res.json({ servers });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/switches/site/:siteId
router.get('/site/:siteId', requireAuth, async (req, res) => {
  try {
    const site = await getSite(req.params.siteId);
    if (!site) return res.status(404).json({ error: 'Site introuvable' });
    const switches = await listSwitchesBySite(req.params.siteId);
    res.json({ switches });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/switches/:id/ports
router.get('/:id/ports', requireAuth, async (req, res) => {
  try {
    const sw = await getSwitch(req.params.id);
    if (!sw) return res.status(404).json({ error: 'Switch introuvable' });
    const ports = await getSwitchPorts(req.params.id);
    res.json({ ports });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/switches  (admin)
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { site_id, name, model, ip } = req.body || {};
    if (!site_id) return res.status(400).json({ error: 'site_id requis' });
    if (!name?.trim()) return res.status(400).json({ error: 'Nom du switch requis' });
    const site = await getSite(site_id);
    if (!site) return res.status(404).json({ error: 'Site introuvable' });
    const sw = await createSwitch(site_id, { name, model, ip });
    await addLog(req.user.username, 'ADD_SWITCH', `Switch « ${sw.name} » ajouté sur site « ${site.name} »`, 'ok');
    res.json(sw);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/switches/:id  (admin)
router.put('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const sw = await getSwitch(req.params.id);
    if (!sw) return res.status(404).json({ error: 'Switch introuvable' });
    const { name, model, ip } = req.body || {};
    if (name !== undefined && !String(name).trim()) return res.status(400).json({ error: 'Nom requis' });
    await updateSwitch(req.params.id, { name, model, ip });
    await addLog(req.user.username, 'UPD_SWITCH', `Switch « ${sw.name} » modifié`, 'info');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/switches/:id  (admin)
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const sw = await getSwitch(req.params.id);
    if (!sw) return res.status(404).json({ error: 'Switch introuvable' });
    await deleteSwitch(req.params.id);
    await addLog(req.user.username, 'DEL_SWITCH', `Switch « ${sw.name} » supprimé`, 'danger');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/switches/:id/ports/:port  (admin)
router.put('/:id/ports/:port', requireAuth, requireAdmin, async (req, res) => {
  try {
    const sw = await getSwitch(req.params.id);
    if (!sw) return res.status(404).json({ error: 'Switch introuvable' });
    const port = req.params.port.trim();
    if (!port) return res.status(400).json({ error: 'Numéro de port requis' });
    const { server, description } = req.body || {};
    if (!server?.trim()) return res.status(400).json({ error: 'Nom du serveur requis' });
    await setSwitchPort(req.params.id, port, { server, description });
    await addLog(req.user.username, 'SET_PORT', `Port ${port} → « ${server} » sur switch « ${sw.name} »`, 'ok');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/switches/:id/ports/:port  (admin)
router.delete('/:id/ports/:port', requireAuth, requireAdmin, async (req, res) => {
  try {
    const sw = await getSwitch(req.params.id);
    if (!sw) return res.status(404).json({ error: 'Switch introuvable' });
    await deleteSwitchPort(req.params.id, req.params.port);
    await addLog(req.user.username, 'DEL_PORT', `Port ${req.params.port} retiré du switch « ${sw.name} »`, 'info');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
