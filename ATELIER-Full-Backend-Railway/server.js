require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const isProduction = process.env.NODE_ENV === 'production' || Boolean(process.env.RAILWAY_ENVIRONMENT_ID);

if (!JWT_SECRET || !ADMIN_PASSWORD) {
  console.error('Missing required environment variables: JWT_SECRET and ADMIN_PASSWORD');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : (process.env.DATABASE_URL ? { rejectUnauthorized: false } : false),
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

app.set('trust proxy', 1);
app.disable('x-powered-by');
const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
pool.on('error', error => console.error('Idle database connection error:', error.message));
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false });
const contactLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false });

const seedProjects = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed-projects.json'), 'utf8'));
const defaultSettings = {
  studioName: 'ATELIER',
  studioEmail: 'hello@atelier-studio.com',
  studioPhone: '+1 (212) 555-0192',
  studioLocation: '142 West 36th Street, Suite 8\nNew York, NY 10018',
  officeHours: 'Monday – Friday, 9am – 6pm EST',
  footerDescription: 'A premium interior architecture and design studio. Spaces Designed Around Life.',
  heroEyebrow: 'Interior Architecture & Design',
  heroTitleLine1: 'Designing Spaces.',
  heroTitleLine2: 'Creating Experiences.',
  heroSubtitle: 'We craft timeless interiors that balance architecture, functionality, and emotion — spaces that feel as good as they look.',
  introTitle: 'Thoughtful Design. Timeless Spaces.',
  introParagraphOne: 'ATELIER is a creative architecture and interior design studio focused on creating meaningful environments. We believe great design is never accidental — it emerges from deep listening, careful material selection, and an unwavering attention to how people move through and inhabit a space.',
  introParagraphTwo: 'From intimate residences to expansive commercial interiors, every project is approached as a unique dialogue between architecture, light, and life.'
};

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_migrations (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS site_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS contact_messages (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT DEFAULT '',
      project_type TEXT NOT NULL,
      budget TEXT DEFAULT '',
      location TEXT DEFAULT '',
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','read','archived')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(87122026)");
    const migration = await client.query("INSERT INTO app_migrations (id) VALUES ('initial-projects') ON CONFLICT DO NOTHING RETURNING id");
    if (migration.rowCount) {
      const count = await client.query('SELECT COUNT(*)::int AS count FROM projects');
      if (count.rows[0].count === 0) {
        for (let i = 0; i < seedProjects.length; i++) {
          const p = seedProjects[i];
          await client.query('INSERT INTO projects (id, data, sort_order) VALUES ($1, $2, $3)', [p.id, p, i]);
        }
      }
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  await pool.query('INSERT INTO site_settings (id, data) VALUES (1, $1) ON CONFLICT (id) DO NOTHING', [defaultSettings]);
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function auth(req, res, next) {
  const token = req.cookies.atelier_admin;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'admin') throw new Error('Invalid role');
    req.admin = payload;
    next();
  } catch (_) { return res.status(401).json({ error: 'Session expired. Please sign in again.' }); }
}
function cleanText(value, max = 5000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
function validProject(p) {
  if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.id || '') || p.id.length > 80) return false;
  if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 180 || typeof p.cat !== 'string' || !p.cat.trim() || p.cat.length > 80) return false;
  const url = value => { try { return ['https:', 'http:'].includes(new URL(value).protocol); } catch { return false; } };
  if (!Array.isArray(p.images) || !p.images.length || p.images.length > 30 || !p.images.every(x => typeof x === 'string' && x.length <= 2048 && url(x))) return false;
  if (p.source && (typeof p.source !== 'string' || !url(p.source))) return false;
  return ['location','scale','credit','photographer','overview','concept','challenges','materials','color'].every(key => p[key] === undefined || (typeof p[key] === 'string' && p[key].length <= 5000));
}

app.get('/api/health', asyncRoute(async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, database: 'connected' }); }
  catch (_) { res.status(503).json({ ok: false, database: 'unavailable' }); }
}));

app.get('/api/public', asyncRoute(async (_req, res) => {
  try {
    const [projects, settings] = await Promise.all([
      pool.query('SELECT data FROM projects ORDER BY sort_order ASC, created_at ASC'),
      pool.query('SELECT data FROM site_settings WHERE id = 1')
    ]);
    res.set('Cache-Control', 'no-store');
    res.json({ projects: projects.rows.map(r => r.data), settings: settings.rows[0]?.data || defaultSettings });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Unable to load site content' }); }
}));

app.post('/api/contact', contactLimiter, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const name = cleanText(body.name, 160);
  const email = cleanText(body.email, 254);
  const phone = cleanText(body.phone, 60);
  const projectType = cleanText(body.type, 120);
  const budget = cleanText(body.budget, 100);
  const location = cleanText(body.location, 180);
  const message = cleanText(body.message, 5000);
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !projectType || message.length < 10) {
    return res.status(400).json({ error: 'Please complete the required fields with valid information.' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO contact_messages (name,email,phone,project_type,budget,location,message)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
      [name,email,phone,projectType,budget,location,message]
    );
    res.status(201).json({ ok: true, message: 'Your enquiry has been received.', id: result.rows[0].id });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Message could not be saved. Please try again.' }); }
}));

app.post('/api/admin/login', loginLimiter, (req, res) => {
  const username = cleanText(req.body?.username, 100);
  const password = String(req.body?.password || '');
  if (!safeEqual(username, ADMIN_USERNAME) || !safeEqual(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  const token = jwt.sign({ role: 'admin', username }, JWT_SECRET, { expiresIn: '12h' });
  res.cookie('atelier_admin', token, { httpOnly: true, secure: isProduction, sameSite: 'lax', maxAge: 12 * 60 * 60 * 1000, path: '/' });
  res.json({ ok: true });
});
app.post('/api/admin/logout', auth, (_req, res) => {
  res.clearCookie('atelier_admin', { httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/' });
  res.json({ ok: true });
});
app.get('/api/admin/me', auth, (req, res) => res.json({ ok: true, username: req.admin.username }));

app.get('/api/admin/projects', auth, asyncRoute(async (_req, res) => {
  const result = await pool.query('SELECT data, sort_order, created_at, updated_at FROM projects ORDER BY sort_order ASC, created_at ASC');
  res.json(result.rows.map(r => ({ ...r.data, _sortOrder: r.sort_order, _updatedAt: r.updated_at })));
}));
app.post('/api/admin/projects', auth, asyncRoute(async (req, res) => {
  const p = req.body;
  if (!validProject(p)) return res.status(400).json({ error: 'Provide a valid project ID, name, category and 1–30 HTTP(S) image URLs. Text fields must be strings of at most 5000 characters.' });
  try {
    const count = await pool.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM projects');
    await pool.query('INSERT INTO projects (id,data,sort_order) VALUES ($1,$2,$3)', [p.id, p, count.rows[0].next]);
    res.status(201).json({ ok: true });
  } catch (e) { res.status(e.code === '23505' ? 409 : 500).json({ error: e.code === '23505' ? 'This project ID already exists.' : 'Could not save project.' }); }
}));
app.put('/api/admin/projects/reorder', auth, asyncRoute(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length || new Set(ids).size !== ids.length || !ids.every(id => typeof id === 'string')) return res.status(400).json({ error: 'Invalid project order.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT id FROM projects FOR UPDATE');
    if (existing.rows.length !== ids.length || existing.rows.some(p => !ids.includes(p.id))) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Order must contain all projects exactly once.' }); }
    for (let i = 0; i < ids.length; i++) await client.query('UPDATE projects SET sort_order=$1 WHERE id=$2', [i, ids[i]]);
    await client.query('COMMIT'); res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: 'Could not reorder projects.' }); }
  finally { client.release(); }
}));
app.put('/api/admin/projects/:id', auth, asyncRoute(async (req, res) => {
  const p = req.body;
  if (!validProject(p) || p.id !== req.params.id) return res.status(400).json({ error: 'Invalid project data.' });
  const result = await pool.query('UPDATE projects SET data=$1, updated_at=NOW() WHERE id=$2', [p, req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Project not found.' });
  res.json({ ok: true });
}));
app.delete('/api/admin/projects/:id', auth, asyncRoute(async (req, res) => {
  const result = await pool.query('DELETE FROM projects WHERE id=$1', [req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Project not found.' });
  res.json({ ok: true });
}));


app.get('/api/admin/settings', auth, asyncRoute(async (_req, res) => {
  const result = await pool.query('SELECT data FROM site_settings WHERE id=1');
  res.json(result.rows[0]?.data || defaultSettings);
}));
app.put('/api/admin/settings', auth, asyncRoute(async (req, res) => {
  const allowed = Object.keys(defaultSettings);
  const next = {};
  for (const key of allowed) next[key] = cleanText(req.body?.[key] ?? defaultSettings[key], 5000);
  await pool.query('INSERT INTO site_settings (id,data) VALUES (1,$1) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, updated_at=NOW()', [next]);
  res.json({ ok: true, settings: next });
}));

app.get('/api/admin/messages', auth, asyncRoute(async (req, res) => {
  const status = ['new','read','archived'].includes(req.query.status) ? req.query.status : null;
  const page = Math.max(1, Math.min(1000000, parseInt(req.query.page, 10) || 1));
  const limit = 50;
  const where = status ? ' WHERE status=$1' : '';
  const params = status ? [status] : [];
  const count = await pool.query('SELECT COUNT(*)::int AS count FROM contact_messages' + where, params);
  const unread = await pool.query("SELECT COUNT(*)::int AS count FROM contact_messages WHERE status='new'");
  const result = await pool.query('SELECT * FROM contact_messages' + where + ` ORDER BY created_at DESC, id DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`, [...params, limit, (page-1)*limit]);
  res.json({ messages: result.rows, page, total: count.rows[0].count, unread: unread.rows[0].count, pages: Math.ceil(count.rows[0].count / limit) });
}));
app.patch('/api/admin/messages/:id', auth, asyncRoute(async (req, res) => {
  if (!/^[1-9][0-9]*$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid message ID.' });
  const status = req.body?.status;
  if (!['new','read','archived'].includes(status)) return res.status(400).json({ error: 'Invalid message status.' });
  const result = await pool.query('UPDATE contact_messages SET status=$1 WHERE id=$2 RETURNING id,status', [status, req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Message not found.' });
  res.json(result.rows[0]);
}));
app.delete('/api/admin/messages/:id', auth, asyncRoute(async (req, res) => {
  if (!/^[1-9][0-9]*$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid message ID.' });
  const result = await pool.query('DELETE FROM contact_messages WHERE id=$1', [req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Message not found.' });
  res.json({ ok: true });
}));

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: isProduction ? '1h' : 0, setHeaders(res, file) { if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); } }));
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'), err => { if (err) next(err); });
});

app.use((error, req, res, next) => {
  console.error('Request failed:', error.message);
  if (res.headersSent) return next(error);
  const status = error.type === 'entity.parse.failed' ? 400 : error.type === 'entity.too.large' ? 413 : 500;
  res.status(status).json({ error: status === 400 ? 'Invalid JSON body.' : status === 413 ? 'Request too large.' : 'Unable to complete the request. Please try again.' });
});

if (require.main === module) {
  initDatabase().then(() => {
    app.listen(PORT, '0.0.0.0', () => console.log(`ATELIER server listening on ${PORT}`));
  }).catch(err => { console.error('Database initialization failed:', err); process.exit(1); });
}
module.exports = { app, pool, initDatabase };

process.on('SIGTERM', async () => { await pool.end(); process.exit(0); });

