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
  stations:   'data/stations.json',
  lines:      'data/lines.json',
  lineTraces: 'data/line-traces.json',
};

let STATIONS = [];
let LINES = [];
let LINES_BY_ID = {};
let LINE_TRACES = {};            // { lineId: { color, segments: [[[lon,lat],...], ...] } }
let STATIONS_BY_LINE = {};       // { lineId: [stationObj, ...] }

async function loadData() {
  const [stations, lines, traces] = await Promise.all([
    fetch(DATA_PATHS.stations).then(r => r.json()),
    fetch(DATA_PATHS.lines).then(r => r.json()),
    fetch(DATA_PATHS.lineTraces).then(r => r.json()),
  ]);
  STATIONS = stations;
  LINES = lines;
  LINES_BY_ID = Object.fromEntries(lines.map(l => [l.id, l]));
  LINE_TRACES = traces;

  // Index inverse : pour chaque ligne, la liste des stations qui la desservent
  STATIONS_BY_LINE = {};
  for (const line of lines) STATIONS_BY_LINE[line.id] = [];
  for (const st of stations) {
    for (const lineId of st.lines) {
      if (STATIONS_BY_LINE[lineId]) STATIONS_BY_LINE[lineId].push(st);
    }
  }
}

/** Renvoie le libellé géographique d'une station : 19e arr. ou Issy-les-Moulineaux. */
function zoneLabel(station) {
  if (station.arrondissement) {
    const a = station.arrondissement;
    const suffix = a === 1 ? 'er' : 'e';
    return `Paris ${a}${suffix}`;
  }
  if (station.commune) return station.commune;
  return '';
}

/* ============================================================
   2. ÉTAT APP
============================================================ */

const state = {
  session: null,
  map: null,
  markerLayer: null,        // calques temporaires (highlight asso, révélations, zones)
  pinsLayer: null,          // calque permanent : toutes les pastilles de stations
  pinByStationId: {},       // index { stationId -> Leaflet marker } pour mutations rapides
  hintZone: null,           // cercle Leaflet de la zone d'indice (mode LOCATE 2e tentative)
  tracesLayer: null,        // calque éphémère pour les tracés de lignes révélés
  revealStationsLayer: null,// calque éphémère pour les stations des lignes révélées
  lineSelection: new Set(), // chips sélectionnés en mode ASSOCIATE avant Valider
  awaitingNext: false,      // true entre la révélation et le clic sur 'Question suivante'
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

  // ordre de z-index : tracés (en dessous) → stations de ligne révélées → pastilles → markers temp
  state.tracesLayer = L.layerGroup().addTo(state.map);
  state.revealStationsLayer = L.layerGroup().addTo(state.map);
  state.pinsLayer = L.layerGroup().addTo(state.map);
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
  if (state.tracesLayer) state.tracesLayer.clearLayers();
  if (state.revealStationsLayer) state.revealStationsLayer.clearLayers();
  state.hintZone = null;
  state.lineSelection.clear();
  state.awaitingNext = false;
  hideNextButton();
  // réaffiche toutes les pastilles (peuvent avoir été masquées par le mode ASSOCIATE)
  Object.values(state.pinByStationId).forEach(m => {
    const el = m.getElement()?.querySelector('.station-pin');
    if (el) el.style.display = '';
  });
  resetStationPins();
}

/**
 * Trace en couleur sur la carte toutes les lignes desservant la station fournie.
 * Appelé au moment de la révélation (succès en LOCATE, succès/fail en ASSOCIATE,
 * fail en LOCATE). Le calque est effacé au passage à la question suivante.
 */
function drawStationLineTraces(station) {
  if (!state.tracesLayer) return;
  for (const lineId of station.lines) {
    const trace = LINE_TRACES[lineId];
    if (!trace) continue;
    // segments = MultiLineString : array de LineStrings
    // Leaflet veut [[lat,lon], ...] alors que GeoJSON donne [lon,lat]
    const latlngs = trace.segments.map(seg => seg.map(([lon, lat]) => [lat, lon]));
    const poly = L.polyline(latlngs, {
      color: trace.color,
      weight: 4.5,
      opacity: 0.85,
      lineCap: 'round',
      lineJoin: 'round',
      className: 'line-trace',
      interactive: false,
    });
    state.tracesLayer.addLayer(poly);
  }
}

/**
 * Affiche, par-dessus les tracés, toutes les stations de chaque ligne révélée.
 * - La station révélée n'a pas de marqueur secondaire (sa pastille principale est déjà en valeur).
 * - Chaque autre station de la ligne reçoit une petite pastille colorée (couleur de la ligne).
 * - Pour une station multi-lignes, on superpose un anneau par ligne supplémentaire.
 * - Les marqueurs sont non interactifs (display only).
 */
function drawStationsOfRevealedLines(centerStation) {
  if (!state.revealStationsLayer) return;
  // Regroupe : par stationId, les couleurs des lignes desservies concernées par la révélation
  const colorsByStation = new Map();
  for (const lineId of centerStation.lines) {
    const color = LINES_BY_ID[lineId]?.color || '#888';
    const stations = STATIONS_BY_LINE[lineId] || [];
    for (const st of stations) {
      if (st.id === centerStation.id) continue;
      const arr = colorsByStation.get(st.id) || [];
      arr.push(color);
      colorsByStation.set(st.id, arr);
    }
  }
  for (const [stationId, colors] of colorsByStation) {
    const st = STATIONS.find(s => s.id === stationId);
    if (!st) continue;
    // primaire = première couleur, secondaire = anneau couleur 2 si multi-lignes
    const primary = colors[0];
    const secondary = colors[1];
    const html = `<div class="line-station" style="background:${primary};${secondary ? `box-shadow:0 0 0 2px ${secondary}, 0 0 0 3px rgba(0,0,0,0.15);` : 'box-shadow:0 0 0 1.5px rgba(255,255,255,0.9), 0 0 0 2.5px rgba(0,0,0,0.12);'}" aria-hidden="true"></div>`;
    const marker = L.marker([st.lat, st.lon], {
      icon: L.divIcon({ className: '', html, iconSize: [10, 10], iconAnchor: [5, 5] }),
      interactive: false,
      keyboard: false,
    });
    state.revealStationsLayer.addLayer(marker);
  }
}

/* ============================================================
   5. QUESTIONS
============================================================ */

function renderCurrentQuestion() {
  clearMap();
  $('#line-picker').hidden = true;
  $('#validate-bar').hidden = true;
  hideFeedback();

  const q = state.session.questions[state.session.index];
  if (q.kind === QUESTION_KINDS.LOCATE) renderLocateQuestion(q);
  else renderAssociateQuestion(q);
  updateTopbar();
}

/* ----- A. LOCALISATION (cliquer sur la bonne pastille) ----- */
function renderLocateQuestion(q) {
  $('#prompt-kind').textContent = 'Localisation';
  const zone = zoneLabel(q.station);
  $('#prompt-text').textContent = zone
    ? `Où se trouve ${q.station.name} (${zone}) ?`
    : `Où se trouve ${q.station.name} ?`;
  $('#prompt-hint').textContent = 'Cliquez sur la bonne station.';
  // Les ~282 pastilles sont déjà affichées en permanence par state.pinsLayer.
}

/** Clic sur une pastille (toutes les questions LOCATE passent par ici). */
function onStationClick(stationId) {
  if (!state.session) return;
  if (state.awaitingNext) return;
  const q = state.session.questions[state.session.index];
  if (q.kind !== QUESTION_KINDS.LOCATE) return;
  if (state.session.attempt >= 2) return;

  const result = evaluate(state.session, { stationId });
  handleLocateOutcome(result, stationId);
}

/* ----- B. ASSOCIATION (sélection multi-lignes + Valider) ----- */
function renderAssociateQuestion(q) {
  $('#prompt-kind').textContent = 'Association';
  const zone = zoneLabel(q.station);
  const expected = q.station.lines.length;
  const consigne = expected === 1
    ? `Quelle ligne dessert ${q.station.name}${zone ? ` (${zone})` : ''} ?`
    : `Quelles lignes desservent ${q.station.name}${zone ? ` (${zone})` : ''} ?`;
  $('#prompt-text').textContent = consigne;
  $('#prompt-hint').textContent = expected === 1
    ? 'Sélectionnez une ligne puis validez.'
    : `${expected} lignes à trouver. Cochez puis validez.`;

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
  state.lineSelection.clear();
  const picker = $('#line-picker-inner');
  picker.innerHTML = '';
  for (const line of LINES) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'line-chip';
    chip.dataset.lineId = line.id;
    chip.textContent = line.id;
    chip.style.background = line.color;
    chip.setAttribute('aria-pressed', 'false');
    if (isLightColor(line.color)) chip.classList.add('is-light');
    chip.addEventListener('click', () => onLineChipClick(line.id, chip));
    picker.appendChild(chip);
  }
  $('#line-picker').hidden = false;
  $('#validate-bar').hidden = false;
  updateValidateButton();
}

function onLineChipClick(lineId, chipEl) {
  if (!state.session) return;
  if (state.awaitingNext) return;
  const q = state.session.questions[state.session.index];
  if (q.kind !== QUESTION_KINDS.ASSOCIATE) return;
  // toggle
  if (state.lineSelection.has(lineId)) {
    state.lineSelection.delete(lineId);
    chipEl.classList.remove('is-picked');
    chipEl.setAttribute('aria-pressed', 'false');
  } else {
    state.lineSelection.add(lineId);
    chipEl.classList.add('is-picked');
    chipEl.setAttribute('aria-pressed', 'true');
  }
  updateValidateButton();
}

function updateValidateButton() {
  const btn = $('#btn-validate');
  const n = state.lineSelection.size;
  btn.disabled = n === 0;
  btn.textContent = n === 0
    ? 'Validez votre sélection'
    : n === 1 ? 'Valider (1 ligne)'
              : `Valider (${n} lignes)`;
}

function onValidateAssociate() {
  if (!state.session || state.awaitingNext) return;
  const q = state.session.questions[state.session.index];
  if (q.kind !== QUESTION_KINDS.ASSOCIATE) return;
  if (state.lineSelection.size === 0) return;

  const lineIds = [...state.lineSelection];
  const result = evaluate(state.session, { lineIds });
  handleAssociateOutcome(result, lineIds);
}

/* =============================================================
   Gestion des outcomes (correct / retry / fail)
============================================================= */

/** Outcome LOCATE : 2 tentatives, indice de zone après la 1ère erreur. */
function handleLocateOutcome(result, clickedStationId) {
  const q = state.session.questions[state.session.index];

  if (result.outcome === 'correct') {
    setPinState(clickedStationId, 'is-correct');
    Object.values(state.pinByStationId).forEach(m => {
      const el = m.getElement()?.querySelector('.station-pin');
      if (el && !el.classList.contains('is-correct')) el.classList.add('is-disabled');
    });
    revealOnMap(q.station);
    showFeedback({
      title: result.attempt === 1 ? 'Bien vu.' : 'Trouvé.',
      detail: revealDetail(q.station, result, 'correct'),
      kind: 'success',
    });
    awaitNext();
    return;
  }

  if (result.outcome === 'retry') {
    setPinState(clickedStationId, 'is-wrong');
    showFeedback({
      title: 'Pas la bonne.',
      detail: 'La station est dans la zone surlignée. Réessayez.',
      kind: 'error',
      ephemeral: true,
    });
    drawHintZone(q.station);
    setTimeout(() => hideFeedback(), 1500);
    return;
  }

  // outcome 'fail' : 2e erreur → révélation
  setPinState(clickedStationId, 'is-wrong');
  setPinState(q.station.id, 'is-reveal');
  Object.values(state.pinByStationId).forEach(m => {
    const el = m.getElement()?.querySelector('.station-pin');
    if (el && !el.classList.contains('is-wrong') && !el.classList.contains('is-reveal')) {
      el.classList.add('is-disabled');
    }
  });
  revealOnMap(q.station);
  showFeedback({
    title: 'Pas trouvé.',
    detail: revealDetail(q.station, result, 'fail'),
    kind: 'error',
  });
  awaitNext();
}

/** Outcome ASSOCIATE : multi-sélection, score net, une seule tentative. */
function handleAssociateOutcome(result, pickedLineIds) {
  const q = state.session.questions[state.session.index];
  const expected = new Set(q.station.lines);
  const picked = new Set(pickedLineIds);

  // marquage des chips : correct / wrong / missed
  document.querySelectorAll('.line-chip').forEach(c => {
    c.disabled = true;
    const id = c.dataset.lineId;
    if (expected.has(id) && picked.has(id)) c.classList.add('is-correct');
    else if (!expected.has(id) && picked.has(id)) c.classList.add('is-wrong');
    else if (expected.has(id) && !picked.has(id)) c.classList.add('is-missed');
  });
  // masquer la barre de validation pour laisser place au bouton 'Question suivante'
  $('#validate-bar').hidden = true;

  revealOnMap(q.station);

  const isFull = result.outcome === 'correct';
  const kind = isFull ? 'success' : (result.outcome === 'partial' ? 'warning' : 'error');
  let title;
  if (isFull) title = expected.size === 1 ? 'Bonne ligne.' : 'Toutes les lignes.';
  else if (result.outcome === 'partial') title = 'Partiellement.';
  else title = 'Pas la bonne ligne.';

  showFeedback({
    title,
    detail: revealDetail(q.station, result, result.outcome),
    kind,
  });
  awaitNext();
}

/* ----- Helpers révélation + feedback ----- */

/** Révélation visuelle complète : tracés + stations de toutes les lignes desservant la station. */
function revealOnMap(station) {
  drawStationLineTraces(station);
  drawStationsOfRevealedLines(station);
}

/** Texte de détail pour le feedback selon le contexte de révélation. */
function revealDetail(station, result, mode) {
  const zone = zoneLabel(station);
  const lines = linesLabel(station);
  const zonePart = zone ? `${zone} · ` : '';

  if (mode === 'correct') {
    const streakPart = state.session.streak > 1 ? ` · Série : ${state.session.streak}` : '';
    return `${zonePart}${lines}. +${result.scoreDelta} pts${streakPart}`;
  }
  if (mode === 'partial') {
    const hits = result.hits?.length || 0;
    const total = station.lines.length;
    const misses = result.misses?.length || 0;
    const missesPart = misses ? `, ${misses} erronée${misses>1?'s':''}` : '';
    return `${zonePart}${lines}. ${hits}/${total} bonne${hits>1?'s':''}${missesPart}. +${result.scoreDelta} pts`;
  }
  // fail
  return `${station.name} — ${zonePart}${lines}.`;
}

function linesLabel(station) {
  return station.lines.map(l => `Ligne ${l}`).join(' · ');
}

function showFeedback({ title, detail, kind }) {
  const fb = $('#feedback');
  const klass = kind === 'success' ? 'is-success'
              : kind === 'warning' ? 'is-warning'
              : 'is-error';
  fb.className = 'feedback is-visible ' + klass;
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

/** Après révélation : on affiche un bouton 'Question suivante' que l'utilisateur clique à son rythme. */
function awaitNext() {
  state.awaitingNext = true;
  updateTopbar();
  showNextButton();
}

function onNextClick() {
  if (!state.session) return;
  state.awaitingNext = false;
  hideNextButton();
  const done = advance(state.session);
  if (done) finishSession();
  else renderCurrentQuestion();
}

function showNextButton() {
  const btn = $('#btn-next');
  if (!btn) return;
  const isLast = state.session.index >= state.session.questions.length - 1;
  btn.textContent = isLast ? 'Voir les résultats' : 'Question suivante';
  btn.hidden = false;
  // focus pour permettre Entrée
  setTimeout(() => btn.focus(), 50);
}

function hideNextButton() {
  const btn = $('#btn-next');
  if (btn) btn.hidden = true;
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

  $('#btn-validate').addEventListener('click', onValidateAssociate);
  $('#btn-next').addEventListener('click', onNextClick);

  // Entrée = question suivante quand le bouton est visible
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && state.awaitingNext) {
      e.preventDefault();
      onNextClick();
    }
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
