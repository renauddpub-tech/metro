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
  markerLayer: null,
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
  state.markerLayer = L.layerGroup().addTo(state.map);

  // clic sur la carte = tentative de réponse en mode LOCATE
  state.map.on('click', onMapClick);
}

function clearMap() {
  if (state.markerLayer) state.markerLayer.clearLayers();
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

/* ----- A. LOCALISATION (clic sur carte) ----- */
function renderLocateQuestion(q) {
  $('#prompt-kind').textContent = 'Localisation';
  $('#prompt-text').textContent = `Où se trouve ${q.station.name} ?`;
  const linesLabel = q.station.lines.map(l => `Ligne ${l}`).join(' · ');
  $('#prompt-hint').textContent = state.session.difficulty === 'easy'
    ? `Indice : ${linesLabel}`
    : '';
  // pas de marqueur affiché : l'utilisateur doit cliquer là où il pense
}

function onMapClick(e) {
  if (!state.session) return;
  const q = state.session.questions[state.session.index];
  if (q.kind !== QUESTION_KINDS.LOCATE) return;

  const result = evaluate(state.session, { lat: e.latlng.lat, lon: e.latlng.lng });
  handleResult(result, { clickLatLng: e.latlng });
}

/* ----- B. ASSOCIATION (sélection de ligne) ----- */
function renderAssociateQuestion(q) {
  $('#prompt-kind').textContent = 'Association';
  $('#prompt-text').textContent = `Quelle ligne dessert ${q.station.name} ?`;
  $('#prompt-hint').textContent = '';

  // marqueur de la station mise en évidence
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

  const result = evaluate(state.session, { lineId });
  // colore le chip choisi + révèle les bonnes réponses
  document.querySelectorAll('.line-chip').forEach(c => {
    c.disabled = true;
    if (q.station.lines.includes(c.dataset.lineId)) {
      c.classList.add('is-correct');
    } else if (c === chipEl) {
      c.classList.add('is-wrong');
    }
  });
  handleResult(result);
}

/* ----- Feedback commun + transition ----- */
function handleResult(result, ctx = {}) {
  const q = state.session.questions[state.session.index];
  const fb = $('#feedback');
  fb.className = 'feedback is-visible ' + (result.isCorrect ? 'is-success' : 'is-error');

  let title, detail;
  if (result.isCorrect) {
    title = q.kind === QUESTION_KINDS.LOCATE ? 'Bien situé.' : 'Bonne ligne.';
    const lines = q.station.lines.map(l => `Ligne ${l}`).join(' · ');
    detail = q.kind === QUESTION_KINDS.LOCATE
      ? `${q.station.name} — ${lines}. +${result.scoreDelta} pts`
      : `+${result.scoreDelta} pts. Série : ${state.session.streak}`;
  } else {
    title = q.kind === QUESTION_KINDS.LOCATE ? 'À côté.' : 'Pas la bonne ligne.';
    const lines = q.station.lines.map(l => `Ligne ${l}`).join(' · ');
    detail = q.kind === QUESTION_KINDS.LOCATE
      ? `${q.station.name} est ici. Desservie par ${lines}.`
      : `${q.station.name} est desservie par ${lines}.`;
  }
  fb.innerHTML = `<p class="feedback-title">${title}</p><p class="feedback-detail">${detail}</p>`;

  // En mode LOCATE : on révèle la vraie position
  if (q.kind === QUESTION_KINDS.LOCATE) {
    const reveal = L.marker([q.station.lat, q.station.lon], {
      icon: L.divIcon({
        className: '',
        html: '<div class="station-dot is-reveal" aria-hidden="true"></div>',
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      }),
      interactive: false,
    });
    state.markerLayer.addLayer(reveal);
    if (ctx.clickLatLng) {
      const click = L.marker([ctx.clickLatLng.lat, ctx.clickLatLng.lng], {
        icon: L.divIcon({
          className: '',
          html: `<div class="station-dot ${result.isCorrect ? 'is-correct' : 'is-wrong'}" aria-hidden="true"></div>`,
          iconSize: [18, 18],
          iconAnchor: [9, 9],
        }),
        interactive: false,
      });
      state.markerLayer.addLayer(click);
    }
    state.map.setView([q.station.lat, q.station.lon], 14, { animate: true });
  }

  updateTopbar();
  // pause pour lire le feedback, puis question suivante
  const pause = result.isCorrect ? 1200 : 2200;
  setTimeout(() => {
    const done = advance(state.session);
    if (done) finishSession();
    else renderCurrentQuestion();
  }, pause);
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
