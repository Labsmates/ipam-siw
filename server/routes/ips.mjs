import express from 'express';
import { getIp, updateIp, deleteIp, searchAllIPs, addLog, getIpHistory } from '../redis.mjs';
import { requireAuth } from '../middleware/auth.mjs';

const router = express.Router();

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
    await updateIp(req.params.id, {
      status, hostname: isRelease ? '' : hostname, os: isRelease ? '' : os,
      role: isRelease ? '' : role,
      demandeur: isRelease ? '' : demandeur, chef_projet: isRelease ? '' : chef_projet,
      direction: isRelease ? '' : direction, product_owner: isRelease ? '' : product_owner,
      architecte: isRelease ? '' : architecte, contact: isRelease ? '' : contact, notes: isRelease ? '' : notes,
      created_by: isRelease ? '' : (isFirstAssignment ? req.user.username : undefined),
      server_type: isRelease ? '' : server_type, cpu: isRelease ? '' : cpu, ram: isRelease ? '' : ram,
      disk_size: isRelease ? '' : disk_size,
      programs: isRelease ? '[]' : (dedupedPrograms !== undefined ? JSON.stringify(dedupedPrograms.slice(0, 20)) : undefined),
    });
    const details = [
      status      !== undefined ? `statut → ${status}`              : null,
      hostname    !== undefined ? `hostname → "${hostname || ''}"`  : null,
      os          !== undefined ? `OS → "${os || ''}"`              : null,
      role        !== undefined ? `rôle → "${role || ''}"`          : null,
      demandeur   !== undefined ? `demandeur → "${demandeur || ''}"` : null,
      chef_projet !== undefined ? `chef de projet → "${chef_projet || ''}"` : null,
      direction   !== undefined ? `direction → "${direction || ''}"` : null,
      product_owner !== undefined ? `product owner → "${product_owner || ''}"` : null,
      architecte  !== undefined ? `architecte → "${architecte || ''}"` : null,
      contact     !== undefined ? `contact → "${contact || ''}"`    : null,
      notes       !== undefined ? `commentaire mis à jour`          : null,
      server_type !== undefined ? `type serveur → "${server_type || ''}"` : null,
      cpu         !== undefined ? `CPU → "${cpu || ''}"`            : null,
      ram         !== undefined ? `RAM → "${ram || ''}"`            : null,
      disk_size   !== undefined ? `disque → "${disk_size || ''}"`  : null,
      programs    !== undefined ? `programmes mis à jour`          : null,
    ].filter(Boolean).join(', ');
    await addLog(req.user.username, 'UPDATE_IP', `${ip.ip_address} : ${details}`,
      status === 'Libre' ? 'info' : 'ok', { ip_address: ip.ip_address });
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
