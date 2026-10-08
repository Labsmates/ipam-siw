// =============================================================================
// IPAM SIW — vlp-sites.mjs
// Liste des sites du groupe VLP (menu « Site VLP ») et import idempotent :
// un site ou un VLAN déjà présent est ignoré, rien n'est jamais écrasé.
// Utilisé par POST /api/sites/vlp-import (bouton admin de Site VLP) et par
// scripts/seed-vlp-sites.mjs.
// =============================================================================
import { redis, createSite, createVlan, updateVlan } from './redis.mjs';

const MASK = '255.255.255.0';

// [site, réseau Admin, id Admin, réseau Prod, id Prod]
export const VLP_SITES = [
  ['VLP LEMNYS',                          '222.4.4.0',     1320, '222.4.3.0',     1321],
  ['VLPR BORDEAUX',                       '10.86.48.0',    1320, '10.86.56.0',    1321],
  ['VLPR BRUNE',                          '188.4.4.0',     1320, '188.4.3.0',     1321],
  ['VLPR LYON',                           '10.86.71.0',    1320, '10.86.78.0',    1321],
  ['VLPR MARSEILLE',                      '218.1.50.0',    1320, '218.1.43.0',    1321],
  ['VLPR MONTPELLIER',                    '10.86.103.0',   1320, '10.86.112.0',   1321],
  ['VLPR NANCY',                          '10.86.168.0',   1320, '10.86.174.0',   1321],
  ["VLPR NANTES MAISON DE L'INNOVATION",  '10.136.79.0',   1331, '10.136.41.0',   1332],
  ['VLPR NANTES HERRIOT',                 '150.73.45.0',   1320, '150.73.54.0',   1321],
  ['VLPR RENNES',                         '10.86.199.0',   1320, '10.86.208.0',   1321],
  ['VLPR ROUEN',                          '10.86.208.0',   1320, '10.86.136.0',   1321],
  ['VLPR STRASBOURG',                     '208.223.20.0',  1320, '208.223.29.0',  1321],
  ['VLPR TOULOUSE',                       '10.86.228.0',   1320, '10.86.238.0',   1321],
];

function hosts24(net) {
  const [a, b, c] = net.split('.').map(Number);
  return Array.from({ length: 254 }, (_, i) => `${a}.${b}.${c}.${i + 1}`);
}

const gw = net => net.replace(/\.0$/, '.1');

// Retourne un rapport [{ site, created, vlans: [{ vlan_id, tag, network, added|error }] }]
export async function importVlpSites() {
  const report = [];
  for (const [name, adminNet, adminId, prodNet, prodId] of VLP_SITES) {
    let siteId = await redis.hget('sites:idx:name', name);
    const created = !siteId;
    if (created) siteId = String((await createSite(name, 'VLP')).id);
    else await redis.hset(`site:${siteId}`, 'group', 'VLP');
    const entry = { site: name, id: Number(siteId), created, vlans: [] };
    for (const [net, vid, tag] of [[adminNet, adminId, 'ADMIN'], [prodNet, prodId, 'METIER']]) {
      try {
        const { vlanDbId, added } = await createVlan(siteId, String(vid), `${net}/24`, MASK, gw(net), hosts24(net));
        await updateVlan(vlanDbId, { description: tag });
        // Gateway en .1 : IP « Utilisé » nommée Gateway
        const ipId = await redis.hget(`vlan:${vlanDbId}:ips:idx`, gw(net));
        if (ipId) await redis.hset(`ip:${ipId}`, { status: 'Utilisé', hostname: 'Gateway', updated_at: new Date().toISOString() });
        entry.vlans.push({ vlan_id: vid, tag, network: `${net}/24`, added });
      } catch (e) {
        entry.vlans.push({ vlan_id: vid, tag, network: `${net}/24`, error: e.message });
      }
    }
    report.push(entry);
  }
  return report;
}
