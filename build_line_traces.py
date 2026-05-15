"""
Construit data/line-traces.json à partir du jeu IDFM
"traces-des-lignes-de-transport-en-commun-idfm".

Sortie : { "1": { color: "#FFCD00", segments: [[[lon,lat],...], ...] }, ... }
Les segments sont des MultiLineString (1 ligne peut avoir plusieurs tronçons).
On simplifie légèrement les coordonnées (4 décimales = ~11 m) pour réduire le poids.
"""

import json
from pathlib import Path

ROOT = Path(__file__).parent
SRC = ROOT / "data" / "traces-raw.geojson"
OUT = ROOT / "data" / "line-traces.json"

# Normalisation des id pour matcher stations.json ('3B' -> '3bis')
def normalize_id(short: str) -> str:
    s = short.strip().upper()
    if s.endswith("B") and s[:-1].isdigit():
        return f"{s[:-1]}bis"
    return s.lower() if s.isalpha() else s

# On garde nos couleurs (charte que j'ai dans lines.json), pas celles de la source
# car elles divergent parfois (la 1 est #FFBE00 dans la source, #FFCD00 dans notre charte)
LINES_PATH = ROOT / "data" / "lines.json"
LINES = {l["id"]: l for l in json.loads(LINES_PATH.read_text(encoding="utf-8"))}

def round_coords(coords, decimals=5):
    """Arrondit récursivement les coordonnées d'un LineString/MultiLineString."""
    if isinstance(coords[0], (int, float)):
        return [round(c, decimals) for c in coords]
    return [round_coords(c, decimals) for c in coords]

def main():
    data = json.loads(SRC.read_text(encoding="utf-8"))
    out = {}
    for f in data["features"]:
        p = f["properties"]
        if p.get("route_type") != "Subway":
            continue
        line_id = normalize_id(p.get("route_short_name", ""))
        if line_id not in LINES:
            continue  # on ignore les lignes hors charte (ex: 3bis si pas pres.)

        geom = f["geometry"]
        if geom["type"] == "LineString":
            segments = [round_coords(geom["coordinates"])]
        elif geom["type"] == "MultiLineString":
            segments = [round_coords(seg) for seg in geom["coordinates"]]
        else:
            continue

        out[line_id] = {
            "color": LINES[line_id]["color"],
            "segments": segments,
        }

    OUT.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    size_kb = OUT.stat().st_size / 1024
    print(f"OK — {len(out)} lignes, {size_kb:.0f} ko")
    for lid, v in out.items():
        total_pts = sum(len(s) for s in v["segments"])
        print(f"  Ligne {lid:5} : {len(v['segments'])} segments, {total_pts} points, couleur {v['color']}")

if __name__ == "__main__":
    main()
