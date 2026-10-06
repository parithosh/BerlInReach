#!/usr/bin/env python3
"""Download the raw sources for the Berlin map into data/.

Usage: python3 fetch_data.py [--gtfs-only | --osm-only]

- VBB GTFS timetable (all of Berlin-Brandenburg: U-Bahn, S-Bahn, tram, regional trains, bus, ferry)
- Berlin district boundaries (ODIS / Geoportal Berlin)
- OpenStreetMap via Overpass: water, parks, rivers and canals, and the bridges over them
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
USER_AGENT = "berlin-in-reach/1.0 (build script)"
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]


def load_config() -> dict:
    return json.loads((ROOT / "config.json").read_text(encoding="utf-8"))


def bbox(values) -> str:
    return ",".join(str(v) for v in values)


def download(url: str, data: bytes | None = None) -> bytes:
    request = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=600) as response:
        return response.read()


def overpass(query: str) -> bytes:
    payload = urllib.parse.urlencode({"data": query}).encode()
    for attempt in range(6):
        for url in OVERPASS_URLS:
            try:
                body = download(url, payload)
                json.loads(body)
                return body
            except Exception as error:  # noqa: BLE001 - Overpass is often busy: retry
                print(f"  {url} failed ({error}), retrying…")
        time.sleep(10 * (attempt + 1))
    raise RuntimeError("Overpass unavailable")


def record(name: str, source: str) -> None:
    """Note in data/manifest.json where each raw file comes from and when it was fetched."""
    manifest_path = DATA / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    path = DATA / name
    manifest[name] = {
        "source": source,
        "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "bytes": path.stat().st_size,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def save(name: str, body: bytes, source: str) -> None:
    (DATA / name).write_bytes(body)
    record(name, source)
    print(f"  {name}: {len(body) / 1_000_000:.1f} MB")


def fetch_gtfs(config: dict) -> None:
    print(f"GTFS {config['network']}…")
    save("gtfs.zip", download(config["gtfsUrl"]), config["gtfsUrl"])


def fetch_osm(config: dict) -> None:
    print("District boundaries…")
    save("districts.geojson", download(config["districtsUrl"]), config["districtsUrl"])

    area = bbox(config["osmBbox"])
    print("Water and parks (OSM)…")
    query = (
        "[out:json][timeout:240];("
        f'relation["natural"="water"]({area});'
        f'way["natural"="water"]({area});'
        f'relation["leisure"="park"]({area});'
        f'way["leisure"="park"]({area});'
        ");out geom;"
    )
    save("osm_water_parks.json", overpass(query), f"Overpass API: {query}")

    # Rivers and canals are crossed on foot only by a bridge.
    print("Rivers and canals (OSM)…")
    rivers = "|".join(re.escape(name) for name in config["rivers"])
    canals = "|".join(re.escape(name) for name in config.get("canals", []))
    query = (
        "[out:json][timeout:180];("
        f'way["waterway"="river"]["name"~"^({rivers})$"]["tunnel"!~"."]({area});'
        + (f'way["waterway"="canal"]["name"~"^({canals})$"]["tunnel"!~"."]({area});' if canals else "")
        + ");out geom;"
    )
    save("osm_rivers.json", overpass(query), f"Overpass API: {query}")

    print("Bridges (OSM)…")
    query = (
        '[out:json][timeout:180];way["bridge"]["highway"]'
        '["highway"!~"^(motorway|motorway_link|trunk_link|construction|proposed|raceway)$"]["foot"!="no"]["access"!="no"]'
        f"({area});out geom;"
    )
    save("osm_bridges.json", overpass(query), f"Overpass API: {query}")


def main() -> None:
    config = load_config()
    DATA.mkdir(exist_ok=True)
    if "--osm-only" not in sys.argv:
        fetch_gtfs(config)
    if "--gtfs-only" not in sys.argv:
        fetch_osm(config)


if __name__ == "__main__":
    main()
