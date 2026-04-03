// Config
var PRICES_URL = 'data/prices.json';
var OSRM_URL = 'https://router.project-osrm.org/route/v1/driving/';
var NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
var CORRIDOR_RADIUS_KM = 2;
var PERTH_CENTER = [-31.95, 115.86];
var DEFAULT_ZOOM = 11;

// State
var map = null;
var pricesData = null;
var activeFuel = 'ulp';
var markers = [];
var routeLine = null;
var routePoints = null;
var hiddenBrands = new Set();
var BRANDS_WITH_PNG = new Set([
    '7eleven','ampol','atlas','betterchoice','bp','caltex','coles','costco',
    'egampol','gull','liberty','metropetroleum','omgmetro','puma','pumaenergy',
    'shell','united','woolworths'
]);
var currentZoom = DEFAULT_ZOOM;
var corridorSortByDist = false;

// Persistence — restore user preferences from localStorage
function savePrefs() {
    try {
        localStorage.setItem('servo-fuel', activeFuel);
        localStorage.setItem('servo-hidden-brands', JSON.stringify(Array.from(hiddenBrands)));
    } catch (e) {}
}
function loadPrefs() {
    try {
        var fuel = localStorage.getItem('servo-fuel');
        if (fuel) activeFuel = fuel;
        var hidden = localStorage.getItem('servo-hidden-brands');
        if (hidden) {
            var arr = JSON.parse(hidden);
            hiddenBrands = new Set(arr);
        }
    } catch (e) {}
}
var lastCorridor = [];
var locationMarker = null;
var corridorCache = null;
var _suburbListCache = null;

// Init
function init() {
    map = L.map('map', { zoomControl: false }).setView(PERTH_CENTER, DEFAULT_ZOOM);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
        maxZoom: 19,
    }).addTo(map);
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    var renderTimer = null;
    map.on('zoomend moveend', function() {
        currentZoom = map.getZoom();
        if (renderTimer) clearTimeout(renderTimer);
        renderTimer = setTimeout(function() {
            renderTimer = null;
            renderMarkers();
            if (routePoints) applyCorridorDimming();
        }, 50);
    });

    loadPrefs();
    loadPrices();

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js').catch(function(e) {
            console.warn('SW registration failed:', e.message);
        });
    }
}

document.addEventListener('DOMContentLoaded', init);

// ============================================================
// Data loading
// ============================================================

function loadPrices() {
    fetch(PRICES_URL)
        .then(function(r) { return r.json(); })
        .then(function(data) {
            pricesData = data;
            renderMarkers();
            showUpdateBadge();
            setupFuelSelector();
            setupRoutePanel();
            setupBrandFilter();
            setupNearbyButton();
            setupSortToggle();
        })
        .catch(function(err) {
            console.error('Failed to load prices:', err);
        });
}

function showUpdateBadge() {
    var badge = document.getElementById('updateBadge');
    if (!badge || !pricesData || !pricesData.updated) return;
    var d = new Date(pricesData.updated);
    var opts = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
    badge.textContent = 'Updated ' + d.toLocaleString('en-AU', opts);
}

// ============================================================
// Marker rendering
// ============================================================

function clearMarkers() {
    for (var i = 0; i < markers.length; i++) {
        map.removeLayer(markers[i]);
    }
    markers = [];
}

function renderMarkers() {
    clearMarkers();
    if (!pricesData || !pricesData.fuel_types) return;

    var stations = pricesData.fuel_types[activeFuel];
    if (!stations || stations.length === 0) return;

    // Calculate min/max for colour ratio
    var prices = stations.map(function(s) { return s.price; });
    var minP = Math.min.apply(null, prices);
    var maxP = Math.max.apply(null, prices);
    var range = maxP - minP || 1;

    // Viewport culling — only render within current bounds + 10% buffer
    var bounds = map.getBounds().pad(0.1);

    // Filter to visible, non-hidden stations sorted cheapest first (for collision culling)
    var visible = [];
    for (var i = 0; i < stations.length; i++) {
        var s = stations[i];
        if (hiddenBrands.has(brandToSlug(s.brand))) continue;
        if (!bounds.contains([s.lat, s.lng])) continue;
        visible.push(s);
    }
    visible.sort(function(a, b) { return a.price - b.price; });

    // Collision culling — 40px grid, cheapest station wins each cell
    var cellSize = currentZoom <= 12 ? 20 : 40;
    var occupiedCells = {};

    for (var j = 0; j < visible.length; j++) {
        var s = visible[j];
        var slug = brandToSlug(s.brand);
        var ratio = (s.price - minP) / range;
        var colour = priceColour(ratio);
        var priceText = s.price.toFixed(1);

        // Collision check
        var px = map.latLngToContainerPoint([s.lat, s.lng]);
        var cellKey = Math.floor(px.x / cellSize) + ',' + Math.floor(px.y / cellSize);
        if (occupiedCells[cellKey]) continue;
        occupiedCells[cellKey] = true;

        // Zoom-adaptive marker HTML
        var html;
        if (currentZoom <= 12) {
            html = '<div class="price-dot" style="background:' + colour + '"></div>';
        } else if (currentZoom <= 14) {
            var logoSrc = brandLogoSrc(slug);
            html = '<div class="price-pill" style="border-color:' + colour + ';color:' + colour + '">' +
                '<img src="' + logoSrc + '" width="14" height="14" alt="" onerror="this.style.display=\'none\'">' +
                '<span>' + priceText + '</span></div>';
        } else {
            var logoSrc = brandLogoSrc(slug);
            html = '<div class="price-marker" style="border-color:' + colour + ';color:' + colour + '">' +
                '<img src="' + logoSrc + '" width="20" height="20" alt="" onerror="this.style.display=\'none\'">' +
                '<span>' + priceText + '</span>' +
                '</div>';
        }

        var iconOpts = { html: html, className: '' };
        if (currentZoom <= 12) {
            iconOpts.iconSize = [8, 8];
            iconOpts.iconAnchor = [4, 4];
        } else if (currentZoom <= 14) {
            iconOpts.iconSize = null;
            iconOpts.iconAnchor = [0, 8];
        } else {
            iconOpts.iconSize = null;
            iconOpts.iconAnchor = [0, 12];
        }
        var icon = L.divIcon(iconOpts);

        var marker = L.marker([s.lat, s.lng], { icon: icon });
        marker._servoStation = s;

        var directionsUrl = 'https://www.google.com/maps/dir/?api=1&destination=' + s.lat + ',' + s.lng;
        var popupHtml = '<div class="popup-name">' + escapeHtml(s.station) + '</div>' +
            '<div class="popup-brand">' + escapeHtml(s.brand) + '</div>' +
            '<div class="popup-prices">' +
            '<span class="popup-price-chip active-fuel">' + activeFuel.toUpperCase() + ' ' + priceText + 'c</span>' +
            '</div>' +
            '<div class="popup-address">' + escapeHtml(s.address) + ', ' + escapeHtml(s.suburb) + '</div>' +
            '<a class="popup-directions" href="' + directionsUrl + '" target="_blank" rel="noopener">Directions ↗</a>';

        marker.bindPopup(popupHtml);
        marker.addTo(map);
        markers.push(marker);
    }

    updatePriceSummary();
}

// ============================================================
// Utilities
// ============================================================

function updatePriceSummary() {
    var el = document.getElementById('priceSummary');
    if (!el) return;
    if (!pricesData || !pricesData.fuel_types) { el.textContent = ''; return; }
    var stations = pricesData.fuel_types[activeFuel];
    if (!stations || stations.length === 0) { el.textContent = ''; return; }
    var prices = stations.map(function(s) { return s.price; });
    var min = Math.min.apply(null, prices);
    var max = Math.max.apply(null, prices);
    var avg = prices.reduce(function(a, b) { return a + b; }, 0) / prices.length;
    el.textContent = min.toFixed(1) + '¢ – ' + max.toFixed(1) + '¢ · avg ' + avg.toFixed(1) + '¢ · ' + stations.length + ' stations';
}

function escapeHtml(str) {
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

function priceColour(ratio) {
    var r, g, b;
    if (ratio < 0.5) {
        // green(34,197,94) → yellow(234,179,8)
        var t = ratio * 2;
        r = Math.round(34  + t * (234 - 34));
        g = Math.round(197 + t * (179 - 197));
        b = Math.round(94  + t * (8   - 94));
    } else {
        // yellow(234,179,8) → red(239,68,68)
        var t = (ratio - 0.5) * 2;
        r = Math.round(234 + t * (239 - 234));
        g = Math.round(179 + t * (68  - 179));
        b = Math.round(8   + t * (68  - 8));
    }
    return 'rgb(' + r + ',' + g + ',' + b + ')';
}

function brandToSlug(brand) {
    return brand.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function brandLogoSrc(slug) {
    return 'logos/' + slug + (BRANDS_WITH_PNG.has(slug) ? '.png' : '.svg');
}

// ============================================================
// Fuel Type Selector
// ============================================================

function setupFuelSelector() {
    var buttons = document.querySelectorAll('[data-fuel]');
    // Restore saved fuel selection
    for (var i = 0; i < buttons.length; i++) {
        if (buttons[i].dataset.fuel === activeFuel) {
            buttons[i].classList.add('active');
        } else {
            buttons[i].classList.remove('active');
        }
        buttons[i].addEventListener('click', function() {
            var btns = document.querySelectorAll('[data-fuel]');
            for (var j = 0; j < btns.length; j++) {
                btns[j].classList.remove('active');
            }
            this.classList.add('active');
            activeFuel = this.dataset.fuel;
            savePrefs();
            renderMarkers();
            if (routePoints) {
                updateCorridorFilter();
            }
        });
    }
}

// ============================================================
// Cheapest Near Me
// ============================================================

function setupNearbyButton() {
    var btn = document.getElementById('nearbyBtn');
    btn.addEventListener('click', function() {
        if (!navigator.geolocation) return;
        btn.classList.add('locating');
        navigator.geolocation.getCurrentPosition(function(pos) {
            btn.classList.remove('locating');
            showNearby(pos.coords.latitude, pos.coords.longitude);
        }, function() {
            btn.classList.remove('locating');
        });
    });
}

function showNearby(lat, lng) {
    if (!pricesData) return;
    // Show blue dot at current location
    if (locationMarker) map.removeLayer(locationMarker);
    locationMarker = L.circleMarker([lat, lng], {
        radius: 8, color: '#fff', weight: 2,
        fillColor: '#4a9eff', fillOpacity: 1
    }).addTo(map).bindTooltip('You are here', { direction: 'top', offset: [0, -10] });
    // Auto-close route panel if open
    var routePanel = document.getElementById('routePanel');
    var routeToggleBtn = document.getElementById('routeToggleBtn');
    if (routePanel) routePanel.hidden = true;
    if (routeToggleBtn) routeToggleBtn.classList.remove('active');
    var stations = pricesData.fuel_types[activeFuel] || [];
    var nearby = [];
    for (var i = 0; i < stations.length; i++) {
        var slug = brandToSlug(stations[i].brand);
        if (hiddenBrands.has(slug)) continue;
        var d = haversine(lat, lng, stations[i].lat, stations[i].lng);
        if (d <= 5) {
            nearby.push({ station: stations[i], dist: d });
        }
    }
    nearby.sort(function(a, b) { return a.station.price - b.station.price; });
    nearby = nearby.slice(0, 5);

    if (routePoints) clearRoute();
    renderNearbySidebar(nearby);
    map.setView([lat, lng], 14);
}

function makeStationCard(station, rank, metaText, priceClass, clickFn) {
    var card = document.createElement('div');
    card.className = 'station-card';

    var header = document.createElement('div');
    header.className = 'station-card-header';

    var nameGroup = document.createElement('div');
    nameGroup.style.cssText = 'display:flex;align-items:center;gap:6px;min-width:0;flex:1;';

    var rankSpan = document.createElement('span');
    rankSpan.style.cssText = 'font-size:11px;color:var(--text-dim);flex-shrink:0;';
    rankSpan.textContent = String(rank);

    var logo = document.createElement('img');
    logo.src = brandLogoSrc(brandToSlug(station.brand));
    logo.alt = '';
    logo.style.cssText = 'width:22px;height:22px;flex-shrink:0;';
    logo.onerror = function() { this.style.display = 'none'; };

    var nameEl = document.createElement('span');
    nameEl.className = 'station-card-name';
    nameEl.textContent = station.station;

    nameGroup.appendChild(rankSpan);
    nameGroup.appendChild(logo);
    nameGroup.appendChild(nameEl);

    var priceEl = document.createElement('span');
    priceEl.className = 'station-card-price ' + priceClass;
    priceEl.textContent = station.price.toFixed(1) + 'c';

    header.appendChild(nameGroup);
    header.appendChild(priceEl);

    var meta = document.createElement('div');
    meta.className = 'station-card-meta';
    var suburbEl = document.createElement('span');
    suburbEl.textContent = station.suburb;
    var detailEl = document.createElement('span');
    detailEl.textContent = metaText;
    meta.appendChild(suburbEl);
    meta.appendChild(detailEl);

    card.appendChild(header);
    card.appendChild(meta);
    card.addEventListener('click', clickFn);

    return card;
}

function renderNearbySidebar(nearby) {
    var sidebar = document.getElementById('sidebar');
    var titleEl = document.getElementById('sidebarTitle');
    titleEl.textContent = 'Cheapest near you';
    var content = document.getElementById('sidebarContent');
    while (content.firstChild) content.removeChild(content.firstChild);

    if (nearby.length === 0) {
        var msg = document.createElement('div');
        msg.style.cssText = 'padding:16px;color:var(--text-dim);font-size:13px;';
        msg.textContent = 'No stations within 5km.';
        content.appendChild(msg);
        sidebar.hidden = false;
        return;
    }

    for (var i = 0; i < nearby.length; i++) {
        (function(item, rank) {
            var card = makeStationCard(
                item.station,
                rank,
                item.dist.toFixed(1) + 'km away',
                'price-cheap',
                function() { map.setView([item.station.lat, item.station.lng], 16); }
            );
            content.appendChild(card);
        })(nearby[i], i + 1);
    }
    sidebar.hidden = false;
}

// ============================================================
// Route Panel + Suburb Autocomplete
// ============================================================

function getSuburbList() {
    if (_suburbListCache) return _suburbListCache;
    if (!pricesData || !pricesData.fuel_types) return [];
    var seen = {};
    var result = [];
    var fuelTypes = Object.keys(pricesData.fuel_types);
    for (var f = 0; f < fuelTypes.length; f++) {
        var stations = pricesData.fuel_types[fuelTypes[f]];
        for (var i = 0; i < stations.length; i++) {
            var s = stations[i];
            var key = s.suburb.toLowerCase();
            if (!seen[key]) {
                seen[key] = true;
                result.push({ name: s.suburb, lat: s.lat, lng: s.lng });
            }
        }
    }
    result.sort(function(a, b) { return a.name.localeCompare(b.name); });
    _suburbListCache = result;
    return result;
}

function clearDropdown(listEl) {
    while (listEl.firstChild) {
        listEl.removeChild(listEl.firstChild);
    }
}

function showAutocomplete(input) {
    var listId = input.id === 'fromInput' ? 'fromAutocomplete' : 'toAutocomplete';
    var list = document.getElementById(listId);
    var query = input.value.trim().toLowerCase();

    clearDropdown(list);

    if (!query) {
        list.hidden = true;
        return;
    }

    var results = [];

    var suburbs = getSuburbList();
    for (var j = 0; j < suburbs.length; j++) {
        var sub = suburbs[j];
        if (sub.name.toLowerCase().indexOf(query) !== -1) {
            results.push({ label: sub.name, lat: sub.lat, lng: sub.lng });
        }
    }

    results = results.slice(0, 10);

    if (results.length === 0) {
        list.hidden = true;
        return;
    }

    for (var r = 0; r < results.length; r++) {
        (function(item) {
            var el = document.createElement('div');
            el.className = 'autocomplete-item';
            el.textContent = item.label;
            el.addEventListener('mousedown', function(e) {
                e.preventDefault();
                input.value = item.label;
                input.dataset.lat = item.lat;
                input.dataset.lng = item.lng;
                list.hidden = true;
            });
            list.appendChild(el);
        })(results[r]);
    }

    list.hidden = false;
}

function setupRoutePanel() {
    var toggleBtn = document.getElementById('routeToggleBtn');
    var panel = document.getElementById('routePanel');
    var fromInput = document.getElementById('fromInput');
    var toInput = document.getElementById('toInput');
    var locateBtn = document.getElementById('locateBtn');
    var goBtn = document.getElementById('routeGoBtn');
    var clearBtn = document.getElementById('routeClearBtn');
    var sidebarCloseBtn = document.getElementById('sidebarCloseBtn');

    // Toggle panel visibility
    toggleBtn.addEventListener('click', function() {
        panel.hidden = !panel.hidden;
        toggleBtn.classList.toggle('active', !panel.hidden);
    });

    // Autocomplete on input
    fromInput.addEventListener('input', function() { showAutocomplete(fromInput); });
    toInput.addEventListener('input', function() { showAutocomplete(toInput); });

    // Close autocomplete on outside click
    document.addEventListener('click', function(e) {
        if (!e.target.closest('.route-panel')) {
            document.getElementById('fromAutocomplete').hidden = true;
            document.getElementById('toAutocomplete').hidden = true;
        }
    });

    // Geolocation button
    locateBtn.addEventListener('click', function() {
        if (!navigator.geolocation) return;
        navigator.geolocation.getCurrentPosition(function(pos) {
            fromInput.value = 'My location';
            fromInput.dataset.lat = pos.coords.latitude;
            fromInput.dataset.lng = pos.coords.longitude;
        }, function(err) {
            console.warn('Geolocation error:', err.message);
        });
    });

    // Go button
    goBtn.addEventListener('click', function() {
        var fromLat = parseFloat(fromInput.dataset.lat);
        var fromLng = parseFloat(fromInput.dataset.lng);
        var toLat = parseFloat(toInput.dataset.lat);
        var toLng = parseFloat(toInput.dataset.lng);
        if (isNaN(fromLat) || isNaN(fromLng) || isNaN(toLat) || isNaN(toLng)) return;
        fetchRoute(fromLng, fromLat, toLng, toLat);
    });

    // Clear button
    clearBtn.addEventListener('click', function() {
        clearRoute();
    });

    // Sidebar close button
    if (sidebarCloseBtn) {
        sidebarCloseBtn.addEventListener('click', function() {
            clearRoute();
        });
    }
}

// ============================================================
// OSRM Routing
// ============================================================

function fetchRoute(fromLng, fromLat, toLng, toLat) {
    var url = OSRM_URL + fromLng + ',' + fromLat + ';' + toLng + ',' + toLat +
              '?overview=simplified&geometries=polyline';
    return fetch(url)
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (!data.routes || data.routes.length === 0) {
                console.warn('OSRM: no route found');
                return;
            }
            routePoints = decodePolyline(data.routes[0].geometry);
            drawRoute();
            updateCorridorFilter();
        })
        .catch(function(err) {
            console.error('OSRM fetch error:', err);
        });
}

function drawRoute() {
    if (routeLine) {
        map.removeLayer(routeLine);
        routeLine = null;
    }
    if (!routePoints || routePoints.length === 0) return;
    routeLine = L.polyline(routePoints, {
        color: '#4a9eff',
        weight: 4,
        opacity: 0.8
    }).addTo(map);
    map.fitBounds(routeLine.getBounds(), { padding: [40, 40] });
}

function clearRoute() {
    if (routeLine) {
        map.removeLayer(routeLine);
        routeLine = null;
    }
    if (locationMarker) {
        map.removeLayer(locationMarker);
        locationMarker = null;
    }
    routePoints = null;
    corridorCache = null;
    var sidebar = document.getElementById('sidebar');
    sidebar.hidden = true;
    var titleEl = document.getElementById('sidebarTitle');
    if (titleEl) titleEl.textContent = 'On your route';
    // Remove dimmed class from all markers
    for (var i = 0; i < markers.length; i++) {
        var el = markers[i].getElement();
        if (el) {
            var inner = el.querySelector('.price-marker, .price-pill, .price-dot');
            if (inner) inner.classList.remove('dimmed');
        }
    }
}

function decodePolyline(encoded) {
    var result = [];
    var index = 0;
    var lat = 0;
    var lng = 0;
    while (index < encoded.length) {
        var b, shift, result_val;
        shift = 0;
        result_val = 0;
        do {
            b = encoded.charCodeAt(index++) - 63;
            result_val |= (b & 0x1f) << shift;
            shift += 5;
        } while (b >= 0x20);
        var dlat = (result_val & 1) ? ~(result_val >> 1) : (result_val >> 1);
        lat += dlat;

        shift = 0;
        result_val = 0;
        do {
            b = encoded.charCodeAt(index++) - 63;
            result_val |= (b & 0x1f) << shift;
            shift += 5;
        } while (b >= 0x20);
        var dlng = (result_val & 1) ? ~(result_val >> 1) : (result_val >> 1);
        lng += dlng;

        result.push([lat / 1e5, lng / 1e5]);
    }
    return result;
}

// ============================================================
// Corridor Filtering + Results Sidebar
// ============================================================

function updateCorridorFilter() {
    if (!routePoints || !pricesData || !pricesData.fuel_types) return;

    var stations = pricesData.fuel_types[activeFuel];
    if (!stations) return;

    var corridor = [];
    for (var i = 0; i < stations.length; i++) {
        var s = stations[i];
        var slug = brandToSlug(s.brand);
        if (hiddenBrands.has(slug)) continue;
        var dist = minDistToRoute(s.lat, s.lng, routePoints);
        if (dist <= CORRIDOR_RADIUS_KM) {
            corridor.push({ station: s, dist: dist });
        }
    }

    // Cache corridor results — only recomputed when route/fuel/brands change
    corridorCache = corridor.slice();

    // Store for sort toggle re-renders
    lastCorridor = corridor.slice();

    // Sort by price or distance depending on toggle state
    if (corridorSortByDist) {
        corridor.sort(function(a, b) { return a.dist - b.dist; });
    } else {
        corridor.sort(function(a, b) { return a.station.price - b.station.price; });
    }

    applyCorridorDimming();
    renderSidebar(corridor);
}

function applyCorridorDimming() {
    if (!corridorCache) return;

    // O(n) lookup with Set
    var corridorSet = new Set();
    for (var c = 0; c < corridorCache.length; c++) {
        corridorSet.add(corridorCache[c].station);
    }

    for (var j = 0; j < markers.length; j++) {
        var m = markers[j];
        var ms = m._servoStation;
        var el = m.getElement();
        if (!el) continue;
        var inner = el.querySelector('.price-marker, .price-pill, .price-dot');
        if (!inner) continue;

        if (corridorSet.has(ms)) {
            inner.classList.remove('dimmed');
        } else {
            inner.classList.add('dimmed');
        }
    }
}

function renderSidebar(corridor) {
    var sidebar = document.getElementById('sidebar');
    var content = document.getElementById('sidebarContent');

    while (content.firstChild) {
        content.removeChild(content.firstChild);
    }

    if (!corridor || corridor.length === 0) {
        sidebar.hidden = true;
        return;
    }

    sidebar.hidden = false;

    var prices = corridor.map(function(c) { return c.station.price; });
    var minP = Math.min.apply(null, prices);
    var maxP = Math.max.apply(null, prices);
    var range = maxP - minP || 1;

    for (var i = 0; i < corridor.length; i++) {
        (function(item, rank) {
            var s = item.station;
            var ratio = (s.price - minP) / range;
            var priceClass = ratio < 0.33 ? 'price-cheap' : ratio < 0.66 ? 'price-mid' : 'price-dear';
            var card = makeStationCard(
                s,
                rank,
                (item.dist * 1000).toFixed(0) + 'm off route',
                priceClass,
                function() { map.panTo([s.lat, s.lng]); }
            );
            content.appendChild(card);
        })(corridor[i], i + 1);
    }
}

function minDistToRoute(lat, lng, route) {
    var minDist = Infinity;
    for (var i = 0; i < route.length - 1; i++) {
        var d = pointToSegmentDist(lat, lng, route[i][0], route[i][1], route[i+1][0], route[i+1][1]);
        if (d < minDist) minDist = d;
    }
    return minDist;
}

function pointToSegmentDist(px, py, ax, ay, bx, by) {
    // Equirectangular approximation: scale longitude differences by cos(lat)
    var cosLat = Math.cos((ax + bx) / 2 * Math.PI / 180);
    var dx = (bx - ax) * cosLat;
    var dy = by - ay;
    var len2 = dx * dx + dy * dy;
    var t = 0;
    if (len2 > 0) {
        var ex = (px - ax) * cosLat;
        var ey = py - ay;
        t = (ex * dx + ey * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
    }
    var closestLat = ax + t * (bx - ax);
    var closestLng = ay + t * (by - ay);
    return haversine(px, py, closestLat, closestLng);
}

function haversine(lat1, lon1, lat2, lon2) {
    var R = 6371;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLon = (lon2 - lon1) * Math.PI / 180;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ============================================================
// Sort Toggle
// ============================================================

function setupSortToggle() {
    var btn = document.getElementById('sortToggle');
    if (!btn) return;
    btn.addEventListener('click', function() {
        corridorSortByDist = !corridorSortByDist;
        this.textContent = corridorSortByDist ? '↕ Distance' : '↕ Price';
        if (lastCorridor.length > 0) {
            var sorted = lastCorridor.slice();
            if (corridorSortByDist) {
                sorted.sort(function(a, b) { return a.dist - b.dist; });
            } else {
                sorted.sort(function(a, b) { return a.station.price - b.station.price; });
            }
            renderSidebar(sorted);
        }
    });
}

// ============================================================
// Brand Filter
// ============================================================

function setupBrandFilter() {
    var btn = document.getElementById('brandFilterBtn');
    var modal = document.getElementById('brandModal');
    var closeBtn = document.getElementById('brandModalClose');

    btn.addEventListener('click', function() {
        modal.hidden = false;
        btn.classList.add('active');
        populateBrandFilter();
    });

    closeBtn.addEventListener('click', function() {
        modal.hidden = true;
        btn.classList.remove('active');
    });

    // Click outside modal content closes it
    modal.addEventListener('click', function(e) {
        if (e.target === modal) {
            modal.hidden = true;
            btn.classList.remove('active');
        }
    });
}

function populateBrandFilter() {
    var body = document.getElementById('brandModalBody');

    while (body.firstChild) {
        body.removeChild(body.firstChild);
    }

    if (!pricesData || !pricesData.fuel_types) return;

    var stations = pricesData.fuel_types[activeFuel];
    if (!stations) return;

    // Collect unique brands for active fuel type
    var brandsSeen = {};
    var brands = [];
    for (var i = 0; i < stations.length; i++) {
        var slug = brandToSlug(stations[i].brand);
        if (!brandsSeen[slug]) {
            brandsSeen[slug] = true;
            brands.push({ name: stations[i].brand, slug: slug });
        }
    }
    brands.sort(function(a, b) { return a.name.localeCompare(b.name); });

    // Select all / Deselect all buttons
    var actions = document.createElement('div');
    actions.className = 'brand-modal-actions';
    var selectAllBtn = document.createElement('button');
    selectAllBtn.className = 'brand-action-btn';
    selectAllBtn.textContent = 'Select all';
    selectAllBtn.addEventListener('click', function() {
        hiddenBrands.clear();
        savePrefs();
        populateBrandFilter();
        renderMarkers();
        if (routePoints) updateCorridorFilter();
    });
    var deselectAllBtn = document.createElement('button');
    deselectAllBtn.className = 'brand-action-btn';
    deselectAllBtn.textContent = 'Deselect all';
    deselectAllBtn.addEventListener('click', function() {
        for (var b = 0; b < brands.length; b++) hiddenBrands.add(brands[b].slug);
        savePrefs();
        populateBrandFilter();
        renderMarkers();
        if (routePoints) updateCorridorFilter();
    });
    actions.appendChild(selectAllBtn);
    actions.appendChild(deselectAllBtn);
    body.appendChild(actions);

    for (var j = 0; j < brands.length; j++) {
        (function(brand) {
            var item = document.createElement('label');
            item.className = 'brand-dropdown-item';

            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !hiddenBrands.has(brand.slug);
            cb.addEventListener('change', function() {
                if (this.checked) {
                    hiddenBrands.delete(brand.slug);
                } else {
                    hiddenBrands.add(brand.slug);
                }
                savePrefs();
                renderMarkers();
                if (routePoints) {
                    updateCorridorFilter();
                }
            });

            var logo = document.createElement('img');
            logo.src = brandLogoSrc(brand.slug);
            logo.alt = '';
            logo.style.cssText = 'width:22px;height:22px;flex-shrink:0;';
            logo.onerror = function() { this.style.display = 'none'; };

            var nameEl = document.createElement('span');
            nameEl.textContent = brand.name;

            item.appendChild(cb);
            item.appendChild(logo);
            item.appendChild(nameEl);
            body.appendChild(item);
        })(brands[j]);
    }
}
