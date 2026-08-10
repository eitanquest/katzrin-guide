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

  // ---------- start & destination search ----------

  async function searchPlaces(q) {
    const res = await fetch(`api/geocode?q=${encodeURIComponent(q)}`);
    if (!res.ok) throw new Error(`geocode ${res.status}`);
    return res.json();
  }

  // Optional starting point. null = "right here" (first GPS fix sets the baseline).
  let startPlace = null;

  async function searchStart() {
    const q = $("start-input").value.trim();
    const ul = $("start-results");
    ul.hidden = true;
    if (!q) {
      startPlace = null;
      return;
    }
    $("setup-status").textContent = "Looking for the starting point… 🔍";
    try {
      const places = await searchPlaces(q);
      ul.innerHTML = "";
      const here = document.createElement("li");
      here.textContent = "📍 Right here (where we are now)";
      here.addEventListener("click", () => {
        startPlace = null;
        $("start-input").value = "";
        ul.hidden = true;
        $("setup-status").textContent = "";
      });
      ul.appendChild(here);
      for (const p of places) {
        const li = document.createElement("li");
        li.textContent = `🏠 ${p.name}`;
        li.addEventListener("click", () => {
          startPlace = p;
          $("start-input").value = shortName(p.name);
          ul.hidden = true;
          $("setup-status").textContent = "";
        });
        ul.appendChild(li);
      }
      ul.hidden = false;
      $("setup-status").textContent = places.length
        ? "Tap where we started! 👇"
        : "Couldn't find that place. Try another name? 🤔";
    } catch {
      $("setup-status").textContent = "Hmm, the search didn't work. Try again? 🙏";
    }
  }

  $("start-search-btn").addEventListener("click", searchStart);
  $("start-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      searchStart();
    }
  });

  $("search-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("dest-input").value.trim();
    if (!q) return;
    $("setup-status").textContent = "Looking for it… 🔍";
    $("results").hidden = true;
    try {
      renderResults(await searchPlaces(q));
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

  // ---------- persistence (survive a page refresh) ----------

  const TRIP_KEY = "awty:trip";      // the in-progress trip, for auto-resume
  const RECENTS_KEY = "awty:recents"; // last destinations, for one-tap restart

  function saveTrip() {
    try {
      localStorage.setItem(
        TRIP_KEY,
        JSON.stringify({
          dest: state.dest,
          start: startPlace,
          tripStartMs: state.tripStartMs,
          baselineMeters: state.baselineMeters,
        })
      );
    } catch { /* private mode etc. — just no resume */ }
  }

  function clearTrip() {
    try { localStorage.removeItem(TRIP_KEY); } catch {}
  }

  function addRecent(place) {
    try {
      const recents = JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]")
        .filter((p) => p.name !== place.name);
      recents.unshift({ name: place.name, lat: place.lat, lon: place.lon });
      localStorage.setItem(RECENTS_KEY, JSON.stringify(recents.slice(0, 6)));
    } catch {}
  }

  function renderRecents() {
    let recents = [];
    try { recents = JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]"); } catch {}
    const ul = $("recents");
    ul.innerHTML = "";
    $("recents-label").hidden = ul.hidden = !recents.length;
    for (const p of recents) {
      const li = document.createElement("li");
      li.textContent = `📍 ${shortName(p.name)}`;
      li.addEventListener("click", () => startTrip(p));
      ul.appendChild(li);
    }
  }

  // ---------- trip ----------

  function startTrip(place, saved) {
    state.dest = place;
    state.baselineMeters = saved?.baselineMeters ?? null;
    state.remainingMeters = null;
    state.arrivalAtMs = null;
    state.tripStartMs = saved?.tripStartMs ?? Date.now();
    state.roughEstimate = false;
    addRecent(place);
    saveTrip();

    $("trip-dest-name").textContent = shortName(place.name);
    $("trip-from").textContent = startPlace
      ? `starting from ${shortName(startPlace.name)}`
      : "starting from right here 📍";
    $("trip-status").textContent = "Finding our car on the map… 🛰️";

    // With a chosen starting point, the WHOLE start→destination route is 100%,
    // so opening the app mid-trip shows real progress instead of 0%.
    // (A restored trip already has its baseline — don't refetch.)
    if (startPlace && state.baselineMeters === null) {
      fetch(`api/route?from=${startPlace.lat},${startPlace.lon}&to=${place.lat},${place.lon}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((r) => {
          if (r) {
            state.baselineMeters = Math.max(r.distanceMeters, state.remainingMeters || 0, 1);
            saveTrip();
            tick();
          }
        })
        .catch(() => {}); // first GPS route will set a baseline instead
    }
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
        const fix = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        const prev = state.lastFix;
        state.lastFix = fix;
        if (!prev) {
          refreshRoute();
          return;
        }
        // smooth-countdown: tick "to go" down with every GPS fix so the number
        // is live between the 30-second route refreshes (which then correct it).
        if (state.remainingMeters !== null) {
          const moved = haversineMeters(prev, fix);
          if (moved > 2 && moved < 1000) {
            state.remainingMeters = Math.max(0, state.remainingMeters - moved);
          }
        }
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
      saveTrip();
    }

    $("trip-status").textContent = rough
      ? "Rough guess mode (no route service right now) 🧭"
      : "";
    tick();
  }

  function tick() {
    if (state.remainingMeters === null) return;

    // Arrive only when the (interpolated) road distance AND the straight-line
    // GPS distance both agree we're basically there.
    if (
      state.remainingMeters <= ARRIVED_METERS &&
      (!state.lastFix || haversineMeters(state.lastFix, state.dest) <= ARRIVED_METERS * 2)
    ) {
      return arrive();
    }

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
    clearTrip();
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
    clearTrip();
    renderRecents();
    startPlace = null;
    $("results").hidden = true;
    $("start-results").hidden = true;
    $("dest-input").value = "";
    $("start-input").value = "";
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

  // ---------- boot: show recents, and auto-resume a trip after a refresh ----

  renderRecents();
  try {
    const saved = JSON.parse(localStorage.getItem(TRIP_KEY) || "null");
    if (saved?.dest && Date.now() - saved.tripStartMs < 12 * 3600 * 1000) {
      startPlace = saved.start || null;
      if (startPlace) $("start-input").value = shortName(startPlace.name);
      startTrip(saved.dest, saved);
    }
  } catch { /* corrupted storage — start fresh */ }
})();
