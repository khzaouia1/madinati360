const express = require('express');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { db, addPoints, UPLOAD_DIR } = require('./db');
const { analyze, CATEGORIES, aiEnabled } = require('./ai');

const app = express();
const PORT = process.env.PORT || 3000;
const STATUSES = {
  signale: 'Signalé',
  transmis: "Transmis à l'APC",
  en_route: 'Équipe technique en route',
  resolu: 'Problème résolu',
  rejete: 'Rejeté',
};
const POINTS = { report: 10, resolved: 20, confirm: 2 };

app.set('trust proxy', 1); // derrière le proxy HTTPS de l'hébergeur
app.use(express.json());
app.get('/health', (req, res) => res.json({ ok: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 864e5 },
}));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules/leaflet/dist')));

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }[file.mimetype] || '';
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)),
});

// ---------- Helpers ----------
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const me = (req) => (req.session.userId
  ? db.prepare('SELECT id,name,email,role,commune,points,created_at FROM users WHERE id=?').get(req.session.userId)
  : null);
function requireAuth(req, res, next) {
  const u = me(req);
  if (!u) return res.status(401).json({ error: 'Connexion requise' });
  req.user = u; next();
}
function requireAgent(req, res, next) {
  requireAuth(req, res, () => (['agent', 'admin'].includes(req.user.role)
    ? next() : res.status(403).json({ error: 'Réservé aux agents municipaux' })));
}
const removeUpload = (f) => f && fs.unlink(path.join(UPLOAD_DIR, path.basename(f)), () => {});

// Score de priorité : gravité + confirmations citoyennes + ancienneté
const REPORT_SELECT = `
  SELECT r.*, u.name AS author, t.name AS team_name,
    (SELECT COUNT(*) FROM confirmations c WHERE c.report_id = r.id) AS confirmations,
    CAST(julianday('now') - julianday(r.created_at) AS REAL) AS age_days
  FROM reports r JOIN users u ON u.id = r.user_id LEFT JOIN teams t ON t.id = r.team_id`;
function decorate(r) {
  if (!r) return r;
  const open = !['resolu', 'rejete'].includes(r.status);
  r.priority = open ? Math.round(r.severity * 20 + r.confirmations * 5 + Math.min(r.age_days, 15) * 2) : 0;
  r.category_label = CATEGORIES[r.category]?.label || r.category;
  r.category_icon = CATEGORIES[r.category]?.icon || '📍';
  r.status_label = STATUSES[r.status];
  return r;
}

// ---------- Auth ----------
app.post('/api/auth/register', (req, res) => {
  const { name, email, password, commune } = req.body || {};
  if (!name || !email || !password || password.length < 6)
    return res.status(400).json({ error: 'Nom, email et mot de passe (6 caractères min.) requis' });
  try {
    const id = db.prepare('INSERT INTO users (name,email,password_hash,commune) VALUES (?,?,?,?)')
      .run(name.trim(), email.trim().toLowerCase(), bcrypt.hashSync(password, 10), commune || null).lastInsertRowid;
    req.session.userId = Number(id);
    res.json(me(req));
  } catch (e) {
    res.status(409).json({ error: 'Cet email est déjà utilisé' });
  }
});
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(email || '').trim().toLowerCase());
  if (!u || !bcrypt.compareSync(String(password || ''), u.password_hash))
    return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
  req.session.userId = u.id;
  res.json(me(req));
});
app.post('/api/auth/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', (req, res) => res.json(me(req)));

app.get('/api/meta', (req, res) => res.json({
  categories: CATEGORIES, statuses: STATUSES, ai: aiEnabled() ? 'claude' : 'local',
  teams: db.prepare('SELECT * FROM teams').all(),
}));

// ---------- Détecteur IA ----------
app.post('/api/analyze', requireAuth, upload.single('photo'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Photo requise (JPEG, PNG ou WebP)' });
  const result = await analyze(req.file.path, req.file.mimetype, req.body.hint);
  res.json({ ...result, photo: req.file.filename });
}));

// ---------- Signalements ----------
app.get('/api/reports', (req, res) => {
  const where = [], args = [];
  if (req.query.status) { where.push('r.status = ?'); args.push(req.query.status); }
  if (req.query.category) { where.push('r.category = ?'); args.push(req.query.category); }
  if (req.query.mine) {
    const u = me(req); if (!u) return res.status(401).json({ error: 'Connexion requise' });
    where.push('r.user_id = ?'); args.push(u.id);
  }
  const rows = db.prepare(`${REPORT_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.created_at DESC LIMIT 500`).all(...args);
  res.json(rows.map(decorate));
});

app.get('/api/reports/:id', (req, res) => {
  const r = decorate(db.prepare(`${REPORT_SELECT} WHERE r.id = ?`).get(req.params.id));
  if (!r) return res.status(404).json({ error: 'Introuvable' });
  r.history = db.prepare(`SELECT h.*, u.name AS by_name FROM report_history h LEFT JOIN users u ON u.id=h.by_user
    WHERE report_id=? ORDER BY h.id`).all(r.id);
  const u = me(req);
  r.confirmed_by_me = !!(u && db.prepare('SELECT 1 FROM confirmations WHERE report_id=? AND user_id=?').get(r.id, u.id));
  res.json(r);
});

app.post('/api/reports', requireAuth, (req, res) => {
  const { photo, category, severity, title, description, lat, lng, address, ai_source, ai_confidence } = req.body || {};
  const la = Number(lat), ln = Number(lng), sev = Number(severity);
  if (!photo || !fs.existsSync(path.join(UPLOAD_DIR, path.basename(photo))))
    return res.status(400).json({ error: 'Photo manquante' });
  if (!Number.isFinite(la) || !Number.isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180)
    return res.status(400).json({ error: 'Position GPS invalide' });
  if (!CATEGORIES[category] || !(sev >= 1 && sev <= 5))
    return res.status(400).json({ error: 'Catégorie ou gravité invalide' });

  const id = Number(db.prepare(`INSERT INTO reports
    (user_id,category,severity,title,description,ai_source,ai_confidence,lat,lng,address,photo_before)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(req.user.id, category, Math.round(sev),
    String(title || CATEGORIES[category].label).slice(0, 120), String(description || '').slice(0, 1000),
    ai_source === 'claude' ? 'claude' : 'local', Number(ai_confidence) || null, la, ln,
    address ? String(address).slice(0, 200) : null, path.basename(photo)).lastInsertRowid);
  db.prepare('INSERT INTO report_history (report_id,status,by_user) VALUES (?,?,?)').run(id, 'signale', req.user.id);
  addPoints(req.user.id, POINTS.report, `Signalement #${id}`);
  res.status(201).json(decorate(db.prepare(`${REPORT_SELECT} WHERE r.id = ?`).get(id)));
});

app.post('/api/reports/:id/confirm', requireAuth, (req, res) => {
  const r = db.prepare('SELECT * FROM reports WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Introuvable' });
  if (r.user_id === req.user.id) return res.status(400).json({ error: 'Vous êtes l\'auteur de ce signalement' });
  const ins = db.prepare('INSERT OR IGNORE INTO confirmations (report_id,user_id) VALUES (?,?)').run(r.id, req.user.id);
  if (ins.changes) addPoints(req.user.id, POINTS.confirm, `Confirmation #${r.id}`);
  res.json({ ok: true });
});

// ---------- Espace municipal (APC) ----------
app.patch('/api/reports/:id', requireAgent, upload.single('photo_after'), (req, res) => {
  const r = db.prepare('SELECT * FROM reports WHERE id=?').get(req.params.id);
  if (!r) { removeUpload(req.file?.filename); return res.status(404).json({ error: 'Introuvable' }); }
  const { status, team_id, note, severity } = req.body || {};
  if (status && !STATUSES[status]) return res.status(400).json({ error: 'Statut invalide' });
  if (status === 'resolu' && !req.file && !r.photo_after)
    return res.status(400).json({ error: 'Une photo "après" est requise pour clôturer' });

  const newStatus = status || r.status;
  db.prepare(`UPDATE reports SET status=?, team_id=?, severity=?, photo_after=COALESCE(?, photo_after),
      updated_at=datetime('now'), resolved_at = CASE WHEN ?='resolu' THEN COALESCE(resolved_at, datetime('now')) ELSE NULL END
    WHERE id=?`).run(newStatus, team_id === '' ? null : (team_id ?? r.team_id),
    severity ? Math.min(5, Math.max(1, Number(severity))) : r.severity, req.file?.filename || null, newStatus, r.id);
  if (newStatus !== r.status || note)
    db.prepare('INSERT INTO report_history (report_id,status,note,by_user) VALUES (?,?,?,?)').run(r.id, newStatus, note || null, req.user.id);
  if (newStatus === 'resolu' && r.status !== 'resolu') addPoints(r.user_id, POINTS.resolved, `Signalement résolu #${r.id}`);
  res.json(decorate(db.prepare(`${REPORT_SELECT} WHERE r.id = ?`).get(r.id)));
});

app.get('/api/dashboard', requireAgent, (req, res) => {
  const one = (sql) => db.prepare(sql).get();
  res.json({
    total: one('SELECT COUNT(*) n FROM reports').n,
    open: one("SELECT COUNT(*) n FROM reports WHERE status NOT IN ('resolu','rejete')").n,
    resolved: one("SELECT COUNT(*) n FROM reports WHERE status='resolu'").n,
    urgent: one("SELECT COUNT(*) n FROM reports WHERE severity>=4 AND status NOT IN ('resolu','rejete')").n,
    avg_resolution_days: one("SELECT ROUND(AVG(julianday(resolved_at)-julianday(created_at)),1) d FROM reports WHERE resolved_at IS NOT NULL").d,
    by_category: db.prepare('SELECT category, COUNT(*) n FROM reports GROUP BY category ORDER BY n DESC').all()
      .map((c) => ({ ...c, label: CATEGORIES[c.category]?.label || c.category })),
    by_status: db.prepare('SELECT status, COUNT(*) n FROM reports GROUP BY status').all(),
    citizens: one("SELECT COUNT(*) n FROM users WHERE role='citizen'").n,
  });
});

// ---------- Gamification ----------
app.get('/api/leaderboard', (req, res) => res.json(db.prepare(`
  SELECT u.id, u.name, u.points, (SELECT COUNT(*) FROM reports r WHERE r.user_id=u.id) AS reports
  FROM users u WHERE role='citizen' ORDER BY points DESC LIMIT 20`).all()));
app.get('/api/rewards', (req, res) => res.json(db.prepare('SELECT * FROM rewards ORDER BY cost').all()));
app.get('/api/me/points', requireAuth, (req, res) => res.json({
  log: db.prepare('SELECT * FROM points_log WHERE user_id=? ORDER BY id DESC LIMIT 30').all(req.user.id),
  redemptions: db.prepare(`SELECT d.*, w.title, w.partner FROM redemptions d JOIN rewards w ON w.id=d.reward_id
    WHERE d.user_id=? ORDER BY d.id DESC`).all(req.user.id),
}));
app.post('/api/rewards/:id/redeem', requireAuth, (req, res) => {
  const w = db.prepare('SELECT * FROM rewards WHERE id=?').get(req.params.id);
  if (!w) return res.status(404).json({ error: 'Récompense introuvable' });
  const upd = db.prepare('UPDATE users SET points = points - ? WHERE id=? AND points >= ?').run(w.cost, req.user.id, w.cost);
  if (!upd.changes) return res.status(400).json({ error: 'Points insuffisants' });
  db.prepare('INSERT INTO points_log (user_id,delta,reason) VALUES (?,?,?)').run(req.user.id, -w.cost, `Récompense : ${w.title}`);
  const code = 'M360-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  db.prepare('INSERT INTO redemptions (user_id,reward_id,code) VALUES (?,?,?)').run(req.user.id, w.id, code);
  res.json({ code, reward: w });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 500).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Fichier trop volumineux (10 Mo max)' : 'Erreur serveur' });
});

app.listen(PORT, () => console.log(`Madinati 360 → http://localhost:${PORT}  (IA : ${aiEnabled() ? 'Claude' : 'analyse locale'})`));
