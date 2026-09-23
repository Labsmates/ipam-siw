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
import { redis, addLog, getSiteData, getLogs } from '../redis.mjs';
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
// Tags de VLAN connus (mêmes que le datalist de la Popup de réservation)
const KNOWN_VLAN_TAGS = ['METIER', 'ADMIN', 'PROCEF', 'IPMI', 'CACI', 'FLUX'];
const DEFAULT_PROMPT = {
  enabled: true,
  message_reserve: 'Avez-vous réservé une IP dans le cadre de la migration Windows Serveur 2022 ? Si oui, merci de faire la correspondance dans Migration Serveurs.',
  message_use: 'Utilisez-vous cette IP dans le cadre de la migration Windows Serveur 2022 ? Si oui, merci de faire la correspondance dans Migration Serveurs.',
  vlan_tags: ['METIER', 'PROCEF', 'CACI'],
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
      vlan_tags: Array.isArray(parsed.vlan_tags) && parsed.vlan_tags.length ? parsed.vlan_tags : DEFAULT_PROMPT.vlan_tags,
    };
  } catch { return DEFAULT_PROMPT; }
}

// GET /api/migrations/prompt-config
router.get('/prompt-config', async (req, res) => {
  try {
    const cfg = await loadPromptConfig();
    if (!cfg.enabled) return res.json({ enabled: false, message_reserve: '', message_use: '', vlan_tags: cfg.vlan_tags });
    res.json(cfg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/migrations/prompt-config — admin uniquement
router.put('/prompt-config', requireAdmin, async (req, res) => {
  try {
    const { enabled, message_reserve, message_use, vlan_tags } = req.body || {};
    const cleanTags = Array.isArray(vlan_tags)
      ? [...new Set(vlan_tags.map(t => String(t || '').trim().toUpperCase()).filter(t => KNOWN_VLAN_TAGS.includes(t)))]
      : [];
    const data = {
      enabled: enabled === true,
      message_reserve: typeof message_reserve === 'string' ? message_reserve.slice(0, 2000) : '',
      message_use: typeof message_use === 'string' ? message_use.slice(0, 2000) : '',
      vlan_tags: cleanTags.length ? cleanTags : DEFAULT_PROMPT.vlan_tags,
      updated_at: new Date().toISOString(),
    };
    await redis.set(PROMPT_KEY, JSON.stringify(data));
    await addLog(req.user.username, 'MIGRATION_PROMPT_UPDATE', { enabled: data.enabled, vlan_tags: data.vlan_tags });
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

// Retrouve le tag de VLAN d'une IP en la situant dans les réseaux des VLAN
// actuels du site — même logique que vlanTagForIp() côté client
// (client/js/migration.js), utilisée pour les IP archivées (libérées, donc
// absentes de siteData.ips).
function vlanTagForIp(siteData, ipAddress) {
  const parts = (ipAddress || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p))) return null;
  const ipInt = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  for (const vlan of siteData.vlans || []) {
    const [netAddr, bitsStr] = (vlan.network || '').split('/');
    const prefix = parseInt(bitsStr, 10);
    const netParts = (netAddr || '').split('.').map(Number);
    if (netParts.length !== 4 || netParts.some(p => isNaN(p)) || isNaN(prefix)) continue;
    const netInt = ((netParts[0] << 24) | (netParts[1] << 16) | (netParts[2] << 8) | netParts[3]) >>> 0;
    const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0;
    if ((ipInt & mask) === (netInt & mask)) return (vlan.description || '').trim().toUpperCase();
  }
  return null;
}

// Résout un hostname OLD soit en live (resolveHost), soit dans les
// libérations archivées du site (Archive) si l'IP a depuis été libérée —
// maintient la correspondance même après un "Libérer" dans Site IPAM
// (cohérent avec archivedOldCandidates() côté client).
async function resolveOldHost(siteData, siteId, hostname) {
  const live = resolveHost(siteData, hostname);
  if (live) return live;
  if (isDeviceExcluded(hostname)) return null;
  const all = await getLogs(2000);
  for (const l of all) {
    if (l.action !== 'RELEASE_IP') continue;
    let d;
    try { d = JSON.parse(l.details); } catch { continue; }
    if (d.hostname !== hostname) continue;
    if (d.site_id && String(d.site_id) !== String(siteId)) continue;
    const vlan_tag = vlanTagForIp(siteData, d.ip);
    if (vlan_tag === 'ADMIN') continue;
    return { ip_address: d.ip, vlan_tag };
  }
  return null;
}

// Motifs de classification OLD (Windows 2016 / Linux CFT) — mêmes que
// isWin2016()/isLinuxCft() côté client (migration.js), utilisés uniquement
// ici pour compter les serveurs encore éligibles à migrer (badge sidebar).
const WIN2016_RE = /(?:SN|QN)-[A-Z0-9]{2}/i;
const LINUX_RE   = /XG/i;
// Un hostname matchant aussi le motif NEW (win2022) n'est jamais compté côté
// OLD — mêmes règles que oldCandidates()/isWin2022() côté client.
const WIN2022_RE = /FS22|FS24|FS26|AP89|AP88|AP87|AP75|AP76|AF21|AF22/;

// GET /api/migrations/remaining-count — nombre de serveurs déjà migrés
// (migrated, lignes créées) et encore éligibles côté OLD (remaining, live,
// hors VLAN ADMIN, pas déjà repris dans une migration), tous sites confondus
// (hors sites archivés). Badge sidebar (affiche "migrated").
router.get('/remaining-count', async (req, res) => {
  try {
    const siteIds = await redis.smembers('sites');
    let remaining = 0;
    let migrated = 0;
    for (const siteId of siteIds) {
      const siteData = await getSiteData(siteId);
      if (!siteData || siteData.site?.archived === '1') continue;
      const migIds = await redis.smembers(`site:${siteId}:migrations`);
      const used = new Set();
      if (migIds.length) {
        const pipe = redis.pipeline();
        migIds.forEach(id => pipe.hgetall(`migration:${id}`));
        const rows = await pipe.exec();
        rows.forEach(([, m]) => {
          if (m?.old_hostname) used.add(m.old_hostname);
          if (m?.new_hostname) used.add(m.new_hostname);
          // Les saisies manuelles (Old/New "Autre") ne comptent pas comme
          // "migré" — voir client/js/migration.js (old_manual/new_manual).
          if (m?.old_manual !== '1' && m?.new_manual !== '1') migrated++;
        });
      }
      for (const ip of siteData.ips || []) {
        if (!ip.hostname || (ip.status !== 'Utilisé' && ip.status !== 'Réservée')) continue;
        if (isDeviceExcluded(ip.hostname)) continue;
        if (!(WIN2016_RE.test(ip.hostname) || LINUX_RE.test(ip.hostname))) continue;
        if (ip.os === 'win2022' || WIN2022_RE.test(ip.hostname)) continue;
        const vlan = (siteData.vlans || []).find(v => String(v.id) === String(ip.vlan_id));
        if ((vlan?.description || '').trim().toUpperCase() === 'ADMIN') continue;
        if (used.has(ip.hostname)) continue;
        remaining++;
      }
    }
    res.json({ remaining, migrated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// Backfill automatique — serveurs PROCEF et FICHIERS déjà migrés dans les
// faits (OLD et NEW tous deux présents et éligibles dans Site IPAM) mais
// sans ligne de migration enregistrée. Idempotent (vérifie les hostnames
// déjà engagés avant de créer) — exécuté à chaque GET /?site_id=X, donc à
// chaque ouverture de la page Migration Serveurs d'un site (et de la vue
// d'ensemble, qui appelle cette route pour tous les sites).
// ---------------------------------------------------------------------------

// PROCEF — détection générique par motif de rôle (les deux doivent être
// présents sur le même site pour créer la paire).
const PROCEF_PAIRS = [
  { old: 'AF11', new: 'AF21' },
  { old: 'AF12', new: 'AF22' },
];

// AP — détection générique par motif de rôle, même principe que PROCEF
// (toujours IP en VLAN METIER — voir findByCode()).
const AP_PAIRS = [
  { old: 'AP99', new: 'AP89' },
  { old: 'AP98', new: 'AP88' },
  { old: 'AP97', new: 'AP87' },
];

// FICHIERS — table exacte fournie par site (hostname complet sans domaine).
// 458100SN-FS04 migre vers le même NEW que 458100SN-FS12 (« mutualisé sur
// le FS22 ») ; 458100SN-FS03 (décommissionné) n'a volontairement pas de
// pendant NEW et n'apparaît donc pas ici.
const FICHIERS_PAIRS = [
  ['518100SN-FS12', '518100SN-FS22'], ['518100SN-FS14', '518100SN-FS24'],
  ['348100SN-FS14', '348100SN-FS24'],
  ['218100SN-FS12', '218100SN-FS22'], ['218100SN-FS14', '218100SN-FS24'],
  ['768100SN-FS12', '768100SN-FS22'],
  ['445490SN-FS01', '445490SN-FS21'],
  ['448100SN-FS06', '448100SN-FS26'], ['448100SN-FS12', '448100SN-FS22'],
  ['311810SN-FS14', '311810SN-FS24'], ['311810SN-FS15', '311810SN-FS25'], ['311810SN-FS16', '311810SN-FS26'],
  ['972880SN-FS12', '972880SN-FS22'],
  ['758100SN-FS12', '758100SN-FS22'], ['758100SN-FS14', '758100SN-FS24'], ['758100SN-FS20', '758100SN-FS26'],
  ['758100ZN-FS12', '758100ZN-FS22'],
  ['358100SN-FS12', '358100SN-FS22'], ['358100SN-FS14', '358100SN-FS24'],
  ['138100SN-FS12', '138100SN-FS22'], ['138100SN-FS14', '138100SN-FS24'],
  ['318100SN-FS12', '318100SN-FS22'], ['318100SN-FS14', '318100SN-FS24'],
  ['458100SN-FS05', '458100SN-FS25'], ['458100SN-FS12', '458100SN-FS22'], ['458100SN-FS04', '458100SN-FS22'],
  ['543560SN-FS02', '543560SN-FS22'],
  ['548100SN-FS06', '548100SN-FS26'], ['548100SN-FS12', '548100SN-FS22'],
  ['971880SN-FS12', '971880SN-FS22'],
  ['973880SN-FS12', '973880SN-FS22'],
  ['974880SN-FS12', '974880SN-FS22'],
];

function vlanTag(ip, siteData) {
  const vlan = (siteData.vlans || []).find(v => String(v.id) === String(ip.vlan_id));
  return (vlan?.description || '').trim().toUpperCase();
}
function eligibleIp(ip, siteData) {
  if (!ip || isDeviceExcluded(ip.hostname)) return false;
  return vlanTag(ip, siteData) !== 'ADMIN';
}
// Un même label/motif peut correspondre à plusieurs IP (ex. le serveur
// réel en VLAN METIER/PROCEF ET son miroir en VLAN ADMIN, ou son
// interface IDRAC/iLO) — on cherche parmi TOUTES les IP qui matchent
// celle qui est réellement éligible, au lieu de s'arrêter à la première
// trouvée (l'ordre de siteData.ips dépend de SMEMBERS Redis, non
// garanti). Priorité au VLAN METIER quand plusieurs IP éligibles
// matchent (ex. FICHIERS en METIER + PROCEF en VLAN PROCEF partageant
// un motif) — c'est l'IP METIER qui doit remonter en priorité.
function findByLabel(siteData, label) {
  const candidates = (siteData.ips || []).filter(i => i.hostname && i.hostname.split('.')[0].toUpperCase() === label
    && (i.status === 'Utilisé' || i.status === 'Réservée') && eligibleIp(i, siteData));
  return candidates.find(ip => vlanTag(ip, siteData) === 'METIER') || candidates[0] || null;
}
function findByCode(siteData, code) {
  const candidates = (siteData.ips || []).filter(i => i.hostname && i.hostname.toUpperCase().includes(code)
    && (i.status === 'Utilisé' || i.status === 'Réservée') && eligibleIp(i, siteData));
  return candidates.find(ip => vlanTag(ip, siteData) === 'METIER') || candidates[0] || null;
}

async function autoBackfillMigrations(siteId, siteData) {
  const existingIds = await redis.smembers(`site:${siteId}:migrations`);
  const used = new Set();
  if (existingIds.length) {
    const pipe = redis.pipeline();
    existingIds.forEach(id => pipe.hmget(`migration:${id}`, 'old_hostname', 'new_hostname'));
    const results = await pipe.exec();
    results.forEach(([, v]) => { (v || []).forEach(h => h && used.add(h)); });
  }

  const toCreate = [];
  for (const { old: oldCode, new: newCode } of PROCEF_PAIRS) {
    const oldIp = findByCode(siteData, oldCode);
    const newIp = findByCode(siteData, newCode);
    if (!oldIp || !newIp || used.has(oldIp.hostname) || used.has(newIp.hostname)) continue;
    toCreate.push({ old: oldIp, new: newIp, comment: 'Changement Serveurs' });
    used.add(oldIp.hostname); used.add(newIp.hostname);
  }
  for (const { old: oldCode, new: newCode } of AP_PAIRS) {
    const oldIp = findByCode(siteData, oldCode);
    const newIp = findByCode(siteData, newCode);
    if (!oldIp || !newIp || used.has(oldIp.hostname) || used.has(newIp.hostname)) continue;
    toCreate.push({ old: oldIp, new: newIp, comment: 'Migration Windows 2022' });
    used.add(oldIp.hostname); used.add(newIp.hostname);
  }
  for (const [oldLabel, newLabel] of FICHIERS_PAIRS) {
    const oldIp = findByLabel(siteData, oldLabel);
    const newIp = findByLabel(siteData, newLabel);
    // Le NEW n'est volontairement pas ajouté à `used` : autorise un même NEW
    // (ex. FS22) à recevoir deux OLD distincts (cas « mutualisé »).
    if (!oldIp || !newIp || used.has(oldIp.hostname)) continue;
    toCreate.push({ old: oldIp, new: newIp, comment: 'Migration Windows 2022' });
    used.add(oldIp.hostname);
  }
  if (!toCreate.length) return;

  const now = new Date().toISOString();
  for (const { old: oldIp, new: newIp, comment } of toCreate) {
    const id = String(await redis.incr('seq:migrations'));
    await redis.hset(`migration:${id}`, {
      site_id: String(siteId),
      old_hostname: oldIp.hostname, old_ip: oldIp.ip_address, old_os: '2016',
      new_hostname: newIp.hostname, new_ip: newIp.ip_address, new_os: '2022',
      comment,
      resp_metier: '', created_by: 'SYSTEM', created_at: now, updated_at: now,
    });
    await redis.sadd(`site:${siteId}:migrations`, id);
  }
}

// GET /api/migrations?site_id=X
router.get('/', async (req, res) => {
  try {
    const siteId = req.query.site_id;
    if (!siteId) return res.status(400).json({ error: 'site_id requis' });
    const siteData = await getSiteData(siteId);
    if (siteData && siteData.site?.archived !== '1') await autoBackfillMigrations(siteId, siteData);
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
    const { site_id, old_hostname, old_os, new_hostname, new_os, comment, resp_metier, old_manual, new_manual, old_ip_manual } = req.body || {};
    if (!site_id) return res.status(400).json({ error: 'site_id requis' });
    if (!old_hostname || !new_hostname) return res.status(400).json({ error: "L'ancien et le nouveau hostname sont requis" });
    if (!comment?.trim()) return res.status(400).json({ error: 'Le commentaire est obligatoire' });
    if (!old_os || !new_os) return res.status(400).json({ error: 'Ancien et nouvel OS requis' });

    const isAdmin = req.user?.role === 'admin';
    await validateOs('old', old_os, isAdmin);
    await validateOs('new', new_os, isAdmin);

    const siteData = await getSiteData(site_id);
    if (!siteData) return res.status(404).json({ error: 'Site introuvable' });

    let oldHost = await resolveOldHost(siteData, site_id, old_hostname);
    const newHost = resolveHost(siteData, new_hostname);
    // OLD introuvable en live ni en Archive : un admin peut saisir l'IP à la
    // main (saisie manuelle uniquement) — le serveur est alors enregistré
    // dans l'Archive après coup pour que la correspondance persiste.
    let registerInArchive = false;
    if (!oldHost && old_manual && isAdmin && old_ip_manual) {
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(old_ip_manual)) return res.status(400).json({ error: 'IP manuelle invalide' });
      oldHost = { ip_address: old_ip_manual, vlan_tag: null };
      registerInArchive = true;
    }
    if (!oldHost) return res.status(400).json({ error: `Hostname "${old_hostname}" introuvable ou non éligible (VLAN ADMIN, iLO/iDRAC/Nutanix exclus)` });
    if (!newHost) return res.status(400).json({ error: `Hostname "${new_hostname}" introuvable ou non éligible (VLAN ADMIN, iLO/iDRAC/Nutanix exclus)` });

    // Un hostname déjà engagé dans une migration active de ce site ne peut pas
    // être repris — sauf en saisie manuelle (old_manual/new_manual), où le
    // but explicite est de pouvoir remonter l'IP d'un serveur déjà engagé.
    const existingIds = await redis.smembers(`site:${site_id}:migrations`);
    if (existingIds.length) {
      const pipe = redis.pipeline();
      existingIds.forEach(id => pipe.hmget(`migration:${id}`, 'old_hostname', 'new_hostname'));
      const results = await pipe.exec();
      const used = new Set(results.flatMap(([, v]) => v || []));
      if ((!old_manual && used.has(old_hostname)) || (!new_manual && used.has(new_hostname)))
        return res.status(409).json({ error: 'Un de ces serveurs est déjà engagé dans une migration' });
    }

    const id  = String(await redis.incr('seq:migrations'));
    const now = new Date().toISOString();
    const row = {
      site_id: String(site_id),
      old_hostname, old_ip: oldHost.ip_address, old_os,
      new_hostname, new_ip: newHost.ip_address, new_os,
      old_manual: old_manual ? '1' : '0', new_manual: new_manual ? '1' : '0',
      comment: comment.trim(), resp_metier: (resp_metier || '').trim(),
      created_by: req.user.username, created_at: now, updated_at: now,
    };
    const pipe = redis.pipeline();
    pipe.hset(`migration:${id}`, row);
    pipe.sadd(`site:${site_id}:migrations`, id);
    await pipe.exec();
    await addLog(req.user.username, 'MIGRATION_CREATE', `${old_hostname} → ${new_hostname}`, 'ok', { site_id: String(site_id) });
    if (registerInArchive) {
      await addLog(req.user.username, 'RELEASE_IP', JSON.stringify({
        ip: oldHost.ip_address, hostname: old_hostname, comment: 'Migration 2022',
        site_id: String(site_id), site_name: siteData.site?.name || '',
      }), 'info', { ip_address: oldHost.ip_address, site_id: String(site_id) });
    }
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

    let archiveRegistration = null;
    if (isAdmin) {
      const { old_hostname, new_hostname, old_os, new_os, old_manual, new_manual, old_ip_manual } = req.body || {};
      if (old_os !== undefined) { await validateOs('old', old_os, true); patch.old_os = old_os; }
      if (new_os !== undefined) { await validateOs('new', new_os, true); patch.new_os = new_os; }
      if (old_hostname !== undefined || new_hostname !== undefined) {
        const siteData = await getSiteData(row.site_id);
        if (old_hostname !== undefined) {
          let h = await resolveOldHost(siteData, row.site_id, old_hostname);
          if (!h && old_manual && old_ip_manual) {
            if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(old_ip_manual)) return res.status(400).json({ error: 'IP manuelle invalide' });
            h = { ip_address: old_ip_manual };
            archiveRegistration = { ip: old_ip_manual, hostname: old_hostname, site_id: row.site_id, site_name: siteData.site?.name || '' };
          }
          if (!h) return res.status(400).json({ error: `Hostname "${old_hostname}" invalide` });
          patch.old_hostname = old_hostname; patch.old_ip = h.ip_address;
          patch.old_manual = old_manual ? '1' : '0';
        }
        if (new_hostname !== undefined) {
          const h = resolveHost(siteData, new_hostname);
          if (!h) return res.status(400).json({ error: `Hostname "${new_hostname}" invalide` });
          patch.new_hostname = new_hostname; patch.new_ip = h.ip_address;
          patch.new_manual = new_manual ? '1' : '0';
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
    if (archiveRegistration) {
      await addLog(req.user.username, 'RELEASE_IP', JSON.stringify({ ...archiveRegistration, comment: 'Migration 2022' }),
        'info', { ip_address: archiveRegistration.ip, site_id: archiveRegistration.site_id });
    }
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
