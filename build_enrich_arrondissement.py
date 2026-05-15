#!/usr/bin/env python3
"""Ajoute le champ `arrondissement` (1-20) à chaque station de stations.json
   via un point-in-polygon contre le geojson officiel de la ville de Paris.

   Usage :  python3 build_enrich_arrondissement.py
"""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).parent
STATIONS_PATH = ROOT / "data" / "stations.json"
ARR_PATH = Path("/tmp/arr.geojson")

if not ARR_PATH.exists():
    sys.exit("Manquant: /tmp/arr.geojson (cf README)")

arr = json.loads(ARR_PATH.read_text())
polys = []  # list of (c_ar, list_of_rings)  where ring = list[(lon,lat)]
for feat in arr["features"]:
    c_ar = int(feat["properties"]["c_ar"])
    geom = feat["geometry"]
    if geom["type"] == "Polygon":
        rings = [geom["coordinates"]]
    elif geom["type"] == "MultiPolygon":
        rings = geom["coordinates"]
    else:
        continue
    polys.append((c_ar, rings))


def point_in_ring(x, y, ring):
    """Ray-casting on a single ring (list of [lon,lat])."""
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi + 1e-15) + xi):
            inside = not inside
        j = i
    return inside


def point_in_polygon(x, y, rings):
    """rings = list of [outer, hole1, hole2, ...] (one polygon)."""
    if not rings:
        return False
    if not point_in_ring(x, y, rings[0]):
        return False
    for hole in rings[1:]:
        if point_in_ring(x, y, hole):
            return False
    return True


def find_arr(lon, lat):
    for c_ar, polygons in polys:
        # MultiPolygon stocke chaque polygone comme [outer, hole1, ...]
        # Polygon stocke un seul polygone également sous cette forme.
        for poly in polygons:
            if point_in_polygon(lon, lat, poly):
                return c_ar
    return None


stations = json.loads(STATIONS_PATH.read_text())
hit, miss = 0, 0
miss_samples = []
for s in stations:
    lon, lat = s["lon"], s["lat"]
    a = find_arr(lon, lat)
    if a is None:
        miss += 1
        if len(miss_samples) < 10:
            miss_samples.append(s["name"])
        s["arrondissement"] = None
    else:
        hit += 1
        s["arrondissement"] = a

print(f"Hit: {hit}  Miss: {miss}")
if miss_samples:
    print("Samples miss:", miss_samples)

STATIONS_PATH.write_text(json.dumps(stations, ensure_ascii=False, indent=2))
print(f"Écrit: {STATIONS_PATH} ({os.path.getsize(STATIONS_PATH)//1024} KB)")
