#!/usr/bin/env node
/**
 * seed-vlp-sites.mjs
 * Importe les sites du groupe VLP (menu « Site VLP ») : 2 VLAN (Admin + Prod),
 * IP /24 et Gateway en .1. Idempotent. Même import que le bouton admin de la
 * page Site VLP.
 *
 * Usage (sur le serveur, depuis /var/www/ipam) :
 *   REDIS_PASSWORD=... node scripts/seed-vlp-sites.mjs
 */
import { redis } from '../server/redis.mjs';
import { importVlpSites } from '../server/vlp-sites.mjs';

for (const s of await importVlpSites()) {
  console.log(`${s.created ? '+' : '='} site ${s.site} (#${s.id})`);
  for (const v of s.vlans) console.log(`    VLAN ${v.vlan_id} ${v.tag} ${v.network} — ${v.error ? 'ignoré : ' + v.error : v.added + ' IP'}`);
}
await redis.quit();
