// BerlInReach, meeting planner: up to five people, the city coloured by the longest (or average) trip among them,
// and the stations where everyone gets fastest.

import {
  $,
  app,
  accessMinutes,
  cellTimes,
  computeGrid,
  describePlace,
  drawMarker,
  formatMinutes,
  formatPair,
  hypot,
  isOnLand,
  parsePair,
  replaceUrl,
  requestRender,
  reveal,
  settingsSummary,
  setupSearch,
  showGrid,
  solveFrom,
  stationLineBadges,
  toWorld,
  toast,
  travelTo,
  walkMeters,
  writeSharedParams,
  start,
} from "./core.js";

const MAX_PEOPLE = 5;
// One fixed colour and letter per slot (Okabe–Ito colours: distinct with every colour vision deficiency).
const SLOTS = [
  { letter: "A", color: "#0072B2", text: "#ffffff" },
  { letter: "B", color: "#E69F00", text: "#111111" },
  { letter: "C", color: "#009E73", text: "#ffffff" },
  { letter: "D", color: "#CC79A7", text: "#111111" },
  { letter: "E", color: "#56B4E9", text: "#111111" },
];
// Two people to start with, so that the page shows something: Prenzlauer Berg and Neukölln.
const DEFAULT_PEOPLE = [
  [52.54132, 13.41226],
  [52.48681, 13.42455],
];
const SPOT_COUNT = 3;
const SPOT_SPACING_METERS = 900; // suggestions apart from each other, not three exits of the same station

const state = {
  people: [], // { slot, point, label, solution, times }
  objective: "fair", // "fair": smallest longest trip; "total": smallest average trip
  spots: [], // best meeting stations: { station, times, worst, mean }
  focus: null, // index in spots highlighted on the map
};

const person = (slot) => state.people.find((p) => p.slot === slot);

function freeSlot() {
  return SLOTS.findIndex((_, slot) => !person(slot));
}

/** One person's travel times (to stations and grid cells), for the current settings. */
function solvePerson(p) {
  p.solution = solveFrom(p.point);
  p.times = cellTimes(p.solution);
}

function score(values) {
  const worst = Math.max(...values);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return { worst, mean, key: state.objective === "fair" ? worst + mean / 1000 : mean + worst / 1000 };
}

/** Time from a person to a station, street level: by transit, or going straight there when that is quicker. */
function timeTo(p, index) {
  const station = app.data.stations[index];
  const byTransit = p.solution.stationTime[index];
  if (accessMinutes(hypot(p.point, station.point)) >= byTransit) return byTransit;
  return Math.min(byTransit, accessMinutes(walkMeters(p.point, station.point)));
}

/** The best meeting stations: rail stations in Berlin, ranked by the longest (or average) trip to them. */
function findSpots() {
  if (state.people.length < 2) return [];
  const ranked = [];
  app.data.stations.forEach((station, index) => {
    if (!station.rail || !station.berlin) return;
    const times = state.people.map((p) => timeTo(p, index));
    if (!times.every(Number.isFinite)) return;
    ranked.push({ station: index, times, ...score(times) });
  });
  ranked.sort((a, b) => a.key - b.key);
  const spots = [];
  for (const spot of ranked) {
    const point = app.data.stations[spot.station].point;
    if (spots.some((s) => hypot(app.data.stations[s.station].point, point) < SPOT_SPACING_METERS)) continue;
    spots.push(spot);
    if (spots.length === SPOT_COUNT) break;
  }
  return spots;
}

function recompute({ fast = false, only = null } = {}) {
  for (const p of state.people) if (only === null || p.slot === only || !p.solution) solvePerson(p);
  if (!state.people.length) {
    showGrid(null);
    state.spots = [];
  } else {
    // Every cell coloured by the longest trip among the people (or their average).
    const count = app.cells.count;
    const values = new Float32Array(count);
    for (let c = 0; c < count; c += 1) {
      let worst = 0;
      let sum = 0;
      for (const p of state.people) {
        const t = p.times[c];
        if (t > worst) worst = t;
        sum += t;
      }
      values[c] = state.objective === "fair" ? worst : sum / state.people.length;
    }
    showGrid(computeGrid(values), { fast });
    // Ranking every station for every person is too slow to follow a dragged marker: done when it is dropped.
    if (!fast) {
      state.spots = findSpots();
      state.focus = state.spots.length ? 0 : null;
    }
  }
  updatePanel();
}

function addPerson(point, label = null, { quiet = false } = {}) {
  if (state.people.length >= MAX_PEOPLE) {
    toast(`Up to ${MAX_PEOPLE} people: remove someone first.`);
    return false;
  }
  if (!isOnLand(point)) {
    toast("That point is outside Berlin or on the water.");
    return false;
  }
  const slot = freeSlot();
  state.people.push({ slot, point, label: label || describePlace(point), solution: null, times: null });
  state.people.sort((a, b) => a.slot - b.slot);
  recompute({ only: slot });
  if (!quiet) syncUrl();
  return true;
}

function removePerson(slot) {
  state.people = state.people.filter((p) => p.slot !== slot);
  recompute({ only: -1 });
  syncUrl();
}

function movePerson(slot, point, { fast = false } = {}) {
  const p = person(slot);
  if (!p || !isOnLand(point)) return;
  p.point = point;
  p.label = describePlace(point);
  recompute({ fast, only: slot });
}

function setObjective(objective) {
  state.objective = objective === "total" ? "total" : "fair";
  for (const button of $("objective").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.objective === state.objective));
  }
  $("legendTitle").textContent = state.objective === "fair" ? "Longest trip among everyone" : "Average trip";
}

// --- Panel ------------------------------------------------------------------------------

function slotDot(slot) {
  const dot = document.createElement("span");
  dot.className = "person-dot";
  dot.textContent = SLOTS[slot].letter;
  dot.style.background = SLOTS[slot].color;
  dot.style.color = SLOTS[slot].text;
  return dot;
}

function timeChips(times) {
  const chips = document.createElement("span");
  chips.className = "time-chips";
  state.people.forEach((p, i) => {
    const chip = document.createElement("span");
    chip.className = "time-chip";
    chip.append(slotDot(p.slot), document.createTextNode(formatMinutes(times[i])));
    chips.append(chip);
  });
  return chips;
}

function updatePanel() {
  $("peopleList").replaceChildren(
    ...state.people.map((p) => {
      const item = document.createElement("li");
      const label = document.createElement("span");
      label.className = "person-label";
      label.textContent = p.label;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "link-button";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove ${SLOTS[p.slot].letter}`);
      remove.addEventListener("click", () => removePerson(p.slot));
      item.append(slotDot(p.slot), label, remove);
      return item;
    }),
  );
  $("peopleHint").textContent =
    state.people.length >= MAX_PEOPLE
      ? "Five people: remove someone to add another. Drag a marker to move it."
      : "Click the map or search to add someone (up to five). Drag a marker to move it.";

  const spots = $("spotList");
  $("spotsBlock").hidden = state.people.length < 2;
  spots.replaceChildren(
    ...state.spots.map((spot, i) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "spot";
      button.setAttribute("aria-pressed", String(state.focus === i));
      const head = document.createElement("span");
      head.className = "spot-head";
      const rank = document.createElement("span");
      rank.className = "rank";
      rank.textContent = String(i + 1).padStart(2, "0");
      const name = document.createElement("strong");
      name.textContent = app.data.stations[spot.station].name;
      const figure = document.createElement("span");
      figure.className = "spot-figure";
      figure.textContent = state.objective === "fair" ? `≤ ${formatMinutes(spot.worst)}` : `⌀ ${formatMinutes(spot.mean)}`;
      head.append(rank, name, figure);
      button.append(head, timeChips(spot.times));
      button.addEventListener("click", () => {
        state.focus = i;
        reveal(app.data.stations[spot.station].point);
        updatePanel();
        requestRender();
      });
      item.append(button);
      return item;
    }),
  );

  const best = state.spots[0];
  $("reach").textContent = best
    ? `Best spot: ${app.data.stations[best.station].name}, everyone there within ${formatMinutes(best.worst)} (${settingsSummary()}).`
    : state.people.length < 2
      ? "Add at least two people to find where to meet."
      : "No station is reachable by everyone with these settings.";
}

function syncUrl() {
  const params = new URLSearchParams();
  for (const p of state.people) params.append("p", formatPair(p.point));
  if (!state.people.length) params.set("p", "none");
  if (state.objective !== "fair") params.set("objective", state.objective);
  writeSharedParams(params);
  replaceUrl(params);
}

function restoreFromUrl() {
  const params = new URLSearchParams(location.search);
  setObjective(params.get("objective"));
  const saved = params.getAll("p");
  const points = saved.length
    ? saved.map(parsePair).filter(Boolean)
    : DEFAULT_PEOPLE.map(([lat, lon]) => toWorld(lat, lon));
  for (const point of points.slice(0, MAX_PEOPLE)) {
    if (!isOnLand(point)) continue;
    state.people.push({ slot: state.people.length, point, label: describePlace(point), solution: null, times: null });
  }
  recompute();
}

// --- Page hooks for the map core ------------------------------------------------------

const page = {
  hoverAnywhere: true,
  start: restoreFromUrl,
  recompute: () => recompute(),
  paramsChanged: syncUrl,
  markers() {
    return state.people.map((p) => ({ key: p.slot, point: p.point }));
  },
  drawOverlay(colors) {
    state.spots.forEach((spot, i) => {
      if (i === state.focus) return;
      drawMarker(app.data.stations[spot.station].point, { color: colors.ink, glyph: String(i + 1), textColor: colors.inkText });
    });
    const focused = state.spots[state.focus];
    if (focused) {
      const label = state.objective === "fair" ? `Meet here · ≤ ${formatMinutes(focused.worst)}` : `Meet here · ⌀ ${formatMinutes(focused.mean)}`;
      drawMarker(app.data.stations[focused.station].point, { color: colors.accent, glyph: String(state.focus + 1), label, textColor: colors.accentText });
    }
    for (const p of state.people) {
      drawMarker(p.point, { color: SLOTS[p.slot].color, glyph: SLOTS[p.slot].letter, textColor: SLOTS[p.slot].text });
    }
  },
  dragMarker(slot, world) {
    movePerson(slot, world, { fast: true });
  },
  dropMarker() {
    recompute();
    syncUrl();
  },
  removeMarker(slot) {
    removePerson(slot);
  },
  click(world) {
    addPerson(world);
  },
  hoverContent({ station, world }) {
    if (!state.people.length) return null;
    const point = station != null ? app.data.stations[station].point : world;
    if (station == null && !isOnLand(point)) return null;
    const title = document.createElement("strong");
    title.textContent = station != null ? app.data.stations[station].name : describePlace(point);
    const times = state.people.map((p) => (station != null ? timeTo(p, station) : travelTo(p.solution, point).minutes));
    const { worst, mean } = score(times);
    const summary = document.createElement("span");
    summary.className = "tooltip-time";
    summary.textContent = state.people.length > 1 ? `Longest ${formatMinutes(worst)} · average ${formatMinutes(mean)}` : "";
    const nodes = [title, timeChips(times), summary];
    if (station != null) nodes.splice(1, 0, stationLineBadges(station));
    return nodes;
  },
};

// --- Page controls ---------------------------------------------------------------------

$("objective").addEventListener("click", (event) => {
  const objective = event.target.closest("button")?.dataset.objective;
  if (!objective || objective === state.objective) return;
  setObjective(objective);
  recompute();
  syncUrl();
});

$("locate").addEventListener("click", () => {
  if (!navigator.geolocation) {
    toast("Geolocation is not available.");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => addPerson(toWorld(coords.latitude, coords.longitude), "My location"),
    (error) =>
      toast(
        error.code === error.PERMISSION_DENIED
          ? "Location denied: allow it, or search for an address."
          : "Could not get your location: search for an address instead.",
      ),
    { timeout: 10000, maximumAge: 60000 },
  );
});

setupSearch($("searchForm"), $("searchInput"), $("searchResults"), (result) => {
  if (addPerson(result.point, result.label)) {
    $("searchInput").value = "";
    reveal(result.point);
  }
});

start(page).catch((error) => {
  console.error(error);
  $("peopleHint").textContent = "Could not load the network.";
});
