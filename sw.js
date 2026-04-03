var CACHE_NAME = 'servo-v1';

var SHELL_ASSETS = [
    './',
    './index.html',
    './app.js',
    './style.css',
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
        })
    );
    self.clients.claim();
});

self.addEventListener('fetch', function(e) {
    var url = e.request.url;

    // Network-first for prices data — want fresh prices, offline fallback
    if (url.indexOf('prices.json') !== -1) {
        e.respondWith(
            fetch(e.request).then(function(res) {
                var clone = res.clone();
                caches.open(CACHE_NAME).then(function(cache) {
                    cache.put(e.request, clone);
                });
                return res;
            }).catch(function() {
                return caches.match(e.request);
            })
        );
        return;
    }

    // Stale-while-revalidate for map tiles
    if (url.indexOf('basemaps.cartocdn.com') !== -1) {
        e.respondWith(
            caches.open(CACHE_NAME).then(function(cache) {
                return cache.match(e.request).then(function(cached) {
                    var fetched = fetch(e.request).then(function(res) {
                        cache.put(e.request, res.clone());
                        return res;
                    }).catch(function() { return cached; });
                    return cached || fetched;
                });
            })
        );
        return;
    }

    // Cache-first for app shell and everything else
    e.respondWith(
        caches.match(e.request).then(function(cached) {
            if (cached) return cached;
            return fetch(e.request).then(function(res) {
                if (res.ok && e.request.method === 'GET') {
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
