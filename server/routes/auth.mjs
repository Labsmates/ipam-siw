import express from 'express';
import jwt     from 'jsonwebtoken';
import { getJwtSecret, ensureDefaultAdmin as _ensureAdmin,
         createUser, getUserByUsername, getUserById,
         listUsers, deleteUser, updatePassword, updateUserRole, addLog,
         incrementLoginCount } from '../redis.mjs';
import { requireAuth, requireAdmin } from '../middleware/auth.mjs';
import { sha256 } from '../utils.mjs';
import { loginRateLimit } from '../middleware/security.mjs';

export { _ensureAdmin as ensureDefaultAdmin };

const router = express.Router();

// POST /api/login
router.post('/login', loginRateLimit, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Identifiant et mot de passe requis' });
    const user = await getUserByUsername(username.trim().toUpperCase());
    if (!user || user.pw_hash !== sha256(password))
      return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect' });
    // Succès : réinitialise le compteur de tentatives pour cette IP
    res.locals.resetLoginRate?.();
    incrementLoginCount(user.id).catch(() => {});
    const secret = await getJwtSecret();
    const token  = jwt.sign(
      { userId: user.id, username: user.username, role: user.role },
      secret,
      { expiresIn: '24h' }
    );
    res.json({ token, user: { id: user.id, username: user.username, role: user.role, created_at: user.created_at } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/me
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await getUserById(req.user.userId);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    res.json({ id: user.id, username: user.username, role: user.role, created_at: user.created_at });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/users (admin)
router.get('/users', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const users = await listUsers();
    res.json({ users: users.map(u => ({ id: u.id, username: u.username, full_name: u.full_name || '', role: u.role, created_at: u.created_at, login_count: parseInt(u.login_count || '0', 10), last_login: u.last_login || null })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const USERNAME_RE = /^[PX][A-Z]{3}\d{3}$/;

// POST /api/users (admin)
router.post('/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { username, password, role, full_name } = req.body || {};
    if (!username?.trim()) return res.status(400).json({ error: 'Identifiant requis' });
    if (!password || password.length < 8) return res.status(400).json({ error: 'Mot de passe : minimum 8 caractères' });

    const uname = username.trim().toUpperCase();
    // Tous les comptes sauf 'admin' doivent respecter le format [PX][A-Z]{3}[0-9]{3}
    if (uname !== 'ADMIN' && !USERNAME_RE.test(uname))
      return res.status(400).json({ error: "Format invalide. L'identifiant doit commencer par P ou X, suivi de 3 lettres et 3 chiffres (ex: PJFY579)" });
    if (!full_name?.trim())
      return res.status(400).json({ error: 'Nom et prénom requis' });

    const validRole = ['admin', 'user', 'viewer'].includes(role) ? role : 'user';
    const user = await createUser(uname, password, validRole, full_name.trim());
    await addLog(req.user.username, 'ADD_USER', `Utilisateur « ${uname} » créé (rôle : ${validRole})`, 'ok');
    res.json({ ok: true, id: user.id });
  } catch (e) {
    if (e.code === 'CONFLICT') return res.status(409).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/users/:id (admin)
router.delete('/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (req.params.id === req.user.userId)
      return res.status(400).json({ error: 'Impossible de supprimer votre propre compte' });
    const target = await getUserById(req.params.id);
    await deleteUser(req.params.id);
    await addLog(req.user.username, 'DEL_USER', `Utilisateur « ${target?.username || req.params.id} » supprimé`, 'danger');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/users/:id/role (admin only — admin role reserved to super admin)
router.put('/users/:id/role', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { role } = req.body || {};
    const isSuperAdmin = req.user.username?.toLowerCase() === 'admin';
    const validRoles = isSuperAdmin ? ['admin', 'user', 'viewer'] : ['user', 'viewer'];
    if (!validRoles.includes(role))
      return res.status(400).json({ error: 'Rôle invalide' });
    if (role === 'admin' && !isSuperAdmin)
      return res.status(403).json({ error: 'Seul le super administrateur peut attribuer le rôle administrateur' });
    const target = await getUserById(req.params.id);
    if (!target) return res.status(404).json({ error: 'Utilisateur introuvable' });
    if (target.username?.toLowerCase() === 'admin')
      return res.status(403).json({ error: 'Impossible de modifier le rôle du super administrateur' });
    if (target.role === 'admin' && !isSuperAdmin)
      return res.status(403).json({ error: 'Seul le super administrateur peut modifier le rôle d\'un administrateur' });
    await updateUserRole(req.params.id, role);
    await addLog(req.user.username, 'CHANGE_ROLE', `${target.username} : ${target.role} → ${role}`, 'info');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/users/:id/password
router.put('/users/:id/password', requireAuth, async (req, res) => {
  try {
    const isSelf  = req.params.id === req.user.userId;
    const isAdmin = req.user.role === 'admin';
    if (!isSelf && !isAdmin) return res.status(403).json({ error: 'Accès refusé' });
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 8)
      return res.status(400).json({ error: 'Minimum 8 caractères' });
    if (isSelf && !isAdmin) {
      const user = await getUserById(req.params.id);
      if (!user || user.pw_hash !== sha256(currentPassword || ''))
        return res.status(400).json({ error: 'Mot de passe actuel incorrect' });
    }
    await updatePassword(req.params.id, newPassword);
    if (!isSelf) {
      const target = await getUserById(req.params.id);
      await addLog(req.user.username, 'RESET_PASSWORD', `MDP réinitialisé pour « ${target?.username || req.params.id} »`, 'info');
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/me/password — changer son propre mot de passe
router.post('/me/password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 8)
      return res.status(400).json({ error: 'Minimum 8 caractères' });
    const user = await getUserById(req.user.userId);
    if (!user || user.pw_hash !== sha256(currentPassword || ''))
      return res.status(400).json({ error: 'Mot de passe actuel incorrect' });
    await updatePassword(req.user.userId, newPassword);
    await addLog(req.user.username, 'CHANGE_PASSWORD', `${req.user.username} a changé son mot de passe`, 'info');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
