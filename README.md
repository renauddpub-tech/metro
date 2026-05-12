# Métropoli

Un jeu web pour apprendre, **en jouant**, les stations du métro parisien et leurs lignes.
L'expérience repose sur une carte réelle de Paris (fond CartoDB Positron via Leaflet), avec un gameplay mixte :

- **Localisation** — repérer une station nommée sur la carte ;
- **Association** — identifier la (les) ligne(s) qui dessert une station mise en évidence.

Le jeu intègre une logique de **répétition espacée simplifiée** : les stations sur lesquelles vous vous trompez réapparaissent prioritairement dans les sessions suivantes.

---

## Démo / publication GitHub Pages

Le projet est **100 % statique** (HTML / CSS / JavaScript vanilla, données JSON). Aucun build, aucun backend.

Pour publier sur GitHub Pages :

1. Pousser le projet sur un dépôt GitHub.
2. Dans **Settings → Pages**, choisir la branche `main` (root).
3. L'URL publique est de la forme `https://<user>.github.io/<repo>/`.

> ⚠️ Vous ne pouvez pas ouvrir `index.html` directement en double-cliquant (`file://`).
> Les modules ES (`<script type="module">`) et `fetch()` exigent un serveur HTTP.

---

## Lancement local

```bash
# depuis la racine du projet
python3 -m http.server 8000
# puis ouvrir http://localhost:8000
```

Alternative Node :

```bash
npx serve .
```

---

## Structure du projet

```
metro-paris-game/
├── index.html              # 3 écrans (accueil, jeu, résultat) dans un seul HTML
├── README.md               # ce fichier
├── build_dataset.py        # script (Python) pour régénérer les données à partir du jeu IDFM
├── assets/
│   ├── styles.css          # design system + composants + responsive
│   └── js/
│       ├── app.js          # orchestration UI, Leaflet, transitions d'écran
│       ├── engine.js       # moteur de jeu pur (sélection, scoring, répétition espacée)
│       └── storage.js      # persistance localStorage (profil, maîtrise, historique)
└── data/
    ├── stations.json       # 282 stations métro intra-muros (id, name, lat, lon, lines[])
    └── lines.json          # 15 lignes (id, label, couleur officielle RATP)
```

### Conventions

- **JS** : ES modules, `camelCase` pour les variables/fonctions, `UPPER_SNAKE_CASE` pour les constantes.
- **CSS** : variables `--kebab-case`, classes `.kebab-case`, modificateurs `.is-active` / `.is-correct`.
- **IDs HTML** : `screen-*` pour les écrans, `r-*` pour l'écran résultat.
- **Données** : `id` station = `st-NNN`, `id` ligne = numéro (`"1"`, `"7bis"`, etc.).

---

## Modèle de données

### `data/stations.json`

```json
[
  {
    "id": "st-001",
    "name": "Châtelet",
    "lat": 48.858625,
    "lon": 2.347244,
    "lines": ["1", "4", "7", "11", "14"]
  }
]
```

### `data/lines.json`

```json
[
  { "id": "1",  "label": "Ligne 1",  "color": "#FFCD00" },
  { "id": "14", "label": "Ligne 14", "color": "#662483" }
]
```

### Extensibilité (Phase 2/3)

- **Phase 2 (métro complet IDF)** : élargir la bounding box dans `build_dataset.py` (couvrir les communes limitrophes), pas de changement de schéma.
- **Phase 3 (RER)** : ajouter `"mode": "RER"` dans `stations.json` et un champ `"network"` dans `lines.json` (`"metro"` / `"rer"`). Le moteur peut filtrer selon le mode choisi dans une session.

---

## Comment ça fonctionne

### Boucle de jeu

1. **Accueil** — saisie d'un pseudo, choix de difficulté.
2. **Session** — 8 à 16 questions selon la difficulté, alternant LOCATE et ASSOCIATE.
3. **Feedback immédiat** après chaque réponse (révélation de la position correcte, mise en avant des lignes correctes).
4. **Résultat** — score, précision, série, niveau, liste des stations à retravailler.

### Répétition espacée (engine.js)

Pour chaque station, on calcule un poids :

```
weight = 1 + 3 * (wrong / seen) + 0.6 si seen < 3
```

Les stations sont ensuite tirées sans remplacement, pondérées par leur poids. Effet : les stations jamais vues et les stations mal réussies ont plus de chances d'être proposées.

### Persistance (storage.js)

Tout est stocké dans `localStorage` sous une clé unique `metropoli.v1` :

- profil (`pseudo`, `createdAt`),
- maîtrise (`mastery[stationId] = { seen, correct, wrong, lastSeen }`),
- historique des 20 dernières sessions.

Un bouton **Réinitialiser mon profil** sur l'accueil efface tout.

---

## Régénérer les données

Le fichier `data/stations.json` est généré à partir du jeu de données ouvert **« Emplacement des gares Île-de-France »** d'Île-de-France Mobilités.

```bash
# 1. Télécharger le GeoJSON officiel
curl -L -o data/stations-idf-raw.geojson \
  "https://data.iledefrance-mobilites.fr/api/explore/v2.1/catalog/datasets/emplacement-des-gares-idf/exports/geojson"

# 2. Régénérer stations.json + lines.json
python3 build_dataset.py
```

Le script :
- filtre `mode == METRO`,
- garde uniquement Paris intra-muros (bounding box paramétrable),
- fusionne les doublons (1 station = 1 enregistrement, lignes agrégées),
- applique les couleurs officielles RATP par ligne.

---

## Stack technique

| Couche | Choix | Justification |
|---|---|---|
| Carte | Leaflet 1.9.4 + CartoDB Positron | Gratuit, sans clé API, rendu sobre adapté à un usage portfolio. Compatible GitHub Pages. |
| Front | HTML + CSS + JS vanilla (ES modules) | Aucun framework requis, zéro build, lisibilité maximale. |
| Données | Fichiers JSON statiques | Faciles à versionner, à diff-er, à enrichir. Pas de backend. |
| Persistance | `localStorage` | MVP démontrable sans compte, sans serveur, sans cookie. |
| Typo | Google Fonts (Inter + Fraunces) | Combo display serif / texte sans-serif premium et neutre. |

---

## Roadmap

### V1 — livrée (MVP)
- 282 stations intra-muros, 15 lignes
- Gameplay mixte LOCATE / ASSOCIATE
- 3 niveaux de difficulté (tolérance + nombre de questions)
- Scoring avec bonus de série
- Répétition espacée simplifiée
- Profil + historique en `localStorage`
- Responsive desktop / mobile

### V2 — backlog
- Mode **Révision ciblée** (uniquement les stations à retravailler).
- Étendre aux ~308 stations du métro complet (toute la région).
- Affichage du tracé des lignes en surcouche (GeoJSON officiel IDFM).
- Mode chrono / mode survie.
- Page « Carte d'apprentissage » : visualisation de la maîtrise par station.

### V3 — backlog
- Intégration RER A/B/C/D/E.
- Mode « Trajet » : trouver le chemin le plus court entre deux stations.
- Mode multijoueur asynchrone (partage d'un score de session via URL).
- PWA (installation, mode hors ligne).
- Internationalisation (anglais, espagnol).

---

## Crédits données

- Stations : [Île-de-France Mobilités — Emplacement des gares IDF](https://data.iledefrance-mobilites.fr/explore/dataset/emplacement-des-gares-idf/) (Licence Ouverte 2.0).
- Fond de carte : © OpenStreetMap contributors, © CARTO.
- Couleurs des lignes : charte RATP officielle.

---

## Licence

MIT. Faites-en ce que vous voulez, créditez les sources de données ci-dessus.
