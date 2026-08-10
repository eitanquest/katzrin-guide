// Are We There Yet? — kid-friendly GPS trip tracker.
// Geocoding + driving ETA go through this site's own /api/awty/* proxy
// (Nominatim + OSRM behind the scenes), so the page works under the strict CSP.

(() => {
  const $ = (id) => document.getElementById(id);

  const screens = {
    setup: $("screen-setup"),
    trip: $("screen-trip"),
    arrived: $("screen-arrived"),
  };

  const ROUTE_REFRESH_MS = 30_000;   // how often we re-ask for a fresh driving ETA
  const ARRIVED_METERS = 200;        // closer than this (by road) counts as "there"

  const state = {
    dest: null,          // { lat, lon, name }
    watchId: null,
    lastFix: null,       // latest GPS position { lat, lon }
    baselineMeters: null,// route length when the trip started (for the progress bar)
    remainingMeters: null,
    arrivalAtMs: null,   // wall-clock ms when we expect to arrive
    tripStartMs: null,
    routeTimer: null,
    tickTimer: null,
    fetchingRoute: false,
    roughEstimate: false,
    wakeLock: null,
  };

  function show(name) {
    Object.values(screens).forEach((s) => s.classList.remove("active"));
    screens[name].classList.add("active");
  }

  // ---------- destination search ----------

  $("search-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("dest-input").value.trim();
    if (!q) return;
    $("setup-status").textContent = "Looking for it… 🔍";
    $("results").hidden = true;
    try {
      const res = await fetch(`api/geocode?q=${encodeURIComponent(q)}`);
      if (!res.ok) throw new Error(`geocode ${res.status}`);
      const places = await res.json();
      renderResults(places);
    } catch {
      $("setup-status").textContent = "Hmm, the search didn't work. Try again? 🙏";
    }
  });

  function renderResults(places) {
    const ul = $("results");
    ul.innerHTML = "";
    if (!places.length) {
      $("setup-status").textContent = "Couldn't find that place. Try another name? 🤔";
      return;
    }
    $("setup-status").textContent = "Tap where we're going! 👇";
    for (const p of places) {
      const li = document.createElement("li");
      li.textContent = `📍 ${p.name}`;
      li.addEventListener("click", () => startTrip(p));
      ul.appendChild(li);
    }
    ul.hidden = false;
  }

  // ---------- trip ----------

  function startTrip(place) {
    state.dest = place;
    state.baselineMeters = null;
    state.remainingMeters = null;
    state.arrivalAtMs = null;
    state.tripStartMs = Date.now();
    state.roughEstimate = false;

    $("trip-dest-name").textContent = shortName(place.name);
    $("trip-status").textContent = "Finding our car on the map… 🛰️";
    $("pct").textContent = "0%";
    $("road-fill").style.width = "0%";
    $("car").style.left = "0%";
    show("trip");
    requestWakeLock();

    if (!("geolocation" in navigator)) {
      $("trip-status").textContent = "This phone can't share its location 😢";
      return;
    }

    state.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const first = !state.lastFix;
        state.lastFix = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        if (first) refreshRoute();
      },
      (err) => {
        $("trip-status").textContent =
          err.code === err.PERMISSION_DENIED
            ? "Please allow location so we can see how close we are! 📍"
            : "Can't find the GPS signal yet… 🛰️";
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
    );

    state.routeTimer = setInterval(refreshRoute, ROUTE_REFRESH_MS);
    state.tickTimer = setInterval(tick, 1000);
  }

  async function refreshRoute() {
    if (!state.lastFix || !state.dest || state.fetchingRoute) return;
    state.fetchingRoute = true;
    try {
      const { lat, lon } = state.lastFix;
      const res = await fetch(
        `api/route?from=${lat},${lon}&to=${state.dest.lat},${state.dest.lon}`
      );
      if (!res.ok) throw new Error(`route ${res.status}`);
      const r = await res.json(); // { durationSec, distanceMeters }
      applyRoute(r.distanceMeters, r.durationSec, false);
    } catch {
      // Fallback: straight-line distance at ~70 km/h so the app still works
      const d = haversineMeters(state.lastFix, state.dest);
      applyRoute(d, d / (70 / 3.6), true);
    } finally {
      state.fetchingRoute = false;
    }
  }

  function applyRoute(distanceMeters, durationSec, rough) {
    state.roughEstimate = rough;
    state.remainingMeters = distanceMeters;
    state.arrivalAtMs = Date.now() + durationSec * 1000;

    // The first route we get becomes 100% of the journey. If a detour makes the
    // route longer than the baseline, re-base so the bar never goes backwards past 0.
    if (state.baselineMeters === null || distanceMeters > state.baselineMeters * 1.1) {
      state.baselineMeters = Math.max(distanceMeters, 1);
    }

    $("trip-status").textContent = rough
      ? "Rough guess mode (no route service right now) 🧭"
      : "";
    tick();
  }

  function tick() {
    if (state.remainingMeters === null) return;

    if (state.remainingMeters <= ARRIVED_METERS) return arrive();

    const pct = Math.min(
      99,
      Math.max(0, Math.round((1 - state.remainingMeters / state.baselineMeters) * 100))
    );
    $("pct").textContent = `${pct}%`;
    $("road-fill").style.width = `${pct}%`;
    $("car").style.left = `${pct}%`;
    $("big-answer").textContent = answerFor(pct);

    const leftMs = Math.max(0, state.arrivalAtMs - Date.now());
    $("eta").textContent = fmtDuration(leftMs);
    $("dist").textContent = fmtDistance(state.remainingMeters);
    $("elapsed").textContent = fmtDuration(Date.now() - state.tripStartMs);
  }

  function answerFor(pct) {
    if (pct < 10) return "Not yet! We just left! 😄";
    if (pct < 25) return "Nope, not yet! 🙈";
    if (pct < 50) return "Getting closer… 🚙";
    if (pct < 75) return "More than halfway! 🎈";
    if (pct < 90) return "Sooo close! 👀";
    return "Almost there!!! 🤩";
  }

  function arrive() {
    const mins = Math.round((Date.now() - state.tripStartMs) / 60000);
    $("arrived-detail").textContent =
      `${shortName(state.dest.name)} — trip took ${mins < 1 ? "less than a minute" : `${mins} min`}`;
    stopTracking();
    show("arrived");
    confetti();
  }

  function stopTracking() {
    if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
    clearInterval(state.routeTimer);
    clearInterval(state.tickTimer);
    state.watchId = state.routeTimer = state.tickTimer = null;
    state.lastFix = null;
    if (state.wakeLock) { state.wakeLock.release().catch(() => {}); state.wakeLock = null; }
  }

  function resetToSetup() {
    stopTracking();
    $("results").hidden = true;
    $("dest-input").value = "";
    $("setup-status").textContent = "";
    $("confetti").innerHTML = "";
    show("setup");
  }

  $("stop-btn").addEventListener("click", resetToSetup);
  $("again-btn").addEventListener("click", resetToSetup);

  // ---------- helpers ----------

  function shortName(full) {
    return full.split(",").slice(0, 2).join(",");
  }

  function fmtDuration(ms) {
    const s = Math.round(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
      : `${m}:${String(sec).padStart(2, "0")}`;
  }

  function fmtDistance(m) {
    return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
  }

  function haversineMeters(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLon = (b.lon - a.lon) * rad;
    const s =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  // Keep the screen awake during the trip (best effort — not all browsers support it)
  async function requestWakeLock() {
    try {
      if ("wakeLock" in navigator) state.wakeLock = await navigator.wakeLock.request("screen");
    } catch { /* screen may still sleep; fine */ }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.watchId !== null) requestWakeLock();
  });

  function confetti() {
    const host = $("confetti");
    const emoji = ["🎉", "🎊", "⭐", "🥳", "🌟", "🎈"];
    for (let i = 0; i < 44; i++) {
      const s = document.createElement("span");
      s.textContent = emoji[i % emoji.length];
      s.style.left = `${Math.random() * 100}vw`;
      s.style.animationDuration = `${2.5 + Math.random() * 2.5}s`;
      s.style.animationDelay = `${Math.random() * 1.5}s`;
      host.appendChild(s);
    }
  }
})();
