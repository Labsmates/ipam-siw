import express  from 'express';
import path     from 'path';
import { fileURLToPath } from 'url';

import authRouter         from './routes/auth.mjs';
import sitesRouter        from './routes/sites.mjs';
import vlansRouter        from './routes/vlans.mjs';
import ipsRouter          from './routes/ips.mjs';
import logsRouter         from './routes/logs.mjs';
import vlanRequestsRouter    from './routes/vlan_requests.mjs';
import accountRequestsRouter from './routes/account_requests.mjs';
import configRouter          from './routes/config.mjs';
import infosRouter           from './routes/infos.mjs';
import nettoolsRouter        from './routes/nettools.mjs';
import { securityHeaders } from './middleware/security.mjs';
import { maintenanceMiddleware } from './middleware/maintenance.mjs';
import { ensureDefaultAdmin } from './routes/auth.mjs';
import { autoTagAllVlans, redis } from './redis.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT      = parseInt(process.env.PORT || '3000');
const BIND      = process.env.NODE_ENV === 'production' ? '127.0.0.1' : '0.0.0.0';

const app = express();
app.disable('x-powered-by');
app.use(securityHeaders);
app.use(express.json({ limit: '10mb' }));

// ── Route publique : statut maintenance (pas d'auth, pas de maintenance block) ──
app.get('/api/maintenance/status', async (_req, res) => {
  try {
    const raw = await redis.get('config:maintenance');
    const m   = raw ? JSON.parse(raw) : { enabled: false };
    res.json({
      enabled:    !!m.enabled,
      message:    m.message    || '',
      plannedEnd: m.plannedEnd || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Middleware maintenance (avant static et routes protégées) ──────────────────
app.use(maintenanceMiddleware);

// Static files
app.use(express.static(path.join(__dirname, '../client')));
app.use('/vendor', express.static(path.join(__dirname, '../vendor')));

// API routes
app.use('/api',       authRouter);
app.use('/api/sites', sitesRouter);
app.use('/api/vlans', vlansRouter);
app.use('/api/ips',   ipsRouter);
app.use('/api/logs',          logsRouter);
app.use('/api/vlan_requests',    vlanRequestsRouter);
app.use('/api/account_requests', accountRequestsRouter);
app.use('/api/config',           configRouter);
app.use('/api/infos',            infosRouter);
app.use('/api/nettools',         nettoolsRouter);

// SPA fallback: unknown routes → index.html
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '../client/index.html')));

// Init & start
await ensureDefaultAdmin();
const tagged = await autoTagAllVlans();
if (tagged > 0) console.log(`[init] ${tagged} VLAN(s) auto-tagués`);
app.listen(PORT, BIND, () => {
  console.log(`IPAM SIW v2 démarré sur ${BIND}:${PORT} [${process.env.NODE_ENV || 'development'}]`);
});
