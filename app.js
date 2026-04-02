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
var currentZoom = DEFAULT_ZOOM;
var corridorSortByDist = false;
var lastCorridor = [];

// Init
function init() {
    map = L.map('map', { zoomControl: false }).setView(PERTH_CENTER, DEFAULT_ZOOM);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
        maxZoom: 19,
    }).addTo(map);
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    map.on('zoomend moveend', function() {
        currentZoom = map.getZoom();
        renderMarkers();
        if (routePoints) updateCorridorFilter();
    });

    loadPrices();
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
            html = '<div class="price-pill" style="border-color:' + colour + ';color:' + colour + '"><span>' + priceText + '</span></div>';
        } else {
            html = '<div class="price-marker" style="border-color:' + colour + ';color:' + colour + '">' +
                '<img src="logos/' + slug + '.svg" alt="" ' +
                'onerror="this.src=\'logos/default.svg\'" ' +
                'style="width:14px;height:14px;vertical-align:middle;margin-right:3px;">' +
                '<span>' + priceText + '</span>' +
                '</div>';
        }

        var icon = L.divIcon({
            html: html,
            className: '',
            iconAnchor: [0, 0]
        });

        var marker = L.marker([s.lat, s.lng], { icon: icon });
        marker._servoStation = s;

        var popupHtml = '<div class="popup-name">' + escapeHtml(s.station) + '</div>' +
            '<div class="popup-brand">' + escapeHtml(s.brand) + '</div>' +
            '<div class="popup-prices">' +
            '<span class="popup-price-chip active-fuel">' + activeFuel.toUpperCase() + ' ' + priceText + 'c</span>' +
            '</div>' +
            '<div class="popup-address">' + escapeHtml(s.address) + ', ' + escapeHtml(s.suburb) + '</div>';

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

// ============================================================
// Task 5: Fuel Type Selector
// ============================================================

function setupFuelSelector() {
    var buttons = document.querySelectorAll('[data-fuel]');
    for (var i = 0; i < buttons.length; i++) {
        buttons[i].addEventListener('click', function() {
            var btns = document.querySelectorAll('[data-fuel]');
            for (var j = 0; j < btns.length; j++) {
                btns[j].classList.remove('active');
            }
            this.classList.add('active');
            activeFuel = this.dataset.fuel;
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
        btn.textContent = '📍 Locating...';
        navigator.geolocation.getCurrentPosition(function(pos) {
            btn.textContent = '📍 Near me';
            showNearby(pos.coords.latitude, pos.coords.longitude);
        }, function() {
            btn.textContent = '📍 Near me';
        });
    });
}

function showNearby(lat, lng) {
    if (!pricesData) return;
    var stations = pricesData.fuel_types[activeFuel] || [];
    var nearby = [];
    for (var i = 0; i < stations.length; i++) {
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
        var item = nearby[i];
        var s = item.station;
        var card = document.createElement('div');
        card.className = 'station-card';

        var cardHeader = document.createElement('div');
        cardHeader.className = 'station-card-header';

        var nameGroup = document.createElement('div');
        nameGroup.style.cssText = 'display:flex;align-items:center;gap:6px;min-width:0;flex:1;';

        var rankSpan = document.createElement('span');
        rankSpan.style.cssText = 'font-size:11px;color:var(--text-dim);flex-shrink:0;';
        rankSpan.textContent = String(i + 1);

        var logo = document.createElement('img');
        logo.src = 'logos/' + brandToSlug(s.brand) + '.svg';
        logo.alt = '';
        logo.style.cssText = 'width:16px;height:16px;flex-shrink:0;';
        logo.onerror = function() { this.src = 'logos/default.svg'; };

        var nameEl = document.createElement('span');
        nameEl.className = 'station-card-name';
        nameEl.textContent = s.station;

        nameGroup.appendChild(rankSpan);
        nameGroup.appendChild(logo);
        nameGroup.appendChild(nameEl);

        var priceEl = document.createElement('span');
        priceEl.className = 'station-card-price price-cheap';
        priceEl.textContent = s.price.toFixed(1) + 'c';

        cardHeader.appendChild(nameGroup);
        cardHeader.appendChild(priceEl);

        var meta = document.createElement('div');
        meta.className = 'station-card-meta';
        var suburbEl = document.createElement('span');
        suburbEl.textContent = s.suburb;
        var distEl = document.createElement('span');
        distEl.textContent = item.dist.toFixed(1) + 'km away';
        meta.appendChild(suburbEl);
        meta.appendChild(distEl);

        card.appendChild(cardHeader);
        card.appendChild(meta);

        (function(station) {
            card.addEventListener('click', function() {
                map.setView([station.lat, station.lng], 16);
            });
        })(s);

        content.appendChild(card);
    }
    sidebar.hidden = false;
}

// ============================================================
// Task 6: Route Panel + Suburb Autocomplete
// ============================================================

function getSavedLocations() {
    try {
        return JSON.parse(localStorage.getItem('servo-locations') || '{}');
    } catch (e) {
        return {};
    }
}

function getSuburbList() {
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

    // Saved locations first (prefixed with pin)
    var saved = getSavedLocations();
    var savedKeys = Object.keys(saved);
    for (var i = 0; i < savedKeys.length; i++) {
        var k = savedKeys[i];
        if (k.toLowerCase().indexOf(query) !== -1) {
            results.push({ label: '\uD83D\uDCCC ' + k, lat: saved[k].lat, lng: saved[k].lng });
        }
    }

    // Suburbs
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
                input.value = item.label.replace(/^\uD83D\uDCCC\s*/, '');
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
// Task 7: OSRM Routing + Route Polyline
// ============================================================

function fetchRoute(fromLng, fromLat, toLng, toLat) {
    var url = OSRM_URL + fromLng + ',' + fromLat + ';' + toLng + ',' + toLat +
              '?overview=full&geometries=polyline';
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
    routePoints = null;
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
// Task 8: Corridor Filtering + Results Sidebar
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

    // Store for sort toggle re-renders
    lastCorridor = corridor.slice();

    // Sort by price or distance depending on toggle state
    if (corridorSortByDist) {
        corridor.sort(function(a, b) { return a.dist - b.dist; });
    } else {
        corridor.sort(function(a, b) { return a.station.price - b.station.price; });
    }

    // Dim/undim markers
    for (var j = 0; j < markers.length; j++) {
        var m = markers[j];
        var ms = m._servoStation;
        var el = m.getElement();
        if (!el) continue;
        var inner = el.querySelector('.price-marker, .price-pill, .price-dot');
        if (!inner) continue;

        var onRoute = false;
        for (var k = 0; k < corridor.length; k++) {
            if (corridor[k].station === ms) { onRoute = true; break; }
        }
        if (onRoute) {
            inner.classList.remove('dimmed');
        } else {
            inner.classList.add('dimmed');
        }
    }

    renderSidebar(corridor);
}

function renderSidebar(corridor) {
    var sidebar = document.getElementById('sidebar');
    var content = document.getElementById('sidebarContent');

    // Clear existing cards using DOM methods
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
        var item = corridor[i];
        var s = item.station;
        var rank = i + 1;
        var ratio = (s.price - minP) / range;
        var priceClass = ratio < 0.33 ? 'price-cheap' : ratio < 0.66 ? 'price-mid' : 'price-dear';

        // Card
        var card = document.createElement('div');
        card.className = 'station-card';

        // Header row
        var header = document.createElement('div');
        header.className = 'station-card-header';

        // Logo + name group
        var nameGroup = document.createElement('div');
        nameGroup.style.cssText = 'display:flex;align-items:center;gap:6px;min-width:0;flex:1;';

        var rankSpan = document.createElement('span');
        rankSpan.style.cssText = 'font-size:11px;color:var(--text-dim);flex-shrink:0;';
        rankSpan.textContent = String(rank);

        var logo = document.createElement('img');
        logo.src = 'logos/' + brandToSlug(s.brand) + '.svg';
        logo.alt = '';
        logo.style.cssText = 'width:16px;height:16px;flex-shrink:0;';
        logo.onerror = function() { this.src = 'logos/default.svg'; };

        var nameEl = document.createElement('span');
        nameEl.className = 'station-card-name';
        nameEl.textContent = s.station;

        nameGroup.appendChild(rankSpan);
        nameGroup.appendChild(logo);
        nameGroup.appendChild(nameEl);

        var priceEl = document.createElement('span');
        priceEl.className = 'station-card-price ' + priceClass;
        priceEl.textContent = s.price.toFixed(1) + 'c';

        header.appendChild(nameGroup);
        header.appendChild(priceEl);

        // Meta row
        var meta = document.createElement('div');
        meta.className = 'station-card-meta';

        var suburbEl = document.createElement('span');
        suburbEl.textContent = s.suburb;

        var detourEl = document.createElement('span');
        detourEl.textContent = (item.dist * 1000).toFixed(0) + 'm off route';

        meta.appendChild(suburbEl);
        meta.appendChild(detourEl);

        card.appendChild(header);
        card.appendChild(meta);

        // Click to pan map
        (function(station) {
            card.addEventListener('click', function() {
                map.panTo([station.lat, station.lng]);
            });
        })(s);

        content.appendChild(card);
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
// Task 10: Brand Filter
// ============================================================

function setupBrandFilter() {
    var btn = document.getElementById('brandFilterBtn');
    var dropdown = document.getElementById('brandDropdown');

    btn.addEventListener('click', function(e) {
        e.stopPropagation();
        dropdown.hidden = !dropdown.hidden;
        btn.classList.toggle('active', !dropdown.hidden);
        if (!dropdown.hidden) {
            populateBrandFilter();
        }
    });

    document.addEventListener('click', function(e) {
        if (!e.target.closest('.brand-filter-wrap')) {
            dropdown.hidden = true;
            btn.classList.remove('active');
        }
    });
}

function populateBrandFilter() {
    var dropdown = document.getElementById('brandDropdown');

    // Clear using DOM methods
    while (dropdown.firstChild) {
        dropdown.removeChild(dropdown.firstChild);
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
                renderMarkers();
                if (routePoints) {
                    updateCorridorFilter();
                }
            });

            var logo = document.createElement('img');
            logo.src = 'logos/' + brand.slug + '.svg';
            logo.alt = '';
            logo.style.cssText = 'width:16px;height:16px;flex-shrink:0;';
            logo.onerror = function() { this.src = 'logos/default.svg'; };

            var nameEl = document.createElement('span');
            nameEl.textContent = brand.name;

            item.appendChild(cb);
            item.appendChild(logo);
            item.appendChild(nameEl);
            dropdown.appendChild(item);
        })(brands[j]);
    }
}
