// Base de données SQLite (module natif node:sqlite, aucune compilation requise)
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

// En production (Railway), DATA_DIR pointe vers un volume persistant (ex. /data)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'madinati360.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'citizen' CHECK (role IN ('citizen','agent','admin')),
  commune       TEXT,
  points        INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS teams (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL,
  specialty TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  category      TEXT NOT NULL,
  severity      INTEGER NOT NULL CHECK (severity BETWEEN 1 AND 5),
  title         TEXT NOT NULL,
  description   TEXT,
  ai_source     TEXT,           -- 'claude' | 'local'
  ai_confidence REAL,
  lat           REAL NOT NULL,
  lng           REAL NOT NULL,
  address       TEXT,
  photo_before  TEXT,
  photo_after   TEXT,
  status        TEXT NOT NULL DEFAULT 'signale'
                CHECK (status IN ('signale','transmis','en_route','resolu','rejete')),
  team_id       INTEGER REFERENCES teams(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_user ON reports(user_id);

CREATE TABLE IF NOT EXISTS report_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id  INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  status     TEXT NOT NULL,
  note       TEXT,
  by_user    INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- "Moi aussi je l'ai vu" : confirmations par d'autres citoyens
CREATE TABLE IF NOT EXISTS confirmations (
  report_id  INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (report_id, user_id)
);

CREATE TABLE IF NOT EXISTS rewards (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  title   TEXT NOT NULL,
  partner TEXT NOT NULL,
  cost    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS redemptions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  reward_id  INTEGER NOT NULL REFERENCES rewards(id),
  code       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS points_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  delta      INTEGER NOT NULL,
  reason     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

function addPoints(userId, delta, reason) {
  db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(delta, userId);
  db.prepare('INSERT INTO points_log (user_id, delta, reason) VALUES (?,?,?)').run(userId, delta, reason);
}

// ---------- Données de démonstration ----------
function placeholderPhoto(name, color, label) {
  const file = `seed-${name}.svg`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420">
<rect width="100%" height="100%" fill="${color}"/>
<text x="50%" y="50%" font-family="sans-serif" font-size="34" fill="#fff" text-anchor="middle">${label}</text></svg>`;
  fs.writeFileSync(path.join(UPLOAD_DIR, file), svg);
  return file;
}

function seed() {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return;
  const hash = (p) => bcrypt.hashSync(p, 10);
  const insUser = db.prepare('INSERT INTO users (name,email,password_hash,role,commune) VALUES (?,?,?,?,?)');
  insUser.run('Agent APC Béjaïa', 'agent@apc-bejaia.dz', hash('agent123'), 'agent', 'Béjaïa');
  const c1 = insUser.run('Amine K.', 'citoyen@demo.dz', hash('demo123'), 'citizen', 'Béjaïa').lastInsertRowid;
  const c2 = insUser.run('Lydia B.', 'lydia@demo.dz', hash('demo123'), 'citizen', 'Béjaïa').lastInsertRowid;

  const insTeam = db.prepare('INSERT INTO teams (name, specialty) VALUES (?,?)');
  [['Équipe Voirie 1', 'voirie'], ['Équipe Eau (ADE)', 'eau'], ['Équipe Éclairage', 'eclairage'],
   ['Équipe Propreté', 'dechets'], ['Équipe Polyvalente', 'autre']].forEach((t) => insTeam.run(...t));

  const insReward = db.prepare('INSERT INTO rewards (title, partner, cost) VALUES (?,?,?)');
  insReward.run('Ticket de bus gratuit', 'ETUB (Transport urbain)', 50);
  insReward.run('-20% abonnement mensuel transport', 'ETUB (Transport urbain)', 150);
  insReward.run('Entrée gratuite piscine municipale', 'APC Béjaïa', 100);
  insReward.run('Café offert', 'Commerces partenaires', 30);

  const insReport = db.prepare(`INSERT INTO reports
    (user_id,category,severity,title,description,ai_source,ai_confidence,lat,lng,address,photo_before,photo_after,status,team_id,created_at,resolved_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now',?),?)`);
  const hist = db.prepare('INSERT INTO report_history (report_id,status,note,created_at) VALUES (?,?,?,datetime(\'now\',?))');

  const samples = [
    [c1, 'nid_de_poule', 4, 'Nid-de-poule profond', 'Trou d\'environ 40 cm sur la chaussée, dangereux pour les deux-roues.', 36.7509, 5.0567, 'Boulevard Amirouche', placeholderPhoto('1', '#6b5b4b', 'Nid-de-poule'), null, 'en_route', 1, '-3 days'],
    [c2, 'fuite_eau', 5, 'Fuite d\'eau importante', 'Eau potable qui jaillit du trottoir depuis ce matin.', 36.7552, 5.0843, 'Rue de la Liberté', placeholderPhoto('2', '#2b6c9e', 'Fuite d\'eau'), null, 'transmis', 2, '-1 days'],
    [c1, 'eclairage', 3, 'Lampadaire en panne', 'Rue plongée dans le noir la nuit.', 36.7470, 5.0640, 'Cité Ihaddaden', placeholderPhoto('3', '#3c3c55', 'Éclairage'), null, 'signale', null, '-6 hours'],
    [c2, 'dechets', 3, 'Dépôt sauvage de déchets', 'Accumulation de sacs poubelles près de l\'école.', 36.7600, 5.0700, 'Quartier Sidi Ahmed', placeholderPhoto('4', '#5e7d3a', 'Déchets'), placeholderPhoto('4b', '#2f8f5b', 'Après nettoyage'), 'resolu', 4, '-8 days'],
    [c1, 'fissure', 4, 'Fissure sur muret de soutènement', 'Fissure qui s\'élargit, risque d\'éboulement.', 36.7535, 5.0480, 'Route des Aiguades', placeholderPhoto('5', '#7a7a7a', 'Fissure'), null, 'signale', null, '-2 days'],
  ];
  const statusFlow = ['signale', 'transmis', 'en_route', 'resolu'];
  for (const s of samples) {
    const [, , , , , , , , , , status, , age] = s;
    const resolvedAt = status === 'resolu' ? new Date(Date.now() - 2 * 864e5).toISOString().replace('T', ' ').slice(0, 19) : null;
    const id = insReport.run(s[0], s[1], s[2], s[3], s[4], 'local', 0.8, s[5], s[6], s[7], s[8], s[9], status, s[11], age, resolvedAt).lastInsertRowid;
    for (const st of statusFlow.slice(0, statusFlow.indexOf(status) + 1)) hist.run(id, st, null, age);
    addPoints(s[0], 10, 'Signalement #' + id);
    if (status === 'resolu') addPoints(s[0], 20, 'Signalement résolu #' + id);
  }
}
seed();

module.exports = { db, addPoints, UPLOAD_DIR };
