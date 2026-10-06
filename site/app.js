// KiezReach, main page: one start, an optional destination with its route, the city coloured by travel time.

import {
  $,
  CITY,
  app,
  accessMinutes,
  buildItinerary,
  cellTimes,
  computeGrid,
  describePlace,
  drawMarker,
  formatMinutes,
  formatPair,
  hypot,
  isOnLand,
  lineBadge,
  parsePair,
  replaceUrl,
  requestRender,
  reveal,
  settingsSummary,
  setupSearch,
  showGrid,
  solveFrom,
  stationLineBadges,
  timeToStation,
  toWorld,
  toast,
  travelTo,
  writeSharedParams,
  start,
} from "./core.js";

const REACH_MINUTES = 30;

const state = {
  from: null, // { point, label }
  to: null, // { point, label }
  heatFrom: "from", // the heatmap starts from the start or the destination
  solution: null, // shortest paths from the start (panel, route)
  heatSolution: null, // shortest paths from the point the heatmap starts from
};

function heatSource() {
  return state.heatFrom === "to" && state.to ? state.to : state.from;
}

function recompute({ fast = false } = {}) {
  if (!state.from) return;
  state.solution = solveFrom(state.from.point);
  state.heatSolution = heatSource() === state.from ? state.solution : solveFrom(state.to.point);
  showGrid(computeGrid(cellTimes(state.heatSolution)), { fast });
  updatePanel();
}

function setFrom(point, label = null, { quiet = false, fast = false } = {}) {
  if (!isOnLand(point)) return false;
  state.from = { point, label: label || describePlace(point) };
  recompute({ fast });
  if (!quiet) syncUrl();
  return true;
}

function setTo(point, label = null, { quiet = false, fast = false } = {}) {
  if (!isOnLand(point)) return false;
  state.to = { point, label: label || describePlace(point) };
  if (state.heatFrom === "to") {
    recompute({ fast });
  } else {
    updatePanel();
    requestRender();
  }
  if (!quiet) syncUrl();
  return true;
}

function removeTo() {
  state.to = null;
  setHeatFrom("from");
  syncUrl();
}

function setHeatFrom(source) {
  state.heatFrom = source === "to" && state.to ? "to" : "from";
  for (const button of $("heatFrom").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.source === state.heatFrom));
  }
  recompute();
}

function updatePanel() {
  $("tripFrom").textContent = state.from?.label ?? "—";
  const result = $("tripResult");
  if (!state.to || !state.solution) {
    result.hidden = true;
    $("tripHint").hidden = false;
  } else {
    const itinerary = buildItinerary(state.solution, state.to.point);
    result.hidden = false;
    $("tripHint").hidden = true;
    $("tripTo").textContent = state.to.label;
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
            badge.textContent = step.text.startsWith("Cycle") ? "🚲" : "🚶";
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

  if (state.heatSolution) {
    const source = heatSource();
    const { stations } = app.data;
    const rail = [];
    stations.forEach((station, index) => {
      if (station.berlin && station.rail) rail.push(index);
    });
    const reachable = rail.filter((index) => {
      const direct = accessMinutes(hypot(source.point, stations[index].point));
      return Math.min(direct, state.heatSolution.stationTime[index]) <= REACH_MINUTES;
    }).length;
    const percent = Math.round((reachable / rail.length) * 100);
    const where = source === state.from ? "this start" : "this destination";
    $("reach").textContent = `${percent}% of Berlin's U-Bahn, S-Bahn, tram and train stations are within ${REACH_MINUTES} minutes of ${where} (${settingsSummary()}).`;
  }
}

function syncUrl() {
  const params = new URLSearchParams();
  if (state.from) params.set("from", formatPair(state.from.point));
  if (state.to) params.set("to", formatPair(state.to.point));
  if (state.to && state.heatFrom === "to") params.set("map", "to");
  writeSharedParams(params);
  replaceUrl(params);
}

function restoreFromUrl() {
  const params = new URLSearchParams(location.search);
  const from = parsePair(params.get("from"));
  if (!from || !setFrom(from, null, { quiet: true })) {
    setFrom(toWorld(CITY.defaultFrom.lat, CITY.defaultFrom.lon), CITY.defaultFrom.label, { quiet: true });
  }
  const to = parsePair(params.get("to"));
  if (to && setTo(to, null, { quiet: true }) && params.get("map") === "to") setHeatFrom("to");
}

// --- Page hooks for the map core ------------------------------------------------------

const page = {
  start: restoreFromUrl,
  recompute: () => recompute(),
  paramsChanged: syncUrl,
  markers() {
    return [state.to && { key: "to", point: state.to.point }, state.from && { key: "from", point: state.from.point }].filter(Boolean);
  },
  drawOverlay(colors) {
    if (state.to) {
      const minutes = state.solution ? formatMinutes(travelTo(state.solution, state.to.point).minutes) : null;
      drawMarker(state.to.point, {
        color: colors.accent,
        label: state.heatFrom === "to" ? `Arrival · ${minutes}` : minutes,
        textColor: colors.accentText,
      });
    }
    if (state.from) drawMarker(state.from.point, { color: colors.ink, label: "Start", textColor: colors.inkText });
  },
  // Grabbing a marker centres the heatmap on it.
  grabMarker(key) {
    if (key !== state.heatFrom) setHeatFrom(key);
  },
  dragMarker(key, world) {
    if (key === "from") setFrom(world, null, { quiet: true, fast: true });
    else setTo(world, null, { quiet: true, fast: true });
  },
  dropMarker() {
    recompute();
    syncUrl();
  },
  removeMarker(key) {
    if (key === "to") removeTo();
  },
  click(world) {
    if (!setTo(world)) toast("That point is outside Berlin or on the water.");
  },
  hoverContent({ station }) {
    if (station == null) return null;
    const title = document.createElement("strong");
    title.textContent = app.data.stations[station].name;
    const time = document.createElement("span");
    time.className = "tooltip-time";
    const source = heatSource();
    if (state.heatSolution && source) {
      time.textContent = `${formatMinutes(timeToStation(state.heatSolution, station))} from ${source === state.from ? "the start" : "the destination"}`;
    }
    return [title, stationLineBadges(station), time];
  },
};

// --- Page controls ---------------------------------------------------------------------

$("swap").addEventListener("click", () => {
  if (!state.to) {
    toast("Pick a destination on the map first.");
    return;
  }
  [state.from, state.to] = [state.to, state.from];
  setHeatFrom("from");
  syncUrl();
});

$("removeTo").addEventListener("click", removeTo);
$("heatFrom").addEventListener("click", (event) => {
  const source = event.target.closest("button")?.dataset.source;
  if (source && source !== state.heatFrom) {
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

setupSearch($("searchForm"), $("searchInput"), $("searchResults"), (result) => {
  $("searchInput").value = result.label;
  setFrom(result.point, result.label);
  reveal(result.point);
});

start(page).catch((error) => {
  console.error(error);
  $("tripFrom").textContent = "Could not load the network.";
});
