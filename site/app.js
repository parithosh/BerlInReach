// Berlin transit time map: the city coloured by how long it takes to get anywhere by public transport.
// Adapted from "À portée de tram" by Camille Roux (https://github.com/camilleroux/montpellier-temps-transport, MIT).
// The page describes the city in the #city-config JSON block; the network comes from data/<slug>.json (build_data.py).

const CITY = JSON.parse(document.getElementById("city-config").textContent);
const DATA_URL = new URL(`./data/${CITY.slug}.json?v=${CITY.dataVersion}`, import.meta.url);
const GEOCODER_URL = "https://photon.komoot.io/api/";

const DEFAULT_FROM = CITY.defaultFrom;
const MODES = ["ubahn", "sbahn", "tram", "regional", "bus", "ferry"];
const MODE_LABELS = {
  ubahn: "U-Bahn",
  sbahn: "S-Bahn",
  tram: "Tram",
  regional: "Regional train",
  bus: "Bus",
  ferry: "Ferry",
};
const RAIL_MODES = ["ubahn", "sbahn", "tram", "regional"];
const DEFAULT_MODES = [...MODES];
// Berlin is large: an hour covers most of the city, and the 45-minute line shows where it starts to take long.
const DEFAULT_MAX = 60;
const ISOCHRONE_OPTIONS = [15, 30, 45, 60];
const DEFAULT_ISOCHRONES = [15, 30, 45];
const REACH_MINUTES = 30;
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

// Monochrome base (after ethlabs.org): white, near-black ink, hairlines, one red accent for the destination.
const FONT = '"Outfit", system-ui, -apple-system, "Segoe UI", sans-serif';
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
    from: "#111111",
    fromText: "#ffffff",
    to: "#e5392b",
    toText: "#ffffff",
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
    from: "#ededed",
    fromText: "#0e0e0e",
    to: "#e5392b",
    toText: "#ffffff",
    markerRing: "#0e0e0e",
    heatAlpha: 0.68,
  },
};
const ROUTE_WIDTH = { ubahn: 3, sbahn: 3, regional: 2.2, tram: 1.8, ferry: 1.8, bus: 1.2 };

const $ = (id) => document.getElementById(id);
const canvas = $("mapCanvas");
const ctx = canvas.getContext("2d");
const stage = $("mapStage");

const app = {
  data: null,
  graph: null,
  cells: null,
  paths: null,
  rivers: new Map(),
  offset: [0, 0],
  view: { cx: 0, cy: 0, scale: 1, fitScale: 1 },
  size: { width: 0, height: 0, dpr: 1 },
  from: null, // { point, label }
  to: null, // { point, label }
  modes: new Set(DEFAULT_MODES),
  modeMask: 0,
  maxMinutes: DEFAULT_MAX,
  isochrones: [...DEFAULT_ISOCHRONES],
  heatFrom: "from", // the heatmap starts from the departure or the arrival
  solution: null, // shortest paths from the departure (panel, itinerary)
  heatSolution: null, // shortest paths from the point the heatmap starts from
  grid: null,
  heatCanvas: document.createElement("canvas"),
  heatLayer: document.createElement("canvas"), // screen-sized, for the soft edge along the city limits
  // The colour-blind palette is the default; visitors who switch it off keep the standard one on this device.
  palette: localStorage.getItem("palette") === "standard" ? "standard" : "colorblind",
  hover: null, // { index, x, y } of the stop under the mouse
  drawnStops: [], // stops drawn in the last frame, in screen coordinates (hover targets)
  drag: null,
  pointers: new Map(),
  frameRequested: false,
};

/** Current map colours: the page theme is set on <html data-theme> (inline script in the page head). */
function theme() {
  return THEMES[document.documentElement.dataset.theme === "dark" ? "dark" : "light"];
}

// --- Small helpers -------------------------------------------------------------

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const hypot = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const modeBit = (mode) => 1 << MODES.indexOf(mode);

function formatMinutes(minutes) {
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

const smoothstep = (t) => t * t * (3 - 2 * t);

function metersPerDegree() {
  const lat = 111320;
  return { lat, lon: lat * Math.cos((app.data.meta.lat0 * Math.PI) / 180) };
}

function toWorld(lat, lon) {
  const m = metersPerDegree();
  return [lon * m.lon, lat * m.lat];
}

function toLatLon(point) {
  const m = metersPerDegree();
  return { lat: point[1] / m.lat, lon: point[0] / m.lon };
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

/** Walking distance in meters: straight, or through a bridge; infinite without a bridge within reach. */
function walkMeters(a, b) {
  const straight = hypot(a, b);
  if (!crossesRiver(a, b)) return straight;
  const limit = app.data.meta.maxBridgeWalkMeters;
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

function isOnLand(point) {
  if (app.data.water.some((polygon) => pointInPolygon(point, polygon))) return false;
  return app.data.districts.some((district) => district.polygons.some((polygon) => pointInPolygon(point, polygon)));
}

function districtAt(point) {
  return app.data.districts.find((district) => district.polygons.some((polygon) => pointInPolygon(point, polygon)))?.name;
}

// --- Network graph --------------------------------------------------------------
// Nodes 0..S-1 are (station, line) states: on the platform or aboard a line. Nodes S..S+N-1 are the stations
// themselves, at street level. Rides link states; alighting/boarding link a state and its station; walks link
// nearby stations.

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

function prepareGraph(data) {
  const { meta, lines, stations } = data;
  const stateCount = data.states.length / 3;
  const nodeCount = stateCount + stations.length;
  const station = new Int32Array(stateCount);
  const line = new Int32Array(stateCount);
  const wait = new Float32Array(stateCount);
  const access = new Float32Array(stateCount);
  const modeOf = new Uint8Array(stateCount);
  const lineMode = lines.map((info) => modeBit(info.mode));
  for (let s = 0; s < stateCount; s += 1) {
    station[s] = data.states[3 * s];
    line[s] = data.states[3 * s + 1];
    wait[s] = data.states[3 * s + 2];
    access[s] = meta.modeAccess[lines[line[s]].mode];
    modeOf[s] = lineMode[line[s]];
  }
  const stationMask = new Uint8Array(stations.length);
  stations.forEach((info, i) => {
    for (const l of info.lines) stationMask[i] |= lineMode[l];
  });

  // Edge list, then compressed rows.
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
  for (let i = 0; i < data.rides.length; i += 3) add(data.rides[i], data.rides[i + 1], data.rides[i + 2]);
  for (let i = 0; i < data.walks.length; i += 3) {
    const minutes = data.walks[i + 2] / meta.walkMetersPerMinute;
    add(stateCount + data.walks[i], stateCount + data.walks[i + 1], minutes);
    add(stateCount + data.walks[i + 1], stateCount + data.walks[i], minutes);
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
  return { stateCount, nodeCount, offsets, targets, weights, station, line, wait, access, modeOf, stationMask };
}

function prepareCells(data) {
  const { cells, meta } = data;
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

function walkMinutes(meters) {
  return meters / app.data.meta.walkMetersPerMinute;
}

function stationUsable(index) {
  return (app.graph.stationMask[index] & app.modeMask) !== 0;
}

/** Stations reachable on foot from a point: the nearest ones, plus the nearest few of each enabled mode. */
function originSeeds(point) {
  const { meta, stations } = app.data;
  const { stationMask } = app.graph;
  const candidates = [];
  for (let i = 0; i < stations.length; i += 1) {
    if (stationMask[i] & app.modeMask) candidates.push([hypot(point, stations[i].point), i]);
  }
  candidates.sort((a, b) => a[0] - b[0]);
  const perMode = new Map();
  const seeds = [];
  for (const [straight, i] of candidates) {
    if (seeds.length >= meta.originStationCount && straight > meta.originMaxMeters) break;
    const here = stationMask[i] & app.modeMask;
    let wanted = seeds.length < meta.originStationCount;
    for (const mode of MODES) {
      const bit = modeBit(mode);
      if (here & bit && (perMode.get(bit) ?? 0) < meta.originPerMode) wanted = true;
    }
    if (!wanted) continue;
    seeds.push(i);
    for (const mode of MODES) {
      const bit = modeBit(mode);
      if (here & bit) perMode.set(bit, (perMode.get(bit) ?? 0) + 1);
    }
  }
  return seeds
    .map((i) => ({ index: i, walk: walkMinutes(walkMeters(point, stations[i].point)) }))
    .filter((seed) => Number.isFinite(seed.walk));
}

/** Shortest paths from a point: arrival time at each node, predecessors, and street-level time at each station. */
function solveFrom(point) {
  const { graph, data } = app;
  const { stateCount, nodeCount } = graph;
  const dist = new Float64Array(nodeCount).fill(Infinity);
  const prev = new Int32Array(nodeCount).fill(-1);
  const seedWalk = new Float64Array(nodeCount);
  const heap = new MinHeap();
  const mask = app.modeMask;

  for (const seed of originSeeds(point)) {
    const node = stateCount + seed.index;
    if (seed.walk < dist[node]) {
      dist[node] = seed.walk;
      seedWalk[node] = seed.walk;
      heap.push(seed.walk, node);
    }
    for (let e = graph.offsets[node]; e < graph.offsets[node + 1]; e += 1) {
      const state = graph.targets[e];
      if (state >= stateCount || !(graph.modeOf[state] & mask)) continue;
      const walk = seed.walk + graph.access[state];
      const time = walk + graph.wait[state];
      if (time < dist[state]) {
        dist[state] = time;
        seedWalk[state] = walk;
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
  return { point, dist, prev, seedWalk, stationTime, stationBest };
}

/** Best time to any point: walking straight there, or through the most favourable station. */
function travelTo(solution, point) {
  const direct = walkMinutes(walkMeters(solution.point, point));
  let best = { minutes: direct, station: -1, walk: direct };
  app.data.stations.forEach((station, index) => {
    const arrival = solution.stationTime[index];
    // The real walking distance (bridges) is costlier: only for a station that can improve the trip.
    if (!Number.isFinite(arrival) || arrival + walkMinutes(hypot(station.point, point)) >= best.minutes) return;
    const walk = walkMinutes(walkMeters(station.point, point));
    if (arrival + walk < best.minutes) best = { minutes: arrival + walk, station: index, walk };
  });
  return best;
}

function lineLabel(lineIndex) {
  const info = app.data.lines[lineIndex];
  // U1, S41, RE1 already say what they are; trams, buses and ferries are just numbers (M10, 100, F10).
  return ["ubahn", "sbahn", "regional"].includes(info.mode) ? info.name : `${MODE_LABELS[info.mode]} ${info.name}`;
}

/** Rebuilds the itinerary (walks, lines, changes) to a point. */
function buildItinerary(solution, point) {
  const { graph, data } = app;
  const { stateCount } = graph;
  const result = travelTo(solution, point);
  if (result.station === -1) {
    return { minutes: result.minutes, steps: [{ kind: "walk", text: "Walk all the way", minutes: result.minutes }] };
  }

  const chain = [];
  for (let node = solution.stationBest[result.station]; node !== -1; node = solution.prev[node]) chain.push(node);
  chain.reverse();

  const stationOf = (node) => (node >= stateCount ? node - stateCount : graph.station[node]);
  const name = (node) => data.stations[stationOf(node)].name;
  const steps = [];
  let walked = solution.seedWalk[chain[0]];
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
      steps.push({ kind: "walk", text: `Walk to ${name(node)}`, minutes: walked });
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
  // Leaving the platform is counted with the final walk.
  const exit = graph.access[chain[chain.length - 1]];
  steps.push({ kind: "walk", text: "Walk to destination", minutes: result.walk + exit });
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

function computeGrid(solution) {
  const { meta } = app.data;
  const cells = app.cells;
  const { gridCols: cols, gridRows: rows } = meta;
  const times = new Float32Array(cols * rows).fill(NaN);
  const origin = solution.point;
  for (let c = 0; c < cells.count; c += 1) {
    // Cell access lists already hold real walking distances (build_data.py); the direct walk is computed here.
    let best = Infinity;
    for (let k = cells.offsets[c]; k < cells.offsets[c + 1]; k += 1) {
      const time = solution.stationTime[cells.stations[k]] + walkMinutes(cells.meters[k]);
      if (time < best) best = time;
    }
    const point = [cells.points[2 * c], cells.points[2 * c + 1]];
    if (walkMinutes(hypot(origin, point)) < best) best = Math.min(best, walkMinutes(walkMeters(origin, point)));
    // A cell cut off behind a river, with no stop on its side: very far, without an infinity that would spoil smoothing.
    times[cells.index[c]] = Math.min(best, 180);
  }
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
function paintHeat(grid, { fast = false } = {}) {
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
      routes.set(route.line, { mode: info.mode, color: info.color, path: new Path2D() });
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

function project(point) {
  const { cx, cy, scale } = app.view;
  return [app.size.width / 2 + (point[0] - cx) * scale, app.size.height / 2 - (point[1] - cy) * scale];
}

function unproject(x, y) {
  const { cx, cy, scale } = app.view;
  return [cx + (x - app.size.width / 2) / scale, cy - (y - app.size.height / 2) / scale];
}

function fitView() {
  const [minX, minY, maxX, maxY] = app.data.meta.viewBounds;
  const { width, height } = app.size;
  const pad = width < 720 ? 12 : 40;
  const scale = Math.min((width - pad * 2) / (maxX - minX), (height - pad * 2) / (maxY - minY));
  app.view = { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, scale, fitScale: scale };
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
    const avoid = [app.from, app.to].filter(Boolean).map((place) => project(place.point));
    avoid.push(...labels.map((label) => label.at));
    const candidates = [];
    for (const [a, b] of segments) {
      const world = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const [x, y] = project(world);
      if (x < 60 || x > app.size.width - 60 || y < 24 || y > app.size.height - 24) continue;
      if (avoid.some(([ax, ay]) => Math.abs(x - ax) < 70 && y - ay > -60 && y - ay < 40)) continue;
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
    const enabled = app.modes.has(route.mode);
    ctx.globalAlpha = enabled ? 1 : 0.18;
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
  const railMask = RAIL_MODES.reduce((mask, mode) => mask | modeBit(mode), 0) | modeBit("ferry");
  const visible = (x, y) => x > -50 && y > -20 && x < app.size.width + 50 && y < app.size.height + 20;
  // Everything drawn here can be hovered (see the pointermove handler).
  const drawn = [];
  if (app.modes.has("bus") && app.view.scale > app.view.fitScale * 1.6) {
    ctx.fillStyle = colors.busStop;
    stations.forEach((station, i) => {
      if (stationMask[i] & railMask) return;
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
  if (!app.hover) return;
  const [x, y] = project(app.data.stations[app.hover.index].point);
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
  // Wide tracking on uppercase labels, the ethlabs.org signature (ignored by browsers without canvas letterSpacing).
  ctx.letterSpacing = "1.5px";
  for (const district of app.data.districts) {
    const [x, y] = project(district.label);
    if (x < 0 || y < 0 || x > app.size.width || y > app.size.height) continue;
    drawHaloText(district.name.toUpperCase(), x, y, { font, color: theme().districtText, halo: theme().districtHalo });
  }
  ctx.letterSpacing = "0px";
}

function drawMarker(point, color, label, textColor, ringColor) {
  const [x, y] = project(point);
  // A hairline circle around a solid dot.
  ctx.beginPath();
  ctx.arc(x, y, 14, 0, Math.PI * 2);
  ctx.lineWidth = 1;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, 6.5, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = ringColor;
  ctx.stroke();
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
  if (!app.data) return;
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
  if (app.to) {
    const minutes = app.solution ? formatMinutes(travelTo(app.solution, app.to.point).minutes) : null;
    drawMarker(app.to.point, colors.to, app.heatFrom === "to" ? `Arrival · ${minutes}` : minutes, colors.toText, colors.markerRing);
  }
  if (app.from) drawMarker(app.from.point, colors.from, "Start", colors.fromText, colors.markerRing);
  positionTooltip();
}

function requestRender() {
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

// --- State, panel and URL ----------------------------------------------------------

/** Place name: the nearby rail station if there is one (more telling than a bus stop), else the nearest stop. */
function nearestStopName(point) {
  const { stationMask } = app.graph;
  const railMask = RAIL_MODES.reduce((mask, mode) => mask | modeBit(mode), 0);
  let best = null;
  let bestDistance = Infinity;
  let rail = null;
  let railDistance = Infinity;
  app.data.stations.forEach((station, i) => {
    const d = hypot(point, station.point);
    if (d < bestDistance) {
      bestDistance = d;
      best = station.name;
    }
    if (stationMask[i] & railMask && d < railDistance) {
      railDistance = d;
      rail = station.name;
    }
  });
  return railDistance <= RAIL_NAME_RADIUS ? rail : best;
}

function describePlace(point) {
  const stop = nearestStopName(point);
  const district = districtAt(point);
  return district ? `Near ${stop} (${district})` : `Near ${stop}`;
}

function heatSource() {
  return app.heatFrom === "to" && app.to ? app.to : app.from;
}

function recompute({ fast = false } = {}) {
  if (!app.from) return;
  app.solution = solveFrom(app.from.point);
  app.heatSolution = heatSource() === app.from ? app.solution : solveFrom(app.to.point);
  app.grid = computeGrid(app.heatSolution);
  paintHeat(app.grid, { fast });
  updatePanel();
  requestRender();
}

function setFrom(point, label = null, { quiet = false, fast = false } = {}) {
  if (!isOnLand(point)) return false;
  app.from = { point, label: label || describePlace(point) };
  recompute({ fast });
  if (!quiet) syncUrl();
  return true;
}

function setTo(point, label = null, { quiet = false, fast = false } = {}) {
  if (!isOnLand(point)) return false;
  app.to = { point, label: label || describePlace(point) };
  if (app.heatFrom === "to") {
    recompute({ fast });
  } else {
    updatePanel();
    requestRender();
  }
  if (!quiet) syncUrl();
  return true;
}

function removeTo() {
  app.to = null;
  setHeatFrom("from");
  syncUrl();
}

function setHeatFrom(source) {
  app.heatFrom = source === "to" && app.to ? "to" : "from";
  for (const button of $("heatFrom").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.source === app.heatFrom));
  }
  recompute();
}

function lineBadge(lineIndex) {
  const info = app.data.lines[lineIndex];
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = info.name;
  badge.style.background = info.color;
  badge.style.color = info.text;
  badge.title = lineLabel(lineIndex);
  return badge;
}

function updatePanel() {
  $("tripFrom").textContent = app.from?.label ?? "—";
  const result = $("tripResult");
  if (!app.to || !app.solution) {
    result.hidden = true;
    $("tripHint").hidden = false;
  } else {
    const itinerary = buildItinerary(app.solution, app.to.point);
    result.hidden = false;
    $("tripHint").hidden = true;
    $("tripTo").textContent = app.to.label;
    $("tripDuration").textContent = formatMinutes(itinerary.minutes);
    $("tripSteps").replaceChildren(
      ...itinerary.steps
        .filter((step) => step.kind === "ride" || step.minutes >= 0.5)
        .map((step) => {
          const item = document.createElement("li");
          let badge;
          if (step.kind === "ride") {
            badge = lineBadge(step.line);
          } else {
            badge = document.createElement("span");
            badge.className = "badge walk";
            badge.textContent = "🚶";
          }
          const text = document.createElement("span");
          text.textContent = step.kind === "ride" ? `${step.text} · wait ~${Math.round(step.wait)} min` : step.text;
          const minutes = document.createElement("span");
          minutes.className = "minutes";
          minutes.textContent = formatMinutes(step.minutes);
          item.append(badge, text, minutes);
          return item;
        }),
    );
  }

  if (app.heatSolution) {
    const source = heatSource();
    const { stations } = app.data;
    const railMask = RAIL_MODES.reduce((mask, mode) => mask | modeBit(mode), 0);
    const rail = [];
    stations.forEach((station, index) => {
      if (station.berlin && app.graph.stationMask[index] & railMask) rail.push(index);
    });
    const reachable = rail.filter((index) => {
      const byFoot = walkMinutes(hypot(source.point, stations[index].point));
      return Math.min(byFoot, app.heatSolution.stationTime[index]) <= REACH_MINUTES;
    }).length;
    const percent = Math.round((reachable / rail.length) * 100);
    const where = source === app.from ? "this start" : "this destination";
    const enabled = MODES.filter((mode) => app.modes.has(mode)).map((mode) => MODE_LABELS[mode]);
    const using = enabled.length === MODES.length ? "using every mode" : enabled.length ? `using ${enabled.join(", ")}` : "on foot only";
    $("reach").textContent = `${percent}% of Berlin's U-Bahn, S-Bahn, tram and train stations are within ${REACH_MINUTES} minutes of ${where} (${using}).`;
  }
}

function updateLegend() {
  const stops = PALETTES[app.palette].map(([t, [r, g, b]]) => `rgb(${r}, ${g}, ${b}) ${Math.round(t * 100)}%`);
  $("legendBar").style.background = `linear-gradient(90deg, ${stops.join(", ")})`;
  $("legendMid").textContent = `${Math.round(app.maxMinutes / 2)} min`;
  $("legendMax").textContent = `${app.maxMinutes} min`;
  $("maxValue").textContent = `${app.maxMinutes} min`;
}

function formatPair(point) {
  const { lat, lon } = toLatLon(point);
  return `${lat.toFixed(5)},${lon.toFixed(5)}`;
}

function parsePair(value) {
  const match = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(value || "");
  return match ? toWorld(Number(match[1]), Number(match[2])) : null;
}

function setModes(modes) {
  app.modes = new Set(modes);
  app.modeMask = [...app.modes].reduce((mask, mode) => mask | modeBit(mode), 0);
  for (const input of $("modeToggles").querySelectorAll("input")) input.checked = app.modes.has(input.value);
}

function syncUrl() {
  const params = new URLSearchParams();
  if (app.from) params.set("from", formatPair(app.from.point));
  if (app.to) params.set("to", formatPair(app.to.point));
  if (app.to && app.heatFrom === "to") params.set("map", "to");
  const modes = MODES.filter((mode) => app.modes.has(mode));
  if (modes.join(",") !== DEFAULT_MODES.join(",")) params.set("modes", modes.join(",") || "none");
  if (app.maxMinutes !== DEFAULT_MAX) params.set("max", String(app.maxMinutes));
  const iso = [...app.isochrones].sort((a, b) => a - b).join(",");
  if (iso !== DEFAULT_ISOCHRONES.join(",")) params.set("iso", iso || "0");
  const query = params.toString().replaceAll("%2C", ",");
  history.replaceState(null, "", query ? `?${query}` : location.pathname);
}

function restoreFromUrl() {
  const params = new URLSearchParams(location.search);
  setModes(params.has("modes") ? params.get("modes").split(",").filter((mode) => MODES.includes(mode)) : DEFAULT_MODES);
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

  const from = parsePair(params.get("from"));
  if (!from || !setFrom(from, null, { quiet: true })) {
    setFrom(toWorld(DEFAULT_FROM.lat, DEFAULT_FROM.lon), DEFAULT_FROM.label, { quiet: true });
  }
  const to = parsePair(params.get("to"));
  if (to && setTo(to, null, { quiet: true }) && params.get("map") === "to") setHeatFrom("to");
}

function toast(message) {
  const element = $("toast");
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    element.hidden = true;
  }, 2200);
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
  for (const key of ["to", "from"]) {
    if (app[key] && hypot(screen, project(app[key].point)) <= MARKER_HIT_RADIUS[kind]) return key;
  }
  return null;
}

// --- Hovering stops -------------------------------------------------------------------

const tooltip = $("mapTooltip");

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

function setHover(index) {
  if ((app.hover?.index ?? null) === index) return;
  app.hover = index === null ? null : { index, solution: null };
  canvas.classList.toggle("over-stop", index !== null);
  requestRender();
}

function fillTooltip(index) {
  const station = app.data.stations[index];
  const title = document.createElement("strong");
  title.textContent = station.name;
  const lines = document.createElement("div");
  lines.className = "tooltip-lines";
  const rail = station.lines.filter((l) => app.data.lines[l].mode !== "bus");
  const bus = station.lines.filter((l) => app.data.lines[l].mode === "bus");
  // Rail and ferry lines first; buses too when the stop has nothing else, or as a count.
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
  const time = document.createElement("span");
  time.className = "tooltip-time";
  const solution = app.heatSolution;
  if (solution) {
    const source = heatSource();
    const minutes = Math.min(solution.stationTime[index], walkMinutes(walkMeters(source.point, station.point)));
    time.textContent = `${formatMinutes(minutes)} from ${source === app.from ? "the start" : "the destination"}`;
  }
  tooltip.replaceChildren(title, lines, time);
}

/** Keeps the tooltip on its stop while the map moves, and its travel time in step with the heatmap. */
function positionTooltip() {
  if (!app.hover || app.drag) {
    tooltip.hidden = true;
    return;
  }
  if (app.hover.solution !== app.heatSolution) {
    fillTooltip(app.hover.index);
    app.hover.solution = app.heatSolution;
  }
  const [x, y] = project(app.data.stations[app.hover.index].point);
  tooltip.hidden = false;
  // Above the stop, flipped below near the top edge, and kept inside the map horizontally.
  const width = tooltip.offsetWidth;
  const height = tooltip.offsetHeight;
  const left = clamp(x - width / 2, 8, app.size.width - width - 8);
  const top = y - height - 14 < 8 ? y + 14 : y - height - 14;
  tooltip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

canvas.addEventListener("pointerleave", () => setHover(null));

canvas.addEventListener("pointerdown", (event) => {
  if (!app.data) return;
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
  app.drag = marker
    ? { kind: "marker", marker, start: screen }
    : { kind: "pan", start: screen, last: screen, moved: false, slop: CLICK_SLOP[pointer] };
  // Grabbing a marker centres the heatmap on it.
  if (marker && marker !== app.heatFrom) setHeatFrom(marker);
});

canvas.addEventListener("pointermove", (event) => {
  if (!app.data) return;
  const screen = eventPoint(event);
  if (app.pointers.has(event.pointerId)) app.pointers.set(event.pointerId, screen);
  const drag = app.drag;

  if (!drag) {
    const marker = markerAt(screen);
    canvas.classList.toggle("over-marker", Boolean(marker));
    setHover(!marker && event.pointerType === "mouse" ? stopAt(screen) : null);
    return;
  }
  if (drag.kind === "pinch" && app.pointers.size === 2) {
    const [a, b] = [...app.pointers.values()];
    const distance = hypot(a, b);
    zoomAt(distance / drag.distance, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    drag.distance = distance;
  } else if (drag.kind === "marker") {
    const world = unproject(...screen);
    if (drag.marker === "from") setFrom(world, null, { quiet: true, fast: true });
    else setTo(world, null, { quiet: true, fast: true });
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

function endPointer(event) {
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
    if (!setTo(unproject(...eventPoint(event)))) toast("That point is outside Berlin or on the water.");
  } else if (drag.kind === "marker") {
    recompute();
    syncUrl();
  }
}

canvas.addEventListener("dblclick", (event) => {
  if (markerAt(eventPoint(event)) === "to") removeTo();
});

canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const [x, y] = eventPoint(event);
    zoomAt(Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0018)), x, y);
  },
  { passive: false },
);

// --- Controls ---------------------------------------------------------------------

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
  recompute();
  syncUrl();
});

$("isoToggles").addEventListener("change", () => {
  app.isochrones = [...$("isoToggles").querySelectorAll("input:checked")].map((input) => Number(input.value));
  requestRender();
  syncUrl();
});

$("maxRange").addEventListener("input", (event) => {
  app.maxMinutes = Number(event.target.value);
  updateLegend();
  if (app.grid) paintHeat(app.grid);
  requestRender();
  syncUrl();
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

function applyTheme(name) {
  document.documentElement.dataset.theme = name;
  const dark = name === "dark";
  themeToggle.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
  themeToggle.title = themeToggle.getAttribute("aria-label");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0e0e0e" : "#ffffff");
  requestRender();
}

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

$("swap").addEventListener("click", () => {
  if (!app.to) {
    toast("Pick a destination on the map first.");
    return;
  }
  [app.from, app.to] = [app.to, app.from];
  setHeatFrom("from");
  syncUrl();
});

$("removeTo").addEventListener("click", removeTo);
$("heatFrom").addEventListener("click", (event) => {
  const source = event.target.closest("button")?.dataset.source;
  if (source && source !== app.heatFrom) {
    setHeatFrom(source);
    syncUrl();
  }
});

$("locate").addEventListener("click", () => {
  if (!navigator.geolocation) {
    toast("Geolocation is not available.");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      if (!setFrom(toWorld(coords.latitude, coords.longitude), "My location")) toast("You are outside Berlin.");
    },
    (error) =>
      toast(
        error.code === error.PERMISSION_DENIED
          ? "Location denied: allow it, or search for an address."
          : "Could not get your location: search for an address instead.",
      ),
    // Without a timeout, some in-app browsers never call either callback.
    { timeout: 10000, maximumAge: 60000 },
  );
});

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

// --- Address search (Photon, OpenStreetMap data) --------------------------------------

const searchInput = $("searchInput");
const searchResults = $("searchResults");
let searchTimer = null;
let searchController = null;

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
  const { stationMask } = app.graph;
  const busOnly = modeBit("bus");
  return app.data.stations
    .map((station, index) => ({ station, index }))
    .filter(({ station, index }) => stationMask[index] !== busOnly && words.every((word) => normalize(station.name).includes(word)))
    .slice(0, 3)
    .map(({ station }) => ({
      label: station.name,
      context: `Station · ${[...new Set(station.lines.filter((l) => app.data.lines[l].mode !== "bus").map((l) => app.data.lines[l].name))].join(", ")}`,
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

async function searchAddress(query) {
  const stops = searchStops(query);
  searchController?.abort();
  searchController = new AbortController();
  const [south, west, north, east] = CITY.searchBbox;
  const params = new URLSearchParams({
    q: query,
    limit: "8",
    lat: String(DEFAULT_FROM.lat),
    lon: String(DEFAULT_FROM.lon),
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

function showResults(results) {
  searchResults.replaceChildren(
    ...results.map((result) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = result.label;
      const context = document.createElement("small");
      context.textContent = result.context;
      button.append(context);
      button.addEventListener("click", () => chooseResult(result));
      item.append(button);
      return item;
    }),
  );
  searchResults.hidden = !results.length;
}

function chooseResult(result) {
  searchResults.hidden = true;
  searchInput.value = result.label;
  setFrom(result.point, result.label);
  syncUrl();
  const [sx, sy] = project(result.point);
  if (sx < 0 || sy < 0 || sx > app.size.width || sy > app.size.height) {
    [app.view.cx, app.view.cy] = result.point;
    requestRender();
  }
}

searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const query = searchInput.value.trim();
  if (query.length < 3 || !app.data) {
    searchResults.hidden = true;
    return;
  }
  searchTimer = setTimeout(async () => {
    try {
      showResults(await searchAddress(query));
    } catch (error) {
      if (error.name !== "AbortError") searchResults.hidden = true;
    }
  }, 300);
});

$("searchForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = searchInput.value.trim();
  if (query.length < 3 || !app.data) return;
  try {
    const results = await searchAddress(query);
    if (results.length) chooseResult(results[0]);
    else toast("Address not found in Berlin.");
  } catch (error) {
    if (error.name !== "AbortError") toast("The address search is not responding.");
  }
});

document.addEventListener("click", (event) => {
  if (!$("searchForm").contains(event.target)) searchResults.hidden = true;
});

// --- Start -----------------------------------------------------------------------------

async function init() {
  resize();
  const response = await fetch(DATA_URL);
  app.data = await response.json();
  app.offset = [app.data.meta.bounds[0], app.data.meta.bounds[1]];
  app.graph = prepareGraph(app.data);
  app.cells = prepareCells(app.data);
  app.rivers = indexRivers(app.data.rivers);
  app.paths = buildPaths(app.data);
  app.size.width = 0;
  resize();
  restoreFromUrl();
  new ResizeObserver(resize).observe(canvas);
}

init().catch((error) => {
  console.error(error);
  $("tripFrom").textContent = "Could not load the network.";
});
