// Diagnostic ponctuel — liste les hostnames + VLAN d'un site, pour comparer
// avec la table FICHIERS_PAIRS de server/routes/migrations.mjs.
// Usage (depuis /var/www/ipam sur le serveur prod) :
//   node scripts/diag-site-hostnames.mjs 518100
// (le paramètre est le code regate, ou un bout du nom du site)
import { redis, getSiteData } from '../server/redis.mjs';

const query = (process.argv[2] || '').toLowerCase();
if (!query) { console.error('Usage: node diag-site-hostnames.mjs <code_regate ou nom du site>'); process.exit(1); }

const siteIds = await redis.smembers('sites');
for (const id of siteIds) {
  const site = await redis.hgetall(`site:${id}`);
  if (!site?.name) continue;
  const hay = `${site.name} ${site.code_regate || ''}`.toLowerCase();
  if (!hay.includes(query)) continue;

  console.log(`\n=== Site #${id} — ${site.name} (regate: ${site.code_regate || '?'}) ===`);
  const data = await getSiteData(id);
  for (const v of data.vlans || []) {
    console.log(`  VLAN #${v.id} — description="${v.description}"`);
  }
  for (const ip of data.ips || []) {
    if (!ip.hostname) continue;
    const vlan = (data.vlans || []).find(v => String(v.id) === String(ip.vlan_id));
    console.log(`    ${ip.ip_address}\thostname="${ip.hostname}"\tstatus=${ip.status}\tvlan="${vlan?.description || '?'}"`);
  }
}
process.exit(0);
