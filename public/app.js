/* Madinati 360 — interface web (vanilla JS) */
const CENTER = [36.7525, 5.0626]; // Béjaïa
const state = { user: null, meta: null };
const $ = (s, el = document) => el.querySelector(s);
const view = () => $('#view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const img = (f) => (f ? `/uploads/${encodeURIComponent(f)}` : '');
const fmtDate = (s) => new Date(s.replace(' ', 'T') + 'Z').toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
const SEV_COLORS = ['', '#6fbf73', '#a8c656', '#f2c541', '#f28a41', '#d64545'];

async function api(url, opts = {}) {
  const o = { credentials: 'same-origin', ...opts };
  if (o.body && !(o.body instanceof FormData)) { o.headers = { 'Content-Type': 'application/json' }; o.body = JSON.stringify(o.body); }
  const res = await fetch(url, o);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), 3500);
}
function openModal(html) { $('#modal-body').innerHTML = html; $('#modal').classList.remove('hidden'); }
function closeModal() { $('#modal').classList.add('hidden'); $('#modal-body').innerHTML = ''; }
$('#modal-close').onclick = closeModal;
$('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };

const badge = (r) => `<span class="badge st-${r.status}">${esc(r.status_label)}</span>`;
const sev = (n) => `<span class="sev sev-${n}" title="Gravité ${n}/5">${n}</span>`;

function makeMap(el, zoom = 14) {
  const m = L.map(el).setView(CENTER, zoom);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(m);
  return m;
}
function addMarkers(map, reports) {
  const layer = L.layerGroup().addTo(map);
  reports.forEach((r) => {
    const color = r.status === 'resolu' ? '#12663b' : SEV_COLORS[r.severity];
    L.circleMarker([r.lat, r.lng], { radius: 9, color: '#fff', weight: 2, fillColor: color, fillOpacity: .95 })
      .bindTooltip(`${r.category_icon} ${esc(r.title)} — ${esc(r.status_label)}`)
      .on('click', () => showReport(r.id)).addTo(layer);
  });
  return layer;
}

// ---------- Navigation ----------
function renderChrome() {
  const u = state.user, route = location.hash || '#/';
  const links = [['#/', 'Carte'], ['#/signaler', '📷 Signaler']];
  if (u) links.push(['#/mes-signalements', 'Mes signalements'], ['#/recompenses', 'Points & récompenses']);
  if (u && u.role !== 'citizen') links.push(['#/apc', 'Tableau de bord APC']);
  $('#nav').innerHTML = links.map(([h, l]) => `<a href="${h}" class="${route === h ? 'active' : ''}">${l}</a>`).join('');
  $('#userbox').innerHTML = u
    ? `<span>${esc(u.name)}</span>${u.role === 'citizen' ? `<span class="pts">${u.points} pts</span>` : '<span class="badge">Agent</span>'}
       <button class="btn secondary" id="logout">Déconnexion</button>`
    : '<a class="btn secondary" href="#/connexion">Connexion</a>';
  if (u) $('#logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); state.user = null; location.hash = '#/'; };
}
async function refreshUser() { state.user = await api('/api/me'); renderChrome(); }

const routes = {
  '#/': viewHome,
  '#/signaler': viewReport,
  '#/mes-signalements': viewMine,
  '#/recompenses': viewRewards,
  '#/apc': viewDashboard,
  '#/connexion': viewAuth,
};
async function router() {
  closeModal(); renderChrome();
  const fn = routes[location.hash || '#/'] || viewHome;
  try { await fn(); } catch (e) { view().innerHTML = `<div class="card">${esc(e.message)}</div>`; }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', router);
function needLogin() {
  if (state.user) return false;
  sessionStorage.setItem('after', location.hash); location.hash = '#/connexion'; return true;
}

// ---------- Accueil : carte publique ----------
async function viewHome() {
  const { categories, statuses } = state.meta;
  view().innerHTML = `
    <section class="hero">
      <h1>Madinati 360 — devenez acteur de votre quartier</h1>
      <p>Une fuite d'eau, un nid-de-poule, un lampadaire en panne, des déchets ? Prenez une photo :
      l'IA détecte le problème et sa gravité, l'APC est alertée, et vous suivez la réparation en temps réel.</p>
      <a class="btn" href="#/signaler">📷 Signaler une anomalie</a>
    </section>
    <div class="filters">
      <select id="f-cat"><option value="">Toutes catégories</option>${Object.entries(categories).map(([k, c]) => `<option value="${k}">${c.icon} ${esc(c.label)}</option>`).join('')}</select>
      <select id="f-st"><option value="">Tous statuts</option>${Object.entries(statuses).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select>
    </div>
    <div class="grid g2">
      <div><div id="map" class="map"></div>
        <div class="legend">Gravité : ${[1, 2, 3, 4, 5].map((n) => sev(n)).join(' ')} <span class="badge st-resolu">● résolu</span></div></div>
      <div class="list" id="list" style="max-height:480px;overflow:auto"></div>
    </div>`;
  const map = makeMap('map');
  let layer;
  async function load() {
    const q = new URLSearchParams({ category: $('#f-cat').value, status: $('#f-st').value });
    [...q.keys()].forEach((k) => !q.get(k) && q.delete(k));
    const reports = await api('/api/reports?' + q);
    if (layer) layer.remove();
    layer = addMarkers(map, reports);
    $('#list').innerHTML = reports.length ? reports.map(itemHtml).join('') : '<div class="card muted">Aucun signalement.</div>';
    bindItems();
  }
  $('#f-cat').onchange = load; $('#f-st').onchange = load;
  await load();
}
const itemHtml = (r) => `
  <div class="item" data-id="${r.id}">
    <img src="${img(r.photo_before)}" alt="">
    <div class="meta"><div class="t">${r.category_icon} ${esc(r.title)}</div>
      <div class="muted">${esc(r.address || '')} · ${fmtDate(r.created_at)} · 👍 ${r.confirmations}</div></div>
    ${sev(r.severity)} ${badge(r)}
  </div>`;
const bindItems = () => document.querySelectorAll('.item[data-id]').forEach((el) => (el.onclick = () => showReport(el.dataset.id)));

// ---------- Détail d'un signalement ----------
async function showReport(id) {
  const r = await api('/api/reports/' + id);
  const u = state.user, isAgent = u && u.role !== 'citizen';
  const teams = state.meta.teams;
  openModal(`
    <h2>${r.category_icon} ${esc(r.title)}</h2>
    <p>${sev(r.severity)} ${badge(r)} <span class="badge">${esc(r.category_label)}</span>
      <span class="badge" title="Source de l'analyse">${r.ai_source === 'claude' ? '🤖 Analyse IA' : '⚙️ Analyse locale'}</span></p>
    <p>${esc(r.description)}</p>
    <p class="muted">📍 ${esc(r.address || `${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}`)} · Signalé par ${esc(r.author)} le ${fmtDate(r.created_at)}
      ${r.team_name ? ` · 👷 ${esc(r.team_name)}` : ''}</p>
    <div class="ba">
      <figure style="margin:0"><img src="${img(r.photo_before)}" alt="Avant"><figcaption>Avant</figcaption></figure>
      <figure style="margin:0">${r.photo_after ? `<img src="${img(r.photo_after)}" alt="Après">` : '<div class="card muted" style="height:100%;display:grid;place-items:center">Photo « après » à venir</div>'}<figcaption>Après</figcaption></figure>
    </div>
    <h2 style="margin-top:16px">Suivi</h2>
    <ul class="timeline">${r.history.map((h) => `<li><b>${esc(state.meta.statuses[h.status])}</b>
      <span class="muted">— ${fmtDate(h.created_at)}${h.by_name ? ' · ' + esc(h.by_name) : ''}</span>${h.note ? `<div>${esc(h.note)}</div>` : ''}</li>`).join('')}</ul>
    <div id="map-detail" class="map small" style="margin-top:12px"></div>
    ${u && !isAgent && u.id !== r.user_id && !['resolu', 'rejete'].includes(r.status)
      ? `<p><button class="btn" id="confirm" ${r.confirmed_by_me ? 'disabled' : ''}>👍 ${r.confirmed_by_me ? 'Déjà confirmé' : "Moi aussi je l'ai vu (+2 pts)"}</button>
         <span class="muted"> ${r.confirmations} confirmation(s)</span></p>` : `<p class="muted">👍 ${r.confirmations} confirmation(s) citoyenne(s)</p>`}
    ${isAgent ? `
      <form id="agent-form" class="card" style="margin-top:12px">
        <h2>Intervention (APC)</h2>
        <div class="grid g3">
          <div><label>Statut</label><select name="status">${Object.entries(state.meta.statuses).map(([k, l]) => `<option value="${k}" ${k === r.status ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
          <div><label>Équipe</label><select name="team_id"><option value="">— Aucune —</option>${teams.map((t) => `<option value="${t.id}" ${t.id === r.team_id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>
          <div><label>Gravité</label><select name="severity">${[1, 2, 3, 4, 5].map((n) => `<option ${n === r.severity ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        </div>
        <label>Note visible par le citoyen</label><input name="note" placeholder="Ex. intervention prévue demain matin">
        <label>Photo « après » (obligatoire pour clôturer)</label><input type="file" name="photo_after" accept="image/*" capture="environment">
        <p><button class="btn">Enregistrer</button></p>
      </form>` : ''}`);
  const m = makeMap('map-detail', 16);
  L.marker([r.lat, r.lng]).addTo(m);
  setTimeout(() => m.invalidateSize(), 50);
  if ($('#confirm')) $('#confirm').onclick = async () => {
    try { await api(`/api/reports/${r.id}/confirm`, { method: 'POST' }); toast('Merci ! +2 points'); await refreshUser(); showReport(r.id); } catch (e) { toast(e.message); }
  };
  if ($('#agent-form')) $('#agent-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    if (!fd.get('photo_after').size) fd.delete('photo_after');
    try { await api('/api/reports/' + r.id, { method: 'PATCH', body: fd }); toast('Signalement mis à jour'); closeModal(); router(); } catch (err) { toast(err.message); }
  };
}

// ---------- Signaler (détecteur IA) ----------
async function viewReport() {
  if (needLogin()) return;
  const { categories } = state.meta;
  const draft = {};
  view().innerHTML = `
    <h1>📷 Signaler une anomalie</h1>
    <div class="steps"><span id="s1" class="on">1. Photo</span><span id="s2">2. Analyse IA</span><span id="s3">3. Position</span></div>
    <div class="grid g2">
      <div class="card">
        <label for="photo">Prenez une photo ou une courte vidéo du problème</label>
        <input type="file" id="photo" accept="image/*,video/*" capture="environment">
        <label for="hint">Un mot pour aider l'IA (facultatif)</label>
        <input id="hint" placeholder="Ex. fuite devant l'école">
        <p><img id="preview" class="preview hidden" alt="Aperçu"></p>
        <button class="btn big" id="analyze" disabled>🤖 Analyser avec l'IA</button>
      </div>
      <div>
        <form id="result" class="ai-box hidden">
          <h2>Résultat de l'analyse <span id="ai-src" class="badge"></span></h2>
          <p id="ai-warn" class="muted hidden">⚠️ L'IA ne voit pas d'anomalie urbaine claire sur cette photo. Vérifiez la catégorie.</p>
          <div class="grid g2">
            <div><label>Catégorie</label><select name="category">${Object.entries(categories).map(([k, c]) => `<option value="${k}">${c.icon} ${esc(c.label)}</option>`).join('')}</select></div>
            <div><label>Gravité (1 à 5)</label><select name="severity">${[1, 2, 3, 4, 5].map((n) => `<option>${n}</option>`).join('')}</select></div>
          </div>
          <label>Titre</label><input name="title" maxlength="120" required>
          <label>Description</label><textarea name="description" rows="3"></textarea>
          <label>Position — cliquez sur la carte ou utilisez le GPS</label>
          <button type="button" class="btn secondary" id="gps">📍 Utiliser ma position GPS</button>
          <div id="map-pick" class="map small" style="margin-top:8px"></div>
          <label>Adresse / repère (facultatif)</label><input name="address" placeholder="Ex. Rue de la Liberté, près de la poste">
          <p><button class="btn big" id="submit" disabled>Envoyer le signalement (+10 pts)</button></p>
        </form>
      </div>
    </div>`;

  let file = null;
  $('#photo').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    file = f.type.startsWith('video/') ? await frameFromVideo(f) : f;
    if (!file) return toast("Impossible de lire cette vidéo — essayez une photo");
    $('#preview').src = URL.createObjectURL(file); $('#preview').classList.remove('hidden');
    $('#analyze').disabled = false;
  };

  $('#analyze').onclick = async () => {
    const btn = $('#analyze'); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Analyse en cours…';
    try {
      const fd = new FormData(); fd.append('photo', file); fd.append('hint', $('#hint').value);
      const a = await api('/api/analyze', { method: 'POST', body: fd });
      Object.assign(draft, { photo: a.photo, ai_source: a.source, ai_confidence: a.confidence });
      const f = $('#result');
      f.category.value = a.category; f.severity.value = a.severity; f.title.value = a.title; f.description.value = a.description;
      $('#ai-src').textContent = a.source === 'claude' ? `🤖 IA visuelle · confiance ${Math.round(a.confidence * 100)}%` : '⚙️ Analyse locale';
      $('#ai-warn').classList.toggle('hidden', a.is_urban_anomaly !== false);
      f.classList.remove('hidden'); $('#s2').classList.add('on');
      setupPicker();
    } catch (e) { toast(e.message); }
    btn.disabled = false; btn.textContent = "🤖 Ré-analyser";
  };

  let pickMap, pickMarker;
  function setPos(lat, lng) {
    draft.lat = lat; draft.lng = lng;
    if (pickMarker) pickMarker.setLatLng([lat, lng]); else pickMarker = L.marker([lat, lng]).addTo(pickMap);
    pickMap.setView([lat, lng], 17);
    $('#submit').disabled = false; $('#s3').classList.add('on');
  }
  function setupPicker() {
    if (pickMap) return;
    pickMap = makeMap('map-pick', 14);
    pickMap.on('click', (e) => setPos(e.latlng.lat, e.latlng.lng));
    $('#gps').onclick = () => {
      if (!navigator.geolocation) return toast('GPS non disponible sur cet appareil');
      $('#gps').textContent = '📍 Localisation…';
      navigator.geolocation.getCurrentPosition(
        (p) => { setPos(p.coords.latitude, p.coords.longitude); $('#gps').textContent = '📍 Position GPS utilisée'; },
        () => { toast('Position refusée — cliquez sur la carte'); $('#gps').textContent = '📍 Utiliser ma position GPS'; },
        { enableHighAccuracy: true, timeout: 10000 });
    };
    $('#gps').click();
  }

  $('#result').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await api('/api/reports', { method: 'POST', body: {
        ...draft, category: f.category.value, severity: f.severity.value, title: f.title.value,
        description: f.description.value, address: f.address.value } });
      toast('Signalement envoyé ! +10 points 🎉');
      await refreshUser();
      location.hash = '#/mes-signalements';
      setTimeout(() => showReport(r.id), 300);
    } catch (err) { toast(err.message); }
  };
}

// Extrait une image d'une vidéo (le citoyen « filme » le problème)
function frameFromVideo(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.src = URL.createObjectURL(file);
    v.onloadeddata = () => { v.currentTime = Math.min(1, (v.duration || 2) / 2); };
    v.onseeked = () => {
      const c = document.createElement('canvas');
      const scale = Math.min(1, 1600 / v.videoWidth);
      c.width = v.videoWidth * scale; c.height = v.videoHeight * scale;
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      c.toBlob((b) => resolve(b ? new File([b], 'video-frame.jpg', { type: 'image/jpeg' }) : null), 'image/jpeg', 0.85);
    };
    v.onerror = () => resolve(null);
  });
}

// ---------- Mes signalements ----------
async function viewMine() {
  if (needLogin()) return;
  const reports = await api('/api/reports?mine=1');
  view().innerHTML = `<h1>Mes signalements</h1>
    <div class="list">${reports.length ? reports.map(itemHtml).join('') : '<div class="card">Vous n\'avez encore rien signalé. <a href="#/signaler">Faire un premier signalement</a></div>'}</div>`;
  bindItems();
}

// ---------- Points & récompenses ----------
async function viewRewards() {
  if (needLogin()) return;
  await refreshUser();
  const [board, rewards, mine] = await Promise.all([api('/api/leaderboard'), api('/api/rewards'), api('/api/me/points')]);
  view().innerHTML = `
    <h1>Points & récompenses</h1>
    <div class="grid g3">
      <div class="card kpi"><b>${state.user.points}</b>points disponibles</div>
      <div class="card"><h2>Comment gagner des points</h2><div>📷 Signalement : <b>+10</b></div><div>✅ Signalement résolu : <b>+20</b></div><div>👍 Confirmer un signalement : <b>+2</b></div></div>
      <div class="card"><h2>Mes codes</h2>${mine.redemptions.length ? mine.redemptions.map((d) => `<div><b>${esc(d.code)}</b> — ${esc(d.title)}</div>`).join('') : '<span class="muted">Aucun code pour l\'instant.</span>'}</div>
    </div>
    <div class="grid g2" style="margin-top:16px">
      <div class="card"><h2>🎁 Récompenses partenaires</h2><div class="list">${rewards.map((w) => `
        <div class="reward"><div><b>${esc(w.title)}</b><div class="muted">${esc(w.partner)}</div></div>
        <button class="btn" data-rw="${w.id}" ${state.user.points < w.cost ? 'disabled' : ''}>${w.cost} pts</button></div>`).join('')}</div></div>
      <div class="card"><h2>🏆 Classement des citoyens</h2><table><tr><th>#</th><th>Citoyen</th><th>Signalements</th><th>Points</th></tr>
        ${board.map((b, i) => `<tr${b.id === state.user.id ? ' style="font-weight:700"' : ''}><td>${i + 1}</td><td>${esc(b.name)}</td><td>${b.reports}</td><td>${b.points}</td></tr>`).join('')}</table></div>
    </div>
    <div class="card" style="margin-top:16px"><h2>Historique</h2>${mine.log.map((l) => `<div>${l.delta > 0 ? '+' : ''}${l.delta} — ${esc(l.reason)} <span class="muted">${fmtDate(l.created_at)}</span></div>`).join('')}</div>`;
  document.querySelectorAll('[data-rw]').forEach((b) => (b.onclick = async () => {
    try { const r = await api(`/api/rewards/${b.dataset.rw}/redeem`, { method: 'POST' }); openModal(`<h2>🎉 ${esc(r.reward.title)}</h2><p>Votre code : <b style="font-size:1.4rem">${esc(r.code)}</b></p><p class="muted">À présenter chez ${esc(r.reward.partner)}.</p>`); viewRewards(); } catch (e) { toast(e.message); }
  }));
}

// ---------- Tableau de bord APC (B2G) ----------
async function viewDashboard() {
  if (needLogin()) return;
  if (state.user.role === 'citizen') { view().innerHTML = '<div class="card">Espace réservé aux agents municipaux.</div>'; return; }
  const [k, reports] = await Promise.all([api('/api/dashboard'), api('/api/reports')]);
  const open = reports.filter((r) => !['resolu', 'rejete'].includes(r.status)).sort((a, b) => b.priority - a.priority);
  const max = Math.max(1, ...k.by_category.map((c) => c.n));
  view().innerHTML = `
    <h1>Tableau de bord 360° — APC</h1>
    <div class="grid g4">
      <div class="card kpi"><b>${k.open}</b>alertes ouvertes</div>
      <div class="card kpi urgent"><b>${k.urgent}</b>urgentes (gravité ≥ 4)</div>
      <div class="card kpi"><b>${k.resolved}</b>résolues</div>
      <div class="card kpi"><b>${k.avg_resolution_days ?? '—'}</b>jours en moyenne pour résoudre</div>
    </div>
    <div class="grid g2" style="margin-top:16px">
      <div class="card"><h2>Carte des alertes ouvertes</h2><div id="map-dash" class="map"></div></div>
      <div class="card"><h2>Par catégorie</h2>${k.by_category.map((c) => `<div class="bar"><span>${esc(c.label)}</span><span class="fill" style="width:${(c.n / max) * 50}%"></span><b>${c.n}</b></div>`).join('')}
        <h2 style="margin-top:16px">Par statut</h2>${k.by_status.map((s) => `<div class="bar"><span>${esc(state.meta.statuses[s.status])}</span><b>${s.n}</b></div>`).join('')}
        <p class="muted">${k.citizens} citoyens inscrits · ${k.total} signalements au total</p></div>
    </div>
    <div class="card" style="margin-top:16px"><h2>File d'intervention — triée par priorité</h2>
      <p class="muted">Priorité = gravité × 20 + confirmations citoyennes × 5 + ancienneté (jours) × 2</p>
      <div class="tablewrap"><table><tr><th>Priorité</th><th>Gravité</th><th>Anomalie</th><th>Lieu</th><th>Statut</th><th>Équipe</th><th>Date</th></tr>
      ${open.map((r) => `<tr class="clickable" data-id="${r.id}"><td><b>${r.priority}</b></td><td>${sev(r.severity)}</td>
        <td>${r.category_icon} ${esc(r.title)}</td><td>${esc(r.address || '')}</td><td>${badge(r)}</td><td>${esc(r.team_name || '—')}</td><td>${fmtDate(r.created_at)}</td></tr>`).join('')
        || '<tr><td colspan="7">Aucune alerte ouverte 🎉</td></tr>'}</table></div></div>`;
  const map = makeMap('map-dash', 13);
  addMarkers(map, open);
  document.querySelectorAll('tr[data-id]').forEach((tr) => (tr.onclick = () => showReport(tr.dataset.id)));
}

// ---------- Connexion / inscription ----------
async function viewAuth() {
  view().innerHTML = `
    <div class="auth card">
      <h1 id="auth-title">Connexion</h1>
      <form id="auth-form">
        <div id="reg-fields" class="hidden"><label>Nom</label><input name="name"><label>Commune</label><input name="commune" placeholder="Béjaïa"></div>
        <label>Email</label><input name="email" type="email" required autocomplete="email">
        <label>Mot de passe</label><input name="password" type="password" required minlength="6">
        <p><button class="btn big" id="auth-btn">Se connecter</button></p>
      </form>
      <p><a href="#" id="toggle">Pas encore de compte ? Inscrivez-vous gratuitement</a></p>
      <p class="muted">Comptes de démonstration — Citoyen : citoyen@demo.dz / demo123 · Agent APC : agent@apc-bejaia.dz / agent123</p>
    </div>`;
  let register = false;
  $('#toggle').onclick = (e) => {
    e.preventDefault(); register = !register;
    $('#reg-fields').classList.toggle('hidden', !register);
    $('#auth-title').textContent = register ? 'Créer un compte citoyen' : 'Connexion';
    $('#auth-btn').textContent = register ? "S'inscrire" : 'Se connecter';
    $('#toggle').textContent = register ? 'Déjà inscrit ? Connexion' : 'Pas encore de compte ? Inscrivez-vous gratuitement';
  };
  $('#auth-form').onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    try {
      state.user = await api(register ? '/api/auth/register' : '/api/auth/login', { method: 'POST', body });
      const after = sessionStorage.getItem('after'); sessionStorage.removeItem('after');
      location.hash = after || (state.user.role === 'citizen' ? '#/' : '#/apc');
    } catch (err) { toast(err.message); }
  };
}

(async function init() {
  [state.meta, state.user] = await Promise.all([api('/api/meta'), api('/api/me')]);
  router();
})();
