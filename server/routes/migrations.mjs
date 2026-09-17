// =============================================================================
// IPAM SIW — migrations.mjs  (Migration Serveurs : ancien host/OS → nouveau host/OS)
// Routes : /api/migrations
//   GET    /?site_id=X   — liste des lignes d'un site (tous les rôles)
//   POST   /              — créer une ligne (tous sauf viewer)
//   PUT    /:id           — modifier (comment/resp_metier pour tous ; OLD/NEW
//                           hostname+OS réservé admin)
//   DELETE /:id           — supprimer (admin uniquement)
//   GET    /os-config     — catalogues OLD/NEW (entrées verrouillées masquées
//                           aux non-admins)
//   PUT    /os-config     — admin : remplace un des deux catalogues
// =============================================================================

import express from 'express';
import { redis, addLog, getSiteData } from '../redis.mjs';
import { requireAuth, requireAdmin } from '../middleware/auth.mjs';

const router = express.Router();
router.use(requireAuth);

function requireNonViewer(req, res, next) {
  if (req.user?.role === 'viewer')
    return res.status(403).json({ error: 'Accès refusé — les lecteurs ne peuvent pas modifier les données' });
  next();
}

// ---------------------------------------------------------------------------
// Catalogue des OS (configurable par l'admin)
// ---------------------------------------------------------------------------
const OS_KEY = 'config:migration_os';
const DEFAULT_OS = {
  old: [
    { value: '2016', icon: 'win2016', locked: false },
    { value: '2019', icon: 'win2016', locked: false },
    { value: '2022', icon: 'win2022', locked: true },
  ],
  new: [
    { value: '2022', icon: 'win2022', locked: false },
    { value: '2025', icon: 'win2025', locked: true },
  ],
};
// Icônes déjà présentes dans client/img/os/ — pas d'upload, on choisit parmi celles-ci
const ALLOWED_ICONS = new Set(['redhat', 'nutanix', 'win2016', 'win2022', 'win2025', 'hp', 'dell', 'gw']);

async function loadOsConfig() {
  const raw = await redis.get(OS_KEY);
  if (!raw) return DEFAULT_OS;
  try {
    const parsed = JSON.parse(raw);
    return {
      old: Array.isArray(parsed.old) && parsed.old.length ? parsed.old : DEFAULT_OS.old,
      new: Array.isArray(parsed.new) && parsed.new.length ? parsed.new : DEFAULT_OS.new,
    };
  } catch { return DEFAULT_OS; }
}

async function validateOs(list, value, isAdmin) {
  const cfg = await loadOsConfig();
  const entry = (cfg[list] || []).find(e => e.value === value);
  if (!entry) throw Object.assign(new Error(`OS "${value}" inconnu`), { status: 400 });
  if (entry.locked && !isAdmin) throw Object.assign(new Error(`OS "${value}" réservé aux administrateurs`), { status: 403 });
}

// GET /api/migrations/os-config
router.get('/os-config', async (req, res) => {
  try {
    const cfg = await loadOsConfig();
    const isAdmin = req.user?.role === 'admin';
    const filter = list => isAdmin ? list : list.filter(e => !e.locked);
    res.json({ old: filter(cfg.old), new: filter(cfg.new) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/migrations/os-config — admin, remplace un des deux catalogues
router.put('/os-config', requireAdmin, async (req, res) => {
  try {
    const { list, entries } = req.body || {};
    if (!['old', 'new'].includes(list)) return res.status(400).json({ error: 'list doit être "old" ou "new"' });
    if (!Array.isArray(entries)) return res.status(400).json({ error: 'entries requis' });
    const clean = [];
    const seen = new Set();
    for (const e of entries) {
      const value = String(e?.value || '').trim().slice(0, 20);
      const icon  = String(e?.icon || '').trim();
      if (!value || !ALLOWED_ICONS.has(icon)) continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      clean.push({ value, icon, locked: e.locked === true });
    }
    if (!clean.length) return res.status(400).json({ error: 'Au moins une entrée valide requise' });
    const cfg = await loadOsConfig();
    cfg[list] = clean;
    await redis.set(OS_KEY, JSON.stringify(cfg));
    await addLog(req.user.username, 'MIGRATION_OS_UPDATE', { list, count: clean.length });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// Popup post-Réserver/Utiliser — demande si l'IP concerne la migration en
// cours, avec redirection vers Migration Serveurs si l'utilisateur confirme.
// ---------------------------------------------------------------------------
const PROMPT_KEY = 'config:migration_prompt';
const DEFAULT_PROMPT = {
  enabled: true,
  message_reserve: 'Avez-vous réservé une IP dans le cadre de la migration Windows Serveur 2022 ? Si oui, merci de faire la correspondance dans Migration Serveurs.',
  message_use: 'Utilisez-vous cette IP dans le cadre de la migration Windows Serveur 2022 ? Si oui, merci de faire la correspondance dans Migration Serveurs.',
};

async function loadPromptConfig() {
  const raw = await redis.get(PROMPT_KEY);
  if (!raw) return DEFAULT_PROMPT;
  try {
    const parsed = JSON.parse(raw);
    return {
      enabled: parsed.enabled === true,
      message_reserve: typeof parsed.message_reserve === 'string' ? parsed.message_reserve : DEFAULT_PROMPT.message_reserve,
      message_use: typeof parsed.message_use === 'string' ? parsed.message_use : DEFAULT_PROMPT.message_use,
    };
  } catch { return DEFAULT_PROMPT; }
}

// GET /api/migrations/prompt-config
router.get('/prompt-config', async (req, res) => {
  try {
    const cfg = await loadPromptConfig();
    if (!cfg.enabled) return res.json({ enabled: false, message_reserve: '', message_use: '' });
    res.json(cfg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/migrations/prompt-config — admin uniquement
router.put('/prompt-config', requireAdmin, async (req, res) => {
  try {
    const { enabled, message_reserve, message_use } = req.body || {};
    const data = {
      enabled: enabled === true,
      message_reserve: typeof message_reserve === 'string' ? message_reserve.slice(0, 2000) : '',
      message_use: typeof message_use === 'string' ? message_use.slice(0, 2000) : '',
      updated_at: new Date().toISOString(),
    };
    await redis.set(PROMPT_KEY, JSON.stringify(data));
    await addLog(req.user.username, 'MIGRATION_PROMPT_UPDATE', { enabled: data.enabled });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Catégories de hostname jamais éligibles à la migration (mêmes motifs que
// isInfoExcluded() côté client — Gateway, iLO, iDRAC, Nutanix)
function isDeviceExcluded(hostname) {
  const h = (hostname || '').toUpperCase();
  if (!h) return false;
  return h.startsWith('GATEWAY') || h.startsWith('ILO-') || h.startsWith('IDRAC-') || /^(?:SPH|SPY|SQH)/.test(h);
}

// ---------------------------------------------------------------------------
// Résout un hostname vers son IP courante (statut Utilisé/Réservée) + tag VLAN.
// Éligible sur tous les VLAN sauf ADMIN ; exclut Gateway/iLO/iDRAC/Nutanix.
// ---------------------------------------------------------------------------
function resolveHost(siteData, hostname) {
  if (isDeviceExcluded(hostname)) return null;
  const ip = (siteData.ips || []).find(i => i.hostname === hostname && (i.status === 'Utilisé' || i.status === 'Réservée'));
  if (!ip) return null;
  const vlan = (siteData.vlans || []).find(v => String(v.id) === String(ip.vlan_id));
  const vlan_tag = (vlan?.description || '').trim().toUpperCase();
  if (vlan_tag === 'ADMIN') return null;
  return { ip_address: ip.ip_address, vlan_tag };
}

// GET /api/migrations?site_id=X
router.get('/', async (req, res) => {
  try {
    const siteId = req.query.site_id;
    if (!siteId) return res.status(400).json({ error: 'site_id requis' });
    const ids = await redis.smembers(`site:${siteId}:migrations`);
    if (!ids.length) return res.json({ migrations: [] });
    const pipe = redis.pipeline();
    ids.forEach(id => pipe.hgetall(`migration:${id}`));
    const rows = await pipe.exec();
    const migrations = ids
      .map((id, i) => ({ id: parseInt(id), ...rows[i][1] }))
      .filter(m => m.site_id)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json({ migrations });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/migrations — crée une ligne (tous sauf viewer)
router.post('/', requireNonViewer, async (req, res) => {
  try {
    const { site_id, old_hostname, old_os, new_hostname, new_os, comment, resp_metier } = req.body || {};
    if (!site_id) return res.status(400).json({ error: 'site_id requis' });
    if (!old_hostname || !new_hostname) return res.status(400).json({ error: "L'ancien et le nouveau hostname sont requis" });
    if (!comment?.trim()) return res.status(400).json({ error: 'Le commentaire est obligatoire' });
    if (!old_os || !new_os) return res.status(400).json({ error: 'Ancien et nouvel OS requis' });

    const isAdmin = req.user?.role === 'admin';
    await validateOs('old', old_os, isAdmin);
    await validateOs('new', new_os, isAdmin);

    const siteData = await getSiteData(site_id);
    if (!siteData) return res.status(404).json({ error: 'Site introuvable' });

    const oldHost = resolveHost(siteData, old_hostname);
    const newHost = resolveHost(siteData, new_hostname);
    if (!oldHost) return res.status(400).json({ error: `Hostname "${old_hostname}" introuvable ou non éligible (VLAN ADMIN, iLO/iDRAC/Nutanix exclus)` });
    if (!newHost) return res.status(400).json({ error: `Hostname "${new_hostname}" introuvable ou non éligible (VLAN ADMIN, iLO/iDRAC/Nutanix exclus)` });

    // Un hostname déjà engagé dans une migration active de ce site ne peut pas être repris
    const existingIds = await redis.smembers(`site:${site_id}:migrations`);
    if (existingIds.length) {
      const pipe = redis.pipeline();
      existingIds.forEach(id => pipe.hmget(`migration:${id}`, 'old_hostname', 'new_hostname'));
      const results = await pipe.exec();
      const used = new Set(results.flatMap(([, v]) => v || []));
      if (used.has(old_hostname) || used.has(new_hostname))
        return res.status(409).json({ error: 'Un de ces serveurs est déjà engagé dans une migration' });
    }

    const id  = String(await redis.incr('seq:migrations'));
    const now = new Date().toISOString();
    const row = {
      site_id: String(site_id),
      old_hostname, old_ip: oldHost.ip_address, old_os,
      new_hostname, new_ip: newHost.ip_address, new_os,
      comment: comment.trim(), resp_metier: (resp_metier || '').trim(),
      created_by: req.user.username, created_at: now, updated_at: now,
    };
    const pipe = redis.pipeline();
    pipe.hset(`migration:${id}`, row);
    pipe.sadd(`site:${site_id}:migrations`, id);
    await pipe.exec();
    await addLog(req.user.username, 'MIGRATION_CREATE', `${old_hostname} → ${new_hostname}`, 'ok', { site_id: String(site_id) });
    res.json({ ok: true, id: parseInt(id) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// PUT /api/migrations/:id
router.put('/:id', requireNonViewer, async (req, res) => {
  try {
    const row = await redis.hgetall(`migration:${req.params.id}`);
    if (!row?.site_id) return res.status(404).json({ error: 'Migration introuvable' });
    const isAdmin = req.user?.role === 'admin';
    const patch = { updated_at: new Date().toISOString() };

    if (req.body?.comment !== undefined) {
      if (!String(req.body.comment).trim()) return res.status(400).json({ error: 'Le commentaire est obligatoire' });
      patch.comment = String(req.body.comment).trim();
    }
    if (req.body?.resp_metier !== undefined) patch.resp_metier = String(req.body.resp_metier).trim();

    if (isAdmin) {
      const { old_hostname, new_hostname, old_os, new_os } = req.body || {};
      if (old_os !== undefined) { await validateOs('old', old_os, true); patch.old_os = old_os; }
      if (new_os !== undefined) { await validateOs('new', new_os, true); patch.new_os = new_os; }
      if (old_hostname !== undefined || new_hostname !== undefined) {
        const siteData = await getSiteData(row.site_id);
        if (old_hostname !== undefined) {
          const h = resolveHost(siteData, old_hostname);
          if (!h) return res.status(400).json({ error: `Hostname "${old_hostname}" invalide` });
          patch.old_hostname = old_hostname; patch.old_ip = h.ip_address;
        }
        if (new_hostname !== undefined) {
          const h = resolveHost(siteData, new_hostname);
          if (!h) return res.status(400).json({ error: `Hostname "${new_hostname}" invalide` });
          patch.new_hostname = new_hostname; patch.new_ip = h.ip_address;
        }
      }
      // Correction manuelle de l'IP (prime sur l'auto-résolution ci-dessus si les deux sont envoyées)
      if (req.body?.old_ip !== undefined) {
        const v = String(req.body.old_ip).trim();
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) return res.status(400).json({ error: 'Adresse OLD IP invalide' });
        patch.old_ip = v;
      }
    }

    await redis.hset(`migration:${req.params.id}`, patch);
    await addLog(req.user.username, 'MIGRATION_UPDATE', `#${req.params.id}`, 'ok', { site_id: row.site_id });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// DELETE /api/migrations/:id — admin uniquement
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const row = await redis.hgetall(`migration:${req.params.id}`);
    if (!row?.site_id) return res.status(404).json({ error: 'Migration introuvable' });
    const pipe = redis.pipeline();
    pipe.del(`migration:${req.params.id}`);
    pipe.srem(`site:${row.site_id}:migrations`, req.params.id);
    await pipe.exec();
    await addLog(req.user.username, 'MIGRATION_DELETE', `${row.old_hostname} → ${row.new_hostname}`, 'info', { site_id: row.site_id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
