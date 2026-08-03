/* REG SLAYER — TestOffline service worker
 * Caches app shell for return visits with no signal.
 * Map tiles: cache-first when already stored; network otherwise (then cache).
 */
const SHELL_CACHE = 'reg-slayer-shell-v7';
const TILE_CACHE = 'reg-slayer-tiles-v2';
const DATA_CACHE = 'reg-slayer-data-v1';

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './reg-slayer-logo.png',
  './peak-rut-antlers.png',
  './offline-engine.js',
  './auth-sync.js',
  './party-maps.js',
  './icons/tools/measure.png',
  './icons/tools/draw.png',
  './icons/tools/track.png',
  './icons/tools/layers.png',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/marker-icon.png',
  './vendor/leaflet/marker-icon-2x.png',
  './vendor/leaflet/marker-shadow.png',
  './vendor/leaflet/layers.png',
  './vendor/leaflet/layers-2x.png'
];

function isTileUrl(url) {
  try {
    const u = new URL(url);
    const h = u.hostname;
    if (h.includes('basemap.nationalmap.gov')) return true;
    if (h.includes('basemaps.cartocdn.com')) return true;
    if (h.includes('arcgisonline.com') && u.pathname.includes('/tile/')) return true;
    if (h.includes('wayback.maptiles.arcgis.com') && u.pathname.includes('/tile/')) return true;
    if (h.includes('tiles.regrid.com')) return true;
    if (h.includes('tilecache.rainviewer.com')) return true;
    if (h.includes('tile.openstreetmap.org')) return true;
    return false;
  } catch (e) {
    return false;
  }
}

function isApiUrl(url) {
  try {
    const u = new URL(url);
    const h = u.hostname;
    if (h.includes('open-meteo.com')) return true;
    if (h.includes('api.weather.gov')) return true;
    if (h.includes('waterservices.usgs.gov') || h.includes('waterdata.usgs.gov')) return true;
    if (h.includes('conservationgis.alabama.gov')) return true;
    if (h.includes('services.arcgis.com') || h.includes('apps.fs.usda.gov')) return true;
    if (h.includes('api.rainviewer.com')) return true;
    return false;
  } catch (e) {
    return false;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      Promise.all(
        SHELL_ASSETS.map((path) =>
          cache.add(path).catch((err) => {
            console.warn('[SW] shell skip', path, err);
          })
        )
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== TILE_CACHE && k !== DATA_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = req.url;

  // App shell / same-origin: cache-first, then network
  if (url.startsWith(self.registration.scope)) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) {
          // Background refresh for HTML so online users get updates
          if (req.mode === 'navigate' || url.endsWith('.html') || url.endsWith('/')) {
            fetch(req)
              .then((res) => {
                if (res && res.ok) {
                  const copy = res.clone();
                  caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
                }
              })
              .catch(() => {});
          }
          return cached;
        }
        return fetch(req)
          .then((res) => {
            if (res && res.ok) {
              const copy = res.clone();
              caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
            }
            return res;
          })
          .catch(() => caches.match('./index.html'));
      })
    );
    return;
  }

  // Map tiles: cache-first (supports offline packs + browsed tiles)
  if (isTileUrl(url)) {
    event.respondWith(
      caches.open(TILE_CACHE).then((cache) =>
        cache.match(req).then((cached) => {
          if (cached) return cached;
          return fetch(req)
            .then((res) => {
              if (res && res.ok) {
                try {
                  cache.put(req, res.clone());
                } catch (e) {}
              }
              return res;
            })
            .catch(() => cached || Response.error());
        })
      )
    );
    return;
  }

  // Weather / GIS APIs: network-first, fall back to cache
  if (isApiUrl(url)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(DATA_CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() =>
          caches.match(req).then((cached) => cached || Response.error())
        )
    );
  }
});

// Allow page to ask SW to precache a list of tile URLs
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'PRECACHE_URLS' && Array.isArray(data.urls)) {
    event.waitUntil(
      caches.open(TILE_CACHE).then(async (cache) => {
        let ok = 0;
        let fail = 0;
        for (const u of data.urls) {
          try {
            const res = await fetch(u, { mode: 'cors', credentials: 'omit' });
            if (res && res.ok) {
              await cache.put(u, res.clone());
              ok++;
            } else {
              fail++;
            }
          } catch (e) {
            fail++;
          }
          if (event.source && (ok + fail) % 20 === 0) {
            event.source.postMessage({
              type: 'PRECACHE_PROGRESS',
              ok,
              fail,
              total: data.urls.length,
              packId: data.packId || null
            });
          }
        }
        if (event.source) {
          event.source.postMessage({
            type: 'PRECACHE_DONE',
            ok,
            fail,
            total: data.urls.length,
            packId: data.packId || null
          });
        }
      })
    );
  }
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
