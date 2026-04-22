// Cache version — bump whenever shell assets (HTML/CSS/JS) change.
// Also embedded in the cache name so browsers evict old versions cleanly.
var SHELL_VERSION = '2026-04-22-5';
var CACHE_NAME = 'servo-' + SHELL_VERSION;

var SHELL_ASSETS = [
    './',
    './index.html',
    './app.js',
    './style.css',
    './manifest.json',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

self.addEventListener('install', function(e) {
    e.waitUntil(
        caches.open(CACHE_NAME).then(function(cache) {
            return cache.addAll(SHELL_ASSETS);
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', function(e) {
    e.waitUntil(
        caches.keys().then(function(names) {
            return Promise.all(
                names.filter(function(n) { return n !== CACHE_NAME; })
                     .map(function(n) { return caches.delete(n); })
            );
        }).then(function() { return self.clients.claim(); })
    );
});

// Listen for {type:'SKIP_WAITING'} from clients so an update button can activate immediately.
self.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function staleWhileRevalidate(request) {
    return caches.open(CACHE_NAME).then(function(cache) {
        return cache.match(request).then(function(cached) {
            var network = fetch(request).then(function(res) {
                if (res && res.ok) cache.put(request, res.clone());
                return res;
            }).catch(function() { return cached; });
            return cached || network;
        });
    });
}

self.addEventListener('fetch', function(e) {
    if (e.request.method !== 'GET') return;
    var url = e.request.url;

    // Stale-while-revalidate for prices & history — instant paint, freshness in the background
    if (url.indexOf('prices.json') !== -1 || url.indexOf('history.json') !== -1) {
        e.respondWith(staleWhileRevalidate(e.request));
        return;
    }

    // Stale-while-revalidate for map tiles
    if (url.indexOf('basemaps.cartocdn.com') !== -1) {
        e.respondWith(staleWhileRevalidate(e.request));
        return;
    }

    // Cache-first for app shell and everything else
    e.respondWith(
        caches.match(e.request).then(function(cached) {
            if (cached) return cached;
            return fetch(e.request).then(function(res) {
                if (res.ok) {
                    var clone = res.clone();
                    caches.open(CACHE_NAME).then(function(cache) {
                        cache.put(e.request, clone);
                    });
                }
                return res;
            });
        })
    );
});
