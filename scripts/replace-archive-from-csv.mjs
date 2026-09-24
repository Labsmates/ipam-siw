// Remplace toutes les entrées "Archive des libérations" (logs action
// RELEASE_IP) par le contenu d'un CSV (colonnes: Hostname, Adresse IP,
// Date, Utilisateur, Commentaire — format DD/MM/YYYY HH:MM:SS).
// Préserve tous les autres types de logs (MIGRATION_CREATE, UPDATE_IP...)
// et reconstruit la liste triée chronologiquement (plus récent en tête),
// comme le fait addLog() normalement.
//
// Usage (depuis /var/www/ipam) :
//   node scripts/replace-archive-from-csv.mjs /tmp/archive.csv
//   node scripts/replace-archive-from-csv.mjs /tmp/archive.csv --dry-run
import { readFileSync } from 'fs';
import { redis } from '../server/redis.mjs';

const csvPath = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
if (!csvPath) { console.error('Usage: node replace-archive-from-csv.mjs <csv> [--dry-run]'); process.exit(1); }

function parseCsvLine(line) {
  // CSV simple avec champs entre guillemets, séparés par des virgules
  const out = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else cur += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function parseDate(raw) {
  // "21/04/2026 10:10:53" -> ISO UTC
  const m = raw.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return new Date().toISOString();
  const [, dd, mm, yyyy, hh, mi, ss] = m;
  return new Date(Date.UTC(+yyyy, +mm - 1, +dd, +hh, +mi, +ss)).toISOString();
}

const raw = readFileSync(csvPath, 'utf8');
const lines = raw.split(/\r?\n/).filter(l => l.trim());
const header = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase());
const idx = {
  hostname: header.indexOf('hostname'),
  ip: header.indexOf('adresse ip'),
  date: header.indexOf('date'),
  user: header.indexOf('utilisateur'),
  comment: header.indexOf('commentaire'),
};
if (idx.hostname < 0 || idx.ip < 0) {
  console.error('Colonnes attendues introuvables. En-tête lu:', header);
  process.exit(1);
}

const csvEntries = lines.slice(1).map(parseCsvLine).map(cols => ({
  username: cols[idx.user]?.trim() || 'import',
  action: 'RELEASE_IP',
  details: JSON.stringify({
    ip: cols[idx.ip]?.trim() || '',
    hostname: cols[idx.hostname]?.trim() || '',
    comment: cols[idx.comment]?.trim() || '',
    site_id: null,
    site_name: '',
  }),
  level: 'info',
  created_at: parseDate(cols[idx.date] || ''),
  ip_address: cols[idx.ip]?.trim() || '',
  site_id: null,
}));
console.log(`CSV : ${csvEntries.length} entrées RELEASE_IP à importer.`);

const rawLogs = await redis.lrange('logs', 0, -1);
const parsed = rawLogs.map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
const kept = parsed.filter(l => l.action !== 'RELEASE_IP');
console.log(`Logs existants : ${parsed.length} au total, dont ${parsed.length - kept.length} RELEASE_IP (supprimées), ${kept.length} autres (conservées).`);

const merged = [...kept, ...csvEntries].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
const capped = merged.slice(0, 5000);

if (dryRun) {
  console.log(`[DRY-RUN] Nouvelle liste "logs" : ${capped.length} entrées (aucune écriture).`);
  console.log('Aperçu des 3 premières entrées RELEASE_IP importées :', JSON.stringify(csvEntries.slice(0, 3), null, 2));
  process.exit(0);
}

const pipe = redis.pipeline();
pipe.del('logs');
// RPUSH dans l'ordre du tableau (plus récent -> plus ancien) pour que
// LRANGE(0,-1) relise bien "plus récent en tête", comme avec LPUSH.
for (const entry of capped) pipe.rpush('logs', JSON.stringify(entry));
await pipe.exec();

console.log(`OK — "logs" reconstruite : ${capped.length} entrées (${csvEntries.length} RELEASE_IP importées + ${kept.length} autres conservées).`);
process.exit(0);
