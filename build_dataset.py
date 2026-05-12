"""
Construit deux fichiers de données propres pour le jeu Métro Paris à partir
du dataset officiel Île-de-France Mobilités "emplacement-des-gares-idf".

Sortie :
- data/stations.json  : liste plate des stations de métro intra-muros
- data/lines.json     : catalogue des lignes de métro avec couleur officielle

Logique :
- on ne garde que les enregistrements mode == "Metro"
- on agrège les doublons (1 enregistrement par ligne desservie -> 1 station unique avec n lignes)
- on filtre sur la bounding box de Paris intra-muros (approx) pour le MVP Phase 1
"""

import json
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).parent
SRC = ROOT / "data" / "stations-idf-raw.geojson"
OUT_STATIONS = ROOT / "data" / "stations.json"
OUT_LINES = ROOT / "data" / "lines.json"

# Bounding box approximative de Paris intra-muros (légèrement élargie pour porte de... )
PARIS_BBOX = {
    "lon_min": 2.224,
    "lon_max": 2.470,
    "lat_min": 48.815,
    "lat_max": 48.905,
}

# Couleurs officielles RATP pour les lignes de métro (charte)
LINE_COLORS = {
    "1":   "#FFCD00",
    "2":   "#0064B0",
    "3":   "#9F9825",
    "3bis": "#98D4E2",
    "4":   "#C04191",
    "5":   "#F28E42",
    "6":   "#83C491",
    "7":   "#F3A4BA",
    "7bis": "#83C491",
    "8":   "#CEADD2",
    "9":   "#D5C900",
    "10":  "#E3B32A",
    "11":  "#8D5E2A",
    "12":  "#00814F",
    "13":  "#98D4E2",
    "14":  "#662483",
}

def normalize_indice(indice: str) -> str:
    """Normalise les indices type '3B' -> '3bis', '7B' -> '7bis'."""
    if not indice:
        return ""
    s = indice.strip().upper().replace(" ", "")
    if s.endswith("B") and s[:-1].isdigit():
        return f"{s[:-1]}bis"
    return s.lower() if s.isalpha() else s

def in_paris(lon: float, lat: float) -> bool:
    return (PARIS_BBOX["lon_min"] <= lon <= PARIS_BBOX["lon_max"]
            and PARIS_BBOX["lat_min"] <= lat <= PARIS_BBOX["lat_max"])

def main():
    raw = json.loads(SRC.read_text(encoding="utf-8"))
    # clé d'agrégation : nom de station normalisé + coords arrondies (évite les fusions abusives)
    grouped = defaultdict(lambda: {"name": None, "lat": None, "lon": None, "lines": set()})

    for feat in raw["features"]:
        props = feat["properties"]
        if str(props.get("mode", "")).upper() != "METRO":
            continue
        indice = normalize_indice(props.get("indice_lig", ""))
        if indice not in LINE_COLORS:
            continue
        coords = feat["geometry"]["coordinates"]
        lon, lat = coords[0], coords[1]
        if not in_paris(lon, lat):
            continue
        name = props.get("nom_gares") or props.get("nom_zdc") or "?"
        # fusion par nom normalisé : un nœud = une station unique multi-lignes
        key = name.lower().strip()
        g = grouped[key]
        g["name"] = name
        g["_coords"] = g.get("_coords", []) + [(lon, lat)]
        g["lines"].add(indice)

    stations = []
    for i, g in enumerate(sorted(grouped.values(), key=lambda x: x["name"]), start=1):
        coords = g["_coords"]
        avg_lon = sum(c[0] for c in coords) / len(coords)
        avg_lat = sum(c[1] for c in coords) / len(coords)
        stations.append({
            "id": f"st-{i:03d}",
            "name": g["name"],
            "lat": round(avg_lat, 6),
            "lon": round(avg_lon, 6),
            "lines": sorted(g["lines"], key=lambda x: (len(x), x)),
        })

    # Catalogue des lignes effectivement présentes
    present_lines = sorted({l for s in stations for l in s["lines"]},
                           key=lambda x: (len(x), x))
    lines = [
        {"id": l, "label": f"Ligne {l}", "color": LINE_COLORS[l]}
        for l in present_lines
    ]

    OUT_STATIONS.write_text(
        json.dumps(stations, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    OUT_LINES.write_text(
        json.dumps(lines, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(f"OK — {len(stations)} stations uniques, {len(lines)} lignes")
    print("Aperçu :")
    for s in stations[:5]:
        print(" ", s)

if __name__ == "__main__":
    main()
