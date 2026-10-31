# Madinati 360 — Ma Ville 360

Application web citoyenne de signalement des anomalies urbaines (fuites d'eau, nids-de-poule, éclairage public, déchets, fissures…) avec détection par IA visuelle, carte publique, suivi en temps réel, gamification et tableau de bord pour les municipalités (APC).

## Démarrage

Prérequis : Node.js 22.13 ou plus récent (la base SQLite intégrée à Node est utilisée, rien à installer en plus).

```bash
npm install
npm start
```

Ouvrir http://localhost:3000

Comptes de démonstration (créés automatiquement au premier lancement) :

| Rôle | Email | Mot de passe |
|---|---|---|
| Citoyen | citoyen@demo.dz | demo123 |
| Citoyen | lydia@demo.dz | demo123 |
| Agent APC | agent@apc-bejaia.dz | agent123 |

## Activer l'IA visuelle (Claude)

Sans clé, l'application utilise une **analyse locale de secours** basée sur le commentaire du citoyen.
Pour que la photo soit réellement analysée par l'IA :

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm start
```

L'IA renvoie la catégorie, la gravité (1–5), un titre et une description ; le citoyen peut corriger avant d'envoyer.

## Fonctionnalités

**Côté citoyen (gratuit)**
- Photo ou courte vidéo (une image est extraite automatiquement) → détection automatique du problème et de sa gravité.
- Géolocalisation GPS ou choix sur la carte.
- Carte publique de la ville avec filtres par catégorie / statut.
- Suivi : Signalé → Transmis à l'APC → Équipe technique en route → Problème résolu, avec photo avant/après.
- « Moi aussi je l'ai vu » : les autres habitants confirment un signalement (augmente sa priorité).
- Points : +10 par signalement, +20 quand il est résolu, +2 par confirmation ; classement et récompenses partenaires (tickets de bus, etc.) avec code unique.

**Côté municipalité / entreprises publiques (SaaS B2G)**
- Tableau de bord 360° : indicateurs, carte des alertes ouvertes, répartition par catégorie et statut.
- File d'intervention triée par priorité (gravité × 20 + confirmations × 5 + ancienneté × 2).
- Affectation des équipes, changement de statut, note visible par le citoyen, photo « après » obligatoire pour clôturer.

## Architecture

```
server.js      API REST Express (auth par session, upload des photos, rôles citoyen/agent)
db.js          Schéma SQLite + données de démo (data/madinati360.db)
ai.js          Détecteur d'anomalies (Claude vision + repli local)
public/        Interface web (HTML/CSS/JS, carte Leaflet + OpenStreetMap)
data/uploads/  Photos envoyées
```

### Base de données

| Table | Contenu |
|---|---|
| users | citoyens et agents (mot de passe haché bcrypt), points |
| reports | signalements : catégorie, gravité, GPS, photos avant/après, statut, équipe |
| report_history | historique des statuts et notes |
| confirmations | confirmations citoyennes |
| teams | équipes techniques |
| rewards / redemptions / points_log | gamification |

### Variables d'environnement

| Variable | Rôle |
|---|---|
| PORT | port HTTP (3000 par défaut) |
| ANTHROPIC_API_KEY | active l'analyse IA des photos |
| SESSION_SECRET | secret des cookies de session (à définir en production) |
| DATA_DIR | dossier de la base et des photos (`/data` sur Railway) |
| NODE_ENV | `production` en ligne (cookies sécurisés) |

## Mise en ligne sur Railway

1. Déposer ce dossier dans un dépôt GitHub.
2. Sur https://railway.com : **New Project → Deploy from GitHub repo** → choisir le dépôt.
3. Dans le service : **Settings → Volumes → Add Volume**, chemin de montage `/data`.
4. **Variables** : `DATA_DIR=/data`, `NODE_ENV=production`, `SESSION_SECRET=<longue phrase aléatoire>` (et `ANTHROPIC_API_KEY` pour l'IA).
5. **Settings → Networking → Generate Domain** : l'adresse publique (https://….up.railway.app) est créée.

## Pour la production

- Remplacer le stockage de session en mémoire par un store persistant (ex. `connect-sqlite3`).
- Pour beaucoup de trafic, migrer SQLite vers PostgreSQL/PostGIS (le schéma est en SQL standard).
