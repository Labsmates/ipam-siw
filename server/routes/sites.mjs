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

  // Infrastructure utilitaire (IPAM, Docker, Rebond CFT...) — ne suit pas la
  // convention REGATE+SN/QN-ROLE##, comptée manuellement comme Linux, quel
  // que soit le domaine (même serveur vu sous plusieurs domaines).
  if (/IPAM|DOCKER|REBOND/i.test(label)) return { type: 'linux', role: 'XG' };

  // XG/XD (Linux/CFT) — détecté par motif de label, indépendant du domaine :
  // certains hostnames Linux restent déclarés sous le domaine Windows
  // .dct.adt.local plutôt que .sf.intra.laposte.fr (ex. GRXG02.dct.adt.local).
  if (/^[A-Z]{2}XG\d+$/i.test(label) || /^[A-Z]{2}XD\d+$/i.test(label)) return { type: 'linux', role: 'XG' };

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
    return null; // XG/XD déjà traités plus haut, indépendamment du domaine
  }

  if (lastDash < 0) return null;
  const suffix = label.slice(lastDash + 1);
  const m = suffix.match(/^([A-Z]{2})\d+$/i);
  if (!m) return null;
  return { type: 'windows', role: m[1].toUpperCase() };
}

// Compte les serveurs Windows/Linux distincts d'un site — VLAN ADMIN et
// IPMI exclus (interfaces de management/infra, pas des serveurs) ; tous
// les autres VLAN (METIER, PROCEF, CACI, etc.) comptent. `seen` est un Set
// fourni par l'appelant (portée site ou globale selon le besoin) — un
// hostname dupliqué entre un VLAN exclu et un VLAN éligible (ex. miroir
// ADMIN) ne doit jamais bloquer l'occurrence valide : l'exclusion VLAN est
// donc vérifiée AVANT de marquer `seen`.
function countSiteWindowsLinux(data, seen, counts) {
  const excludedVlanIds = new Set(
    (data?.vlans || [])
      .filter(v => ['ADMIN', 'IPMI'].includes((v.description || '').trim().toUpperCase()))
      .map(v => String(v.id))
  );
  for (const ip of (data?.ips || [])) {
    if (!ip.hostname || ip.status === 'Libre') continue;
    if (excludedVlanIds.has(String(ip.vlan_id))) continue;
    const key = ip.hostname.split('.')[0].toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const result = classifyHostname(ip.hostname);
    if (!result) continue;
    if (result.type === 'windows' && result.role !== 'IDRAC') counts.windows++;
    else if (result.type === 'linux') counts.linux++;
  }
}

// GET /api/sites/os-summary — total Windows/Linux distincts, tous sites
// confondus (hors sites archivés) — pastilles du menu "Sites IPAM".
router.get('/os-summary', requireAuth, async (req, res) => {
  try {
    const sites = (await listSitesWithStats()).filter(s => !s.archived);
    const seen = new Set();
    const counts = { windows: 0, linux: 0 };
    for (const s of sites) {
      countSiteWindowsLinux(await getSiteData(s.id), seen, counts);
    }
    res.json(counts);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/sites/metier-recap — récap Windows/Linux/Cluster Nutanix +
// nombre de serveurs par site, pour la vue d'accueil de Site IPAM (aucun
// site sélectionné).
// - totals.windows / totals.linux : mêmes chiffres que la page Statistiques
//   (VLAN ADMIN et IPMI exclus, dédupliqué globalement — identique à
//   GET /os-summary).
// - totals.nutanix_clusters : hostnames contenant "CLU" (ex.
//   SPHXXXXCLU.hdcadmin.sf.intra.laposte.fr), qui ne vivent QUE dans le
//   VLAN ADMIN — dédupliqués par site.
// - sites[].count : nombre de serveurs par site, même périmètre que les
//   totaux globaux (VLAN ADMIN et IPMI exclus — METIER, PROCEF, CACI, etc.
//   comptent tous), dédupliqué par site.
router.get('/metier-recap', requireAuth, async (req, res) => {
  try {
    const sites = (await listSitesWithStats()).filter(s => !s.archived);
    let nutanixClusters = 0;
    const seenGlobal = new Set();
    const globalCounts = { windows: 0, linux: 0 };
    const siteCounts = [];
    for (const s of sites) {
      const data = await getSiteData(s.id);

      countSiteWindowsLinux(data, seenGlobal, globalCounts);

      const adminVlanIds = new Set(
        (data?.vlans || [])
          .filter(v => (v.description || '').trim().toUpperCase() === 'ADMIN')
          .map(v => String(v.id))
      );

      // Cluster Nutanix — VLAN ADMIN uniquement, dédup par site
      let siteClu = 0;
      const seenClu = new Set();
      for (const ip of (data?.ips || [])) {
        if (!ip.hostname || ip.status === 'Libre') continue;
        if (!adminVlanIds.has(String(ip.vlan_id))) continue;
        const key = ip.hostname.split('.')[0].toUpperCase();
        if (!/CLU/.test(key) || seenClu.has(key)) continue;
        seenClu.add(key);
        siteClu++;
      }
      nutanixClusters += siteClu;

      // Compte par site — même périmètre que le total global (VLAN ADMIN/IPMI exclus)
      const siteCounts_ = { windows: 0, linux: 0 };
      countSiteWindowsLinux(data, new Set(), siteCounts_);
      siteCounts.push({ id: s.id, name: s.name, count: siteCounts_.windows + siteCounts_.linux });
    }
    res.json({ totals: { windows: globalCounts.windows, linux: globalCounts.linux, nutanix_clusters: nutanixClusters }, sites: siteCounts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/sites/hostname-conflicts — détecte les serveurs Windows dont le
// hostname ne correspond pas au Code Regate du site où ils sont rangés
// (Code Regate = 6 premiers caractères du hostname, ex. "138100SN-AF12" →
// "138100"). Ne vérifie que les sites dont le Code Regate est renseigné
// dans Configuration → Codes Site, Regate (admin/config.html) — impossible
// de détecter une anomalie sans référence. Si le code détecté correspond
// au Code Regate d'un AUTRE site, on le propose comme site probable.
router.get('/hostname-conflicts', requireAuth, async (req, res) => {
  try {
    const sites = (await listSitesWithStats()).filter(s => !s.archived);
    let siteCodes = [];
    try {
      const raw = await redis.get('config:infos');
      siteCodes = raw ? (JSON.parse(raw).site_codes || []) : [];
    } catch (_) {}

    const codeToSite = new Map(); // code_regate → {id, name}
    siteCodes.forEach(sc => {
      if (sc.code_regate) codeToSite.set(sc.code_regate.toUpperCase(), { id: sc.site_id, name: sc.site_name });
    });
    const configuredSites = siteCodes.filter(sc => sc.code_regate);

    const conflicts = [];
    for (const sc of configuredSites) {
      const site = sites.find(s => String(s.id) === String(sc.site_id));
      if (!site) continue;
      const codeRegate = sc.code_regate.toUpperCase();
      const data = await getSiteData(site.id);
      const seen = new Set();
      for (const ip of (data?.ips || [])) {
        if (!ip.hostname || ip.status === 'Libre') continue;
        const key = ip.hostname.split('.')[0].toUpperCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const result = classifyHostname(ip.hostname);
        if (!result || result.type !== 'windows' || result.role === 'IDRAC') continue;
        // Convention ZN (ex. 758100ZN-FS22) : infrastructure mutualisée dont le
        // préfixe ne suit volontairement pas le Code Regate du site où elle est
        // rangée — ne jamais signaler de conflit pour ces hostnames.
        if (result.role === 'ZN') continue;

        const detected = key.slice(0, codeRegate.length);
        if (detected === codeRegate) continue;

        const expected = codeToSite.get(detected);
        conflicts.push({
          hostname: ip.hostname,
          ip_address: ip.ip_address,
          current_site_id: site.id,
          current_site_name: site.name,
          detected_code: detected,
          expected_site_id: expected && String(expected.id) !== String(site.id) ? expected.id : null,
          expected_site_name: expected && String(expected.id) !== String(site.id) ? expected.name : null,
        });
      }
    }
    res.json({ conflicts });
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
