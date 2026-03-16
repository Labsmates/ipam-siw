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
import { securityHeaders } from './middleware/security.mjs';
import { ensureDefaultAdmin } from './routes/auth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT      = parseInt(process.env.PORT || '3000');
const BIND      = process.env.NODE_ENV === 'production' ? '127.0.0.1' : '0.0.0.0';

const app = express();
app.disable('x-powered-by');
app.use(securityHeaders);
app.use(express.json({ limit: '10mb' }));

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

// SPA fallback: unknown routes → index.html
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '../client/index.html')));

// Init & start
await ensureDefaultAdmin();
app.listen(PORT, BIND, () => {
  console.log(`IPAM SIW v2 démarré sur ${BIND}:${PORT} [${process.env.NODE_ENV || 'development'}]`);
});
