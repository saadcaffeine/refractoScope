/**
 * service-worker.js
 * Cache-first app shell so refractoScope loads and fully functions
 * with no network connection after the first visit. Everything the
 * app needs (HTML/CSS/JS/icons) is same-origin and precached here —
 * there are no external CDN dependencies to worry about.
 */

const CACHE_VERSION = "v9"; // bump whenever cached app files change, so installed/offline copies update; matches app v0.2.0
const CACHE_NAME = "refractoscope-" + CACHE_VERSION;

const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/style.css",
  "./js/app.js",
  "./js/camera.js",
  "./js/detector.js",
  "./js/calibration.js",
  "./js/level.js",
  "./js/weather.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Cache-first for everything same-origin; network is never required
// once the shell is cached. Falls back to the cached index.html for
// navigation requests so deep-ish reloads still work offline.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // don't intercept cross-origin

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.ok) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return networkResponse;
        })
        .catch(() => {
          if (req.mode === "navigate") {
            return caches.match("./index.html");
          }
          return new Response("", { status: 504, statusText: "Offline" });
        });
    })
  );
});
