// Détecteur d'anomalies urbaines
// - Si une clé API Anthropic est configurée : analyse visuelle de la photo par Claude.
// - Sinon (ou en cas d'erreur) : analyse locale de secours basée sur le texte saisi.
const fs = require('fs');
const { z } = require('zod');

const CATEGORIES = {
  nid_de_poule: { label: 'Nid-de-poule / chaussée', team: 'voirie', icon: '🕳️' },
  fuite_eau:    { label: "Fuite d'eau", team: 'eau', icon: '💧' },
  eclairage:    { label: 'Éclairage public', team: 'eclairage', icon: '💡' },
  dechets:      { label: 'Déchets / dépôt sauvage', team: 'dechets', icon: '🗑️' },
  fissure:      { label: 'Fissure / ouvrage dégradé', team: 'voirie', icon: '🧱' },
  signalisation:{ label: 'Signalisation endommagée', team: 'voirie', icon: '🚸' },
  egout:        { label: 'Égout / assainissement', team: 'eau', icon: '🚰' },
  espace_vert:  { label: 'Espace vert / arbre', team: 'autre', icon: '🌳' },
  autre:        { label: 'Autre', team: 'autre', icon: '📍' },
};

const AnalysisSchema = z.object({
  is_urban_anomaly: z.boolean(),
  category: z.enum(Object.keys(CATEGORIES)),
  severity: z.number().int().min(1).max(5),
  confidence: z.number().min(0).max(1),
  title: z.string(),
  description: z.string(),
});

const SYSTEM = `Tu es le détecteur d'anomalies urbaines de l'application citoyenne "Madinati 360".
On te montre la photo prise par un habitant. Identifie le problème visible sur la voie publique.
Catégories possibles : ${Object.entries(CATEGORIES).map(([k, v]) => `${k} (${v.label})`).join(', ')}.
Gravité de 1 (gêne mineure) à 5 (danger immédiat pour les personnes ou dégât qui s'aggrave vite, ex. grosse fuite d'eau, câble à nu, effondrement).
Le titre fait moins de 60 caractères ; la description 1 à 2 phrases factuelles, en français, utiles à une équipe technique.
Si la photo ne montre aucune anomalie urbaine, mets is_urban_anomaly à false et category à "autre".`;

let client = null;
function getClient() {
  if (client !== null) return client;
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return (client = false);
  const Anthropic = require('@anthropic-ai/sdk').default;
  client = new Anthropic();
  return client;
}

async function analyzeWithClaude(filePath, mimeType, hint) {
  const anthropic = getClient();
  if (!anthropic) return null;
  const { betaZodOutputFormat } = require('@anthropic-ai/sdk/helpers/beta/zod');
  const data = fs.readFileSync(filePath).toString('base64');
  const response = await anthropic.beta.messages.parse({
    model: process.env.CLAUDE_MODEL || 'claude-opus-5-5',
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: betaZodOutputFormat(AnalysisSchema) },
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data } },
        { type: 'text', text: hint ? `Commentaire du citoyen : ${hint}` : 'Analyse cette photo.' },
      ],
    }],
  });
  if (response.stop_reason === 'refusal' || !response.parsed_output) return null;
  return { ...response.parsed_output, source: 'claude' };
}

// Analyse locale de secours (mots-clés)
const KEYWORDS = {
  fuite_eau: ['fuite', 'eau', 'inond', 'canalisation', 'jaillit', 'ma', 'water'],
  nid_de_poule: ['nid', 'trou', 'chaussée', 'route', 'goudron', 'bitume'],
  eclairage: ['lampadaire', 'éclairage', 'eclairage', 'lumière', 'noir', 'ampoule'],
  dechets: ['déchet', 'dechet', 'poubelle', 'ordure', 'sac', 'décharge', 'saleté'],
  fissure: ['fissure', 'mur', 'pont', 'effondr', 'craquel', 'muret'],
  signalisation: ['panneau', 'feu', 'signalisation', 'passage piéton'],
  egout: ['égout', 'egout', 'regard', 'odeur', 'assainissement', 'bouche'],
  espace_vert: ['arbre', 'branche', 'jardin', 'parc', 'herbe'],
};
const URGENT = ['danger', 'urgent', 'enfant', 'école', 'accident', 'grave', 'effondr', 'câble', 'cable', 'important'];

function analyzeLocally(hint = '') {
  const t = hint.toLowerCase();
  let best = 'autre', score = 0;
  for (const [cat, words] of Object.entries(KEYWORDS)) {
    const s = words.filter((w) => w.length > 2 && t.includes(w)).length;
    if (s > score) { best = cat; score = s; }
  }
  const base = { fuite_eau: 4, fissure: 4, egout: 3, nid_de_poule: 3, eclairage: 3, signalisation: 3, dechets: 2, espace_vert: 2, autre: 2 }[best];
  const severity = Math.min(5, base + (URGENT.some((w) => t.includes(w)) ? 1 : 0));
  return {
    is_urban_anomaly: true,
    category: best,
    severity,
    confidence: score ? Math.min(0.9, 0.5 + score * 0.15) : 0.3,
    title: CATEGORIES[best].label,
    description: hint || 'Anomalie signalée par un citoyen.',
    source: 'local',
  };
}

async function analyze(filePath, mimeType, hint) {
  const supported = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (filePath && supported.includes(mimeType)) {
    try {
      const r = await analyzeWithClaude(filePath, mimeType, hint);
      if (r) return r;
    } catch (err) {
      console.error('[IA] Analyse Claude indisponible, repli local :', err.message);
    }
  }
  return analyzeLocally(hint);
}

module.exports = { analyze, CATEGORIES, aiEnabled: () => !!getClient() };
