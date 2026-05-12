/**
 * storage.js — Persistance locale (profil joueur + historique + maîtrise des stations).
 *
 * Le stockage est volontairement minimaliste : 1 seul profil actif (suffisant pour MVP).
 * Tout est versionné via STORAGE_VERSION pour permettre une migration future.
 *
 * Schéma :
 * {
 *   version: 1,
 *   profile:  { pseudo, createdAt },
 *   mastery:  { [stationId]: { seen, correct, wrong, lastSeen } },
 *   sessions: [{ date, score, accuracy, level, difficulty }]
 * }
 */

const STORAGE_KEY = 'metropoli.v1';
const STORAGE_VERSION = 1;

const DEFAULT_STATE = {
  version: STORAGE_VERSION,
  profile: null,
  mastery: {},
  sessions: [],
};

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_STATE);
    const parsed = JSON.parse(raw);
    if (parsed.version !== STORAGE_VERSION) return structuredClone(DEFAULT_STATE);
    return parsed;
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('[storage] Impossible de sauvegarder :', err);
  }
}

/* --------- API publique ---------- */

export const Storage = {
  getProfile() {
    return loadState().profile;
  },

  setProfile(pseudo) {
    const state = loadState();
    state.profile = { pseudo, createdAt: state.profile?.createdAt || Date.now() };
    saveState(state);
  },

  reset() {
    localStorage.removeItem(STORAGE_KEY);
  },

  getMastery(stationId) {
    const m = loadState().mastery[stationId];
    return m || { seen: 0, correct: 0, wrong: 0, lastSeen: 0 };
  },

  getAllMastery() {
    return loadState().mastery;
  },

  /**
   * Met à jour la maîtrise d'une station après une question.
   * isCorrect : boolean
   */
  recordAnswer(stationId, isCorrect) {
    const state = loadState();
    const m = state.mastery[stationId] || { seen: 0, correct: 0, wrong: 0, lastSeen: 0 };
    m.seen += 1;
    if (isCorrect) m.correct += 1;
    else m.wrong += 1;
    m.lastSeen = Date.now();
    state.mastery[stationId] = m;
    saveState(state);
  },

  /**
   * Ajoute une session terminée à l'historique (max 20 dernières).
   */
  addSession(session) {
    const state = loadState();
    state.sessions.unshift({ ...session, date: Date.now() });
    state.sessions = state.sessions.slice(0, 20);
    saveState(state);
  },

  getSessions() {
    return loadState().sessions;
  },
};
