import express from 'express';
import { getLogs, clearLogs, clearArchiveLogs, deleteLogEntry, redis } from '../redis.mjs';
import { requireAuth, requireAdmin, requireSuperAdmin } from '../middleware/auth.mjs';

const router = express.Router();

// GET /api/logs/archive (all authenticated users) — hostname release history
router.get('/archive', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 2000, 5000);
    const all = await getLogs(limit);
    const releases = all
      .filter(l => l.action === 'RELEASE_IP')
      .map(l => {
        try {
          const d = JSON.parse(l.details);
          return {
            username:   l.username,
            ip:         d.ip,
            hostname:   d.hostname,
            comment:    d.comment || '',
            created_at: l.created_at,
            _raw:       l._raw,
          };
        } catch { return null; }
      })
      .filter(Boolean);
    res.json({ releases });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/logs/archive — effacer toutes les entrées de libération (super admin only)
router.delete('/archive', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const count = await clearArchiveLogs();
    res.json({ ok: true, count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/logs/site-stats (super admin) — connexions semaine/mois/année + durée moyenne + répartition par rôle
router.get('/site-stats', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const all  = await getLogs(5000);
    const now  = new Date();
    const startOf = (d, unit) => {
      const dt = new Date(d);
      if (unit === 'week') { const day = dt.getDay() || 7; dt.setHours(0,0,0,0); dt.setDate(dt.getDate() - (day - 1)); }
      else if (unit === 'month') { dt.setDate(1); dt.setHours(0,0,0,0); }
      else if (unit === 'year')  { dt.setMonth(0,1); dt.setHours(0,0,0,0); }
      return dt;
    };
    const weekStart  = startOf(now, 'week').getTime();
    const monthStart = startOf(now, 'month').getTime();
    const yearStart  = startOf(now, 'year').getTime();

    // Pré-charger le rôle des usernames sans JSON dans les détails
    const unknownUsers = new Set();
    for (const l of all) {
      if (l.action !== 'LOGIN' && l.action !== 'LOGOUT') continue;
      try { if (!JSON.parse(l.details || '{}').role) unknownUsers.add(l.username); }
      catch { unknownUsers.add(l.username); }
    }
    const userRoleCache = {};
    if (unknownUsers.size) {
      const uArr = [...unknownUsers];
      const pipe1 = redis.pipeline();
      uArr.forEach(u => pipe1.hget('users:idx:username', u));
      const ids = await pipe1.exec();
      const pipe2 = redis.pipeline();
      ids.forEach(([, id]) => id ? pipe2.hget(`user:${id}`, 'role') : pipe2.hget('_noop_', '_noop_'));
      const roles = await pipe2.exec();
      uArr.forEach((u, i) => { userRoleCache[u] = ids[i][1] ? (roles[i][1] || 'user') : 'user'; });
    }

    const getRole = (l) => {
      try { return JSON.parse(l.details || '{}').role || userRoleCache[l.username] || 'user'; }
      catch { return userRoleCache[l.username] || 'user'; }
    };

    let weekLogins = 0, monthLogins = 0, yearLogins = 0;
    const durations = [];
    const ROLES = ['admin', 'user', 'viewer'];
    const byRole = {};
    ROLES.forEach(r => { byRole[r] = { logins: 0, duration_total: 0, duration_count: 0 }; });

    for (const l of all) {
      const ts   = l.created_at ? new Date(l.created_at).getTime() : 0;
      const role = getRole(l);
      const rb   = byRole[role] || byRole['user'];
      if (l.action === 'LOGIN') {
        if (ts >= weekStart)  weekLogins++;
        if (ts >= monthStart) monthLogins++;
        if (ts >= yearStart)  yearLogins++;
        rb.logins++;
      } else if (l.action === 'LOGOUT') {
        try {
          const d = JSON.parse(l.details || '{}');
          if (d.duration_s > 0) {
            durations.push(d.duration_s);
            rb.duration_total += d.duration_s;
            rb.duration_count++;
          }
        } catch (_) {}
      }
    }

    const avg_duration_s = durations.length
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : null;

    const byRoleOut = {};
    ROLES.forEach(r => {
      byRoleOut[r] = {
        logins: byRole[r].logins,
        avg_duration_s: byRole[r].duration_count
          ? Math.round(byRole[r].duration_total / byRole[r].duration_count)
          : null,
      };
    });

    res.json({ week: weekLogins, month: monthLogins, year: yearLogins, avg_duration_s, sample: durations.length, by_role: byRoleOut });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/logs (admin)
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 500, 5000);
    res.json({ logs: await getLogs(limit) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/logs/entry — supprimer un log individuel (super admin only)
router.delete('/entry', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { raw } = req.body || {};
    if (!raw) return res.status(400).json({ error: 'Entrée manquante' });
    const removed = await deleteLogEntry(raw);
    if (!removed) return res.status(404).json({ error: 'Entrée introuvable' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/logs — effacer tous les logs (super admin only)
router.delete('/', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    await clearLogs();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
