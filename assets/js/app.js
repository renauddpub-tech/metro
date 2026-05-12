/**
 * app.js — Orchestration UI : écrans, carte Leaflet, interactions.
 *
 * Architecture :
 *  - state global minimal (currentSession, currentMap, mode)
 *  - une fonction par transition (goHome, startGame, finishSession)
 *  - une fonction par mécanique (renderLocateQuestion, renderAssociateQuestion)
 *  - les modules engine.js et storage.js gèrent la logique pure
 */

import { Storage } from './storage.js';
import {
  buildSession, evaluate, advance, computeSummary,
  QUESTION_KINDS,
} from './engine.js';

/* ============================================================
   1. CHARGEMENT DES DONNÉES
============================================================ */

const DATA_PATHS = {
  stations: 'data/stations.json',
  lines: 'data/lines.json',
};

let STATIONS = [];
let LINES = [];
let LINES_BY_ID = {};

async function loadData() {
  const [stations, lines] = await Promise.all([
    fetch(DATA_PATHS.stations).then(r => r.json()),
    fetch(DATA_PATHS.lines).then(r => r.json()),
  ]);
  STATIONS = stations;
  LINES = lines;
  LINES_BY_ID = Object.fromEntries(lines.map(l => [l.id, l]));
}

/* ============================================================
   2. ÉTAT APP
============================================================ */

const state = {
  session: null,
  map: null,
  markerLayer: null,    // calques temporaires (highlight asso, révélations, zones)
  pinsLayer: null,      // calque permanent : toutes les pastilles de stations
  pinByStationId: {},   // index { stationId -> Leaflet marker } pour mutations rapides
  hintZone: null,       // cercle Leaflet de la zone d'indice (mode LOCATE 2e tentative)
  difficulty: 'normal',
};

/* ============================================================
   3. ÉCRANS
============================================================ */

const $ = sel => document.querySelector(sel);

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('is-active'));
  $(id).classList.add('is-active');
}

/* ----- ACCUEIL ----- */
function renderHome() {
  const profile = Storage.getProfile();
  if (profile) {
    $('#pseudo').value = profile.pseudo;
  }
  renderHistory();
  showScreen('#screen-home');
  // focus pseudo si vide
  if (!profile) setTimeout(() => $('#pseudo').focus(), 50);
}

function renderHistory() {
  const sessions = Storage.getSessions();
  const wrap = $('#home-stats');
  const list = $('#history-list');
  if (!sessions.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  list.innerHTML = sessions.slice(0, 5).map(s => {
    const d = new Date(s.date);
    const dateStr = d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })
                  + ' · ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    return `<div class="history-item">
      <span><strong>${s.score} pts</strong> · ${s.accuracy}% précision · niveau ${s.level}</span>
      <span class="h-meta">${dateStr} · ${labelDifficulty(s.difficulty)}</span>
    </div>`;
  }).join('');
}

function labelDifficulty(d) {
  return { easy: 'Découverte', normal: 'Entraînement', hard: 'Consolidation' }[d] || d;
}

/* ----- JEU ----- */
function startGame({ pseudo, difficulty }) {
  Storage.setProfile(pseudo);
  state.difficulty = difficulty;
  state.session = buildSession({ stations: STATIONS, lines: LINES, difficulty });

  showScreen('#screen-game');
  $('#player-tag').textContent = pseudo;
  $('#q-total').textContent = state.session.questions.length;
  updateTopbar();

  // (Ré)initialise la carte une fois l'écran visible (Leaflet a besoin d'un container monté)
  initMap();
  // petit délai pour laisser Leaflet calculer correctement la taille
  setTimeout(() => {
    state.map.invalidateSize();
    renderCurrentQuestion();
  }, 60);
}

function updateTopbar() {
  const s = state.session;
  $('#score-val').textContent = s.score;
  $('#q-current').textContent = Math.min(s.index + 1, s.questions.length);
  $('#streak-val').textContent = s.streak;
  const pct = (s.index / s.questions.length) * 100;
  $('#progress-bar').style.width = `${pct}%`;
}

/* ============================================================
   4. CARTE LEAFLET
============================================================ */

const PARIS_CENTER = [48.8566, 2.3522];
const PARIS_BOUNDS = L.latLngBounds([48.815, 2.224], [48.905, 2.470]);

// Fond de carte premium sobre — CartoDB Positron (gratuit, sans clé)
const TILE_URL = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

function initMap() {
  if (state.map) return;
  state.map = L.map('map', {
    center: PARIS_CENTER,
    zoom: 13,
    minZoom: 12,
    maxZoom: 17,
    maxBounds: PARIS_BOUNDS.pad(0.1),
    zoomControl: true,
    attributionControl: true,
  });
  L.tileLayer(TILE_URL, {
    attribution: TILE_ATTR,
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(state.map);

  // calque permanent : toutes les pastilles
  state.pinsLayer = L.layerGroup().addTo(state.map);
  // calque temporaire : highlight, zone, révélation
  state.markerLayer = L.layerGroup().addTo(state.map);

  buildStationPins();
}

/** Crée une pastille cliquable pour chaque station, indexe-la par id. */
function buildStationPins() {
  state.pinByStationId = {};
  for (const st of STATIONS) {
    const marker = L.marker([st.lat, st.lon], {
      icon: L.divIcon({
        className: '',
        html: `<div class="station-pin" data-id="${st.id}" aria-label="Station"></div>`,
        iconSize: [12, 12],
        iconAnchor: [6, 6],
      }),
      keyboard: false,
      riseOnHover: true,
    });
    marker.on('click', () => onStationClick(st.id));
    marker.addTo(state.pinsLayer);
    state.pinByStationId[st.id] = marker;
  }
}

/** Réinitialise visuellement toutes les pastilles. */
function resetStationPins() {
  Object.values(state.pinByStationId).forEach(m => {
    const el = m.getElement()?.querySelector('.station-pin');
    if (el) el.className = 'station-pin';
  });
}

/** Modifie la classe CSS d'une pastille par stationId. */
function setPinState(stationId, cssClass) {
  const m = state.pinByStationId[stationId];
  const el = m?.getElement()?.querySelector('.station-pin');
  if (el) el.classList.add(cssClass);
}

function clearMap() {
  if (state.markerLayer) state.markerLayer.clearLayers();
  state.hintZone = null;
  // réaffiche toutes les pastilles (peuvent avoir été masquées par le mode ASSOCIATE)
  Object.values(state.pinByStationId).forEach(m => {
    const el = m.getElement()?.querySelector('.station-pin');
    if (el) el.style.display = '';
  });
  resetStationPins();
}

/* ============================================================
   5. QUESTIONS
============================================================ */

function renderCurrentQuestion() {
  clearMap();
  $('#line-picker').hidden = true;
  hideFeedback();

  const q = state.session.questions[state.session.index];
  if (q.kind === QUESTION_KINDS.LOCATE) renderLocateQuestion(q);
  else renderAssociateQuestion(q);
  updateTopbar();
}

/* ----- A. LOCALISATION (cliquer sur la bonne pastille) ----- */
function renderLocateQuestion(q) {
  $('#prompt-kind').textContent = 'Localisation';
  $('#prompt-text').textContent = `Où se trouve ${q.station.name} ?`;
  const linesLabel = q.station.lines.map(l => `Ligne ${l}`).join(' · ');
  $('#prompt-hint').textContent = state.session.difficulty === 'easy'
    ? `Indice : ${linesLabel}`
    : 'Cliquez sur la bonne station.';
  // Les ~282 pastilles sont déjà affichées en permanence par state.pinsLayer.
}

/** Clic sur une pastille (toutes les questions LOCATE passent par ici). */
function onStationClick(stationId) {
  if (!state.session) return;
  const q = state.session.questions[state.session.index];
  if (q.kind !== QUESTION_KINDS.LOCATE) return;
  // si on est déjà en feedback final, on ignore
  if ($('#feedback').classList.contains('is-visible')
      && state.session.attempt >= 2) return;

  const result = evaluate(state.session, { stationId });
  handleLocateOutcome(result, stationId);
}

/* ----- B. ASSOCIATION (sélection de ligne) ----- */
function renderAssociateQuestion(q) {
  $('#prompt-kind').textContent = 'Association';
  $('#prompt-text').textContent = `Quelle ligne dessert ${q.station.name} ?`;
  $('#prompt-hint').textContent = '';

  // En mode association, on masque les pastilles voisines pour faire ressortir la cible
  Object.values(state.pinByStationId).forEach(m => {
    const el = m.getElement()?.querySelector('.station-pin');
    if (el) el.style.display = 'none';
  });

  // marqueur de la station mise en évidence (point pulsant)
  const marker = L.marker([q.station.lat, q.station.lon], {
    icon: L.divIcon({
      className: '',
      html: '<div class="station-dot" aria-hidden="true"></div>',
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    }),
    interactive: false,
  });
  state.markerLayer.addLayer(marker);
  state.map.setView([q.station.lat, q.station.lon], 14, { animate: true });

  // line-picker
  const picker = $('#line-picker-inner');
  picker.innerHTML = '';
  for (const line of LINES) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'line-chip';
    chip.dataset.lineId = line.id;
    chip.textContent = line.id;
    chip.style.background = line.color;
    if (isLightColor(line.color)) chip.classList.add('is-light');
    chip.addEventListener('click', () => onLineChipClick(line.id, chip));
    picker.appendChild(chip);
  }
  $('#line-picker').hidden = false;
}

function onLineChipClick(lineId, chipEl) {
  if (!state.session) return;
  const q = state.session.questions[state.session.index];
  if (q.kind !== QUESTION_KINDS.ASSOCIATE) return;
  if (state.session.attempt >= 2) return;

  const result = evaluate(state.session, { lineId });
  handleAssociateOutcome(result, chipEl);
}

/* =============================================================
   Gestion des outcomes (correct / retry / fail)
============================================================= */

/** Outcome LOCATE : 2 tentatives, indice de zone après la 1ère erreur. */
function handleLocateOutcome(result, clickedStationId) {
  const q = state.session.questions[state.session.index];

  if (result.outcome === 'correct') {
    setPinState(clickedStationId, 'is-correct');
    // désactiver toutes les autres pastilles
    Object.values(state.pinByStationId).forEach(m => {
      const el = m.getElement()?.querySelector('.station-pin');
      if (el && !el.classList.contains('is-correct')) el.classList.add('is-disabled');
    });
    showFeedback({
      title: result.attempt === 1 ? 'Bien vu.' : 'Trouvé.',
      detail: feedbackDetailCorrect(q, result),
      kind: 'success',
    });
    transitionToNext(1200);
    return;
  }

  if (result.outcome === 'retry') {
    // mauvaise pastille → rouge, on garde toutes les autres cliquables
    setPinState(clickedStationId, 'is-wrong');
    showFeedback({
      title: 'Pas la bonne.',
      detail: 'La station est dans la zone surlignée. Réessayez.',
      kind: 'error',
      ephemeral: true,
    });
    drawHintZone(q.station);
    // on cache le feedback rapidement pour ne pas gêner le 2e clic
    setTimeout(() => hideFeedback(), 1500);
    return;
  }

  // outcome 'fail' : 2e erreur consécutive → on révèle la bonne
  setPinState(clickedStationId, 'is-wrong');
  setPinState(q.station.id, 'is-reveal');
  // désactiver tout le reste
  Object.values(state.pinByStationId).forEach(m => {
    const el = m.getElement()?.querySelector('.station-pin');
    if (el && !el.classList.contains('is-wrong') && !el.classList.contains('is-reveal')) {
      el.classList.add('is-disabled');
    }
  });
  showFeedback({
    title: 'Pas trouvé.',
    detail: `${q.station.name} est ici. ${linesLabel(q.station)}.`,
    kind: 'error',
  });
  transitionToNext(2200);
}

/** Outcome ASSOCIATE : 2 tentatives sans indice (la station est déjà visible). */
function handleAssociateOutcome(result, chipEl) {
  const q = state.session.questions[state.session.index];

  if (result.outcome === 'correct') {
    // colorer le chip choisi en succès, désactiver tous les autres
    document.querySelectorAll('.line-chip').forEach(c => {
      c.disabled = true;
      if (q.station.lines.includes(c.dataset.lineId)) c.classList.add('is-correct');
    });
    showFeedback({
      title: result.attempt === 1 ? 'Bonne ligne.' : 'Trouvé.',
      detail: result.attempt === 1
        ? `+${result.scoreDelta} pts. Série : ${state.session.streak}`
        : `+${result.scoreDelta} pts (2e essai).`,
      kind: 'success',
    });
    transitionToNext(1200);
    return;
  }

  if (result.outcome === 'retry') {
    chipEl.classList.add('is-wrong');
    chipEl.disabled = true;
    showFeedback({
      title: 'Pas cette ligne.',
      detail: 'Une seconde tentative.',
      kind: 'error',
      ephemeral: true,
    });
    setTimeout(() => hideFeedback(), 1200);
    return;
  }

  // fail : on révèle toutes les bonnes lignes
  chipEl.classList.add('is-wrong');
  document.querySelectorAll('.line-chip').forEach(c => {
    c.disabled = true;
    if (q.station.lines.includes(c.dataset.lineId)) c.classList.add('is-correct');
  });
  showFeedback({
    title: 'Pas la bonne ligne.',
    detail: `${q.station.name} est desservie par ${linesLabel(q.station)}.`,
    kind: 'error',
  });
  transitionToNext(2200);
}

/* ----- Helpers feedback ----- */

function feedbackDetailCorrect(q, result) {
  if (q.kind === QUESTION_KINDS.LOCATE) {
    return result.attempt === 1
      ? `${linesLabel(q.station)}. +${result.scoreDelta} pts`
      : `${linesLabel(q.station)}. +${result.scoreDelta} pts (2e essai).`;
  }
  return result.attempt === 1
    ? `+${result.scoreDelta} pts. Série : ${state.session.streak}`
    : `+${result.scoreDelta} pts (2e essai).`;
}

function linesLabel(station) {
  return station.lines.map(l => `Ligne ${l}`).join(' · ');
}

function showFeedback({ title, detail, kind, ephemeral = false }) {
  const fb = $('#feedback');
  fb.className = 'feedback is-visible ' + (kind === 'success' ? 'is-success' : 'is-error');
  fb.innerHTML = `<p class="feedback-title">${title}</p><p class="feedback-detail">${detail}</p>`;
}

/** Dessine la zone d'indice : cercle de ~400m autour de la bonne station. */
function drawHintZone(station) {
  if (state.hintZone) state.markerLayer.removeLayer(state.hintZone);
  state.hintZone = L.circle([station.lat, station.lon], {
    radius: 400,
    className: 'hint-zone',
    interactive: false,
  });
  state.markerLayer.addLayer(state.hintZone);
  // marque visuellement les pastilles à l'intérieur (léger renforcement)
  for (const s of STATIONS) {
    const dist = haversine(s.lat, s.lon, station.lat, station.lon);
    if (dist <= 400) setPinState(s.id, 'is-in-hint-zone');
  }
  updateTopbar();
}

/** Transition vers la question suivante après un délai. */
function transitionToNext(delayMs) {
  updateTopbar();
  setTimeout(() => {
    const done = advance(state.session);
    if (done) finishSession();
    else renderCurrentQuestion();
  }, delayMs);
}

/** Distance Haversine en mètres (dupliqué ici pour ne pas exposer l'utilitaire d'engine). */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function hideFeedback() {
  $('#feedback').classList.remove('is-visible');
}

/* ============================================================
   6. FIN DE SESSION
============================================================ */

function finishSession() {
  const summary = computeSummary(state.session, STATIONS);
  Storage.addSession({
    score: summary.score,
    accuracy: summary.accuracy,
    level: summary.level,
    difficulty: summary.difficulty,
  });

  $('#r-score').textContent = summary.score;
  $('#r-accuracy').textContent = `${summary.accuracy}%`;
  $('#r-streak').textContent = summary.bestStreak;
  $('#r-level').textContent = summary.level;
  $('#result-subtitle').textContent = subtitleFromAccuracy(summary.accuracy);
  $('#r-weak').innerHTML = summary.weakStations
    .map(s => `<li>${s.name}</li>`).join('');
  showScreen('#screen-result');
}

function subtitleFromAccuracy(acc) {
  if (acc >= 90) return 'Maîtrise nette. Passez à la difficulté supérieure.';
  if (acc >= 70) return 'Bon niveau. Quelques stations à réviser.';
  if (acc >= 50) return 'Apprentissage en cours. Continuez.';
  return 'Découverte. La répétition fera le reste.';
}

/* ============================================================
   7. UTILITAIRES UI
============================================================ */

/** Détermine si une couleur hex est claire (utilisé pour le contraste du texte sur les chips). */
function isLightColor(hex) {
  const c = hex.replace('#', '');
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  // luminance perçue
  const lum = (0.299 * r + 0.587 * g + 0.114 * b);
  return lum > 170;
}

/* ============================================================
   8. BINDINGS
============================================================ */

function bindEvents() {
  $('#profile-form').addEventListener('submit', e => {
    e.preventDefault();
    const pseudo = $('#pseudo').value.trim() || 'Joueur';
    const difficulty = document.querySelector('input[name="difficulty"]:checked').value;
    startGame({ pseudo, difficulty });
  });

  $('#btn-quit').addEventListener('click', () => {
    if (!confirm('Quitter la session en cours ? Votre progression de session sera perdue.')) return;
    state.session = null;
    renderHome();
  });

  $('#btn-replay').addEventListener('click', () => {
    const profile = Storage.getProfile();
    startGame({ pseudo: profile?.pseudo || 'Joueur', difficulty: state.difficulty });
  });

  $('#btn-home').addEventListener('click', renderHome);

  $('#reset-profile').addEventListener('click', () => {
    if (!confirm('Effacer le profil, l\'historique et la maîtrise des stations ?')) return;
    Storage.reset();
    $('#pseudo').value = '';
    renderHome();
  });
}

/* ============================================================
   9. BOOT
============================================================ */

(async function boot() {
  try {
    await loadData();
    bindEvents();
    renderHome();
  } catch (err) {
    console.error(err);
    document.body.innerHTML =
      `<div style="padding:40px;font-family:sans-serif;">
        <h1>Erreur de chargement</h1>
        <p>Impossible de charger les données du jeu. Si vous ouvrez ce fichier directement
        avec <code>file://</code>, lancez plutôt un serveur local
        (<code>python3 -m http.server</code>) puis ouvrez <code>http://localhost:8000</code>.</p>
        <pre>${err.message}</pre>
      </div>`;
  }
})();
