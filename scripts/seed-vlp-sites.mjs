#!/usr/bin/env node
/**
 * seed-vlp-sites.mjs
 * Crée les sites du groupe VLP (menu « Site VLP ») avec leurs 2 VLAN
 * (Admin + Prod) et les IP /24 associées. Idempotent : un site ou un VLAN
 * déjà présent est ignoré.
 *
 * Usage (sur le serveur, depuis /var/www/ipam) :
 *   REDIS_PASSWORD=... node scripts/seed-vlp-sites.mjs
 */
import { redis, createSite, createVlan, updateVlan } from '../server/redis.mjs';

const MASK = '255.255.255.0';

// [site, réseau Admin, id Admin, réseau Prod, id Prod]
const SITES = [
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

for (const [name, adminNet, adminId, prodNet, prodId] of SITES) {
  let siteId = await redis.hget('sites:idx:name', name);
  if (!siteId) {
    siteId = String((await createSite(name, 'VLP')).id);
    console.log(`+ site ${name} (#${siteId})`);
  } else {
    await redis.hset(`site:${siteId}`, 'group', 'VLP');
    console.log(`= site ${name} (#${siteId}) existant`);
  }
  for (const [net, vid, tag] of [[adminNet, adminId, 'ADMIN'], [prodNet, prodId, 'METIER']]) {
    try {
      const { vlanDbId, added } = await createVlan(siteId, String(vid), `${net}/24`, MASK, '', hosts24(net));
      await updateVlan(vlanDbId, { description: tag });
      console.log(`    VLAN ${vid} ${tag} ${net}/24 — ${added} IP`);
    } catch (e) {
      console.log(`    VLAN ${vid} ${net}/24 ignoré : ${e.message}`);
    }
  }
}
await redis.quit();
