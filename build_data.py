#!/usr/bin/env python3
"""Build the compact JSON bundle of the Berlin transit time map (site/data/berlin.json) and the figures shown on
the page (data/stats.json), from the raw sources downloaded by fetch_data.py.

Model (same as site/app.js):
- a plain weekday (Tuesday or Thursday) of the VBB timetable, 7:00–20:00;
- ride time between two stops = median of the scheduled times;
- wait = half of the mean headway at the stop, between 1 and 15 minutes;
- changing lines = short walk (1.5 min in total), platform access for underground and big stations, plus the wait;
- walking at 4.5 km/h in a straight line; the Spree, Havel, Dahme, the big canals and the big lakes are crossed on
  foot only on a bridge.
"""

from __future__ import annotations

import csv
import heapq
import io
import json
import math
import re
import statistics
import zipfile
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Sequence, Tuple

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"

LAND_PAD_METERS = 1200.0
VIEW_PAD_METERS = 600.0
GRID_CELL_METERS = 200.0
WALK_METERS_PER_MINUTE = 75.0  # 4.5 km/h
TRANSFER_WALK = 1.5
INTER_STATION_WALK_RADIUS = 450.0
MIN_RIDE_MINUTES = 0.4
MIN_WAIT = 1.0
MAX_WAIT = 15.0
SERVICE_WINDOW = (7 * 3600, 20 * 3600)
PEAK_WINDOW = (7 * 3600, 9 * 3600)
REFERENCE_HORIZON_DAYS = 60

# Stations looked at around a departure point (also used by site/app.js): the nearest ones, plus a few of each mode.
ORIGIN_NEAREST_STATIONS = 8
ORIGIN_NEAREST_PER_MODE = 3
ORIGIN_MAX_METERS = 2500.0
# Stations attached to each grid cell: the nearest ones, plus a few of each mode (so that any mode filter works).
CELL_NEAREST_STATIONS = 5
CELL_NEAREST_PER_MODE = 2
CELL_CANDIDATES = 4
CELL_MODE_MAX_METERS = 2500.0

MIN_RING_DISTANCE = 35.0
MIN_LINE_DISTANCE = 40.0
RIVER_POINT_DISTANCE = 20.0
RIVER_BUCKET_METERS = 500.0
MAX_BRIDGE_WALK_METERS = 3000.0  # beyond 40 min, walking is never the best option (also in site/app.js)
MIN_PARK_AREA = 20_000.0
MIN_WATER_AREA = 15_000.0
WATER_MASK_AREA = 1_000_000.0  # lakes at least this large are not land: no heatmap there

# Display order, labels and defaults of the transport modes.
MODES = ["ubahn", "sbahn", "tram", "regional", "bus", "ferry"]
RAIL_MODES = {"ubahn", "sbahn", "tram", "regional"}
# Minutes to walk from the street to the platform (and back): stairs and corridors of underground and large stations.
MODE_ACCESS_MINUTES = {"ubahn": 1.0, "sbahn": 1.0, "regional": 1.5, "tram": 0.0, "bus": 0.0, "ferry": 0.5}
MODE_COLORS = {"ubahn": "#115D91", "sbahn": "#008D4F", "tram": "#BE1414", "regional": "#E2001A", "bus": "#A5027D", "ferry": "#0080BA"}


def route_mode(route_type: str) -> str | None:
    value = int(route_type or 3)
    if value in (1,) or 400 <= value < 500:
        return "ubahn"
    if value == 109:
        return "sbahn"
    if value in (2,) or 100 <= value < 200:
        return "regional"
    if value == 0 or 900 <= value < 1000:
        return "tram"
    if value == 4 or 1000 <= value < 1100 or 1200 <= value < 1300:
        return "ferry"
    if value == 3 or 700 <= value < 712 or value == 714 or 200 <= value < 300:
        return "bus"
    return None  # school buses, demand-responsive services, long-distance trains: not modelled


Point = Tuple[float, float]
Ring = List[Point]
Polygon = List[Ring]
MultiPolygon = List[Polygon]

LAT0 = 52.52


def lonlat_to_xy(lon: float, lat: float) -> Point:
    meters_per_deg_lat = 111_320.0
    return lon * meters_per_deg_lat * math.cos(math.radians(LAT0)), lat * meters_per_deg_lat


def xy_to_latlon(point: Point) -> Tuple[float, float]:
    meters_per_deg_lat = 111_320.0
    return point[1] / meters_per_deg_lat, point[0] / (meters_per_deg_lat * math.cos(math.radians(LAT0)))


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def round_point(point: Point) -> List[float]:
    return [round(point[0], 1), round(point[1], 1)]


def dist(a: Point, b: Point) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


# --- Geometry ------------------------------------------------------------------


def ring_area(ring: Sequence[Point]) -> float:
    area = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        area += x1 * y2 - x2 * y1
    return area / 2.0


def polygon_centroid(ring: Sequence[Point]) -> Point:
    area = ring_area(ring) or 1.0
    cx = cy = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        cross = x1 * y2 - x2 * y1
        cx += (x1 + x2) * cross
        cy += (y1 + y2) * cross
    return cx / (6 * area), cy / (6 * area)


def simplify_polyline(points: Sequence[Point], min_distance: float) -> List[Point]:
    if len(points) <= 2:
        return list(points)
    simplified = [points[0]]
    for point in points[1:-1]:
        if dist(point, simplified[-1]) >= min_distance:
            simplified.append(point)
    simplified.append(points[-1])
    return simplified


def simplify_ring(ring: Sequence[Point], min_distance: float) -> Ring:
    if len(ring) <= 4:
        return list(ring)
    simplified = simplify_polyline(ring[:-1], min_distance)
    if len(simplified) < 3:
        return list(ring)
    return simplified + [simplified[0]]


def ring_bounds(ring: Sequence[Point]) -> Tuple[float, float, float, float]:
    xs = [x for x, _ in ring]
    ys = [y for _, y in ring]
    return min(xs), min(ys), max(xs), max(ys)


def point_in_ring(point: Point, ring: Sequence[Point]) -> bool:
    x, y = point
    inside = False
    for (xi, yi), (xj, yj) in zip(ring, ring[1:] + ring[:1]):
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
    return inside


def raster_mask(polygons: MultiPolygon, bounds, cols: int, rows: int) -> bytearray:
    """Grid cells whose centre lies inside any of the polygons (even-odd inside each polygon: holes stay out).
    A scanline fill: thousands of vertices × tens of thousands of cells would be far too slow point by point."""
    min_x, min_y, max_x, max_y = bounds
    cell_w = (max_x - min_x) / cols
    cell_h = (max_y - min_y) / rows
    mask = bytearray(cols * rows)
    for polygon in polygons:
        crossings: Dict[int, List[float]] = defaultdict(list)
        for ring in polygon:
            for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
                if y1 == y2:
                    continue
                low, high = min(y1, y2), max(y1, y2)
                first = max(0, math.ceil((low - min_y) / cell_h - 0.5))
                last = min(rows - 1, math.ceil((high - min_y) / cell_h - 0.5) - 1)
                for row in range(first, last + 1):
                    yc = min_y + (row + 0.5) * cell_h
                    crossings[row].append(x1 + (yc - y1) * (x2 - x1) / (y2 - y1))
        for row, xs in crossings.items():
            xs.sort()
            for a, b in zip(xs[::2], xs[1::2]):
                first = max(0, math.ceil((a - min_x) / cell_w - 0.5))
                last = min(cols - 1, math.ceil((b - min_x) / cell_w - 0.5) - 1)
                for col in range(first, last + 1):
                    mask[row * cols + col] = 1
    return mask


def serialize_polygon(polygon: Polygon) -> List[List[List[float]]]:
    return [[round_point(point) for point in ring] for ring in polygon]


def geojson_polygons(geometry: dict, min_distance: float) -> MultiPolygon:
    parts = geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]
    polygons: MultiPolygon = []
    for part in parts:
        rings = [simplify_ring([lonlat_to_xy(lon, lat) for lon, lat, *_ in ring], min_distance) for ring in part]
        if rings and abs(ring_area(rings[0])) > 10_000:
            polygons.append(rings)
    return polygons


class StationIndex:
    """Bucket grid for nearest-station queries."""

    def __init__(self, points: Sequence[Point], indexes: Iterable[int], size: float = 800.0):
        self.size = size
        self.points = points
        self.buckets: Dict[Tuple[int, int], List[int]] = defaultdict(list)
        count = 0
        for index in indexes:
            x, y = points[index]
            self.buckets[(int(x // size), int(y // size))].append(index)
            count += 1
        self.empty = count == 0

    def nearest(self, point: Point, count: int, max_rings: int = 30) -> List[Tuple[float, int]]:
        if self.empty:
            return []
        cx, cy = int(point[0] // self.size), int(point[1] // self.size)
        found: List[Tuple[float, int]] = []
        for ring in range(max_rings + 1):
            for gx in range(cx - ring, cx + ring + 1):
                for gy in range(cy - ring, cy + ring + 1):
                    if max(abs(gx - cx), abs(gy - cy)) != ring:
                        continue
                    for index in self.buckets.get((gx, gy), ()):
                        found.append((dist(point, self.points[index]), index))
            found.sort()
            if len(found) >= count and found[count - 1][0] <= ring * self.size:
                break
        return found[:count]

    def within(self, point: Point, radius: float) -> List[int]:
        reach = int(radius // self.size) + 1
        cx, cy = int(point[0] // self.size), int(point[1] // self.size)
        return [
            index
            for gx in range(cx - reach, cx + reach + 1)
            for gy in range(cy - reach, cy + reach + 1)
            for index in self.buckets.get((gx, gy), ())
            if dist(point, self.points[index]) <= radius
        ]


def segments_cross(a: Point, b: Point, c: Point, d: Point) -> bool:
    def side(p: Point, q: Point, r: Point) -> float:
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    return side(a, b, c) * side(a, b, d) < 0 and side(c, d, a) * side(c, d, b) < 0


class Rivers:
    """Rivers and canals are crossed on foot only by a bridge: a walk whose straight line cuts one goes through the
    best bridge instead (one bridge at most). Same rule as site/app.js."""

    def __init__(self, lines: Sequence[Sequence[Point]], bridges: Sequence[Tuple[Point, Point, float]] = ()):
        self.buckets: Dict[Tuple[int, int], List[Tuple[Point, Point]]] = defaultdict(list)
        for line in lines:
            for a, b in zip(line, line[1:]):
                for key in self._keys(a, b):
                    self.buckets[key].append((a, b))
        self.bridges = list(bridges)

    @staticmethod
    def _keys(a: Point, b: Point):
        size = RIVER_BUCKET_METERS
        for gx in range(int(min(a[0], b[0]) // size), int(max(a[0], b[0]) // size) + 1):
            for gy in range(int(min(a[1], b[1]) // size), int(max(a[1], b[1]) // size) + 1):
                yield gx, gy

    def crosses(self, a: Point, b: Point) -> bool:
        if not self.buckets:
            return False
        for key in self._keys(a, b):
            for c, d in self.buckets.get(key, ()):
                if segments_cross(a, b, c, d):
                    return True
        return False

    def walk(self, a: Point, b: Point) -> float:
        """Walking distance in meters: straight, or through a bridge; infinite without one within reach."""
        if not self.crosses(a, b):
            return dist(a, b)
        detours = []
        for end_a, end_b, length in self.bridges:
            for near, far in ((end_a, end_b), (end_b, end_a)):
                meters = dist(a, near) + length + dist(far, b)
                if meters <= MAX_BRIDGE_WALK_METERS:
                    detours.append((meters, near, far))
        detours.sort()
        for meters, near, far in detours:
            if not self.crosses(a, near) and not self.crosses(far, b):
                return meters
        return math.inf


def way_points(geometry: Sequence[dict]) -> List[Point]:
    return [lonlat_to_xy(node["lon"], node["lat"]) for node in geometry if node]


def extract_rivers(lakes: MultiPolygon) -> Tuple[List[List[Point]], List[Tuple[Point, Point, float]]]:
    """Lines that cannot be crossed on foot except over a bridge: rivers, canals, and the shores of the big lakes
    (the Havel lakes, Müggelsee…). Returns them with the bridges over them: (one end, other end, length)."""
    lines = []
    for element in load_json(DATA / "osm_rivers.json")["elements"]:
        points = way_points(element.get("geometry", []))
        if len(points) >= 2:
            lines.append(simplify_polyline(points, RIVER_POINT_DISTANCE))
    lines += [list(ring) for polygon in lakes for ring in polygon]
    rivers = Rivers(lines)
    bridges: Dict[Tuple[int, int], Tuple[Point, Point, float]] = {}
    for element in load_json(DATA / "osm_bridges.json")["elements"]:
        points = way_points(element.get("geometry", []))
        if len(points) < 2 or not any(rivers.crosses(a, b) for a, b in zip(points, points[1:])):
            continue
        length = sum(dist(a, b) for a, b in zip(points, points[1:]))
        # Carriageways and sidewalks of the same bridge are separate ways: keep one per 40 m.
        middle = ((points[0][0] + points[-1][0]) / 2, (points[0][1] + points[-1][1]) / 2)
        bridges.setdefault((round(middle[0] / 40), round(middle[1] / 40)), (points[0], points[-1], length))
    return lines, list(bridges.values())


# --- Districts, water, parks -------------------------------------------------------


def extract_districts() -> Tuple[List[dict], MultiPolygon]:
    payload = load_json(DATA / "districts.geojson")
    districts = []
    land: MultiPolygon = []
    for feature in sorted(payload["features"], key=lambda f: f["properties"]["Gemeinde_name"]):
        polygons = geojson_polygons(feature["geometry"], MIN_RING_DISTANCE)
        largest = max((polygon[0] for polygon in polygons), key=lambda ring: abs(ring_area(ring)))
        districts.append(
            {
                "name": feature["properties"]["Gemeinde_name"],
                "polygons": [serialize_polygon(polygon) for polygon in polygons],
                "label": round_point(polygon_centroid(largest)),
            }
        )
        land.extend(polygons)
    return districts, land


def assemble_rings(ways: List[List[Point]]) -> List[Ring]:
    """Join open ways end to end into closed rings (OSM multipolygon members)."""
    rings: List[Ring] = []
    pending = [list(way) for way in ways if len(way) >= 2]
    while pending:
        ring = pending.pop()
        while ring[0] != ring[-1]:
            for i, way in enumerate(pending):
                if way[0] == ring[-1]:
                    ring.extend(way[1:])
                elif way[-1] == ring[-1]:
                    ring.extend(reversed(way[:-1]))
                elif way[-1] == ring[0]:
                    ring[:0] = way[:-1]
                elif way[0] == ring[0]:
                    ring[:0] = list(reversed(way[1:]))
                else:
                    continue
                pending.pop(i)
                break
            else:
                break  # cut by the query bounding box: drop it
        if ring[0] == ring[-1] and len(ring) >= 4:
            rings.append(ring)
    return rings


def osm_polygons(element: dict) -> MultiPolygon:
    if element["type"] == "way":
        points = way_points(element.get("geometry") or [])
        return [[points]] if len(points) >= 4 and points[0] == points[-1] else []
    members = [m for m in element.get("members", []) if m["type"] == "way" and m.get("geometry")]
    outers = assemble_rings([way_points(m["geometry"]) for m in members if m.get("role") != "inner"])
    inners = assemble_rings([way_points(m["geometry"]) for m in members if m.get("role") == "inner"])
    return [[outer, *[inner for inner in inners if point_in_ring(inner[0], outer)]] for outer in outers]


def extract_water_and_parks(bounds) -> Tuple[MultiPolygon, MultiPolygon, MultiPolygon]:
    """Return (water that is not land, other water shown on the map, parks)."""
    payload = load_json(DATA / "osm_water_parks.json")
    min_x, min_y, max_x, max_y = bounds
    masked: MultiPolygon = []
    water: MultiPolygon = []
    parks: MultiPolygon = []
    for element in payload["elements"]:
        tags = element.get("tags", {})
        for polygon in osm_polygons(element):
            ring_min_x, ring_min_y, ring_max_x, ring_max_y = ring_bounds(polygon[0])
            if ring_max_x < min_x or ring_min_x > max_x or ring_max_y < min_y or ring_min_y > max_y:
                continue
            area = abs(ring_area(polygon[0]))
            if tags.get("natural") == "water":
                if area < MIN_WATER_AREA:
                    continue
                tolerance = MIN_RING_DISTANCE if area > 1e6 else 12.0
                simplified = [simplify_ring(ring, tolerance) for ring in polygon]
                (masked if area >= WATER_MASK_AREA else water).append(simplified)
            elif tags.get("leisure") == "park" and area >= MIN_PARK_AREA:
                parks.append([simplify_ring(ring, 15.0) for ring in polygon])
    return masked, water, parks


# --- GTFS ---------------------------------------------------------------------------


def read_gtfs_table(archive: zipfile.ZipFile, name: str) -> Iterable[dict]:
    if name not in archive.namelist():
        return
    with archive.open(name) as handle:
        yield from csv.DictReader(io.TextIOWrapper(handle, encoding="utf-8-sig"))


def parse_time(value: str) -> int:
    hours, minutes, seconds = (int(part) for part in value.strip().split(":"))
    return hours * 3600 + minutes * 60 + seconds


def parse_date(value: str) -> date:
    return date(int(value[:4]), int(value[4:6]), int(value[6:8]))


WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


def services_by_date(calendar: Sequence[dict], calendar_dates: Sequence[dict]) -> Dict[date, frozenset]:
    """Active services for every day of the feed (calendar.txt rules + calendar_dates.txt exceptions)."""
    active: Dict[date, set] = defaultdict(set)
    for row in calendar:
        day, end = parse_date(row["start_date"]), parse_date(row["end_date"])
        while day <= end:
            if row[WEEKDAYS[day.weekday()]] == "1":
                active[day].add(row["service_id"])
            day += timedelta(days=1)
    for row in calendar_dates:
        day = parse_date(row["date"])
        if row["exception_type"] == "1":
            active[day].add(row["service_id"])
        else:
            active[day].discard(row["service_id"])
    return {day: frozenset(services) for day, services in active.items()}


def pick_reference_date(services: Dict[date, frozenset], trips_per_service: Counter) -> date:
    """A plain school-term Tuesday or Thursday: the most common set of services among the near-busiest such days
    (holidays and construction weeks run fewer trips)."""
    weekdays = sorted(day for day, active in services.items() if day.weekday() in (1, 3) and active)
    upcoming = [day for day in weekdays if day >= date.today()] or weekdays
    soon = [day for day in upcoming if day <= upcoming[0] + timedelta(days=REFERENCE_HORIZON_DAYS)]
    upcoming = soon if len(soon) >= 4 else upcoming
    volume = {day: sum(trips_per_service[service] for service in services[day]) for day in upcoming}
    busiest = max(volume.values())
    candidates = [day for day in upcoming if volume[day] >= 0.92 * busiest]
    signatures = Counter(services[day] for day in candidates)
    typical = signatures.most_common(1)[0][0]
    return next(day for day in candidates if services[day] == typical)


def display_name(raw: str) -> str:
    """VBB names: « S+U Alexanderplatz Bhf/Memhardstr. (Berlin) [Tram] » → « S+U Alexanderplatz/Memhardstr. »,
    « Berlin, Rahnsdorf/Waldschänke » → « Rahnsdorf/Waldschänke »."""
    name = re.sub(r"\s*\[[^\]]*\]", "", raw)
    name = re.sub(r"\s*\(Berlin\)", "", name)
    name = re.sub(r"^Berlin,\s*", "", name)
    name = re.sub(r"\s+Bhf\b\.?", "", name)
    return " ".join(name.split())


def station_key(stop: dict) -> str:
    """VBB stop ids are DHIDs (de:11000:900100003:1:50): the first three parts identify the station."""
    parts = stop["stop_id"].split(":")
    if len(parts) >= 3 and parts[0] == "de":
        return ":".join(parts[:3])
    return stop.get("parent_station") or stop["stop_id"]


def in_bbox(lat: float, lon: float, box) -> bool:
    south, west, north, east = box
    return south <= lat <= north and west <= lon <= east


def line_key(route: dict, mode: str) -> Tuple[str, str, str]:
    # Rail lines have unique names across operators; buses, trams and ferries are numbered per operator.
    name = route.get("route_short_name") or route.get("route_long_name") or route["route_id"]
    return ("" if mode in ("ubahn", "sbahn", "regional") else route["agency_id"], mode, name)


def extract_network(config: dict):
    archive = zipfile.ZipFile(DATA / "gtfs.zip")
    routes = {row["route_id"]: row for row in read_gtfs_table(archive, "routes.txt")}
    route_modes = {route_id: route_mode(row["route_type"]) for route_id, row in routes.items()}

    stops = {row["stop_id"]: row for row in read_gtfs_table(archive, "stops.txt")}
    box = config["stopBbox"]
    kept_stops = {
        stop_id
        for stop_id, row in stops.items()
        if row.get("location_type", "0") in ("", "0") and in_bbox(float(row["stop_lat"]), float(row["stop_lon"]), box)
    }

    services = services_by_date(list(read_gtfs_table(archive, "calendar.txt")), list(read_gtfs_table(archive, "calendar_dates.txt")))
    all_trips = [row for row in read_gtfs_table(archive, "trips.txt") if route_modes.get(row["route_id"])]
    reference_date = pick_reference_date(services, Counter(row["service_id"] for row in all_trips))
    weekday_services = services[reference_date]
    trips = {row["trip_id"]: row for row in all_trips if row["service_id"] in weekday_services}

    # Stream stop_times.txt (300 MB): keep the reference day's trips only.
    stop_times: Dict[str, List[Tuple[int, str, int, int]]] = defaultdict(list)
    with archive.open("stop_times.txt") as handle:
        reader = csv.reader(io.TextIOWrapper(handle, encoding="utf-8-sig"))
        header = next(reader)
        trip_col, seq_col, stop_col = header.index("trip_id"), header.index("stop_sequence"), header.index("stop_id")
        arr_col, dep_col = header.index("arrival_time"), header.index("departure_time")
        for row in reader:
            trip_id = row[trip_col]
            if trip_id not in trips or not row[arr_col]:
                continue
            stop_times[trip_id].append((int(row[seq_col]), row[stop_col], parse_time(row[arr_col]), parse_time(row[dep_col])))

    # Group the stops of each station (DHID); a station's name comes from its parent station when there is one.
    used_stop_ids = {stop_id for seq in stop_times.values() for _, stop_id, _, _ in seq if stop_id in kept_stops}
    by_key: Dict[str, List[str]] = defaultdict(list)
    for stop_id in sorted(used_stop_ids):
        by_key[station_key(stops[stop_id])].append(stop_id)
    stations: List[dict] = []
    station_of: Dict[str, int] = {}
    for key, stop_ids in sorted(by_key.items()):
        points = [lonlat_to_xy(float(stops[s]["stop_lon"]), float(stops[s]["stop_lat"])) for s in stop_ids]
        parent = stops.get(key)
        names = Counter(display_name(stops[s]["stop_name"]) for s in stop_ids)
        name = display_name(parent["stop_name"]) if parent else names.most_common(1)[0][0]
        for stop_id in stop_ids:
            station_of[stop_id] = len(stations)
        stations.append(
            {
                "key": key,
                "name": name,
                "point": (sum(x for x, _ in points) / len(points), sum(y for _, y in points) / len(points)),
                "lines": set(),
            }
        )

    # Logical lines: VBB splits some lines across several route_ids (S1 has two).
    line_index: Dict[Tuple[str, str, str], int] = {}
    lines: List[dict] = []
    route_line: Dict[str, int] = {}
    for route_id in sorted(routes):
        mode = route_modes[route_id]
        if not mode:
            continue
        row = routes[route_id]
        key = line_key(row, mode)
        if key not in line_index:
            line_index[key] = len(lines)
            lines.append({"name": key[2], "mode": mode, "color": "", "text": "", "agency": row["agency_id"]})
        line = lines[line_index[key]]
        color = (row.get("route_color") or "").strip().lstrip("#")
        if color and not line["color"]:
            line["color"] = f"#{color.upper()}"
            text = (row.get("route_text_color") or "").strip().lstrip("#")
            line["text"] = f"#{text.upper()}" if text else ""
        route_line[route_id] = line_index[key]

    def sequences(times: Dict[str, List[Tuple[int, str, int, int]]], trip_rows: Dict[str, dict]):
        """Per trip: its line, and the runs of consecutive stops inside the area, as (station, arrival, departure)."""
        for trip_id, sequence in times.items():
            sequence.sort()
            runs: List[List[Tuple[int, int, int]]] = [[]]
            for _, stop_id, arrival, departure in sequence:
                if stop_id in station_of:
                    runs[-1].append((station_of[stop_id], arrival, departure))
                elif runs[-1]:
                    runs.append([])
            yield trip_id, route_line[trip_rows[trip_id]["route_id"]], [run for run in runs if len(run) >= 2]

    ride_samples: Dict[Tuple[int, int, int], List[float]] = defaultdict(list)
    departures: Dict[Tuple[int, int], Counter] = defaultdict(Counter)
    peak_departures: Dict[Tuple[int, int, str], int] = Counter()
    daily_departures: Counter = Counter()  # per station, rail lines only, whole day
    trips_per_mode: Counter = Counter()
    longest: Dict[int, Tuple[float, int, int]] = {}
    window_start, window_end = SERVICE_WINDOW
    for trip_id, line, runs in sequences(stop_times, trips):
        if not runs:
            continue
        trips_per_mode[lines[line]["mode"]] += 1
        direction = trips[trip_id].get("direction_id") or "0"
        for run in runs:
            duration = (run[-1][1] - run[0][2]) / 60.0
            if duration > longest.get(line, (0,))[0]:
                longest[line] = (duration, run[0][0], run[-1][0])
            for (a, _, dep_a), (b, arr_b, _) in zip(run, run[1:]):
                stations[a]["lines"].add(line)
                stations[b]["lines"].add(line)
                if lines[line]["mode"] in RAIL_MODES:
                    daily_departures[a] += 1
                if PEAK_WINDOW[0] <= dep_a < PEAK_WINDOW[1]:
                    peak_departures[(a, line, direction)] += 1
                if a == b or not window_start <= dep_a < window_end:
                    continue
                ride_samples[(a, b, line)].append(max(0, arr_b - dep_a) / 60.0)
                departures[(a, line)][direction] += 1

    edges = {key: max(MIN_RIDE_MINUTES, statistics.median(samples)) for key, samples in ride_samples.items()}
    window_minutes = (window_end - window_start) / 60.0
    headways: Dict[Tuple[int, int], float] = {}
    for key, per_direction in departures.items():
        headways[key] = window_minutes / (sum(per_direction.values()) / len(per_direction))

    rail_shapes: Dict[str, int] = {}
    for trip in trips.values():
        line = route_line[trip["route_id"]]
        if lines[line]["mode"] != "bus" and trip.get("shape_id"):
            rail_shapes.setdefault(trip["shape_id"], line)

    timetable = {
        "dailyDepartures": daily_departures,
        "peakDepartures": peak_departures,
        "tripsPerMode": trips_per_mode,
        "longest": longest,
    }
    return archive, reference_date, stations, lines, edges, headways, rail_shapes, timetable


def line_geometry(archive: zipfile.ZipFile, rail_shapes: Dict[str, int], lines: List[dict], used_lines: Dict[int, int], box) -> List[dict]:
    """Line tracks from shapes.txt (non-bus lines), cut to the area and deduplicated."""
    points: Dict[str, List[Tuple[int, float, float]]] = defaultdict(list)
    for row in read_gtfs_table(archive, "shapes.txt"):
        if row["shape_id"] in rail_shapes:
            points[row["shape_id"]].append((int(row["shape_pt_sequence"]), float(row["shape_pt_lat"]), float(row["shape_pt_lon"])))
    south, west, north, east = box
    per_line: Dict[int, List[List[Point]]] = defaultdict(list)
    for shape_id, sequence in sorted(points.items()):
        line = rail_shapes[shape_id]
        if line not in used_lines:
            continue
        sequence.sort()
        parts: List[List[Point]] = [[]]
        for _, lat, lon in sequence:
            if in_bbox(lat, lon, (south - 0.02, west - 0.03, north + 0.02, east + 0.03)):
                parts[-1].append(lonlat_to_xy(lon, lat))
            elif parts[-1]:
                parts.append([])
        per_line[line] += [simplify_polyline(part, MIN_LINE_DISTANCE) for part in parts if len(part) >= 2]

    # Variants of a line mostly overlap: draw each stretch once. Longest variants first, then only the stretches
    # that are not already within ~75 m of a drawn one.
    bucket = 50.0
    shapes = []
    for line, parts in sorted(per_line.items()):
        covered: set = set()

        def mark(a: Point, b: Point) -> None:
            steps = max(1, int(dist(a, b) // 25))
            for k in range(steps + 1):
                x, y = a[0] + (b[0] - a[0]) * k / steps, a[1] + (b[1] - a[1]) * k / steps
                gx, gy = round(x / bucket), round(y / bucket)
                covered.update((gx + dx, gy + dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1))

        for part in sorted(parts, key=len, reverse=True):
            runs: List[List[Point]] = [[]]
            for i, point in enumerate(part):
                if (round(point[0] / bucket), round(point[1] / bucket)) in covered:
                    if runs[-1]:
                        runs[-1].append(point)  # join the already drawn stretch
                        runs.append([])
                    continue
                if not runs[-1] and i:
                    runs[-1].append(part[i - 1])
                runs[-1].append(point)
            for run in runs:
                if len(run) >= 2:
                    shapes.append({"line": used_lines[line], "points": [round_point(p) for p in run]})
            for a, b in zip(part, part[1:]):
                mark(a, b)
    return shapes


# --- Network graph (same model as site/app.js) ---------------------------------------------


class Network:
    """Nodes: one per (station, line) "state" (being on the platform/vehicle of a line), then one per station
    (being in the street at the station). Rides link states; alighting and boarding link a state to its station;
    walks link nearby stations."""

    def __init__(self, stations, lines, states, rides, walks):
        self.stations, self.lines, self.states = stations, lines, states
        count = len(states) + len(stations)
        self.adjacency: List[List[Tuple[int, float]]] = [[] for _ in range(count)]
        self.station_states: List[List[int]] = [[] for _ in stations]
        offset = len(states)
        for index, (station, line, wait) in enumerate(states):
            self.station_states[station].append(index)
            access = MODE_ACCESS_MINUTES[lines[line]["mode"]]
            self.adjacency[index].append((offset + station, access / 2 + TRANSFER_WALK / 2))
            self.adjacency[offset + station].append((index, access / 2 + TRANSFER_WALK / 2 + wait))
        for a, b, minutes in rides:
            self.adjacency[a].append((b, minutes))
        for a, b, meters in walks:
            self.adjacency[offset + a].append((offset + b, meters / WALK_METERS_PER_MINUTE))
            self.adjacency[offset + b].append((offset + a, meters / WALK_METERS_PER_MINUTE))

    def state_mode(self, state: int) -> str:
        return self.lines[self.states[state][1]]["mode"]

    def seeds(self, origin: Point, modes: set, rivers: Rivers) -> List[Tuple[int, float]]:
        """Stations reachable on foot from a departure point: the nearest ones, plus the nearest few of each mode."""
        usable = [i for i, s in enumerate(self.stations) if s["modes"] & modes]
        usable.sort(key=lambda i: dist(origin, self.stations[i]["point"]))
        taken, per_mode = [], Counter()
        for i in usable:
            if len(taken) >= ORIGIN_NEAREST_STATIONS and dist(origin, self.stations[i]["point"]) > ORIGIN_MAX_METERS:
                break
            station_modes = self.stations[i]["modes"] & modes
            if len(taken) < ORIGIN_NEAREST_STATIONS or any(per_mode[m] < ORIGIN_NEAREST_PER_MODE for m in station_modes):
                taken.append(i)
                per_mode.update(station_modes)
        result = []
        for i in taken:
            meters = rivers.walk(origin, self.stations[i]["point"])
            if meters < math.inf:
                result.append((i, meters / WALK_METERS_PER_MINUTE))
        return result

    def solve(self, origin: Point, modes: set, rivers: Rivers) -> List[float]:
        """Arrival time (in the street) at each station."""
        offset = len(self.states)
        best = [math.inf] * len(self.adjacency)
        heap: List[Tuple[float, int]] = []

        def push(node: int, time: float) -> None:
            if time < best[node]:
                best[node] = time
                heapq.heappush(heap, (time, node))

        for station, walk in self.seeds(origin, modes, rivers):
            push(offset + station, walk)
            for state in self.station_states[station]:
                if self.state_mode(state) in modes:
                    push(state, walk + MODE_ACCESS_MINUTES[self.state_mode(state)] + self.states[state][2])
        while heap:
            time, node = heapq.heappop(heap)
            if time > best[node]:
                continue
            for target, weight in self.adjacency[node]:
                if target < offset and self.state_mode(target) not in modes:
                    continue
                push(target, time + weight)
        arrival = [math.inf] * len(self.stations)
        for state, (station, line, _) in enumerate(self.states):
            out = best[state] + MODE_ACCESS_MINUTES[self.lines[line]["mode"]]
            arrival[station] = min(arrival[station], out)
        for station in range(len(self.stations)):
            on_foot = rivers.walk(origin, self.stations[station]["point"]) / WALK_METERS_PER_MINUTE
            arrival[station] = min(arrival[station], on_foot)
        return arrival


# --- Main ------------------------------------------------------------------------------------


def contrast_text(hex_color: str) -> str:
    value = int(hex_color.lstrip("#"), 16)
    luminance = 0.299 * (value >> 16) + 0.587 * ((value >> 8) & 255) + 0.114 * (value & 255)
    return "#111111" if luminance > 150 else "#FFFFFF"


def main() -> None:
    global LAT0
    config = load_json(ROOT / "config.json")
    LAT0 = config["lat0"]

    print("Reading the VBB timetable…")
    archive, reference_date, raw_stations, raw_lines, edges, headways, rail_shapes, timetable = extract_network(config)

    # Keep only the lines and stations actually served on the reference day inside the area.
    served_lines = sorted({line for station in raw_stations for line in station["lines"]},
                          key=lambda l: (MODES.index(raw_lines[l]["mode"]), len(raw_lines[l]["name"]), raw_lines[l]["name"]))
    used_lines = {old: new for new, old in enumerate(served_lines)}
    lines = []
    for old in served_lines:
        line = raw_lines[old]
        color = line["color"] or MODE_COLORS[line["mode"]]
        lines.append({"name": line["name"], "mode": line["mode"], "color": color, "text": line["text"] or contrast_text(color)})
    kept_stations = [i for i, station in enumerate(raw_stations) if station["lines"]]
    station_index = {old: new for new, old in enumerate(kept_stations)}
    stations = [
        {
            "name": raw_stations[old]["name"],
            "point": raw_stations[old]["point"],
            "lines": sorted(used_lines[l] for l in raw_stations[old]["lines"]),
        }
        for old in kept_stations
    ]
    for station in stations:
        station["modes"] = {lines[l]["mode"] for l in station["lines"]}
        station["rail"] = bool(station["modes"] & RAIL_MODES)

    print("Districts, water, parks, rivers…")
    districts, land = extract_districts()
    xs = [x for polygon in land for ring in polygon for x, _ in ring]
    ys = [y for polygon in land for ring in polygon for _, y in ring]
    bounds = (min(xs) - LAND_PAD_METERS, min(ys) - LAND_PAD_METERS, max(xs) + LAND_PAD_METERS, max(ys) + LAND_PAD_METERS)
    cols = round((bounds[2] - bounds[0]) / GRID_CELL_METERS)
    rows = round((bounds[3] - bounds[1]) / GRID_CELL_METERS)
    masked_water, water, parks = extract_water_and_parks(bounds)
    river_lines, bridges = extract_rivers(masked_water)
    rivers = Rivers(river_lines, bridges)

    land_mask = raster_mask(land, bounds, cols, rows)
    water_mask = raster_mask(masked_water, bounds, cols, rows)
    cell_w = (bounds[2] - bounds[0]) / cols
    cell_h = (bounds[3] - bounds[1]) / rows

    def cell_of(point: Point) -> int | None:
        col, row = int((point[0] - bounds[0]) / cell_w), int((point[1] - bounds[1]) / cell_h)
        return row * cols + col if 0 <= col < cols and 0 <= row < rows else None

    for station in stations:
        cell = cell_of(station["point"])
        station["berlin"] = cell is not None and bool(land_mask[cell])

    print("Graph…")
    states: List[Tuple[int, int, float]] = []
    state_of: Dict[Tuple[int, int], int] = {}
    for index, station in enumerate(stations):
        for line in station["lines"]:
            state_of[(index, line)] = len(states)
            old_key = (kept_stations[index], served_lines[line])
            headway = headways.get(old_key)
            wait = min(MAX_WAIT, max(MIN_WAIT, headway / 2)) if headway else MAX_WAIT
            states.append((index, line, round(wait, 2)))
    rides = []
    for (a, b, line), minutes in sorted(edges.items()):
        if a in station_index and b in station_index:
            rides.append((state_of[(station_index[a], used_lines[line])], state_of[(station_index[b], used_lines[line])], round(minutes, 2)))
    points = [station["point"] for station in stations]
    index_all = StationIndex(points, range(len(points)))
    walks = []
    for i, station in enumerate(stations):
        for j in index_all.within(station["point"], INTER_STATION_WALK_RADIUS):
            if j <= i:
                continue
            meters = rivers.walk(station["point"], points[j])
            if meters <= INTER_STATION_WALK_RADIUS:
                walks.append((i, j, round(meters)))
    network = Network(stations, lines, states, rides, walks)

    print("Grid…")
    mode_indexes = {mode: StationIndex(points, [i for i, s in enumerate(stations) if mode in s["modes"]]) for mode in MODES}
    cells = []
    for row in range(rows):
        for col in range(cols):
            if not land_mask[row * cols + col] or water_mask[row * cols + col]:
                continue
            point = (bounds[0] + (col + 0.5) * cell_w, bounds[1] + (row + 0.5) * cell_h)

            def reachable(index: StationIndex, count: int) -> List[Tuple[float, int]]:
                found: List[Tuple[float, int]] = []
                for straight, i in index.nearest(point, count * CELL_CANDIDATES):
                    if len(found) >= count and straight >= found[count - 1][0]:
                        break
                    meters = rivers.walk(point, points[i])
                    if meters < math.inf:
                        found.append((meters, i))
                        found.sort()
                return found[:count]

            access = {i: meters for meters, i in reachable(index_all, CELL_NEAREST_STATIONS)}
            for mode in MODES:
                # A station of a mode is worth listing only within a sensible walk (beyond, the nearest stops win).
                for meters, i in reachable(mode_indexes[mode], CELL_NEAREST_PER_MODE):
                    if meters <= CELL_MODE_MAX_METERS:
                        access[i] = meters
            if not access:
                # Cut off by rivers on every side (a cell centre on the water, or a bridgeless islet): left empty and
                # filled from its neighbours in the browser, instead of a far-away value that spreads when smoothed.
                continue
            entry = [row, col]
            for i, meters in sorted(access.items(), key=lambda item: item[1]):
                entry += [i, round(meters)]
            cells.append(entry)

    print("Line geometry…")
    routes = line_geometry(archive, rail_shapes, raw_lines, used_lines, config["stopBbox"])

    rail_points = [s["point"] for s in stations if s["rail"] and s["berlin"]]
    view_bounds = (
        min(x for x, _ in rail_points) - VIEW_PAD_METERS,
        min(y for _, y in rail_points) - VIEW_PAD_METERS,
        max(x for x, _ in rail_points) + VIEW_PAD_METERS,
        max(y for _, y in rail_points) + VIEW_PAD_METERS,
    )

    output = {
        "meta": {
            "lat0": LAT0,
            "referenceDate": reference_date.isoformat(),
            "bounds": [round(v, 1) for v in bounds],
            "viewBounds": [round(v, 1) for v in view_bounds],
            "gridCols": cols,
            "gridRows": rows,
            "walkMetersPerMinute": WALK_METERS_PER_MINUTE,
            "transferWalk": TRANSFER_WALK,
            "modeAccess": MODE_ACCESS_MINUTES,
            "originStationCount": ORIGIN_NEAREST_STATIONS,
            "originPerMode": ORIGIN_NEAREST_PER_MODE,
            "originMaxMeters": ORIGIN_MAX_METERS,
            "maxBridgeWalkMeters": MAX_BRIDGE_WALK_METERS,
        },
        "districts": districts,
        "rivers": [[round_point(p) for p in line] for line in river_lines],
        "bridges": [[round_point(a), round_point(b), round(length, 1)] for a, b, length in bridges],
        "water": [serialize_polygon(polygon) for polygon in masked_water + water],
        "parks": [serialize_polygon(polygon) for polygon in parks],
        "routes": routes,
        "lines": lines,
        "stations": [
            {"name": s["name"], "point": round_point(s["point"]), "lines": s["lines"], **({"berlin": 1} if s["berlin"] else {})}
            for s in stations
        ],
        "states": [value for state in states for value in state],
        "rides": [value for ride in rides for value in ride],
        "walks": [value for walk in walks for value in walk],
        "cells": cells,
    }
    output_path = ROOT / "site" / "data" / f"{config['slug']}.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")

    print("Figures…")
    stats = network_stats(config, reference_date, network, stations, lines, rivers, kept_stations, served_lines, headways, timetable, raw_stations)
    stats_path = DATA / "stats.json"
    stats_path.write_text(json.dumps(stats, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    modes = Counter(line["mode"] for line in lines)
    print(
        f"Wrote {output_path.relative_to(ROOT)} ({output_path.stat().st_size / 1_000_000:.2f} MB, reference day {reference_date}, "
        f"lines {dict(modes)}, {len(stations)} stations ({sum(s['rail'] for s in stations)} rail), {len(states)} states, "
        f"{len(rides)} rides, {len(walks)} walks, {len(cells)} cells ({cols}×{rows}), {len(routes)} tracks, {len(bridges)} bridges)"
    )
    print(f"Wrote {stats_path.relative_to(ROOT)}")


def network_stats(config, reference_date, network: Network, stations, lines, rivers, kept_stations, served_lines, headways, timetable, raw_stations) -> dict:
    """Figures and rankings shown on the page, read from the timetable and the same model as the map."""
    used_station = {old: new for new, old in enumerate(kept_stations)}
    used_line = {old: new for new, old in enumerate(served_lines)}
    origin = lonlat_to_xy(config["defaultFrom"]["lon"], config["defaultFrom"]["lat"])
    rail_ids = [i for i, s in enumerate(stations) if s["rail"] and s["berlin"]]

    rail_times = network.solve(origin, RAIL_MODES, rivers)
    all_times = network.solve(origin, set(MODES), rivers)
    rail_reach = [rail_times[i] for i in rail_ids]
    all_reach = [all_times[i] for i in rail_ids]
    farthest = max((i for i in rail_ids if math.isfinite(rail_times[i])), key=lambda i: rail_times[i])

    def share(values, limit):
        return round(100 * sum(v <= limit for v in values) / len(values))

    line_rows = []
    for new, old in enumerate(served_lines):
        line = lines[new]
        if line["mode"] == "bus":
            continue
        served = [i for i, s in enumerate(stations) if new in s["lines"] and s["berlin"]]
        if not served:
            continue
        values = [headways[(kept_stations[i], old)] for i in served if (kept_stations[i], old) in headways]
        line_rows.append({
            "name": line["name"],
            "mode": line["mode"],
            "color": line["color"],
            "text": line["text"],
            "stations": len(served),
            "headway": round(statistics.median(values), 1) if values else None,
        })

    peak: Dict[int, int] = {}
    for (station, line, _), count in timetable["peakDepartures"].items():
        if line in used_line and station in used_station and stations[used_station[station]]["berlin"]:
            peak[line] = max(peak.get(line, 0), count)
    peak_minutes = 120.0
    frequent = sorted(
        ({"line": used_line[line], "headway": round(peak_minutes / count, 1)} for line, count in peak.items()
         if lines[used_line[line]]["mode"] in RAIL_MODES),
        key=lambda item: item["headway"],
    )

    busiest = sorted(
        ({"station": stations[used_station[s]]["name"], "departures": count} for s, count in timetable["dailyDepartures"].items()
         if s in used_station and stations[used_station[s]]["berlin"]),
        key=lambda item: -item["departures"],
    )

    longest = sorted(
        (
            {
                "line": used_line[line],
                "minutes": round(minutes),
                "from": raw_stations[a]["name"],
                "to": raw_stations[b]["name"],
            }
            for line, (minutes, a, b) in timetable["longest"].items()
            if line in used_line and lines[used_line[line]]["mode"] in RAIL_MODES - {"regional"}
        ),
        key=lambda item: -item["minutes"],
    )

    manifest = load_json(DATA / "manifest.json")
    with zipfile.ZipFile(DATA / "gtfs.zip") as archive:
        services = services_by_date(list(read_gtfs_table(archive, "calendar.txt")), list(read_gtfs_table(archive, "calendar_dates.txt")))
    days = sorted(day for day, active in services.items() if active)

    return {
        "builtAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "referenceDate": reference_date.isoformat(),
        "gtfsFetchedAt": manifest.get("gtfs.zip", {}).get("fetchedAt"),
        "servicePeriod": [days[0].isoformat(), days[-1].isoformat()] if days else None,
        "center": config["defaultFrom"]["label"],
        "railStations": len(rail_ids),
        "stationsByMode": {mode: sum(1 for s in stations if s["berlin"] and mode in s["modes"]) for mode in MODES},
        "linesByMode": dict(Counter(line["mode"] for line in lines)),
        "tripsPerMode": dict(timetable["tripsPerMode"]),
        "within15": share(rail_reach, 15),
        "within30": share(rail_reach, 30),
        "within30All": share(all_reach, 30),
        "farthestStation": stations[farthest]["name"],
        "farthestMinutes": round(rail_times[farthest]),
        "lines": line_rows,
        "lineInfo": lines,
        "frequent": frequent[:10],
        "busiest": busiest[:10],
        "longest": longest[:10],
    }


if __name__ == "__main__":
    main()
