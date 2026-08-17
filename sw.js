const CACHE_NAME = 'flightim-v22';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/db.js',
  './js/kmlParser.js',
  './js/flightAwareParser.js',
  './js/notionParser.js',
  './js/notionHtmlParser.js',
  './js/mapView.js',
  './js/airports.js',
  './js/worldGeo.js',
  './js/replay.js',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/leaflet.css',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isTile = /tile|basemaps/i.test(url.hostname);

  if (isTile) {
    // Network-first for map tiles; don't let a flaky connection block rendering.
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  if (event.request.method !== 'GET' || url.origin !== location.origin) return;

  // Réseau d'abord pour l'app shell : avec la stratégie "cache d'abord"
  // précédente, un simple rechargement ne montrait jamais la dernière
  // version au premier essai (le réseau ne servait qu'à rafraîchir le cache
  // pour LA FOIS SUIVANTE) — ce qui rendait "Recharger l'app" inefficace en
  // pratique. Le cache ne sert plus que de repli hors-ligne.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) caches.open(CACHE_NAME).then((c) => c.put(event.request, res.clone()));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
