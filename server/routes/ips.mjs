import express from 'express';
import { getIp, updateIp, deleteIp, searchAllIPs, addLog, getIpHistory, getVlan } from '../redis.mjs';
import { requireAuth } from '../middleware/auth.mjs';

const router = express.Router();

// Doit rester synchronisé avec PROCEF_DEFAULTS dans client/js/site.js
const PROCEF_DEFAULTS = {
  role: 'Serveurs PROCEF',
  demandeur: 'LBP DOSB SOLU PART EXP',
  chef_projet: 'Florence MENARD',
  direction: 'Service Généraux du CREC',
  product_owner: 'Leila BOUHOUT',
  architecte: 'Francois-Hugues M.',
  contact: 'leila.bouhout@labanquepostale.fr',
  cpu: '12 vCPU',
  ram: '64 Go',
  disk_size: '24 To',
  programs: ['SQL Server', 'SQL Management Studio', 'SMI Server', 'IIS'],
};

function hasInfoData(ip) {
  return !!(ip.role || ip.demandeur || ip.chef_projet || ip.direction || ip.product_owner || ip.architecte ||
    ip.contact || ip.notes || ip.server_type || ip.cpu || ip.ram || ip.disk_size ||
    (ip.programs && ip.programs !== '[]'));
}

// GET /api/ips/search?q= — recherche globale d'une IP dans tous les sites
router.get('/search', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 3) return res.json({ results: [] });
  try {
    res.json({ results: await searchAllIPs(q) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Middleware : interdit aux lecteurs (role viewer)
function requireNonViewer(req, res, next) {
  if (req.user?.role === 'viewer')
    return res.status(403).json({ error: 'Accès refusé — les lecteurs ne peuvent pas modifier les données' });
  next();
}

// PUT /api/ips/:id — modifier statut et/ou hostname et/ou fiche serveur (Info)
router.put('/:id', requireAuth, requireNonViewer, async (req, res) => {
  try {
    const { status, hostname, os, comment, role, demandeur, chef_projet, direction, product_owner, architecte, contact, notes,
      server_type, cpu, ram, disk_size, programs } = req.body || {};
    if ([status, hostname, os, role, demandeur, chef_projet, direction, product_owner, architecte, contact, notes,
      server_type, cpu, ram, disk_size, programs].every(v => v === undefined))
      return res.status(400).json({ error: 'Aucun champ à mettre à jour' });
    if (programs !== undefined && !Array.isArray(programs))
      return res.status(400).json({ error: 'Format de programmes invalide' });
    // Dédoublonnage insensible à la casse (filet de sécurité — le client valide déjà)
    let dedupedPrograms = programs;
    if (Array.isArray(programs)) {
      const seen = new Set();
      dedupedPrograms = programs.filter(p => {
        const n = String(p || '').trim().toLowerCase();
        if (!n || seen.has(n)) return false;
        seen.add(n);
        return true;
      });
    }
    const ip = await getIp(req.params.id);
    if (!ip) return res.status(404).json({ error: 'IP introuvable' });
    const isRelease = status === 'Libre';
    // Capture l'auteur dès que l'IP a (ou reçoit) un hostname et n'en a pas encore —
    // couvre la première assignation, mais aussi les IPs déjà assignées avant l'ajout de ce champ
    const effectiveHostname = hostname !== undefined ? hostname : ip.hostname;
    const isFirstAssignment = !isRelease && !ip.created_by && effectiveHostname && effectiveHostname.trim();

    // Pré-remplissage automatique (et enregistré immédiatement) pour les serveurs PROCEF
    // dont le hostname contient AF21/AF22, tant que la fiche est encore vide.
    let procefFill = null;
    if (!isRelease && effectiveHostname && /AF21|AF22/i.test(effectiveHostname) && !hasInfoData(ip)) {
      const vlan = await getVlan(ip.vlan_id);
      if ((vlan?.description || '').trim().toUpperCase() === 'PROCEF') procefFill = PROCEF_DEFAULTS;
    }
    const effRole        = role !== undefined ? role : procefFill?.role;
    const effDemandeur   = demandeur !== undefined ? demandeur : procefFill?.demandeur;
    const effChefProjet  = chef_projet !== undefined ? chef_projet : procefFill?.chef_projet;
    const effDirection   = direction !== undefined ? direction : procefFill?.direction;
    const effProductOwner = product_owner !== undefined ? product_owner : procefFill?.product_owner;
    const effArchitecte  = architecte !== undefined ? architecte : procefFill?.architecte;
    const effContact     = contact !== undefined ? contact : procefFill?.contact;
    const effCpu         = cpu !== undefined ? cpu : procefFill?.cpu;
    const effRam         = ram !== undefined ? ram : procefFill?.ram;
    const effDiskSize    = disk_size !== undefined ? disk_size : procefFill?.disk_size;
    const effPrograms    = dedupedPrograms !== undefined ? dedupedPrograms : procefFill?.programs;

    await updateIp(req.params.id, {
      status, hostname: isRelease ? '' : hostname, os: isRelease ? '' : os,
      role: isRelease ? '' : effRole,
      demandeur: isRelease ? '' : effDemandeur, chef_projet: isRelease ? '' : effChefProjet,
      direction: isRelease ? '' : effDirection, product_owner: isRelease ? '' : effProductOwner,
      architecte: isRelease ? '' : effArchitecte, contact: isRelease ? '' : effContact, notes: isRelease ? '' : notes,
      created_by: isRelease ? '' : (isFirstAssignment ? req.user.username : undefined),
      server_type: isRelease ? '' : server_type, cpu: isRelease ? '' : effCpu, ram: isRelease ? '' : effRam,
      disk_size: isRelease ? '' : effDiskSize,
      programs: isRelease ? '[]' : (effPrograms !== undefined ? JSON.stringify(effPrograms.slice(0, 20)) : undefined),
    });
    // Ne consigne que ce qui a réellement changé (ajouté / modifié / supprimé),
    // pas tous les champs envoyés par le formulaire (la fiche Info renvoie tout à chaque fois).
    const trunc = s => s.length > 200 ? s.slice(0, 200) + '…' : s;
    const diffField = (label, key, newVal) => {
      if (newVal === undefined) return null;
      const oldVal = (ip[key] || '').trim();
      const nv = (newVal || '').trim();
      if (oldVal === nv) return null;
      if (!oldVal) return `${label} ajouté : "${trunc(nv)}"`;
      if (!nv) return `${label} supprimé (était "${trunc(oldVal)}")`;
      return `${label} modifié : "${trunc(oldVal)}" → "${trunc(nv)}"`;
    };
    let programsDiff = null;
    if (effPrograms !== undefined) {
      let oldPrograms = [];
      try { oldPrograms = JSON.parse(ip.programs || '[]'); } catch { /* ignore */ }
      const added   = effPrograms.filter(p => !oldPrograms.includes(p));
      const removed = oldPrograms.filter(p => !effPrograms.includes(p));
      if (added.length || removed.length) {
        programsDiff = `programmes : ${[added.length && `+${added.join(', ')}`, removed.length && `-${removed.join(', ')}`].filter(Boolean).join(' / ')}`;
      }
    }
    const details = [
      procefFill ? 'fiche PROCEF pré-remplie automatiquement (AF21/AF22)' : null,
      diffField('statut', 'status', status),
      diffField('hostname', 'hostname', hostname),
      diffField('OS', 'os', os),
      diffField('rôle', 'role', effRole),
      diffField('demandeur', 'demandeur', effDemandeur),
      diffField('chef de projet', 'chef_projet', effChefProjet),
      diffField('direction', 'direction', effDirection),
      diffField('product owner', 'product_owner', effProductOwner),
      diffField('architecte', 'architecte', effArchitecte),
      diffField('contact', 'contact', effContact),
      diffField('commentaire', 'notes', notes),
      diffField('type serveur', 'server_type', server_type),
      diffField('CPU', 'cpu', effCpu),
      diffField('RAM', 'ram', effRam),
      diffField('disque', 'disk_size', effDiskSize),
      programsDiff,
    ].filter(Boolean).join(', ');
    if (details) {
      await addLog(req.user.username, 'UPDATE_IP', `${ip.ip_address} : ${details}`,
        status === 'Libre' ? 'info' : 'ok', { ip_address: ip.ip_address });
    }
    // Archive entry when an IP is released and had a hostname
    if (status === 'Libre' && ip.hostname) {
      await addLog(req.user.username, 'RELEASE_IP',
        JSON.stringify({ ip: ip.ip_address, hostname: ip.hostname, comment: (comment || '').slice(0, 300) }), 'info',
        { ip_address: ip.ip_address });
    }
    res.json({ ok: true });
  } catch (e) {
    if (e.message === 'Statut invalide') return res.status(400).json({ error: e.message });
    if (e.code === 'CONFLICT') return res.status(409).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/ips/:id — supprime définitivement une IP .255 (broadcast)
router.delete('/:id', requireAuth, requireNonViewer, async (req, res) => {
  try {
    const ip = await getIp(req.params.id);
    if (!ip) return res.status(404).json({ error: 'IP introuvable' });
    if (!ip.ip_address.endsWith('.255'))
      return res.status(403).json({ error: 'Suppression réservée aux adresses .255' });
    await deleteIp(req.params.id);
    await addLog(req.user.username, 'DEL_IP', `${ip.ip_address} supprimée`, 'info', { ip_address: ip.ip_address });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/ips/:id/history — historique des actions liées à cette IP (fiche serveur)
router.get('/:id/history', requireAuth, async (req, res) => {
  try {
    const ip = await getIp(req.params.id);
    if (!ip) return res.status(404).json({ error: 'IP introuvable' });
    const history = await getIpHistory(ip.ip_address);
    res.json({ history });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
