/**
 * engine.js — Moteur de jeu.
 *
 * Responsabilités :
 * - construire une session de N questions selon la difficulté,
 * - alterner les deux mécaniques (LOCATE / ASSOCIATE),
 * - prioriser les stations mal maîtrisées (répétition espacée simplifiée),
 * - calculer score, série, niveau, précision,
 * - exposer une API pure (pas de DOM ici).
 *
 * Algorithme de sélection :
 *   weight(station) = base + 3 * wrongRatio + bonusJamaisVue + bonusDecouverte
 *   On tire sans remplacement, pondéré.
 */

import { Storage } from './storage.js';

const QUESTION_KINDS = {
  LOCATE: 'LOCATE',       // clique sur la bonne station
  ASSOCIATE: 'ASSOCIATE', // sélectionne la bonne ligne
};

const DIFFICULTY = {
  easy:   { count: 8,  pool: 60,  hint: true,  scoreBase: 80 },
  normal: { count: 12, pool: 120, hint: false, scoreBase: 100 },
  hard:   { count: 16, pool: 999, hint: false, scoreBase: 130 },
};

/**
 * Pondération d'une station en fonction de la maîtrise stockée.
 * Plus la station est mal connue, plus elle a de chances d'être tirée.
 */
function stationWeight(station, mastery) {
  const m = mastery[station.id];
  if (!m || m.seen === 0) return 2.0; // station jamais vue : priorité haute
  const wrongRatio = m.wrong / Math.max(1, m.seen);
  // base 1.0 + 3.0 * tauxErreur + bonus si peu vue
  return 1.0 + 3.0 * wrongRatio + (m.seen < 3 ? 0.6 : 0);
}

/** Tirage pondéré sans remplacement. */
function weightedPick(items, weights, k) {
  const pool = items.map((it, i) => ({ it, w: weights[i] }));
  const out = [];
  for (let n = 0; n < k && pool.length; n++) {
    const total = pool.reduce((s, p) => s + p.w, 0);
    let r = Math.random() * total;
    let idx = 0;
    for (; idx < pool.length; idx++) {
      r -= pool[idx].w;
      if (r <= 0) break;
    }
    idx = Math.min(idx, pool.length - 1);
    out.push(pool[idx].it);
    pool.splice(idx, 1);
  }
  return out;
}

/**
 * Construit la séquence de questions d'une session.
 * Alterne LOCATE et ASSOCIATE (50/50, motif fixe pour un rythme régulier).
 */
export function buildSession({ stations, lines, difficulty = 'normal' }) {
  const cfg = DIFFICULTY[difficulty] || DIFFICULTY.normal;

  // 1. on sous-échantillonne le pool de stations selon la difficulté
  const mastery = Storage.getAllMastery();
  const orderable = [...stations];
  // pool : on prend les N premières stations triées par poids (descendant)
  orderable.sort((a, b) => stationWeight(b, mastery) - stationWeight(a, mastery));
  const pool = orderable.slice(0, cfg.pool);

  // 2. on tire `count` stations dans le pool, pondérées
  const weights = pool.map(s => stationWeight(s, mastery));
  const chosen = weightedPick(pool, weights, cfg.count);

  // 3. on construit les questions en alternant les deux mécaniques
  const questions = chosen.map((station, idx) => {
    const kind = idx % 2 === 0 ? QUESTION_KINDS.LOCATE : QUESTION_KINDS.ASSOCIATE;
    return { kind, stationId: station.id, station };
  });

  return {
    difficulty,
    cfg,
    questions,
    index: 0,
    score: 0,
    streak: 0,
    bestStreak: 0,
    correctCount: 0,
    wrongStationIds: new Set(),
  };
}

/**
 * Évalue la réponse à la question courante.
 * - payload pour LOCATE : { lat, lon } cliqués
 * - payload pour ASSOCIATE : { lineId }
 *
 * Retourne { isCorrect, distanceMeters?, correctLines?, scoreDelta }
 */
export function evaluate(session, payload) {
  const q = session.questions[session.index];
  const st = q.station;
  let isCorrect = false;
  let distanceMeters = null;

  if (q.kind === QUESTION_KINDS.LOCATE) {
    distanceMeters = haversine(st.lat, st.lon, payload.lat, payload.lon);
    // Tolérance : 120 m en normal, 180 m en easy, 80 m en hard
    const tol = session.difficulty === 'easy' ? 180
              : session.difficulty === 'hard' ? 80
              : 120;
    isCorrect = distanceMeters <= tol;
  } else {
    isCorrect = st.lines.includes(payload.lineId);
  }

  // Score : base * facteur série, malus si erreur
  let scoreDelta = 0;
  if (isCorrect) {
    const streakBonus = 1 + Math.min(session.streak, 5) * 0.1;
    scoreDelta = Math.round(session.cfg.scoreBase * streakBonus);
    session.score += scoreDelta;
    session.streak += 1;
    session.bestStreak = Math.max(session.bestStreak, session.streak);
    session.correctCount += 1;
  } else {
    session.streak = 0;
    session.wrongStationIds.add(st.id);
  }

  // Persistance maîtrise
  Storage.recordAnswer(st.id, isCorrect);

  return {
    isCorrect,
    distanceMeters,
    correctLines: st.lines,
    scoreDelta,
    question: q,
  };
}

export function advance(session) {
  session.index += 1;
  return session.index >= session.questions.length;
}

export function computeSummary(session, stations) {
  const total = session.questions.length;
  const accuracy = total === 0 ? 0 : Math.round((session.correctCount / total) * 100);
  // Niveau atteint : 1 par défaut, +1 par tranche de 600 pts
  const level = 1 + Math.floor(session.score / 600);
  const weakStations = [...session.wrongStationIds]
    .map(id => stations.find(s => s.id === id))
    .filter(Boolean);

  return {
    score: session.score,
    accuracy,
    bestStreak: session.bestStreak,
    level,
    weakStations,
    total,
    correctCount: session.correctCount,
    difficulty: session.difficulty,
  };
}

/* --------- Utilitaires ---------- */

/** Distance en mètres entre deux points GPS (formule Haversine). */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export { QUESTION_KINDS, DIFFICULTY };
