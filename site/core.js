// BerlInReach core: network data, travel-time model, map rendering and the controls shared by every page.
// Adapted from "À portée de tram" by Camille Roux (https://github.com/camilleroux/montpellier-temps-transport, MIT).
//
// A page module (app.js: one start; meet.js: several people) calls start(page) with hooks:
//   start()                       data loaded: restore state from the URL and draw
//   recompute()                   time of day, modes or travel changed: recompute everything
//   drawOverlay(colors)           markers drawn on top of the map
//   markers()                     [{ key, point }] that can be grabbed and dragged
//   grabMarker(key) / dragMarker(key, world) / dropMarker(key) / removeMarker(key)
//   click(world)                  click on the map (not a drag)
//   hoverContent(target)          tooltip content (DOM nodes) for { station, world }, or null
//   hoverAnywhere                 true: tooltips anywhere on the map, not only over stops
//   paramsChanged()               shared settings changed: write the URL

export const CITY = JSON.parse(document.getElementById("city-config").textContent);
const BASE_URL = new URL(`./data/${CITY.slug}.json?v=${CITY.dataVersion}`, import.meta.url);
const periodUrl = (period) => new URL(`./data/${CITY.slug}-${period}.json?v=${CITY.dataVersion}`, import.meta.url);
const GEOCODER_URL = "https://photon.komoot.io/api/";

export const MODES = ["ubahn", "sbahn", "tram", "regional", "bus", "ferry"];
export const MODE_LABELS = {
  ubahn: "U-Bahn",
  sbahn: "S-Bahn",
  tram: "Tram",
  regional: "Regional train",
  bus: "Bus",
  ferry: "Ferry",
};
export const RAIL_MODES = ["ubahn", "sbahn", "tram", "regional"];
export const PERIODS = ["day", "rush", "night"];
export const PERIOD_LABELS = { day: "daytime", rush: "rush hour", night: "at night" };
const DEFAULT_MODES = [...MODES];
// Berlin is large: an hour covers most of the city, and the 45-minute line shows where it starts to take long.
const DEFAULT_MAX = 60;
export const ISOCHRONE_OPTIONS = [15, 30, 45, 60];
const DEFAULT_ISOCHRONES = [15, 30, 45];

// Getting to and from the stops: on foot, or by bike (15 km/h, plus a minute or two to unlock and park it).
// Changing between stops is always on foot.
const BIKE_METERS_PER_MINUTE = 250;
const BIKE_PARKING_MINUTES = 2;
// By bike, stations farther away are worth reaching, and a detour to a bridge can be longer.
const BIKE_ORIGIN_MAX_METERS = 6000;
const BIKE_ORIGIN_PER_MODE = 4;
const BIKE_MAX_BRIDGE_METERS = 10000;

// Fingers aim less precisely, and a tap often moves by a few pixels.
const MARKER_HIT_RADIUS = { mouse: 18, touch: 30 };
const CLICK_SLOP = { mouse: 5, touch: 12 };
const MIN_ZOOM_FACTOR = 0.5;
const MAX_ZOOM_FACTOR = 16;
const STOP_LABEL_SCALE = 0.16; // pixels per meter beyond which rail stations are named
const RAIL_NAME_RADIUS = 400; // meters

// From closest to farthest. The standard palette runs green → red; the colour-blind one is viridis (yellow → purple),
// readable with every common colour vision deficiency and in greyscale.
const PALETTES = {
  standard: [
    [0, [47, 150, 18]],
    [0.25, [126, 200, 80]],
    [0.5, [226, 228, 120]],
    [0.75, [244, 182, 112]],
    [1, [226, 120, 120]],
  ],
  colorblind: [
    [0, [253, 231, 37]],
    [0.25, [94, 201, 98]],
    [0.5, [33, 145, 140]],
    [0.75, [59, 82, 139]],
    [1, [68, 1, 84]],
  ],
};
// Beyond the maximum, the colour fades out smoothly over this share of the scale (half: 60 → 90 min).
const BEYOND_FADE = 0.5;
const HEAT_UPSAMPLE = 3;
const LUT_SIZE = 512;
const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const RIVER_BRIDGE_CELLS = 4; // 200 m cells: enough to span the Spree and the Havel
// Soft edge of the heatmap along the city limits, in CSS pixels.
const HEAT_EDGE_BLUR = 7;
const HOVER_RADIUS = 9; // pixels around a drawn stop that count as hovering it

// Monochrome base (after ethlabs.org): white, near-black ink, hairlines, one red accent.
export const FONT = '"Outfit", system-ui, -apple-system, "Segoe UI", sans-serif';
const THEMES = {
  light: {
    background: "#ffffff",
    land: "#f2f2f0",
    water: "#dde5ea",
    park: "rgba(110, 150, 90, 0.10)",
    districtLine: "rgba(17, 17, 17, 0.22)",
    districtText: "rgba(17, 17, 17, 0.5)",
    districtHalo: "rgba(255, 255, 255, 0.7)",
    contour: "#111111",
    contourHalo: "rgba(255, 255, 255, 0.75)",
    text: "#111111",
    halo: "rgba(255, 255, 255, 0.9)",
    stopFill: "#ffffff",
    stopStroke: "#111111",
    busStop: "rgba(17, 17, 17, 0.4)",
    ink: "#111111",
    inkText: "#ffffff",
    accent: "#e5392b",
    accentText: "#ffffff",
    markerRing: "#ffffff",
    heatAlpha: 0.74,
  },
  dark: {
    background: "#0e0e0e",
    land: "#1a1a1a",
    water: "#18232b",
    park: "rgba(140, 180, 120, 0.07)",
    districtLine: "rgba(237, 237, 237, 0.18)",
    districtText: "rgba(237, 237, 237, 0.5)",
    districtHalo: "rgba(0, 0, 0, 0.5)",
    contour: "#ededed",
    contourHalo: "rgba(0, 0, 0, 0.6)",
    text: "#ededed",
    halo: "rgba(14, 14, 14, 0.9)",
    stopFill: "#0e0e0e",
    stopStroke: "#ededed",
    busStop: "rgba(237, 237, 237, 0.35)",
    ink: "#ededed",
    inkText: "#0e0e0e",
    accent: "#e5392b",
    accentText: "#ffffff",
    markerRing: "#0e0e0e",
    heatAlpha: 0.68,
  },
};
const ROUTE_WIDTH = { ubahn: 3, sbahn: 3, regional: 2.2, tram: 1.8, ferry: 1.8, bus: 1.2 };

export const $ = (id) => document.getElementById(id);
const canvas = $("mapCanvas");
const ctx = canvas.getContext("2d");
const stage = $("mapStage");
const tooltip = $("mapTooltip");

export const app = {
  page: null,
  data: null, // base: geometry, lines, stations, walks
  periodData: new Map(), // period → { states, rides, cells }
  graph: null,
  cells: null,
  paths: null,
  rivers: new Map(),
  offset: [0, 0],
  view: { cx: 0, cy: 0, scale: 1, fitScale: 1 },
  size: { width: 0, height: 0, dpr: 1 },
  modes: new Set(DEFAULT_MODES),
  modeMask: 0,
  period: "day",
  travel: "walk", // to and from the stops: "walk" or "bike"
  maxMinutes: DEFAULT_MAX,
  isochrones: [...DEFAULT_ISOCHRONES],
  // The colour-blind palette is the default; visitors who switch it off keep the standard one on this device.
  palette: localStorage.getItem("palette") === "standard" ? "standard" : "colorblind",
  grid: null,
  heatCanvas: document.createElement("canvas"),
  heatLayer: document.createElement("canvas"), // screen-sized, for the soft edge along the city limits
  stamp: 0, // bumped on every recompute: tooltips refresh their figures
  hover: null, // { station, world, stamp }
  drawnStops: [], // stops drawn in the last frame, in screen coordinates (hover targets)
  drag: null,
  pointers: new Map(),
  frameRequested: false,
};

/** Current map colours: the page theme is set on <html data-theme> (inline script in the page head). */
export function theme() {
  return THEMES[document.documentElement.dataset.theme === "dark" ? "dark" : "light"];
}

// --- Small helpers -------------------------------------------------------------

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const hypot = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const modeBit = (mode) => 1 << MODES.indexOf(mode);
const RAIL_MASK = RAIL_MODES.reduce((mask, mode) => mask | (1 << MODES.indexOf(mode)), 0);
const smoothstep = (t) => t * t * (3 - 2 * t);

export function formatMinutes(minutes) {
  if (!Number.isFinite(minutes)) return "—";
  if (minutes < 1) return "< 1 min";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes - hours * 60);
  return `${hours} h ${String(rest).padStart(2, "0")}`;
}

function paletteColor(t) {
  const palette = PALETTES[app.palette];
  for (let i = 1; i < palette.length; i += 1) {
    const [stop, color] = palette[i];
    if (t <= stop) {
      const [prevStop, prevColor] = palette[i - 1];
      const mix = (t - prevStop) / (stop - prevStop);
      return prevColor.map((channel, c) => Math.round(channel + (color[c] - channel) * mix));
    }
  }
  return palette[palette.length - 1][1];
}

function metersPerDegree() {
  const lat = 111320;
  return { lat, lon: lat * Math.cos((app.data.meta.lat0 * Math.PI) / 180) };
}

export function toWorld(lat, lon) {
  const m = metersPerDegree();
  return [lon * m.lon, lat * m.lat];
}

export function toLatLon(point) {
  const m = metersPerDegree();
  return { lat: point[1] / m.lat, lon: point[0] / m.lon };
}

export function formatPair(point) {
  const { lat, lon } = toLatLon(point);
  return `${lat.toFixed(5)},${lon.toFixed(5)}`;
}

export function parsePair(value) {
  const match = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(value || "");
  return match ? toWorld(Number(match[1]), Number(match[2])) : null;
}

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInPolygon(point, polygon) {
  return pointInRing(point, polygon[0]) && !polygon.slice(1).some((hole) => pointInRing(point, hole));
}

export function isOnLand(point) {
  if (app.data.water.some((polygon) => pointInPolygon(point, polygon))) return false;
  return app.data.districts.some((district) => district.polygons.some((polygon) => pointInPolygon(point, polygon)));
}

export function districtAt(point) {
  return app.data.districts.find((district) => district.polygons.some((polygon) => pointInPolygon(point, polygon)))?.name;
}

export function toast(message) {
  const element = $("toast");
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    element.hidden = true;
  }, 2400);
}

// --- Rivers ---------------------------------------------------------------------
// The Spree, Havel, Dahme, the big canals and the shores of the big lakes are crossed on foot only on a bridge: a walk
// whose straight line cuts one goes through the best bridge (one at most). Same rule as build_data.py.

const RIVER_BUCKET = 500;

function riverKeys(a, b, visit) {
  for (let gx = Math.floor(Math.min(a[0], b[0]) / RIVER_BUCKET); gx <= Math.floor(Math.max(a[0], b[0]) / RIVER_BUCKET); gx += 1) {
    for (let gy = Math.floor(Math.min(a[1], b[1]) / RIVER_BUCKET); gy <= Math.floor(Math.max(a[1], b[1]) / RIVER_BUCKET); gy += 1) {
      if (visit(`${gx},${gy}`)) return true;
    }
  }
  return false;
}

function indexRivers(lines) {
  const buckets = new Map();
  for (const line of lines ?? []) {
    for (let i = 1; i < line.length; i += 1) {
      const segment = [line[i - 1], line[i]];
      riverKeys(segment[0], segment[1], (key) => {
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(segment);
      });
    }
  }
  return buckets;
}

function side(p, q, r) {
  return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
}

function crossesRiver(a, b) {
  const buckets = app.rivers;
  if (!buckets.size) return false;
  return riverKeys(a, b, (key) =>
    (buckets.get(key) ?? []).some(([c, d]) => side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0),
  );
}

/** Distance in meters on foot or by bike: straight, or through a bridge; infinite without a bridge within reach. */
export function walkMeters(a, b) {
  const straight = hypot(a, b);
  if (!crossesRiver(a, b)) return straight;
  const limit = app.travel === "bike" ? BIKE_MAX_BRIDGE_METERS : app.data.meta.maxBridgeWalkMeters;
  const detours = [];
  for (const [endA, endB, length] of app.data.bridges) {
    const ab = hypot(a, endA) + length + hypot(endB, b);
    const ba = hypot(a, endB) + length + hypot(endA, b);
    if (ab <= limit) detours.push([ab, endA, endB]);
    if (ba <= limit) detours.push([ba, endB, endA]);
  }
  detours.sort((x, y) => x[0] - y[0]);
  const found = detours.find(([, near, far]) => !crossesRiver(a, near) && !crossesRiver(far, b));
  return found ? found[0] : Infinity;
}

/** Changing between stops: always on foot. */
export function walkMinutes(meters) {
  return meters / app.data.meta.walkMetersPerMinute;
}

/** Getting to the first stop or from the last one (or all the way): on foot or by bike. */
export function accessMinutes(meters) {
  if (app.travel === "bike") return meters / BIKE_METERS_PER_MINUTE + BIKE_PARKING_MINUTES;
  return meters / app.data.meta.walkMetersPerMinute;
}

export const accessVerb = () => (app.travel === "bike" ? "Cycle" : "Walk");

// --- Network graph --------------------------------------------------------------
// Nodes 0..S-1 are (station, line) states: on the platform or aboard a line. Nodes S..S+N-1 are the stations
// themselves, at street level. Rides link states; alighting/boarding link a state and its station; walks link
// nearby stations. States and rides depend on the time of day; stations and walks do not.

class MinHeap {
  constructor() {
    this.keys = [];
    this.values = [];
  }

  get size() {
    return this.keys.length;
  }

  push(key, value) {
    const { keys, values } = this;
    let i = keys.length;
    keys.push(key);
    values.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[i] = keys[parent];
      values[i] = values[parent];
      i = parent;
    }
    keys[i] = key;
    values[i] = value;
  }

  pop() {
    const { keys, values } = this;
    const top = values[0];
    const lastKey = keys.pop();
    const lastValue = values.pop();
    if (keys.length) {
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= keys.length) break;
        if (child + 1 < keys.length && keys[child + 1] < keys[child]) child += 1;
        if (keys[child] >= lastKey) break;
        keys[i] = keys[child];
        values[i] = values[child];
        i = child;
      }
      keys[i] = lastKey;
      values[i] = lastValue;
    }
    return top;
  }
}

function prepareGraph(base, period) {
  const { meta, lines, stations } = base;
  const stateCount = period.states.length / 3;
  const nodeCount = stateCount + stations.length;
  const station = new Int32Array(stateCount);
  const line = new Int32Array(stateCount);
  const wait = new Float32Array(stateCount);
  const access = new Float32Array(stateCount);
  const modeOf = new Uint8Array(stateCount);
  const lineMode = lines.map((info) => modeBit(info.mode));
  // Lines running at each station in this time window (tooltips, search), and which modes stop there.
  const stationLines = stations.map(() => []);
  const stationMask = new Uint8Array(stations.length);
  const activeLines = new Set();
  for (let s = 0; s < stateCount; s += 1) {
    station[s] = period.states[3 * s];
    line[s] = period.states[3 * s + 1];
    wait[s] = period.states[3 * s + 2];
    access[s] = meta.modeAccess[lines[line[s]].mode];
    modeOf[s] = lineMode[line[s]];
    stationLines[station[s]].push(line[s]);
    stationMask[station[s]] |= modeOf[s];
    activeLines.add(line[s]);
  }

  const from = [];
  const to = [];
  const weight = [];
  const add = (a, b, w) => {
    from.push(a);
    to.push(b);
    weight.push(w);
  };
  const half = meta.transferWalk / 2;
  for (let s = 0; s < stateCount; s += 1) {
    add(s, stateCount + station[s], access[s] / 2 + half);
    add(stateCount + station[s], s, access[s] / 2 + half + wait[s]);
  }
  for (let i = 0; i < period.rides.length; i += 3) add(period.rides[i], period.rides[i + 1], period.rides[i + 2]);
  for (let i = 0; i < base.walks.length; i += 3) {
    const minutes = base.walks[i + 2] / meta.walkMetersPerMinute;
    add(stateCount + base.walks[i], stateCount + base.walks[i + 1], minutes);
    add(stateCount + base.walks[i + 1], stateCount + base.walks[i], minutes);
  }
  const offsets = new Int32Array(nodeCount + 1);
  for (const a of from) offsets[a + 1] += 1;
  for (let n = 0; n < nodeCount; n += 1) offsets[n + 1] += offsets[n];
  const fill = offsets.slice(0, nodeCount);
  const targets = new Int32Array(from.length);
  const weights = new Float32Array(from.length);
  for (let e = 0; e < from.length; e += 1) {
    const slot = fill[from[e]]++;
    targets[slot] = to[e];
    weights[slot] = weight[e];
  }
  return { stateCount, nodeCount, offsets, targets, weights, station, line, wait, access, modeOf, stationMask, stationLines, activeLines };
}

function prepareCells(meta, cells) {
  const [minX, minY, maxX, maxY] = meta.bounds;
  const cellW = (maxX - minX) / meta.gridCols;
  const cellH = (maxY - minY) / meta.gridRows;
  const count = cells.length;
  const index = new Int32Array(count);
  const points = new Float64Array(count * 2);
  const offsets = new Int32Array(count + 1);
  cells.forEach((cell, c) => {
    offsets[c + 1] = offsets[c] + (cell.length - 2) / 2;
  });
  const stations = new Int32Array(offsets[count]);
  const meters = new Float32Array(offsets[count]);
  cells.forEach((cell, c) => {
    const [row, col] = cell;
    index[c] = row * meta.gridCols + col;
    points[2 * c] = minX + (col + 0.5) * cellW;
    points[2 * c + 1] = minY + (row + 0.5) * cellH;
    for (let k = 2, slot = offsets[c]; k < cell.length; k += 2, slot += 1) {
      stations[slot] = cell[k];
      meters[slot] = cell[k + 1];
    }
  });
  return { count, index, points, offsets, stations, meters };
}

async function loadPeriod(period) {
  if (!app.periodData.has(period)) {
    const response = await fetch(periodUrl(period));
    if (!response.ok) throw new Error(`Could not load the ${period} timetable`);
    app.periodData.set(period, await response.json());
  }
  const data = app.periodData.get(period);
  app.period = period;
  app.graph = prepareGraph(app.data, data);
  app.cells = prepareCells(app.data.meta, data.cells);
}

/** Stations reachable on foot (or by bike) from a point: the nearest ones, plus the nearest few of each enabled mode. */
function originSeeds(point) {
  const { meta, stations } = app.data;
  const { stationMask } = app.graph;
  const bike = app.travel === "bike";
  const maxMeters = bike ? BIKE_ORIGIN_MAX_METERS : meta.originMaxMeters;
  const perModeCount = bike ? BIKE_ORIGIN_PER_MODE : meta.originPerMode;
  const candidates = [];
  for (let i = 0; i < stations.length; i += 1) {
    if (stationMask[i] & app.modeMask) candidates.push([hypot(point, stations[i].point), i]);
  }
  candidates.sort((a, b) => a[0] - b[0]);
  const perMode = new Map();
  const seeds = [];
  for (const [straight, i] of candidates) {
    if (seeds.length >= meta.originStationCount && straight > maxMeters) break;
    const here = stationMask[i] & app.modeMask;
    let wanted = seeds.length < meta.originStationCount;
    for (const mode of MODES) {
      const bit = modeBit(mode);
      if (here & bit && (perMode.get(bit) ?? 0) < perModeCount) wanted = true;
    }
    if (!wanted) continue;
    seeds.push(i);
    for (const mode of MODES) {
      const bit = modeBit(mode);
      if (here & bit) perMode.set(bit, (perMode.get(bit) ?? 0) + 1);
    }
  }
  return seeds
    .map((i) => ({ index: i, minutes: accessMinutes(walkMeters(point, stations[i].point)) }))
    .filter((seed) => Number.isFinite(seed.minutes));
}

/** Shortest paths from a point: arrival time at each node, predecessors, and street-level time at each station. */
export function solveFrom(point) {
  const { graph, data } = app;
  const { stateCount, nodeCount } = graph;
  const dist = new Float64Array(nodeCount).fill(Infinity);
  const prev = new Int32Array(nodeCount).fill(-1);
  const seedAccess = new Float64Array(nodeCount);
  const heap = new MinHeap();
  const mask = app.modeMask;

  for (const seed of originSeeds(point)) {
    const node = stateCount + seed.index;
    if (seed.minutes < dist[node]) {
      dist[node] = seed.minutes;
      seedAccess[node] = seed.minutes;
      heap.push(seed.minutes, node);
    }
    for (let e = graph.offsets[node]; e < graph.offsets[node + 1]; e += 1) {
      const state = graph.targets[e];
      if (state >= stateCount || !(graph.modeOf[state] & mask)) continue;
      const reach = seed.minutes + graph.access[state];
      const time = reach + graph.wait[state];
      if (time < dist[state]) {
        dist[state] = time;
        seedAccess[state] = reach;
        prev[state] = -1;
        heap.push(time, state);
      }
    }
  }

  while (heap.size) {
    const node = heap.pop();
    const base = dist[node];
    for (let e = graph.offsets[node]; e < graph.offsets[node + 1]; e += 1) {
      const next = graph.targets[e];
      if (next < stateCount && !(graph.modeOf[next] & mask)) continue;
      const time = base + graph.weights[e];
      if (time < dist[next]) {
        dist[next] = time;
        prev[next] = node;
        heap.push(time, next);
      }
    }
  }

  const stationTime = new Float64Array(data.stations.length).fill(Infinity);
  const stationBest = new Int32Array(data.stations.length).fill(-1);
  // Back in the street at each station (underground lines need climbing up from the platform).
  for (let state = 0; state < stateCount; state += 1) {
    const out = dist[state] + graph.access[state];
    const station = graph.station[state];
    if (out < stationTime[station]) {
      stationTime[station] = out;
      stationBest[station] = state;
    }
  }
  return { point, dist, prev, seedAccess, stationTime, stationBest };
}

/** Best time to any point: going straight there, or through the most favourable station. */
export function travelTo(solution, point) {
  const direct = accessMinutes(walkMeters(solution.point, point));
  let best = { minutes: direct, station: -1, last: direct };
  app.data.stations.forEach((station, index) => {
    const arrival = solution.stationTime[index];
    // The real distance (bridges) is costlier: only for a station that can improve the trip.
    if (!Number.isFinite(arrival) || arrival + accessMinutes(hypot(station.point, point)) >= best.minutes) return;
    const last = accessMinutes(walkMeters(station.point, point));
    if (arrival + last < best.minutes) best = { minutes: arrival + last, station: index, last };
  });
  return best;
}

/** Time to reach a station (street level): by transit, or going straight there. */
export function timeToStation(solution, index) {
  const station = app.data.stations[index];
  return Math.min(solution.stationTime[index], accessMinutes(walkMeters(solution.point, station.point)));
}

export function lineLabel(lineIndex) {
  const info = app.data.lines[lineIndex];
  // U1, S41, RE1 already say what they are; trams, buses and ferries are just numbers (M10, 100, F10).
  return ["ubahn", "sbahn", "regional"].includes(info.mode) ? info.name : `${MODE_LABELS[info.mode]} ${info.name}`;
}

export function lineBadge(lineIndex) {
  const info = app.data.lines[lineIndex];
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = info.name;
  badge.style.background = info.color;
  badge.style.color = info.text;
  badge.title = lineLabel(lineIndex);
  return badge;
}

/** Rebuilds the itinerary (walks, lines, changes) to a point. */
export function buildItinerary(solution, point) {
  const { graph, data } = app;
  const { stateCount } = graph;
  const verb = accessVerb();
  const result = travelTo(solution, point);
  if (result.station === -1) {
    const text = app.travel === "bike" ? "Cycle all the way" : "Walk all the way";
    return { minutes: result.minutes, steps: [{ kind: "walk", text, minutes: result.minutes }] };
  }

  const chain = [];
  for (let node = solution.stationBest[result.station]; node !== -1; node = solution.prev[node]) chain.push(node);
  chain.reverse();

  const stationOf = (node) => (node >= stateCount ? node - stateCount : graph.station[node]);
  const name = (node) => data.stations[stationOf(node)].name;
  const steps = [];
  let walked = solution.seedAccess[chain[0]];
  let lastStation = -1; // station where the previous ride ended
  let i = 0;
  while (i < chain.length) {
    const node = chain[i];
    if (node >= stateCount) {
      // Street level: alighting, or walking between stations.
      if (i > 0) walked += solution.dist[node] - solution.dist[chain[i - 1]];
      i += 1;
      continue;
    }
    // Boarding a line: whatever happened since the last ride (minus the wait) was walking.
    if (i > 0) walked += solution.dist[node] - solution.dist[chain[i - 1]] - graph.wait[node];
    const here = graph.station[node];
    if (lastStation === -1) {
      steps.push({ kind: "walk", text: `${verb} to ${name(node)}`, minutes: walked });
    } else if (here !== lastStation) {
      steps.push({ kind: "walk", text: `Walk to ${name(node)}`, minutes: walked });
    } else {
      steps.push({ kind: "walk", text: `Change at ${name(node)}`, minutes: walked });
    }
    let end = i;
    while (end + 1 < chain.length && chain[end + 1] < stateCount && graph.line[chain[end + 1]] === graph.line[node]) end += 1;
    steps.push({
      kind: "ride",
      line: graph.line[node],
      text: `${name(node)} → ${name(chain[end])}`,
      wait: graph.wait[node],
      minutes: solution.dist[chain[end]] - solution.dist[node],
    });
    lastStation = graph.station[chain[end]];
    walked = 0;
    i = end + 1;
  }
  // Leaving the platform is counted with the final leg.
  const exit = graph.access[chain[chain.length - 1]];
  steps.push({ kind: "walk", text: `${verb} to destination`, minutes: result.last + exit });
  return { minutes: result.minutes, steps };
}

// --- Time grid ------------------------------------------------------------------

/** Fills empty cells (water, outside the map) with the mean of their neighbours, `passes` times. */
function fillGaps(values, cols, rows, passes) {
  const filled = Float32Array.from(values);
  for (let pass = 0; pass < passes; pass += 1) {
    const source = Float32Array.from(filled);
    for (let index = 0; index < source.length; index += 1) {
      if (!Number.isNaN(source[index])) continue;
      const row = Math.floor(index / cols);
      const col = index % cols;
      let sum = 0;
      let count = 0;
      for (const [dr, dc] of NEIGHBOURS) {
        const r = row + dr;
        const c = col + dc;
        if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
        const value = source[r * cols + c];
        if (!Number.isNaN(value)) {
          sum += value;
          count += 1;
        }
      }
      if (count) filled[index] = sum / count;
    }
  }
  return filled;
}

/** Travel time from a solution's origin to every grid cell (index = cell, not grid position). */
export function cellTimes(solution) {
  const cells = app.cells;
  const out = new Float32Array(cells.count);
  const origin = solution.point;
  for (let c = 0; c < cells.count; c += 1) {
    // Cell access lists already hold real walking distances (build_data.py); the direct trip is computed here.
    let best = Infinity;
    for (let k = cells.offsets[c]; k < cells.offsets[c + 1]; k += 1) {
      const time = solution.stationTime[cells.stations[k]] + accessMinutes(cells.meters[k]);
      if (time < best) best = time;
    }
    const point = [cells.points[2 * c], cells.points[2 * c + 1]];
    if (accessMinutes(hypot(origin, point)) < best) best = Math.min(best, accessMinutes(walkMeters(origin, point)));
    // A cell cut off behind a river, with no stop on its side: very far, without an infinity that would spoil smoothing.
    out[c] = Math.min(best, 180);
  }
  return out;
}

/** Grid of times (per cell values from cellTimes, or a combination of several), smoothed for drawing. */
export function computeGrid(values) {
  const { gridCols: cols, gridRows: rows } = app.data.meta;
  const cells = app.cells;
  const times = new Float32Array(cols * rows).fill(NaN);
  for (let c = 0; c < cells.count; c += 1) times[cells.index[c]] = values[c];
  // Isochrones span the rivers (filled with the values of the banks) instead of going round them; they are then
  // clipped to dry land when drawn.
  const bridged = fillGaps(times, cols, rows, RIVER_BRIDGE_CELLS);
  return { smooth: smoothGrid(bridged, cols, rows), cols, rows, contours: {} };
}

/** 3×3 mean restricted to land, for less jagged isochrones and heatmap. */
function smoothGrid(times, cols, rows) {
  const out = new Float32Array(times.length).fill(NaN);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const index = row * cols + col;
      if (Number.isNaN(times[index])) continue;
      let sum = 0;
      let weight = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const r = row + dy;
          const c = col + dx;
          if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
          const value = times[r * cols + c];
          if (Number.isNaN(value)) continue;
          const w = dx === 0 && dy === 0 ? 2 : 1;
          sum += value * w;
          weight += w;
        }
      }
      out[index] = sum / weight;
    }
  }
  return out;
}

/** Paints the grid into an image (HEAT_UPSAMPLE² pixels per cell, bilinear interpolation). */
export function paintHeat(grid, { fast = false } = {}) {
  const { cols, rows, smooth } = grid;
  const upsample = fast ? 1 : HEAT_UPSAMPLE;
  const heat = app.heatCanvas;
  heat.width = cols * upsample;
  heat.height = rows * upsample;
  const heatCtx = heat.getContext("2d");
  const image = heatCtx.createImageData(heat.width, heat.height);

  // Lightly smoothed values (fewer blobs around isolated stops), spread a few cells beyond the city limits so that
  // the soft edge drawn in render() fades into colour rather than into nothing.
  const filled = fillGaps(smooth, cols, rows, 3);

  const lutMax = 1 + BEYOND_FADE;
  const lut = new Uint32Array(LUT_SIZE);
  const lutBytes = new Uint8Array(lut.buffer);
  for (let i = 0; i < LUT_SIZE; i += 1) {
    const t = (i / (LUT_SIZE - 1)) * lutMax;
    const [r, g, b] = paletteColor(Math.min(t, 1));
    // Past the maximum, an eased fade-out instead of a hard cut.
    const alpha = t <= 1 ? 255 : Math.round((1 - smoothstep(clamp((t - 1) / BEYOND_FADE, 0, 1))) * 255);
    lutBytes.set([r, g, b, alpha], i * 4);
  }
  const pixels = new Uint32Array(image.data.buffer);
  const toLut = (LUT_SIZE - 1) / (app.maxMinutes * lutMax);
  const step = 1 / upsample;
  const width = heat.width;
  for (let y = 0; y < heat.height; y += 1) {
    const gy = (y + 0.5) * step - 0.5;
    const row0 = clamp(Math.floor(gy), 0, rows - 1);
    const row1 = Math.min(row0 + 1, rows - 1);
    const ty = clamp(gy - row0, 0, 1);
    for (let x = 0; x < width; x += 1) {
      const gx = (x + 0.5) * step - 0.5;
      const col0 = clamp(Math.floor(gx), 0, cols - 1);
      const col1 = Math.min(col0 + 1, cols - 1);
      const tx = clamp(gx - col0, 0, 1);
      const v00 = filled[row0 * cols + col0];
      const v01 = filled[row0 * cols + col1];
      const v10 = filled[row1 * cols + col0];
      const v11 = filled[row1 * cols + col1];
      let sum = 0;
      let weight = 0;
      let w = (1 - tx) * (1 - ty);
      if (v00 === v00) { sum += v00 * w; weight += w; }
      w = tx * (1 - ty);
      if (v01 === v01) { sum += v01 * w; weight += w; }
      w = (1 - tx) * ty;
      if (v10 === v10) { sum += v10 * w; weight += w; }
      w = tx * ty;
      if (v11 === v11) { sum += v11 * w; weight += w; }
      if (weight < 0.25) continue;
      const index = Math.round((sum / weight) * toLut);
      if (index < LUT_SIZE) pixels[y * width + x] = lut[index];
    }
  }
  heatCtx.putImageData(image, 0, 0);
}

/** Sets the grid drawn on the map (null: none) and paints it. */
export function showGrid(grid, { fast = false } = {}) {
  app.grid = grid;
  if (grid) paintHeat(grid, { fast });
  app.stamp += 1;
  requestRender();
}

/** Marching squares over cell centres; returns segments in world coordinates. */
function contourSegments(grid, threshold) {
  const { cols, rows, smooth } = grid;
  const [minX, minY, maxX, maxY] = app.data.meta.bounds;
  const cellW = (maxX - minX) / cols;
  const cellH = (maxY - minY) / rows;
  const value = (row, col) => {
    const v = smooth[row * cols + col];
    return Number.isNaN(v) ? Infinity : v;
  };
  const center = (row, col) => [minX + (col + 0.5) * cellW, minY + (row + 0.5) * cellH];
  const between = (pa, va, pb, vb) => {
    const t = Number.isFinite(va) && Number.isFinite(vb) ? clamp((threshold - va) / (vb - va), 0, 1) : 0.5;
    return [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t];
  };

  const segments = [];
  for (let row = 0; row < rows - 1; row += 1) {
    for (let col = 0; col < cols - 1; col += 1) {
      // Corners counter-clockwise: bottom-left, bottom-right, top-right, top-left.
      const corners = [
        [center(row, col), value(row, col)],
        [center(row, col + 1), value(row, col + 1)],
        [center(row + 1, col + 1), value(row + 1, col + 1)],
        [center(row + 1, col), value(row + 1, col)],
      ];
      const inside = corners.map(([, v]) => v <= threshold);
      const crossings = [];
      for (let k = 0; k < 4; k += 1) {
        const a = corners[k];
        const b = corners[(k + 1) % 4];
        if (inside[k] !== inside[(k + 1) % 4]) crossings.push(between(a[0], a[1], b[0], b[1]));
      }
      if (crossings.length === 2) segments.push(crossings);
      else if (crossings.length === 4) segments.push([crossings[0], crossings[1]], [crossings[2], crossings[3]]);
    }
  }
  return segments;
}

// --- Place names -------------------------------------------------------------------------

/** Place name: the nearby rail station if there is one (more telling than a bus stop), else the nearest stop. */
export function nearestStopName(point) {
  let best = null;
  let bestDistance = Infinity;
  let rail = null;
  let railDistance = Infinity;
  app.data.stations.forEach((station) => {
    const d = hypot(point, station.point);
    if (d < bestDistance) {
      bestDistance = d;
      best = station.name;
    }
    if (station.rail && d < railDistance) {
      railDistance = d;
      rail = station.name;
    }
  });
  return railDistance <= RAIL_NAME_RADIUS ? rail : best;
}

export function describePlace(point) {
  const stop = nearestStopName(point);
  const district = districtAt(point);
  return district ? `Near ${stop} (${district})` : `Near ${stop}`;
}

// --- View and rendering ----------------------------------------------------------

function buildPaths(data) {
  const [ox, oy] = app.offset;
  const ringPath = (path, ring) => {
    ring.forEach(([x, y], i) => (i ? path.lineTo(x - ox, y - oy) : path.moveTo(x - ox, y - oy)));
    path.closePath();
  };
  const polygonsPath = (polygons) => {
    const path = new Path2D();
    for (const polygon of polygons) for (const ring of polygon) ringPath(path, ring);
    return path;
  };
  const districtLines = new Path2D();
  for (const district of data.districts) for (const polygon of district.polygons) ringPath(districtLines, polygon[0]);

  const routes = new Map();
  for (const route of data.routes) {
    if (!routes.has(route.line)) {
      const info = data.lines[route.line];
      routes.set(route.line, { line: route.line, mode: info.mode, color: info.color, path: new Path2D() });
    }
    const { path } = routes.get(route.line);
    route.points.forEach(([x, y], i) => (i ? path.lineTo(x - ox, y - oy) : path.moveTo(x - ox, y - oy)));
  }
  // Drawn from the least to the most important: U-Bahn and S-Bahn on top.
  const order = ["ferry", "tram", "regional", "sbahn", "ubahn"];
  return {
    land: polygonsPath(data.districts.flatMap((district) => district.polygons)),
    // One path per polygon, filled "evenodd": islands (holes) stay land without overlapping water bodies cancelling out.
    water: data.water.map((polygon) => polygonsPath([polygon])),
    parks: data.parks.map((polygon) => polygonsPath([polygon])),
    districtLines,
    routes: [...routes.values()].sort((a, b) => order.indexOf(a.mode) - order.indexOf(b.mode)),
  };
}

export function project(point) {
  const { cx, cy, scale } = app.view;
  return [app.size.width / 2 + (point[0] - cx) * scale, app.size.height / 2 - (point[1] - cy) * scale];
}

export function unproject(x, y) {
  const { cx, cy, scale } = app.view;
  return [cx + (x - app.size.width / 2) / scale, cy - (y - app.size.height / 2) / scale];
}

export function fitView() {
  const [minX, minY, maxX, maxY] = app.data.meta.viewBounds;
  const { width, height } = app.size;
  const pad = width < 720 ? 12 : 40;
  const scale = Math.min((width - pad * 2) / (maxX - minX), (height - pad * 2) / (maxY - minY));
  app.view = { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, scale, fitScale: scale };
}

/** Brings a point into view if it is off screen. */
export function reveal(point) {
  const [x, y] = project(point);
  if (x < 0 || y < 0 || x > app.size.width || y > app.size.height) {
    [app.view.cx, app.view.cy] = point;
    requestRender();
  }
}

function zoomAt(factor, screenX, screenY) {
  const before = unproject(screenX, screenY);
  const { fitScale } = app.view;
  app.view.scale = clamp(app.view.scale * factor, fitScale * MIN_ZOOM_FACTOR, fitScale * MAX_ZOOM_FACTOR);
  const after = unproject(screenX, screenY);
  app.view.cx += before[0] - after[0];
  app.view.cy += before[1] - after[1];
  requestRender();
}

/** World coordinates (meters, shifted origin, y axis pointing north). */
function useWorldTransform() {
  const { cx, cy, scale } = app.view;
  const { width, height, dpr } = app.size;
  const [ox, oy] = app.offset;
  ctx.setTransform(dpr * scale, 0, 0, -dpr * scale, dpr * (width / 2 + (ox - cx) * scale), dpr * (height / 2 - (oy - cy) * scale));
}

function useScreenTransform() {
  const { dpr } = app.size;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawHaloText(text, x, y, { font, color, halo = theme().halo, width = 3.5 }) {
  ctx.font = font;
  ctx.lineJoin = "round";
  ctx.strokeStyle = halo;
  ctx.lineWidth = width;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function drawIsochrones() {
  if (!app.grid || !app.isochrones.length) return;
  const px = 1 / app.view.scale;
  const [ox, oy] = app.offset;
  const labels = [];
  const avoid = (app.page.markers?.() ?? []).map((marker) => project(marker.point));
  for (const threshold of [...app.isochrones].sort((a, b) => a - b)) {
    app.grid.contours[threshold] ??= contourSegments(app.grid, threshold);
    const segments = app.grid.contours[threshold];
    if (!segments.length) continue;
    useWorldTransform();
    const path = new Path2D();
    for (const [a, b] of segments) {
      path.moveTo(a[0] - ox, a[1] - oy);
      path.lineTo(b[0] - ox, b[1] - oy);
    }
    ctx.save();
    ctx.clip(app.paths.land, "evenodd");
    ctx.lineCap = "round";
    ctx.strokeStyle = theme().contourHalo;
    ctx.lineWidth = 4.5 * px;
    ctx.stroke(path);
    ctx.strokeStyle = theme().contour;
    ctx.lineWidth = (threshold >= 30 ? 2 : 1.4) * px;
    ctx.stroke(path);
    ctx.restore();

    // Label on the northernmost visible point of the curve, away from the markers and the labels already placed.
    const blocked = [...avoid, ...labels.map((label) => label.at)];
    const candidates = [];
    for (const [a, b] of segments) {
      const world = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const [x, y] = project(world);
      if (x < 60 || x > app.size.width - 60 || y < 24 || y > app.size.height - 24) continue;
      if (blocked.some(([ax, ay]) => Math.abs(x - ax) < 70 && y - ay > -60 && y - ay < 40)) continue;
      candidates.push({ world, at: [x, y] });
    }
    candidates.sort((p, q) => p.at[1] - q.at[1]);
    const best = candidates.find((candidate) => isOnLand(candidate.world));
    if (best) labels.push({ text: `${threshold} min`, at: best.at });
  }
  useScreenTransform();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const { text, at } of labels) {
    drawHaloText(text, at[0], at[1], { font: `600 12px ${FONT}`, color: theme().contour, width: 5 });
  }
}

function drawRoutes() {
  const px = 1 / app.view.scale;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const route of app.paths.routes) {
    // Lines switched off, or not running at this time of day (most U-Bahn lines at night), are faded.
    const enabled = app.modes.has(route.mode) && app.graph.activeLines.has(route.line);
    ctx.globalAlpha = enabled ? 1 : 0.15;
    ctx.strokeStyle = route.color;
    ctx.lineWidth = ROUTE_WIDTH[route.mode] * px;
    ctx.setLineDash(route.mode === "ferry" ? [6 * px, 5 * px] : []);
    ctx.stroke(route.path);
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

function drawStops() {
  const { stations } = app.data;
  const { stationMask } = app.graph;
  const colors = theme();
  const railMask = RAIL_MASK | modeBit("ferry");
  const visible = (x, y) => x > -50 && y > -20 && x < app.size.width + 50 && y < app.size.height + 20;
  // Everything drawn here can be hovered (see the pointermove handler).
  const drawn = [];
  if (app.modes.has("bus") && app.view.scale > app.view.fitScale * 1.6) {
    ctx.fillStyle = colors.busStop;
    stations.forEach((station, i) => {
      if (!(stationMask[i] & modeBit("bus")) || stationMask[i] & railMask) return;
      const [x, y] = project(station.point);
      if (!visible(x, y)) return;
      ctx.fillRect(x - 1, y - 1, 2, 2);
      drawn.push({ index: i, x, y, radius: 1.5 });
    });
  }
  const zoomed = app.view.scale > STOP_LABEL_SCALE;
  const radius = zoomed ? 3.2 : 2;
  const shown = [];
  stations.forEach((station, i) => {
    const mask = stationMask[i] & railMask & app.modeMask;
    if (!mask) return;
    // Tram stops only once zoomed in: there are hundreds of them.
    const major = mask & (modeBit("ubahn") | modeBit("sbahn") | modeBit("regional"));
    if (!major && !zoomed && app.view.scale < app.view.fitScale * 2) return;
    const [x, y] = project(station.point);
    if (!visible(x, y)) return;
    const r = major ? radius : radius * 0.75;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = colors.stopFill;
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = colors.stopStroke;
    ctx.stroke();
    shown.push({ station, x, y, major });
    drawn.push({ index: i, x, y, radius: r });
  });
  if (zoomed) {
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (const { station, x, y, major } of shown) {
      if (!major && app.view.scale < STOP_LABEL_SCALE * 2) continue;
      drawHaloText(station.name, x + 6, y, { font: `${major ? 500 : 400} 11.5px ${FONT}`, color: colors.text });
    }
  }
  app.drawnStops = drawn;
}

/** Ring around the hovered stop. */
function drawHover() {
  if (app.hover?.station == null) return;
  const [x, y] = project(app.data.stations[app.hover.station].point);
  ctx.beginPath();
  ctx.arc(x, y, 7, 0, Math.PI * 2);
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = theme().contour;
  ctx.stroke();
}

function drawDistrictNames() {
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const font = `400 ${app.view.scale > app.view.fitScale * 2 ? 12.5 : 10}px ${FONT}`;
  // Wide tracking on uppercase labels (ignored by browsers without canvas letterSpacing).
  ctx.letterSpacing = "1.5px";
  for (const district of app.data.districts) {
    const [x, y] = project(district.label);
    if (x < 0 || y < 0 || x > app.size.width || y > app.size.height) continue;
    drawHaloText(district.name.toUpperCase(), x, y, { font, color: theme().districtText, halo: theme().districtHalo });
  }
  ctx.letterSpacing = "0px";
}

/** A marker: hairline circle around a solid dot, with an optional square label above. */
export function drawMarker(point, { color, label = null, textColor = "#fff", ring = theme().markerRing, glyph = null }) {
  const [x, y] = project(point);
  ctx.beginPath();
  ctx.arc(x, y, 14, 0, Math.PI * 2);
  ctx.lineWidth = 1;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, glyph ? 8.5 : 6.5, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = ring;
  ctx.stroke();
  if (glyph) {
    // A letter inside the dot (people on the meeting page).
    ctx.font = `600 10px ${FONT}`;
    ctx.fillStyle = textColor;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(glyph, x, y + 0.5);
  }
  if (!label) return;
  ctx.font = `500 11px ${FONT}`;
  ctx.letterSpacing = "1.2px";
  const text = label.toUpperCase();
  const width = ctx.measureText(text).width + 16;
  const left = clamp(x - width / 2, 6, app.size.width - width - 6);
  const top = y - 40;
  ctx.fillStyle = color;
  ctx.fillRect(left, top, width, 21);
  ctx.fillStyle = textColor;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, left + width / 2, top + 11);
  ctx.letterSpacing = "0px";
}

/** The heatmap, with a soft edge along the city limits instead of a hard cut: drawn on a screen-sized layer, then
 * masked by a blurred city shape. Browsers without canvas filters get the plain (hard) mask. */
function drawHeat(colors) {
  const { width, height, dpr } = app.size;
  const layer = app.heatLayer;
  const w = Math.round(width * dpr);
  const h = Math.round(height * dpr);
  if (layer.width !== w || layer.height !== h) {
    layer.width = w;
    layer.height = h;
  }
  const layerCtx = layer.getContext("2d");
  layerCtx.setTransform(1, 0, 0, 1, 0, 0);
  layerCtx.clearRect(0, 0, w, h);
  const { cx, cy, scale } = app.view;
  const [ox, oy] = app.offset;
  layerCtx.setTransform(dpr * scale, 0, 0, -dpr * scale, dpr * (width / 2 + (ox - cx) * scale), dpr * (height / 2 - (oy - cy) * scale));
  layerCtx.imageSmoothingEnabled = true;
  layerCtx.imageSmoothingQuality = "high";
  const [minX, minY, maxX, maxY] = app.data.meta.bounds;
  // The image has its row 0 in the south: with the y axis flipped, it is drawn the right way up.
  layerCtx.drawImage(app.heatCanvas, minX - ox, minY - oy, maxX - minX, maxY - minY);
  layerCtx.globalCompositeOperation = "destination-in";
  layerCtx.filter = `blur(${HEAT_EDGE_BLUR * dpr}px)`;
  layerCtx.fillStyle = "#000";
  layerCtx.fill(app.paths.land, "evenodd");
  layerCtx.filter = "none";
  layerCtx.globalCompositeOperation = "source-over";

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = colors.heatAlpha;
  ctx.drawImage(layer, 0, 0);
  ctx.globalAlpha = 1;
}

function render() {
  app.frameRequested = false;
  if (!app.data || !app.graph) return;
  const { width, height, dpr } = app.size;
  const px = 1 / app.view.scale;
  const colors = theme();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = colors.background;
  ctx.fillRect(0, 0, width, height);

  useWorldTransform();
  ctx.fillStyle = colors.land;
  ctx.fill(app.paths.land, "evenodd");
  if (app.grid) drawHeat(colors);

  useWorldTransform();
  ctx.fillStyle = colors.park;
  for (const park of app.paths.parks) ctx.fill(park, "evenodd");
  ctx.fillStyle = colors.water;
  for (const water of app.paths.water) ctx.fill(water, "evenodd");
  ctx.strokeStyle = colors.districtLine;
  ctx.lineWidth = 1.1 * px;
  ctx.stroke(app.paths.districtLines);

  drawRoutes();
  drawIsochrones();
  useScreenTransform();
  drawDistrictNames();
  drawStops();
  drawHover();
  app.page.drawOverlay?.(colors);
  positionTooltip();
}

export function requestRender() {
  if (app.frameRequested) return;
  app.frameRequested = true;
  requestAnimationFrame(render);
}

function resize() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const first = !app.size.width;
  const ratio = app.size.width ? rect.width / app.size.width : 1;
  app.size = { width: rect.width, height: rect.height, dpr };
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  if (!app.data) return;
  if (first) {
    fitView();
  } else {
    app.view.scale *= ratio;
    app.view.fitScale *= ratio;
  }
  requestRender();
}

// --- Hover tooltips -------------------------------------------------------------------

/** The drawn stop under the cursor, rail stations first (a bus stop next to a station should not hide it). */
function stopAt(screen) {
  let best = null;
  let bestScore = Infinity;
  for (const stop of app.drawnStops) {
    const d = Math.hypot(screen[0] - stop.x, screen[1] - stop.y);
    if (d > stop.radius + HOVER_RADIUS) continue;
    const score = d - (stop.radius > 1.5 ? 4 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = stop.index;
    }
  }
  return best;
}

function setHover(target) {
  const same = app.hover && target && app.hover.station === target.station && (target.station != null || hypot(app.hover.screen, target.screen) < 6);
  if (same || (!app.hover && !target)) return;
  app.hover = target ? { ...target, stamp: -1 } : null;
  canvas.classList.toggle("over-stop", target?.station != null);
  requestRender();
}

/** Lines running at a station at the current time of day, as badges (rail first; buses as a count). */
export function stationLineBadges(index) {
  const lines = document.createElement("div");
  lines.className = "tooltip-lines";
  const here = app.graph.stationLines[index];
  const rail = here.filter((l) => app.data.lines[l].mode !== "bus");
  const bus = here.filter((l) => app.data.lines[l].mode === "bus");
  const listed = rail.length ? rail : bus.slice(0, 8);
  const seen = new Set();
  for (const l of listed) {
    const key = app.data.lines[l].name;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.append(lineBadge(l));
  }
  const more = rail.length ? bus.length : bus.length - listed.length;
  if (more > 0) {
    const extra = document.createElement("span");
    extra.className = "tooltip-more";
    extra.textContent = rail.length ? `+ ${more} bus line${more > 1 ? "s" : ""}` : `+ ${more} more`;
    lines.append(extra);
  }
  if (!here.length) {
    const none = document.createElement("span");
    none.className = "tooltip-more";
    none.textContent = "No service at this time";
    lines.append(none);
  }
  return lines;
}

/** Keeps the tooltip on its target while the map moves, and its figures in step with the latest computation. */
function positionTooltip() {
  if (!app.hover || app.drag) {
    tooltip.hidden = true;
    return;
  }
  if (app.hover.stamp !== app.stamp) {
    const content = app.page.hoverContent?.(app.hover);
    app.hover.stamp = app.stamp;
    app.hover.empty = !content;
    if (content) tooltip.replaceChildren(...content);
  }
  if (app.hover.empty) {
    tooltip.hidden = true;
    return;
  }
  const anchor = app.hover.station != null ? app.data.stations[app.hover.station].point : app.hover.world;
  const [x, y] = project(anchor);
  tooltip.hidden = false;
  // Above the target, flipped below near the top edge, and kept inside the map horizontally.
  const width = tooltip.offsetWidth;
  const height = tooltip.offsetHeight;
  const left = clamp(x - width / 2, 8, app.size.width - width - 8);
  const top = y - height - 14 < 8 ? y + 14 : y - height - 14;
  tooltip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

// --- Map interactions --------------------------------------------------------------

function eventPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return [event.clientX - rect.left, event.clientY - rect.top];
}

function pointerKind(event) {
  return event.pointerType === "mouse" ? "mouse" : "touch";
}

function markerAt(screen, kind = "mouse") {
  // Last drawn on top: look from the end.
  const markers = app.page.markers?.() ?? [];
  for (let i = markers.length - 1; i >= 0; i -= 1) {
    if (hypot(screen, project(markers[i].point)) <= MARKER_HIT_RADIUS[kind]) return markers[i].key;
  }
  return null;
}

function setupMapInteractions() {
  canvas.addEventListener("pointerleave", () => setHover(null));

  canvas.addEventListener("pointerdown", (event) => {
    if (!app.graph) return;
    const screen = eventPoint(event);
    app.pointers.set(event.pointerId, screen);
    canvas.setPointerCapture(event.pointerId);
    if (app.pointers.size === 2) {
      const [a, b] = [...app.pointers.values()];
      app.drag = { kind: "pinch", distance: hypot(a, b) };
      return;
    }
    const pointer = pointerKind(event);
    const marker = markerAt(screen, pointer);
    // Marker keys can be 0 (first person on the meeting page): compare with null, not truthiness.
    app.drag = marker != null
      ? { kind: "marker", marker, start: screen }
      : { kind: "pan", start: screen, last: screen, moved: false, slop: CLICK_SLOP[pointer] };
    if (marker != null) app.page.grabMarker?.(marker);
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!app.graph) return;
    const screen = eventPoint(event);
    if (app.pointers.has(event.pointerId)) app.pointers.set(event.pointerId, screen);
    const drag = app.drag;

    if (!drag) {
      const marker = markerAt(screen);
      canvas.classList.toggle("over-marker", marker != null);
      if (marker != null || event.pointerType !== "mouse") {
        setHover(null);
        return;
      }
      const station = stopAt(screen);
      if (station != null) setHover({ station, screen });
      else if (app.page.hoverAnywhere) setHover({ station: null, world: unproject(...screen), screen });
      else setHover(null);
      return;
    }
    if (drag.kind === "pinch" && app.pointers.size === 2) {
      const [a, b] = [...app.pointers.values()];
      const distance = hypot(a, b);
      zoomAt(distance / drag.distance, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      drag.distance = distance;
    } else if (drag.kind === "marker") {
      app.page.dragMarker?.(drag.marker, unproject(...screen));
    } else if (drag.kind === "pan") {
      if (!drag.moved && hypot(screen, drag.start) < drag.slop) return;
      drag.moved = true;
      canvas.classList.add("panning");
      app.view.cx -= (screen[0] - drag.last[0]) / app.view.scale;
      app.view.cy += (screen[1] - drag.last[1]) / app.view.scale;
      drag.last = screen;
      requestRender();
    }
  });

  const endPointer = (event) => {
    app.pointers.delete(event.pointerId);
    const drag = app.drag;
    if (!drag) return;
    if (drag.kind === "pinch") {
      if (!app.pointers.size) app.drag = null;
      return;
    }
    app.drag = null;
    canvas.classList.remove("panning");
    if (event.type === "pointercancel") return;
    if (drag.kind === "pan" && !drag.moved) {
      app.page.click?.(unproject(...eventPoint(event)));
    } else if (drag.kind === "marker") {
      app.page.dropMarker?.(drag.marker);
    }
    requestRender();
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);

  canvas.addEventListener("dblclick", (event) => {
    const marker = markerAt(eventPoint(event));
    if (marker != null) app.page.removeMarker?.(marker);
  });
  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const [x, y] = eventPoint(event);
      zoomAt(Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0018)), x, y);
    },
    { passive: false },
  );
}

// --- Shared controls ------------------------------------------------------------------

function updateLegend() {
  const stops = PALETTES[app.palette].map(([t, [r, g, b]]) => `rgb(${r}, ${g}, ${b}) ${Math.round(t * 100)}%`);
  $("legendBar").style.background = `linear-gradient(90deg, ${stops.join(", ")})`;
  $("legendMid").textContent = `${Math.round(app.maxMinutes / 2)} min`;
  $("legendMax").textContent = `${app.maxMinutes} min`;
  $("maxValue").textContent = `${app.maxMinutes} min`;
}

function setModes(modes) {
  app.modes = new Set(modes);
  app.modeMask = [...app.modes].reduce((mask, mode) => mask | modeBit(mode), 0);
  for (const input of $("modeToggles").querySelectorAll("input")) input.checked = app.modes.has(input.value);
}

function pressButtons(groupId, attribute, value) {
  for (const button of $(groupId).querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset[attribute] === value));
  }
}

function setTravel(travel) {
  app.travel = travel === "bike" ? "bike" : "walk";
  pressButtons("travelToggle", "travel", app.travel);
}

/** Switches the time of day (loading its timetable on first use) and recomputes. */
async function switchPeriod(period) {
  const group = $("periodToggle");
  group.setAttribute("aria-busy", "true");
  try {
    await loadPeriod(period);
    pressButtons("periodToggle", "period", period);
    app.page.recompute();
    app.page.paramsChanged();
  } catch (error) {
    console.error(error);
    toast("Could not load that timetable.");
  } finally {
    group.removeAttribute("aria-busy");
  }
}

/** Shared settings in the URL: time of day, travel, modes, scale, contours. */
export function writeSharedParams(params) {
  if (app.period !== "day") params.set("time", app.period);
  if (app.travel !== "walk") params.set("by", app.travel);
  const modes = MODES.filter((mode) => app.modes.has(mode));
  if (modes.join(",") !== DEFAULT_MODES.join(",")) params.set("modes", modes.join(",") || "none");
  if (app.maxMinutes !== DEFAULT_MAX) params.set("max", String(app.maxMinutes));
  const iso = [...app.isochrones].sort((a, b) => a - b).join(",");
  if (iso !== DEFAULT_ISOCHRONES.join(",")) params.set("iso", iso || "0");
}

export function replaceUrl(params) {
  const query = params.toString().replaceAll("%2C", ",");
  history.replaceState(null, "", query ? `?${query}` : location.pathname);
}

function readSharedParams(params) {
  setModes(params.has("modes") ? params.get("modes").split(",").filter((mode) => MODES.includes(mode)) : DEFAULT_MODES);
  setTravel(params.get("by"));
  const max = Number(params.get("max"));
  if (max >= 20 && max <= 120) app.maxMinutes = max;
  $("maxRange").value = String(app.maxMinutes);
  if (params.has("iso")) {
    app.isochrones = params
      .get("iso")
      .split(",")
      .map(Number)
      .filter((value) => ISOCHRONE_OPTIONS.includes(value));
  }
  for (const input of $("isoToggles").querySelectorAll("input")) input.checked = app.isochrones.includes(Number(input.value));
  updateLegend();
  const period = params.get("time");
  return PERIODS.includes(period) ? period : "day";
}

function setupControls() {
  $("zoomIn").addEventListener("click", () => zoomAt(1.4, app.size.width / 2, app.size.height / 2));
  $("zoomOut").addEventListener("click", () => zoomAt(1 / 1.4, app.size.width / 2, app.size.height / 2));
  $("recenter").addEventListener("click", () => {
    fitView();
    requestRender();
  });
  // iPhones cannot put a page element in fullscreen: hide the button.
  $("fullscreen").hidden = !document.fullscreenEnabled;
  $("fullscreen").addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else stage.requestFullscreen?.();
  });

  $("modeToggles").addEventListener("change", () => {
    setModes([...$("modeToggles").querySelectorAll("input:checked")].map((input) => input.value));
    app.page.recompute();
    app.page.paramsChanged();
  });

  $("periodToggle").addEventListener("click", (event) => {
    const period = event.target.closest("button")?.dataset.period;
    if (period && period !== app.period) switchPeriod(period);
  });

  $("travelToggle").addEventListener("click", (event) => {
    const travel = event.target.closest("button")?.dataset.travel;
    if (!travel || travel === app.travel) return;
    setTravel(travel);
    app.page.recompute();
    app.page.paramsChanged();
  });

  $("isoToggles").addEventListener("change", () => {
    app.isochrones = [...$("isoToggles").querySelectorAll("input:checked")].map((input) => Number(input.value));
    requestRender();
    app.page.paramsChanged();
  });

  $("maxRange").addEventListener("input", (event) => {
    app.maxMinutes = Number(event.target.value);
    updateLegend();
    if (app.grid) paintHeat(app.grid);
    requestRender();
    app.page.paramsChanged();
  });

  // Colour-blind palette: a viewer preference, remembered on this device.
  const paletteToggle = $("paletteToggle");
  paletteToggle.checked = app.palette === "colorblind";
  paletteToggle.addEventListener("change", () => {
    app.palette = paletteToggle.checked ? "colorblind" : "standard";
    localStorage.setItem("palette", app.palette);
    updateLegend();
    if (app.grid) paintHeat(app.grid);
    requestRender();
  });

  // Dark mode: follows the system until the visitor picks one (the inline script in the page head applies it before
  // the first paint).
  const themeToggle = $("themeToggle");
  const applyTheme = (name) => {
    document.documentElement.dataset.theme = name;
    const dark = name === "dark";
    themeToggle.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
    themeToggle.title = themeToggle.getAttribute("aria-label");
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0e0e0e" : "#ffffff");
    requestRender();
  };
  themeToggle.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    localStorage.setItem("theme", next);
    applyTheme(next);
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (event) => {
    if (!localStorage.getItem("theme")) applyTheme(event.matches ? "dark" : "light");
  });
  applyTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  // Canvas text uses Outfit too: redraw once the web font has arrived.
  document.fonts?.ready.then(requestRender);

  $("share").addEventListener("click", async () => {
    const url = location.href;
    if (navigator.share) {
      try {
        await navigator.share({ title: document.title, url });
        return;
      } catch {
        /* share cancelled: fall back to copying */
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied!");
    } catch {
      toast(url);
    }
  });
}

/** The current settings in words, for the panel ("by day, walking, every mode"). */
export function settingsSummary() {
  const enabled = MODES.filter((mode) => app.modes.has(mode)).map((mode) => MODE_LABELS[mode]);
  const using = enabled.length === MODES.length ? "every mode" : enabled.length ? enabled.join(", ") : "no transit";
  return `${PERIOD_LABELS[app.period]}, ${app.travel === "bike" ? "cycling" : "walking"} to the stops, ${using}`;
}

// --- Search (Photon, OpenStreetMap data) ---------------------------------------------

function normalize(text) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Rail and ferry stations whose name contains every typed word. */
function searchStops(query) {
  const words = normalize(query).split(" ");
  return app.data.stations
    .map((station, index) => ({ station, index }))
    .filter(({ station }) => station.rail && words.every((word) => normalize(station.name).includes(word)))
    .slice(0, 3)
    .map(({ station, index }) => ({
      label: station.name,
      context: `Station · ${[...new Set(app.graph.stationLines[index].filter((l) => app.data.lines[l].mode !== "bus").map((l) => app.data.lines[l].name))].join(", ")}`,
      point: station.point,
    }));
}

function photonLabel(properties) {
  const street = [properties.street, properties.housenumber].filter(Boolean).join(" ");
  const label = properties.name || street || properties.district || properties.city;
  const context = [properties.name && street, properties.postcode, properties.district || properties.locality, properties.city]
    .filter(Boolean)
    .filter((part, i, all) => part !== label && all.indexOf(part) === i)
    .join(", ");
  return { label, context };
}

let searchController = null;

async function searchPlaces(query) {
  const stops = searchStops(query);
  searchController?.abort();
  searchController = new AbortController();
  const [south, west, north, east] = CITY.searchBbox;
  const params = new URLSearchParams({
    q: query,
    limit: "8",
    lat: String(CITY.defaultFrom.lat),
    lon: String(CITY.defaultFrom.lon),
    bbox: `${west},${south},${east},${north}`,
    lang: "en",
  });
  let payload = { features: [] };
  try {
    const response = await fetch(`${GEOCODER_URL}?${params}`, { signal: searchController.signal });
    payload = await response.json();
  } catch (error) {
    if (error.name === "AbortError" || !stops.length) throw error;
  }
  const seen = new Set();
  const addresses = payload.features
    .map((feature) => {
      const [lon, lat] = feature.geometry.coordinates;
      return { ...photonLabel(feature.properties), point: toWorld(lat, lon) };
    })
    .filter((result) => {
      const key = `${result.label}|${result.context}`;
      if (!result.label || seen.has(key)) return false;
      seen.add(key);
      return isOnLand(result.point);
    });
  return [...stops, ...addresses].slice(0, 7);
}

/** Address/station search box: `choose(result)` receives { label, context, point }. */
export function setupSearch(form, input, list, choose) {
  let timer = null;
  const show = (results) => {
    list.replaceChildren(
      ...results.map((result) => {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = result.label;
        const context = document.createElement("small");
        context.textContent = result.context;
        button.append(context);
        button.addEventListener("click", () => {
          list.hidden = true;
          choose(result);
        });
        item.append(button);
        return item;
      }),
    );
    list.hidden = !results.length;
  };
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const query = input.value.trim();
    if (query.length < 3 || !app.graph) {
      list.hidden = true;
      return;
    }
    timer = setTimeout(async () => {
      try {
        show(await searchPlaces(query));
      } catch (error) {
        if (error.name !== "AbortError") list.hidden = true;
      }
    }, 300);
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = input.value.trim();
    if (query.length < 3 || !app.graph) return;
    try {
      const results = await searchPlaces(query);
      list.hidden = true;
      if (results.length) choose(results[0]);
      else toast("Address not found in Berlin.");
    } catch (error) {
      if (error.name !== "AbortError") toast("The address search is not responding.");
    }
  });
  document.addEventListener("click", (event) => {
    if (!form.contains(event.target)) list.hidden = true;
  });
}

// --- Start -----------------------------------------------------------------------------

export async function start(page) {
  app.page = page;
  setupMapInteractions();
  setupControls();
  resize();
  const response = await fetch(BASE_URL);
  app.data = await response.json();
  app.offset = [app.data.meta.bounds[0], app.data.meta.bounds[1]];
  app.rivers = indexRivers(app.data.rivers);
  app.paths = buildPaths(app.data);
  const period = readSharedParams(new URLSearchParams(location.search));
  await loadPeriod(period);
  pressButtons("periodToggle", "period", period);
  app.size.width = 0;
  resize();
  page.start();
  new ResizeObserver(resize).observe(canvas);
}
