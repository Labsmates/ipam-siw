// =============================================================================
// IPAM SIW — infos.mjs  (Informations réseau — lecture pour tous, édition admin)
// Routes : /api/infos/*
// =============================================================================

import express from 'express';
import { redis, addLog } from '../redis.mjs';
import { requireAuth, requireAdmin } from '../middleware/auth.mjs';

const router = express.Router();
router.use(requireAuth);

const KEY = 'config:infos';

const DEFAULTS = {
  dns1:      '194.5.88.5',
  dns2:      '194.5.88.133',
  dns_dc:    '200.16.1.11',
  route_psm: '10.19.1.1:28',
  domains:   ['dct.dat.local', 'hdcadmin.sf.intra.laposte.local', 'sf.intra.laposte.local'],
  site_codes: [],
  notes:     '',
};

async function load() {
  const raw = await redis.get(KEY);
  const data = raw ? JSON.parse(raw) : {};
  return {
    ...DEFAULTS, ...data,
    domains:    data.domains    ?? [...DEFAULTS.domains],
    site_codes: data.site_codes ?? [],
  };
}

async function save(data) {
  await redis.set(KEY, JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// GET /api/infos
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const data = await load();
    // Enrichir chaque site_code avec code_regate / code_pst depuis le hash Redis du site
    if (data.site_codes?.length) {
      const pipe = redis.pipeline();
      data.site_codes.forEach(sc => pipe.hmget(`site:${sc.site_id}`, 'code_regate', 'code_pst'));
      const results = await pipe.exec();
      data.site_codes.forEach((sc, i) => {
        const [cr, cp] = results[i][1] || [];
        if (cr) sc.code_regate = cr;
        if (cp) sc.code_pst    = cp;
      });
    }
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/infos  — admin only (dns1, dns2, dns_dc, route_psm)
// ---------------------------------------------------------------------------
router.put('/', requireAdmin, async (req, res) => {
  try {
    const { dns1, dns2, dns_dc, route_psm, notes } = req.body || {};
    const data = await load();
    if (dns1      !== undefined) data.dns1      = String(dns1).trim();
    if (dns2      !== undefined) data.dns2      = String(dns2).trim();
    if (dns_dc    !== undefined) data.dns_dc    = String(dns_dc).trim();
    if (route_psm !== undefined) data.route_psm = String(route_psm).trim();
    if (notes     !== undefined) data.notes     = String(notes);
    await save(data);
    await addLog(req.user.username, 'INFOS_UPDATE',
      { dns1: data.dns1, dns2: data.dns2, dns_dc: data.dns_dc, route_psm: data.route_psm });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/infos/domains  — admin only
// ---------------------------------------------------------------------------
router.post('/domains', requireAdmin, async (req, res) => {
  try {
    const { domain } = req.body || {};
    if (!domain?.trim()) return res.status(400).json({ error: 'domain requis' });
    const d    = domain.trim().toLowerCase();
    const data = await load();
    if ((data.domains || []).includes(d))
      return res.status(409).json({ error: 'Ce domaine existe déjà' });
    data.domains = [...(data.domains || []), d];
    await save(data);
    await addLog(req.user.username, 'DOMAIN_ADD', { domain: d });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/infos/domains/:domain  — admin only
router.put('/domains/:domain', requireAdmin, async (req, res) => {
  try {
    const oldDomain = req.params.domain;
    const { newDomain } = req.body || {};
    if (!newDomain?.trim()) return res.status(400).json({ error: 'newDomain requis' });
    const nd   = newDomain.trim().toLowerCase();
    const data = await load();
    const idx  = (data.domains || []).indexOf(oldDomain);
    if (idx === -1) return res.status(404).json({ error: 'Domaine introuvable' });
    data.domains[idx] = nd;
    await save(data);
    await addLog(req.user.username, 'DOMAIN_UPDATE', { old: oldDomain, new: nd });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/infos/domains/:domain  — admin only
router.delete('/domains/:domain', requireAdmin, async (req, res) => {
  try {
    const domain = req.params.domain;
    const data   = await load();
    const before = (data.domains || []).length;
    data.domains = (data.domains || []).filter(d => d !== domain);
    if (data.domains.length === before)
      return res.status(404).json({ error: 'Domaine introuvable' });
    await save(data);
    await addLog(req.user.username, 'DOMAIN_DELETE', { domain });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/infos/site-codes  — admin only
// ---------------------------------------------------------------------------
router.post('/site-codes', requireAdmin, async (req, res) => {
  try {
    const { site_id, site_name, code, code_regate, code_pst } = req.body || {};
    if (!site_id || !code?.trim())
      return res.status(400).json({ error: 'site_id et code requis' });

    const c  = String(code).trim().toUpperCase().slice(0, 8);
    const cr = code_regate ? String(code_regate).trim().toUpperCase().slice(0, 10) : undefined;
    const cp = code_pst    ? String(code_pst).trim().toUpperCase().slice(0, 10)    : undefined;
    const data = await load();

    // Remplace si ce site a déjà un code
    data.site_codes = (data.site_codes || []).filter(s => s.site_id !== site_id);
    const entry = { site_id, site_name: String(site_name || ''), code: c };
    if (cr) entry.code_regate = cr;
    if (cp) entry.code_pst    = cp;
    data.site_codes.push(entry);
    data.site_codes.sort((a, b) =>
      a.site_name.localeCompare(b.site_name, 'fr', { sensitivity: 'base' }));

    await save(data);
    await addLog(req.user.username, 'SITE_CODE_ADD', { site_id, code: c });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/infos/site-codes/:siteId  — admin only
// ---------------------------------------------------------------------------
router.put('/site-codes/:siteId', requireAdmin, async (req, res) => {
  try {
    const { siteId } = req.params;
    const { code, code_regate, code_pst } = req.body || {};
    if (!code?.trim()) return res.status(400).json({ error: 'code requis' });

    const c  = String(code).trim().toUpperCase().slice(0, 8);
    const data = await load();
    const entry = (data.site_codes || []).find(s => s.site_id === siteId);
    if (!entry) return res.status(404).json({ error: 'Code site introuvable' });

    entry.code = c;
    if (code_regate !== undefined) {
      const cr = String(code_regate).trim().toUpperCase().slice(0, 10);
      if (cr) entry.code_regate = cr; else delete entry.code_regate;
    }
    if (code_pst !== undefined) {
      const cp = String(code_pst).trim().toUpperCase().slice(0, 10);
      if (cp) entry.code_pst = cp; else delete entry.code_pst;
    }
    await save(data);
    await addLog(req.user.username, 'SITE_CODE_UPDATE', { site_id: siteId, code: c });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/infos/site-codes/:siteId  — admin only
// ---------------------------------------------------------------------------
router.delete('/site-codes/:siteId', requireAdmin, async (req, res) => {
  try {
    const { siteId } = req.params;
    const data   = await load();
    const before = (data.site_codes || []).length;

    data.site_codes = (data.site_codes || []).filter(s => s.site_id !== siteId);
    if (data.site_codes.length === before)
      return res.status(404).json({ error: 'Code site introuvable' });

    await save(data);
    await addLog(req.user.username, 'SITE_CODE_DELETE', { site_id: siteId });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
