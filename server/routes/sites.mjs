import express from 'express';
import { createSite, getSite, listSitesWithStats, getSiteData,
         renameSite, deleteSite, createVlan, importIps, cleanupBroadcastIps, addLog, updateSiteFields, setSiteArchived, redis } from '../redis.mjs';
import { requireAuth, requireAdmin } from '../middleware/auth.mjs';

const router = express.Router();

// GET /api/sites
router.get('/', requireAuth, async (req, res) => {
  try {
    let sites = await listSitesWithStats();
    const includeArchived = req.query.all === '1' && req.user.role === 'admin';
    if (!includeArchived) sites = sites.filter(s => !s.archived);
    try {
      const raw = await redis.get('config:infos');
      const infos = raw ? JSON.parse(raw) : {};
      const siteCodesMap = {};
      (infos.site_codes || []).forEach(sc => { siteCodesMap[String(sc.site_id)] = sc; });
      sites.forEach(s => {
        const entry = siteCodesMap[String(s.id)];
        if (entry) {
          if (entry.code        && !s.site_code)   s.site_code   = entry.code;
          if (entry.code_regate && !s.code_regate) s.code_regate = entry.code_regate;
          if (entry.code_pst    && !s.code_pst)    s.code_pst    = entry.code_pst;
        }
      });
    } catch (_) {}
    res.json({ sites });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// Classification Windows/Linux — même logique que classifyHostname() côté
// client (client/js/stats.js), utilisée uniquement ici pour les pastilles
// du menu "Sites IPAM" (badge bleu = Windows, rouge = Linux). IDRAC/iLO
// exclus du total (ce sont des interfaces de management, pas des OS).
// ---------------------------------------------------------------------------
const WIN_DOMAIN  = '.dct.adt.local';
const LIN_DOMAINS = ['.hdcadmin.sf.intra.laposte.fr', '.sf.intra.laposte.fr'];

function classifyHostname(raw) {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const label = raw.split('.')[0];

  if (/^(IDRAC|ILO)-/i.test(label)) return { type: 'windows', role: 'IDRAC' };

  const lastDash = label.lastIndexOf('-');
  if (lastDash >= 0) {
    const prefix = label.slice(0, lastDash);
    if (/ZN$/i.test(prefix)) return { type: 'windows', role: 'ZN' };
    if (/QN$/i.test(prefix)) return { type: 'windows', role: 'QN' };
  }

  const isWindows = lower.endsWith(WIN_DOMAIN);
  const isLinux   = LIN_DOMAINS.some(d => lower.endsWith(d));
  if (!isWindows && !isLinux) return null;

  if (isLinux) {
    if (/^SP/i.test(label)) return { type: 'nutanix', role: 'SPHY' };
    if (label.match(/^[A-Z]{2}XG\d+$/i)) return { type: 'linux', role: 'XG' };
    if (label.match(/^[A-Z]{2}XD\d+$/i)) return { type: 'linux', role: 'XG' };
    return null;
  }

  if (lastDash < 0) return null;
  const suffix = label.slice(lastDash + 1);
  const m = suffix.match(/^([A-Z]{2})\d+$/i);
  if (!m) return null;
  return { type: 'windows', role: m[1].toUpperCase() };
}

// GET /api/sites/os-summary — total Windows/Linux distincts, tous sites
// confondus (hors sites archivés) — pastilles du menu "Sites IPAM".
router.get('/os-summary', requireAuth, async (req, res) => {
  try {
    const sites = (await listSitesWithStats()).filter(s => !s.archived);
    let windows = 0, linux = 0;
    const seen = new Set();
    for (const s of sites) {
      const data = await getSiteData(s.id);
      for (const ip of (data?.ips || [])) {
        if (!ip.hostname || ip.status === 'Libre') continue;
        const key = ip.hostname.split('.')[0].toUpperCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const result = classifyHostname(ip.hostname);
        if (!result) continue;
        if (result.type === 'windows' && result.role !== 'IDRAC') windows++;
        else if (result.type === 'linux') linux++;
      }
    }
    res.json({ windows, linux });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/sites/:id  — detail plat pour le frontend site.js
router.get('/:id([0-9]+)', requireAuth, async (req, res) => {
  try {
    const data = await getSiteData(req.params.id);
    if (!data) return res.status(404).json({ error: 'Site introuvable' });
    const site = { ...data.site };
    // Enrichir code / code_regate / code_pst depuis config:infos si absents du hash site
    try {
      const raw = await redis.get('config:infos');
      const infos = raw ? JSON.parse(raw) : {};
      const entry = (infos.site_codes || []).find(sc => String(sc.site_id) === String(req.params.id));
      if (entry) {
        if (entry.code       && !site.site_code)    site.site_code    = entry.code;
        if (entry.code_regate && !site.code_regate) site.code_regate  = entry.code_regate;
        if (entry.code_pst    && !site.code_pst)    site.code_pst     = entry.code_pst;
      }
    } catch (_) {}
    res.json({ ...site, vlans: data.vlans, ips: data.ips });
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

// PATCH /api/sites/:id/codes (admin) — code_regate, code_pst
router.patch('/:id/codes', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { code_regate, code_pst } = req.body || {};
    const site = await getSite(req.params.id);
    if (!site) return res.status(404).json({ error: 'Site introuvable' });
    const fields = {};
    if (code_regate !== undefined) fields.code_regate = String(code_regate || '').trim().toUpperCase().slice(0, 10);
    if (code_pst     !== undefined) fields.code_pst    = String(code_pst    || '').trim().toUpperCase().slice(0, 10);
    await updateSiteFields(req.params.id, fields);
    await addLog(req.user.username, 'UPDATE_SITE_CODES', `Codes site « ${site.name} » mis à jour`, 'info');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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

// PATCH /api/sites/:id/archive (admin)
router.patch('/:id/archive', requireAuth, requireAdmin, async (req, res) => {
  try {
    const archived = !!req.body?.archived;
    const site = await getSite(req.params.id);
    if (!site) return res.status(404).json({ error: 'Site introuvable' });
    const { vlan_count, ip_count } = await setSiteArchived(req.params.id, archived);
    await addLog(req.user.username, archived ? 'ARCHIVE_SITE' : 'UNARCHIVE_SITE',
      `Site « ${site.name} » ${archived ? 'archivé' : 'désarchivé'} (${vlan_count} VLAN(s), ${ip_count} IP(s))`,
      archived ? 'info' : 'ok');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/sites/:id/vlans (admin)
router.post('/:id/vlans', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { vlan_id, network, mask, gateway, ips = [] } = req.body || {};
    if (!vlan_id) return res.status(400).json({ error: 'VLAN ID requis' });
    if (!/^\d+$/.test(String(vlan_id))) return res.status(400).json({ error: 'VLAN ID doit être un nombre entier' });
    const site = await getSite(req.params.id);
    if (!site) return res.status(404).json({ error: 'Site introuvable' });
    const result = await createVlan(req.params.id, String(vlan_id), network, mask, gateway, ips);
    await addLog(req.user.username, 'ADD_VLAN',
      `VLAN ${vlan_id} ajouté sur « ${site.name} » (${network || '—'}, ${result.added} IPs)`, 'ok');
    res.json({ ok: true, ...result });
  } catch (e) {
    if (e.code === 'CONFLICT') return res.status(409).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sites/:id/ips/import
router.post('/:id/ips/import', requireAuth, requireAdmin, async (req, res) => {
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
