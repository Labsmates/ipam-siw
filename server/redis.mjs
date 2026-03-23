// =============================================================================
// IPAM SIW — Couche d'accès Redis
// Schéma des clés :
//   system:jwt_secret          STRING
//   seq:sites / seq:vlans / seq:ips  → INCR
//   users                      SET {uuid…}
//   users:idx:username         HASH {username: uuid}
//   user:{uuid}                HASH {username, pw_hash, role, created_at}
//   sites                      SET {id…}
//   sites:idx:name             HASH {NAME: id}
//   site:{id}                  HASH {name, created_at}
//   site:{id}:vlans            SET {vlan_db_id…}
//   site:{id}:vlans:idx        HASH {vlan_id_str: vlan_db_id}
//   vlan:{id}                  HASH {site_id, vlan_id, network, mask, gateway, created_at}
//   vlan:{id}:ips              SET {ip_id…}
//   vlan:{id}:ips:idx          HASH {ip_address: ip_id}
//   ip:{id}                    HASH {vlan_id, ip_address, status, created_at, updated_at}
//   logs                       LIST JSON (lpush, ltrim 5000)
// =============================================================================

import Redis   from 'ioredis';
import crypto  from 'crypto';
import { uid, sha256 } from './utils.mjs';

// ── Connexion ─────────────────────────────────────────────────────────────────
export const redis = new Redis({
  host:          process.env.REDIS_HOST     || '127.0.0.1',
  port:          parseInt(process.env.REDIS_PORT || '6379'),
  password:      process.env.REDIS_PASSWORD || undefined,
  db:            parseInt(process.env.REDIS_DB   || '0'),
  retryStrategy: (times) => Math.min(times * 200, 5000),
  maxRetriesPerRequest: 3,
  lazyConnect: false,
});

redis.on('error',   (e) => console.error('[Redis] Erreur :', e.message));
redis.on('connect', ()  => console.log('[Redis] Connecté'));

// ── Helpers ───────────────────────────────────────────────────────────────────
const now = () => new Date().toISOString();

// Calcule l'adresse de broadcast d'un réseau (network + mask en notation pointée)
function computeBroadcast(network, mask) {
  if (!network || !mask) return null;
  const n = network.split('.').map(Number);
  const m = mask.split('.').map(Number);
  if (n.length !== 4 || m.length !== 4 || n.some(isNaN) || m.some(isNaN)) return null;
  return n.map((b, i) => (b | (~m[i] & 0xFF))).join('.');
}

// ── JWT Secret ────────────────────────────────────────────────────────────────
export async function getJwtSecret() {
  let secret = await redis.get('system:jwt_secret');
  if (!secret) {
    secret = crypto.randomBytes(48).toString('hex');
    await redis.set('system:jwt_secret', secret);
    console.log('[init] JWT secret généré');
  }
  return secret;
}

// =============================================================================
// USERS
// =============================================================================
export async function ensureDefaultAdmin() {
  // Check if ADMIN exists in the username index
  let adminId = await redis.hget('users:idx:username', 'ADMIN');

  // If not found, scan all users to detect a lowercase 'admin' and repair it
  if (!adminId) {
    adminId = await redis.hget('users:idx:username', 'admin');
    if (adminId) {
      // Repair: normalize username to uppercase and fix the index
      await redis.hset(`user:${adminId}`, 'username', 'ADMIN');
      await redis.hset('users:idx:username', 'ADMIN', adminId);
      await redis.hdel('users:idx:username', 'admin');
      console.log('[init] Admin username normalisé en majuscules (réparation automatique)');
      return;
    }
  }

  // No admin at all — create one
  if (!adminId) {
    const count = await redis.scard('users');
    await createUser('ADMIN', process.env.DEFAULT_ADMIN_PASSWORD || 'SWI@IPAM2026$', 'admin');
    console.log(`[init] Admin par défaut créé (${count} autre(s) utilisateur(s) existant(s))`);
  }
}

export async function createUser(username, password, role = 'user', fullName = '') {
  const existing = await redis.hget('users:idx:username', username);
  if (existing) throw Object.assign(new Error('Identifiant déjà utilisé'), { code: 'CONFLICT' });
  const id = uid();
  const pipe = redis.pipeline();
  pipe.hset(`user:${id}`, {
    username,
    full_name:  fullName || '',
    pw_hash:    sha256(password),
    role,
    created_at: now(),
  });
  pipe.hset('users:idx:username', username, id);
  pipe.sadd('users', id);
  await pipe.exec();
  return { id, username, full_name: fullName, role };
}

export async function getUserByUsername(username) {
  const id = await redis.hget('users:idx:username', username);
  if (!id) return null;
  const u = await redis.hgetall(`user:${id}`);
  return u && u.username ? { id, ...u } : null;
}

export async function getUserById(id) {
  const u = await redis.hgetall(`user:${id}`);
  return u && u.username ? { id, ...u } : null;
}

export async function listUsers() {
  const ids = await redis.smembers('users');
  if (!ids.length) return [];
  const pipe = redis.pipeline();
  ids.forEach(id => pipe.hgetall(`user:${id}`));
  const results = await pipe.exec();
  return ids
    .map((id, i) => ({ id, ...results[i][1] }))
    .filter(u => u.username)
    .sort((a, b) => a.created_at?.localeCompare(b.created_at || '') || 0);
}

export async function incrementLoginCount(id) {
  const pipe = redis.pipeline();
  pipe.hincrby(`user:${id}`, 'login_count', 1);
  pipe.hset(`user:${id}`, 'last_login', now());
  await pipe.exec();
}

export async function deleteUser(id) {
  const u = await redis.hgetall(`user:${id}`);
  if (!u?.username) return;
  const pipe = redis.pipeline();
  pipe.hdel('users:idx:username', u.username);
  pipe.srem('users', id);
  pipe.del(`user:${id}`);
  await pipe.exec();
}

export async function updatePassword(id, newPassword) {
  await redis.hset(`user:${id}`, 'pw_hash', sha256(newPassword));
}

export async function updateUserRole(id, role) {
  await redis.hset(`user:${id}`, 'role', role);
}

// =============================================================================
// SITES
// =============================================================================
export async function createSite(name) {
  const nameKey = name.toUpperCase();
  const existing = await redis.hget('sites:idx:name', nameKey);
  if (existing) throw Object.assign(new Error('Ce site existe déjà'), { code: 'CONFLICT' });
  const id = String(await redis.incr('seq:sites'));
  const pipe = redis.pipeline();
  pipe.hset(`site:${id}`, { name, created_at: now() });
  pipe.hset('sites:idx:name', nameKey, id);
  pipe.sadd('sites', id);
  await pipe.exec();
  return { id: parseInt(id), name };
}

export async function getSite(id) {
  const s = await redis.hgetall(`site:${id}`);
  return s?.name ? { id: parseInt(id), ...s } : null;
}

export async function listSitesWithStats() {
  const ids = await redis.smembers('sites');
  if (!ids.length) return [];

  // Get all site hashes
  const pipe1 = redis.pipeline();
  ids.forEach(id => pipe1.hgetall(`site:${id}`));
  const siteResults = await pipe1.exec();

  // Get all vlan sets per site
  const pipe2 = redis.pipeline();
  ids.forEach(id => pipe2.smembers(`site:${id}:vlans`));
  const vlanSets = await pipe2.exec();

  // Collect all vlan IDs
  const allVlanIds = vlanSets.flatMap(([, v]) => v || []);

  // Get all IP sets per vlan
  const pipe3 = redis.pipeline();
  allVlanIds.forEach(vid => pipe3.smembers(`vlan:${vid}:ips`));
  const ipSets = await pipe3.exec();

  // Collect all IP IDs with their vlan context
  const allIpIds = ipSets.flatMap(([, v]) => v || []);

  // Get all IP statuses
  const pipe4 = redis.pipeline();
  allIpIds.forEach(ipId => pipe4.hget(`ip:${ipId}`, 'status'));
  const statuses = await pipe4.exec();

  // Map vlan_db_id → siteId
  const vlanToSite = {};
  ids.forEach((siteId, si) => {
    (vlanSets[si][1] || []).forEach(vid => { vlanToSite[vid] = siteId; });
  });

  // Map ip_db_id → vlan_db_id
  let ipIdx = 0;
  const ipToVlan = {};
  allVlanIds.forEach((vid, vi) => {
    (ipSets[vi][1] || []).forEach(ipId => { ipToVlan[ipId] = vid; ipIdx++; });
  });

  // Aggregate stats per site
  const stats = {};
  ids.forEach(id => { stats[id] = { vlan_count: 0, ip_total: 0, ip_libre: 0, ip_utilise: 0, ip_reservee: 0 }; });
  ids.forEach((siteId, si) => { stats[siteId].vlan_count = (vlanSets[si][1] || []).length; });

  allIpIds.forEach((ipId, i) => {
    const vid    = ipToVlan[ipId];
    const siteId = vlanToSite[vid];
    if (!siteId) return;
    const status = statuses[i][1] || 'Libre';
    stats[siteId].ip_total++;
    if (status === 'Libre')    stats[siteId].ip_libre++;
    if (status === 'Utilisé')  stats[siteId].ip_utilise++;
    if (status === 'Réservée') stats[siteId].ip_reservee++;
  });

  return ids
    .map((id, i) => {
      const s = siteResults[i][1];
      if (!s?.name) return null;
      return {
        id:           parseInt(id),
        name:         s.name,
        created_at:   s.created_at,
        vlan_count:   stats[id].vlan_count,
        total:        stats[id].ip_total,
        libre:        stats[id].ip_libre,
        utilise:      stats[id].ip_utilise,
        reserve:      stats[id].ip_reservee,
        // aliases
        ip_total:     stats[id].ip_total,
        ip_free:      stats[id].ip_libre,
        ip_used:      stats[id].ip_utilise,
        ip_reserved:  stats[id].ip_reservee,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getSiteData(id) {
  const site = await redis.hgetall(`site:${id}`);
  if (!site?.name) return null;

  const vlanIds = await redis.smembers(`site:${id}:vlans`);

  const pipe1 = redis.pipeline();
  vlanIds.forEach(vid => pipe1.hgetall(`vlan:${vid}`));
  const vlanResults = await pipe1.exec();
  const vlans = vlanIds
    .map((vid, i) => ({ id: parseInt(vid), ...vlanResults[i][1] }))
    .filter(v => v.vlan_id)
    .sort((a, b) => parseInt(a.vlan_id || 0) - parseInt(b.vlan_id || 0));

  const pipe2 = redis.pipeline();
  vlanIds.forEach(vid => pipe2.smembers(`vlan:${vid}:ips`));
  const ipSets = await pipe2.exec();
  const allIpIds = ipSets.flatMap(([, v]) => v || []);

  const pipe3 = redis.pipeline();
  allIpIds.forEach(ipId => pipe3.hgetall(`ip:${ipId}`));
  const ipResults = await pipe3.exec();

  // Broadcast addresses per VLAN (masquées partout)
  const broadcastByVlan = {};
  for (const v of vlans) {
    const bcast = computeBroadcast(v.network, v.mask);
    if (bcast) broadcastByVlan[String(v.id)] = bcast;
  }

  const ips = allIpIds
    .map((ipId, i) => ({ id: parseInt(ipId), ...ipResults[i][1] }))
    .filter(ip => {
      if (!ip.ip_address) return false;
      // Masquer si hostname contient "broadcast" (insensible casse, espaces ignorés)
      if (ip.hostname && ip.hostname.trim().toLowerCase().includes('broadcast')) return false;
      // Masquer si l'adresse IP correspond à l'adresse de broadcast calculée du VLAN
      const bcast = broadcastByVlan[String(ip.vlan_id)];
      if (bcast && ip.ip_address === bcast) return false;
      return true;
    });

  return {
    site: { id: parseInt(id), ...site },
    vlans,
    ips,
  };
}

export async function renameSite(id, newName) {
  const site = await redis.hgetall(`site:${id}`);
  if (!site?.name) throw new Error('Site introuvable');
  const newKey = newName.toUpperCase();
  const oldKey = site.name.toUpperCase();
  const existing = await redis.hget('sites:idx:name', newKey);
  if (existing && existing !== String(id)) throw Object.assign(new Error('Ce nom existe déjà'), { code: 'CONFLICT' });
  const pipe = redis.pipeline();
  if (oldKey !== newKey) {
    pipe.hdel('sites:idx:name', oldKey);
    pipe.hset('sites:idx:name', newKey, id);
  }
  pipe.hset(`site:${id}`, 'name', newName);
  await pipe.exec();
}

export async function deleteSite(id) {
  const site = await redis.hgetall(`site:${id}`);
  if (!site?.name) return;
  const vlanIds = await redis.smembers(`site:${id}:vlans`);

  const pipe = redis.pipeline();
  for (const vid of vlanIds) {
    const ipIds = await redis.smembers(`vlan:${vid}:ips`); // eslint-disable-line no-await-in-loop
    ipIds.forEach(ipId => pipe.del(`ip:${ipId}`));
    pipe.del(`vlan:${vid}:ips`);
    pipe.del(`vlan:${vid}:ips:idx`);
    pipe.del(`vlan:${vid}`);
  }
  pipe.del(`site:${id}:vlans`);
  pipe.del(`site:${id}:vlans:idx`);
  pipe.del(`site:${id}`);
  pipe.hdel('sites:idx:name', site.name.toUpperCase());
  pipe.srem('sites', id);
  await pipe.exec();
}

// =============================================================================
// VLANS
// =============================================================================
export async function createVlan(siteId, vlanIdStr, network, mask, gateway, ipList = []) {
  const site = await redis.hgetall(`site:${siteId}`);
  if (!site?.name) throw new Error('Site introuvable');

  let vlanDbId = await redis.hget(`site:${siteId}:vlans:idx`, vlanIdStr);
  if (!vlanDbId) {
    vlanDbId = String(await redis.incr('seq:vlans'));
    const pipe = redis.pipeline();
    pipe.hset(`vlan:${vlanDbId}`, {
      site_id:     String(siteId),
      vlan_id:     vlanIdStr,
      network:     network  || '',
      mask:        mask     || '',
      gateway:     gateway  || '',
      created_at:  now(),
      description: getVlanAutoDesc(vlanIdStr),
    });
    pipe.hset(`site:${siteId}:vlans:idx`, vlanIdStr, vlanDbId);
    pipe.sadd(`site:${siteId}:vlans`, vlanDbId);
    await pipe.exec();
  } else {
    // Update metadata if vlan already exists
    await redis.hset(`vlan:${vlanDbId}`, {
      network: network || '',
      mask:    mask    || '',
      gateway: gateway || '',
    });
  }

  // Insert IPs (INSERT OR IGNORE logic via EXISTS on idx)
  let added = 0;
  if (ipList.length) {
    const seqStart = await redis.incrby('seq:ips', ipList.length);
    const seqBase  = seqStart - ipList.length;
    const pipe = redis.pipeline();
    ipList.forEach((ipAddr, i) => {
      const ipId = String(seqBase + i + 1);
      // Use HSETNX on the idx hash to avoid duplicates
      pipe.hsetnx(`vlan:${vlanDbId}:ips:idx`, ipAddr, ipId);
    });
    const idxResults = await pipe.exec();

    const pipe2 = redis.pipeline();
    ipList.forEach((ipAddr, i) => {
      if (idxResults[i][1] === 1) { // hsetnx returned 1 = was new
        const ipId = String(seqBase + i + 1);
        pipe2.hset(`ip:${ipId}`, {
          vlan_id:    vlanDbId,
          ip_address: ipAddr,
          status:     'Libre',
          created_at: now(),
          updated_at: now(),
        });
        pipe2.sadd(`vlan:${vlanDbId}:ips`, ipId);
        added++;
      }
    });
    await pipe2.exec();
  }

  return { vlanDbId: parseInt(vlanDbId), added };
}

// ---------------------------------------------------------------------------
// Auto-description VLAN basée sur le VLAN ID
// ---------------------------------------------------------------------------
const VLAN_DESC_MAP = {
  202: 'METIER', 1461: 'METIER', 50: 'METIER', 42: 'METIER',
  43:  'METIER', 403:  'METIER', 1491: 'METIER',
  203: 'ADMIN',  1460: 'ADMIN',  1490: 'ADMIN',
  1499: 'IPMI',  300:  'IPMI',   1479: 'IPMI',
  600: 'PROCEF', 37:  'PROCEF',
};

export function getVlanAutoDesc(vlanId) {
  return VLAN_DESC_MAP[parseInt(vlanId)] || 'AUTRES';
}

export async function autoTagAllVlans() {
  const keys = await redis.keys('vlan:*');
  const vlanKeys = keys.filter(k => /^vlan:\d+$/.test(k));
  if (!vlanKeys.length) return 0;

  const pipe1 = redis.pipeline();
  vlanKeys.forEach(k => pipe1.hgetall(k));
  const results = await pipe1.exec();

  const AUTO_TAGS = new Set(Object.values(VLAN_DESC_MAP));
  const pipe2 = redis.pipeline();
  let updated = 0;
  for (let i = 0; i < vlanKeys.length; i++) {
    const vlan = results[i][1];
    if (!vlan?.vlan_id) continue;
    // Skip si description manuelle (non générée automatiquement)
    if (vlan.description && !AUTO_TAGS.has(vlan.description)) continue;
    pipe2.hset(vlanKeys[i], 'description', getVlanAutoDesc(vlan.vlan_id));
    updated++;
  }
  if (updated > 0) await pipe2.exec();
  return updated;
}

export async function getVlan(id) {
  const v = await redis.hgetall(`vlan:${id}`);
  return v?.vlan_id ? { id: parseInt(id), ...v } : null;
}

export async function updateVlan(id, { vlan_id, network, mask, gateway, description }) {
  const vlan = await redis.hgetall(`vlan:${id}`);
  if (!vlan?.vlan_id) throw new Error('VLAN introuvable');

  // Rename vlan_id index if changed
  if (vlan_id && vlan_id !== vlan.vlan_id) {
    const existing = await redis.hget(`site:${vlan.site_id}:vlans:idx`, vlan_id);
    if (existing && existing !== String(id)) throw Object.assign(new Error('Ce VLAN ID existe déjà'), { code: 'CONFLICT' });
    const pipe = redis.pipeline();
    pipe.hdel(`site:${vlan.site_id}:vlans:idx`, vlan.vlan_id);
    pipe.hset(`site:${vlan.site_id}:vlans:idx`, vlan_id, id);
    pipe.hset(`vlan:${id}`, 'vlan_id', vlan_id);
    await pipe.exec();
  }

  const fields = {};
  if (network      !== undefined) fields.network      = network;
  if (mask         !== undefined) fields.mask         = mask;
  if (gateway      !== undefined) fields.gateway      = gateway;
  if (description  !== undefined) fields.description  = description;
  if (Object.keys(fields).length) await redis.hset(`vlan:${id}`, fields);
}

export async function deleteVlan(id) {
  const vlan = await redis.hgetall(`vlan:${id}`);
  if (!vlan?.vlan_id) return;
  const ipIds = await redis.smembers(`vlan:${id}:ips`);
  const pipe = redis.pipeline();
  ipIds.forEach(ipId => pipe.del(`ip:${ipId}`));
  pipe.del(`vlan:${id}:ips`);
  pipe.del(`vlan:${id}:ips:idx`);
  pipe.hdel(`site:${vlan.site_id}:vlans:idx`, vlan.vlan_id);
  pipe.srem(`site:${vlan.site_id}:vlans`, id);
  pipe.del(`vlan:${id}`);
  await pipe.exec();
}

// =============================================================================
// IPS  (pas de hostname)
// =============================================================================
export async function getIp(id) {
  const ip = await redis.hgetall(`ip:${id}`);
  return ip?.ip_address ? { id: parseInt(id), ...ip } : null;
}

export async function updateIpStatus(id, status) {
  const VALID = ['Libre', 'Utilisé', 'Réservée'];
  if (!VALID.includes(status)) throw new Error('Statut invalide');
  const ip = await redis.hgetall(`ip:${id}`);
  if (!ip?.ip_address) throw new Error('IP introuvable');
  await redis.hset(`ip:${id}`, { status, updated_at: now() });
}

export async function updateIp(id, { status, hostname }) {
  const VALID = ['Libre', 'Utilisé', 'Réservée'];
  const ip = await redis.hgetall(`ip:${id}`);
  if (!ip?.ip_address) throw new Error('IP introuvable');
  const patch = { updated_at: now() };
  if (status !== undefined) {
    if (!VALID.includes(status)) throw new Error('Statut invalide');
    patch.status = status;
  }
  if (hostname !== undefined) patch.hostname = hostname;
  await redis.hset(`ip:${id}`, patch);
}

// Supprime définitivement toutes les IPs broadcast de tous les sites
// (adresse = broadcast calculée du VLAN, ou hostname contient 'broadcast')
export async function cleanupBroadcastIps() {
  const siteIds = await redis.smembers('sites');
  let deleted = 0;
  const report = [];

  for (const siteId of siteIds) {
    const vlanIds = await redis.smembers(`site:${siteId}:vlans`);
    for (const vlanId of vlanIds) {
      const vlan = await redis.hgetall(`vlan:${vlanId}`);
      if (!vlan?.vlan_id) continue;

      const bcast = computeBroadcast(vlan.network, vlan.mask);
      const ipIds = await redis.smembers(`vlan:${vlanId}:ips`);
      if (!ipIds.length) continue;

      const pipe = redis.pipeline();
      ipIds.forEach(ipId => pipe.hgetall(`ip:${ipId}`));
      const results = await pipe.exec();

      const toDelete = [];
      results.forEach(([, ip], i) => {
        if (!ip?.ip_address) return;
        const isBcastAddr = bcast && ip.ip_address === bcast;
        const isBcastHost = ip.hostname && ip.hostname.trim().toLowerCase().includes('broadcast');
        if (isBcastAddr || isBcastHost) toDelete.push({ ipId: ipIds[i], ip });
      });

      if (!toDelete.length) continue;

      const pipe2 = redis.pipeline();
      for (const { ipId, ip } of toDelete) {
        pipe2.del(`ip:${ipId}`);
        pipe2.srem(`vlan:${vlanId}:ips`, ipId);
        pipe2.hdel(`vlan:${vlanId}:ips:idx`, ip.ip_address);
        deleted++;
        report.push(`${ip.ip_address} (VLAN ${vlan.vlan_id})`);
      }
      await pipe2.exec();
    }
  }

  return { deleted, report };
}

export async function importIps(siteId, rows) {
  // rows = [{ip, hostname?, vlan?, status?}]
  // vlan field (VLAN number string, e.g. "100") is used for precise lookup when provided
  if (!rows.length) return 0;

  // Load all VLANs for this site: build vlan_id_str → { dbId, ips:idx map }
  const vlanDbIds = await redis.smembers(`site:${siteId}:vlans`);
  const pipe1 = redis.pipeline();
  vlanDbIds.forEach(vid => {
    pipe1.hgetall(`vlan:${vid}`);          // all VLAN fields (vlan_id, network, mask…)
    pipe1.hgetall(`vlan:${vid}:ips:idx`);  // ip_address → ip_id
  });
  const res1 = await pipe1.exec();

  // Build lookup structures + broadcast set
  const vlanNumToIpIdx = {};
  const addrToId = {};
  const broadcastSet = new Set();
  for (let i = 0; i < vlanDbIds.length; i++) {
    const vlanData = res1[i * 2][1];      // { vlan_id, network, mask, … }
    const ipIdx    = res1[i * 2 + 1][1]; // { ip_address: ip_id }
    if (vlanData?.vlan_id) vlanNumToIpIdx[String(vlanData.vlan_id)] = ipIdx || {};
    const bcast = computeBroadcast(vlanData?.network, vlanData?.mask);
    if (bcast) broadcastSet.add(bcast);
    if (ipIdx) Object.entries(ipIdx).forEach(([addr, ipId]) => { addrToId[addr] = ipId; });
  }

  let updated = 0;
  const pipe2 = redis.pipeline();
  for (const row of rows) {
    // Ignorer les adresses de broadcast (par adresse ou par hostname)
    if (broadcastSet.has(row.ip)) continue;
    if (row.hostname && row.hostname.trim().toLowerCase().includes('broadcast')) continue;
    // Prefer VLAN-scoped lookup when row.vlan is provided
    const scopedIdx = row.vlan ? vlanNumToIpIdx[String(row.vlan)] : null;
    const ipId = (scopedIdx && scopedIdx[row.ip]) || addrToId[row.ip];
    if (ipId) {
      const fields = { status: row.status || 'Utilisé', updated_at: now() };
      if (row.hostname) fields.hostname = row.hostname;
      pipe2.hset(`ip:${ipId}`, fields);
      updated++;
    }
  }
  await pipe2.exec();
  return updated;
}

// =============================================================================
// LOGS
// =============================================================================
export async function addLog(username, action, details, level = 'info') {
  const entry = JSON.stringify({ username, action, details, level, created_at: now() });
  const pipe = redis.pipeline();
  pipe.lpush('logs', entry);
  pipe.ltrim('logs', 0, 4999);
  await pipe.exec();
}

export async function getLogs(limit = 500) {
  const raw = await redis.lrange('logs', 0, Math.min(limit, 5000) - 1);
  return raw.map((r, i) => {
    try { return { _raw: r, id: i + 1, ...JSON.parse(r) }; }
    catch { return null; }
  }).filter(Boolean);
}

export async function clearLogs() {
  await redis.del('logs');
}

export async function deleteLogEntry(raw) {
  const removed = await redis.lrem('logs', 1, raw);
  return removed > 0;
}

// =============================================================================
// VLAN REQUESTS (pending approval)
// =============================================================================
export async function createVlanRequest(siteId, siteName, vlanId, network, mask, gateway, username) {
  const id = String(await redis.incr('seq:vlan_requests'));
  await redis.hset(`vlan_request:${id}`, {
    site_id:    String(siteId),
    site_name:  siteName,
    vlan_id:    vlanId,
    network:    network  || '',
    mask:       mask     || '',
    gateway:    gateway  || '',
    username,
    created_at: now(),
  });
  await redis.sadd('vlan_requests', id);
  return { id: parseInt(id), site_id: siteId, site_name: siteName, vlan_id: vlanId };
}

export async function listVlanRequests() {
  const ids = await redis.smembers('vlan_requests');
  if (!ids.length) return [];
  const pipe = redis.pipeline();
  ids.forEach(id => pipe.hgetall(`vlan_request:${id}`));
  const results = await pipe.exec();
  return ids
    .map((id, i) => ({ id: parseInt(id), ...results[i][1] }))
    .filter(r => r.vlan_id)
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
}

export async function getVlanRequest(id) {
  const r = await redis.hgetall(`vlan_request:${id}`);
  return r?.vlan_id ? { id: parseInt(id), ...r } : null;
}

export async function deleteVlanRequest(id) {
  await redis.del(`vlan_request:${id}`);
  await redis.srem('vlan_requests', String(id));
}

// =============================================================================
// ACCOUNT REQUESTS (pending admin approval)
// =============================================================================
export async function createUserWithHash(username, pwHash, role, fullName) {
  const existing = await redis.hget('users:idx:username', username);
  if (existing) throw Object.assign(new Error('Identifiant déjà utilisé'), { code: 'CONFLICT' });
  const id = uid();
  const pipe = redis.pipeline();
  pipe.hset(`user:${id}`, {
    username,
    full_name:  fullName || '',
    pw_hash:    pwHash,
    role,
    created_at: now(),
  });
  pipe.hset('users:idx:username', username, id);
  pipe.sadd('users', id);
  await pipe.exec();
  return { id, username, full_name: fullName, role };
}

export async function createAccountRequest(fullName, username, password) {
  const id = String(await redis.incr('seq:account_requests'));
  await redis.hset(`account_request:${id}`, {
    full_name:  fullName,
    username:   username.trim().toUpperCase(),
    pw_hash:    sha256(password),
    created_at: now(),
  });
  await redis.sadd('account_requests', id);
  return { id: parseInt(id) };
}

export async function listAccountRequests() {
  const ids = await redis.smembers('account_requests');
  if (!ids.length) return [];
  const pipe = redis.pipeline();
  ids.forEach(id => pipe.hgetall(`account_request:${id}`));
  const results = await pipe.exec();
  return ids
    .map((id, i) => ({ id: parseInt(id), ...results[i][1] }))
    .filter(r => r.username)
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
}

export async function getAccountRequest(id) {
  const r = await redis.hgetall(`account_request:${id}`);
  return r?.username ? { id: parseInt(id), ...r } : null;
}

export async function deleteAccountRequest(id) {
  await redis.del(`account_request:${id}`);
  await redis.srem('account_requests', String(id));
}
