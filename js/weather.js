/**
 * weather.js
 * Optional, opt-in: if the device's location can be determined, fetch
 * today's ambient temperature range from Open-Meteo (a free,
 * key-less, CORS-enabled weather API) and expose it for the header
 * chip. Off by default - only runs after the user explicitly enables
 * it in Settings, matching the app's explicit-permission pattern for
 * camera access. Degrades silently (no UI break) if offline, denied,
 * or the location/weather lookup fails for any reason.
 *
 * Exposes a single global: window.WeatherCtl
 */
(function () {
  "use strict";

  const STORAGE_KEY = "refractoscope.weather.v1";
  const CACHE_MS = 2 * 60 * 60 * 1000; // 2 hours
  const FETCH_TIMEOUT_MS = 8000;

  const WeatherCtl = {
    status: "idle", // idle | locating | fetching | ready | denied | unsupported | offline | error
    range: null, // { min, max, unit: 'C' }

    _prefs() {
      try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
      } catch (e) {
        return {};
      }
    },

    _savePrefs(p) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
      } catch (e) { /* ignore storage errors (e.g. private mode) */ }
    },

    isEnabled() {
      return !!this._prefs().enabled;
    },

    /**
     * Best-effort last-known coordinates, reused by the snapshot
     * overlay so it doesn't need its own separate location prompt.
     * Returns null if weather/location was never enabled or no
     * successful lookup has happened yet.
     */
    getLastKnownLocation() {
      const cache = this._prefs().cache;
      if (!cache || typeof cache.lat !== "number" || typeof cache.lon !== "number") return null;
      return { lat: cache.lat, lon: cache.lon, fetchedAt: cache.fetchedAt };
    },

    setEnabled(v) {
      const p = this._prefs();
      p.enabled = v;
      this._savePrefs(p);
    },

    /** Kick off (or re-kick) a location + weather lookup. */
    async refresh() {
      if (!("geolocation" in navigator)) {
        this.status = "unsupported";
        return this.status;
      }
      if (navigator.onLine === false) {
        this.status = "offline";
        return this.status;
      }

      this.status = "locating";
      let pos;
      try {
        pos = await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: false,
            timeout: 10000,
            maximumAge: 30 * 60 * 1000,
          });
        });
      } catch (err) {
        this.status = err && err.code === 1 ? "denied" : "error";
        return this.status;
      }

      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;

      // Reuse a recent cached reading for roughly the same spot rather
      // than re-fetching every time the app opens.
      const cache = this._prefs().cache;
      if (
        cache &&
        Date.now() - cache.fetchedAt < CACHE_MS &&
        Math.abs(cache.lat - lat) < 0.5 &&
        Math.abs(cache.lon - lon) < 0.5
      ) {
        this.range = { min: cache.min, max: cache.max, unit: cache.unit };
        this.status = "ready";
        return this.status;
      }

      this.status = "fetching";
      try {
        const url =
          "https://api.open-meteo.com/v1/forecast" +
          `?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}` +
          "&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1";

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        let res;
        try {
          res = await fetch(url, { signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
        if (!res.ok) throw new Error("bad status " + res.status);
        const data = await res.json();
        const max = data && data.daily && data.daily.temperature_2m_max && data.daily.temperature_2m_max[0];
        const min = data && data.daily && data.daily.temperature_2m_min && data.daily.temperature_2m_min[0];
        if (typeof max !== "number" || typeof min !== "number") throw new Error("unexpected response shape");

        this.range = { min, max, unit: "C" };
        const p = this._prefs();
        p.cache = { lat, lon, min, max, unit: "C", fetchedAt: Date.now() };
        this._savePrefs(p);
        this.status = "ready";
      } catch (e) {
        this.status = navigator.onLine === false ? "offline" : "error";
      }
      return this.status;
    },
  };

  window.WeatherCtl = WeatherCtl;
})();
