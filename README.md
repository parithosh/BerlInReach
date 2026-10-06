# BerlInReach

Interactive travel-time map of Berlin by public transport: pick a starting point and the whole city is coloured by how
long it takes to get anywhere by **U-Bahn, S-Bahn, tram, regional train (RE/RB/FEX), bus and ferry**. Click anywhere
for the travel time and a step-by-step route.

An English, all-modes adaptation for Berlin of [À portée de tram](https://tram.camilleroux.com/) by
[Camille Roux](https://github.com/camilleroux/montpellier-temps-transport) (MIT), itself inspired by Anthony Castrio's
[NYC Transit Time Cartogram](https://castrio.me/nyc/) and Jules Grandin's
[Paris map](https://julesgrandin.github.io/paris-temps-transport/).

Features: heatmap and 15/30/45/60-minute isochrones from a draggable start, fading out smoothly past the chosen scale
and along the city limits; destination by click with the detailed route (lines, changes, walks); map coloured from the
start or the destination; per-mode toggles (U-Bahn, S-Bahn, tram, regional train, bus, ferry); hovering a station
shows its name, lines and travel time; colour-blind palette (viridis) and dark mode (follows the system, remembered
per device); address search (Photon / OpenStreetMap) and station search; pan, zoom, fullscreen, geolocation,
shareable links (`?from=lat,lon&to=lat,lon&modes=ubahn,sbahn&max=60&iso=15,30,45`).

## Run

```bash
python3 fetch_data.py      # download VBB GTFS, district boundaries, OSM water/parks/rivers/bridges into data/
python3 build_data.py      # compute site/data/berlin.json and data/stats.json (~1–2 min)
python3 build_pages.py     # render site/index.html from templates/index.html
python3 -m http.server 8000 --directory site
```

Then open <http://localhost:8000>. Python 3.10+ with the standard library only. `fetch_data.py --gtfs-only` refreshes
just the timetable (VBB publishes a new one twice a week); `--osm-only` the map layers. Raw sources in `data/` are not
meant to be versioned; `data/manifest.json` records where and when each file was downloaded, with its SHA-256.

## Data

- Timetable: [VBB GTFS](https://daten.berlin.de/datensaetze/vbb-fahrplandaten-via-gtfs), all of Berlin-Brandenburg,
  © VBB Verkehrsverbund Berlin-Brandenburg GmbH, CC BY. Only stops inside `stopBbox` (Berlin plus a margin) are kept.
- District boundaries: [Bezirksgrenzen](https://daten.odis-berlin.de/de/dataset/bezirksgrenzen/), Geoportal Berlin,
  dl-de/zero-2-0.
- Water, parks, rivers, canals and bridges: © OpenStreetMap contributors (ODbL), via the Overpass API.
- Address search in the browser: [Photon](https://photon.komoot.io/) by Komoot.

## Model

- Reference day: the most common service pattern among the upcoming, near-busiest Tuesdays and Thursdays of the feed;
  times between 7:00 and 20:00.
- Lines: VBB `route_type` 400 → U-Bahn, 109 → S-Bahn, 900 → tram, 100/106 → regional train, 700/3 → bus,
  1000 → ferry. Route ids sharing a line name (VBB splits S1, S3…) are merged.
- Stations: stops grouped by DHID station (`de:11000:900100003:…`); names cleaned (`S+U Alexanderplatz Bhf (Berlin)` →
  `S+U Alexanderplatz`).
- Ride time between two stops = median scheduled time; wait = half the mean headway at the stop, between 1 and 15 min.
- Graph: one node per (station, line) plus one street-level node per station. Changing lines costs 1.5 min of walking
  plus platform access (U-Bahn and S-Bahn 1 min, regional 1.5 min, ferry 0.5 min) and the wait; stations within 450 m
  are linked on foot.
- Walking at 4.5 km/h in a straight line. The Spree, Havel, Dahme, Teltowkanal, Berlin-Spandauer Schifffahrtskanal and
  the shores of lakes larger than 1 km² can only be crossed over a bridge (OSM), otherwise by transit.
- The map is a 200 m grid over Berlin; each cell knows its nearest stops (and the nearest of each mode), so that every
  mode filter is computed in the browser with Dijkstra in a few milliseconds.

No real-time data, no disruptions: the city “on paper”.

## Files

- `config.json`: sources, centre (Alexanderplatz), areas, rivers.
- `fetch_data.py`, `build_data.py`, `build_pages.py`: pipeline above.
- `templates/index.html`: page template (stats, rankings and FAQ are filled from `data/stats.json`).
- `site/`: the static site (`index.html`, `app.js`, `styles.css`, `data/berlin.json`).

## Licences

- Code: MIT (see [LICENSE](LICENSE)).
- Computed data (`site/data/berlin.json`): derived from OpenStreetMap (ODbL) and the VBB timetable (CC BY).
