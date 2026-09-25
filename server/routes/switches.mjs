import express from 'express';
import {
  createSwitch, getSwitch, listSwitchesBySite, updateSwitch, deleteSwitch,
  setSwitchPort, deleteSwitchPort, getSwitchPorts,
  getSite, addLog, listServerHostnames, listSitesWithStats, redis,
} from '../redis.mjs';
import { requireAuth, requireAdmin } from '../middleware/auth.mjs';

const router = express.Router();

// Préfixes essayés dans l'ordre pour retrouver un site à partir d'un nom
// abrégé dans un fichier d'import (ex. "AJACCIO" -> "CREC AJACCIO").
const SITE_NAME_PREFIXES = ['', 'CREC ', 'DSIBA ', 'DOP ', 'EBR ', 'LBPE ', 'LBPF '];

function resolveSiteId(sitesByName, rawName) {
  const nameUp = String(rawName || '').trim().toUpperCase();
  if (!nameUp) return null;
  if (sitesByName.has(nameUp)) return sitesByName.get(nameUp);
  for (const prefix of SITE_NAME_PREFIXES) {
    const candidate = `${prefix}${nameUp}`.trim();
    if (sitesByName.has(candidate)) return sitesByName.get(candidate);
  }
  const matches = [...sitesByName.entries()].filter(([nm]) => nm.includes(nameUp));
  return matches.length === 1 ? matches[0][1] : null;
}

// GET /api/switches/servers — hostnames filtrés pour la combobox
router.get('/servers', requireAuth, async (_req, res) => {
  try {
    const servers = await listServerHostnames();
    res.json({ servers });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/switches/import  (admin) — import en masse depuis CSV/Excel
// (parsé côté client), format plat 1 ligne = 1 port :
//   { rows: [{ site, switch, model, port, server, description }, …] }
// Ne remplace JAMAIS l'existant : un switch déjà présent sur le site (même
// nom) est réutilisé, un port déjà présent sur un switch (même numéro) est
// ignoré — seuls les nouveaux switches/ports sont créés.
router.post('/import', requireAuth, requireAdmin, async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: 'Aucune ligne à importer' });

    const sites = (await listSitesWithStats()).filter(s => !s.archived);
    const sitesByName = new Map(sites.map(s => [s.name.trim().toUpperCase(), s.id]));

    const switchCache = new Map(); // `${siteId}::${NAME}` -> switchId
    const stats = { switch_created: 0, switch_reused: 0, port_added: 0, port_skipped: 0, rows_skipped: 0 };
    const unresolvedSites = new Set();
    const details = [];

    for (const row of rows) {
      const siteRaw   = String(row?.site || '').trim();
      const swRaw      = String(row?.switch || '').trim();
      const model      = String(row?.model || '').trim() || 'CISCO';
      const portRaw    = String(row?.port || '').trim();
      const serverRaw  = String(row?.server || '').trim();
      const description = String(row?.description || '').trim();

      if (!siteRaw || !swRaw || !portRaw || !serverRaw) { stats.rows_skipped++; continue; }

      const siteId = resolveSiteId(sitesByName, siteRaw);
      if (!siteId) { unresolvedSites.add(siteRaw); stats.rows_skipped++; continue; }

      const cacheKey = `${siteId}::${swRaw.toUpperCase()}`;
      let switchId = switchCache.get(cacheKey);
      let switchCreated = false;
      if (!switchId) {
        const existingIds = await redis.smembers(`site:${siteId}:switches`);
        for (const sid of existingIds) {
          const nm = await redis.hget(`switch:${sid}`, 'name');
          if ((nm || '').trim().toUpperCase() === swRaw.toUpperCase()) { switchId = sid; break; }
        }
        if (!switchId) {
          const created = await createSwitch(siteId, { name: swRaw, model });
          switchId = String(created.id);
          switchCreated = true;
        }
        switchCache.set(cacheKey, switchId);
        stats[switchCreated ? 'switch_created' : 'switch_reused']++;
      }

      const alreadyExists = await redis.hexists(`switch:${switchId}:ports`, portRaw);
      if (alreadyExists) {
        stats.port_skipped++;
        details.push({ switch: swRaw, port: portRaw, status: 'skipped' });
      } else {
        await setSwitchPort(switchId, portRaw, { server: serverRaw, description });
        stats.port_added++;
        details.push({ switch: swRaw, port: portRaw, status: 'added' });
      }
    }

    await addLog(req.user.username, 'IMPORT_SWITCHES', {
      switch_created: stats.switch_created, switch_reused: stats.switch_reused,
      port_added: stats.port_added, port_skipped: stats.port_skipped, rows_skipped: stats.rows_skipped,
    }, 'ok');

    res.json({ ...stats, unresolved_sites: [...unresolvedSites], details });
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
    // Express ne décode pas %2F dans un segment de route (sécurité anti-ambiguïté),
    // indispensable ici car les noms de port contiennent des "/" (ex. "Gi 1/0/13").
    const port = decodeURIComponent(req.params.port).trim();
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
    const port = decodeURIComponent(req.params.port).trim();
    await deleteSwitchPort(req.params.id, port);
    await addLog(req.user.username, 'DEL_PORT', `Port ${port} retiré du switch « ${sw.name} »`, 'info');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
