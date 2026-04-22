// Config
var PRICES_URL = 'data/prices.json';
var HISTORY_URL = 'data/history.json';
var OSRM_URL = 'https://router.project-osrm.org/route/v1/driving/';
var NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
var CORRIDOR_RADIUS_KM = 2;
var PERTH_CENTER = [-31.95, 115.86];
var DEFAULT_ZOOM = 11;
var FETCH_TIMEOUT_MS = 10000;
var FUEL_ORDER = ['ulp', 'pulp', '98', 'diesel'];
var FUEL_LABEL = { ulp: 'ULP', pulp: 'PULP', '98': '98', diesel: 'Diesel' };
var DARK_TILES = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
var LIGHT_TILES = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
var TILE_ATTR = '&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>';

// State
var map = null;
var pricesData = null;
var historyData = null;
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
var tileLayer = null;
var lastCorridor = [];
var locationMarker = null;
var corridorCache = null;
var _suburbListCache = null;
var _stationsByFuelCache = {};
var _lastRenderKey = null;

// ============================================================
// Persistence
// ============================================================

function savePrefs() {
    try {
        localStorage.setItem('servo-fuel', activeFuel);
        localStorage.setItem('servo-hidden-brands', JSON.stringify(Array.from(hiddenBrands)));
    } catch (e) {}
}

function loadPrefs() {
    try {
        var fuel = localStorage.getItem('servo-fuel');
        if (fuel && FUEL_ORDER.indexOf(fuel) !== -1) activeFuel = fuel;
        var hidden = localStorage.getItem('servo-hidden-brands');
        if (hidden) hiddenBrands = new Set(JSON.parse(hidden));
    } catch (e) {}
}

// ============================================================
// Init
// ============================================================

function init() {
    map = L.map('map', { zoomControl: false }).setView(PERTH_CENTER, DEFAULT_ZOOM);
    setTileLayer();
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', setTileLayer);
    setupZoomButtons();

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
    setupKeyboardShortcuts();
    loadPrices();
    loadHistory();

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js').catch(function(e) {
            console.warn('SW registration failed:', e.message);
        });
    }
}

document.addEventListener('DOMContentLoaded', init);

// ============================================================
// Tile layer — auto day/night
// ============================================================

function isDarkMode() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function setTileLayer() {
    var url = isDarkMode() ? DARK_TILES : LIGHT_TILES;
    if (tileLayer) map.removeLayer(tileLayer);
    tileLayer = L.tileLayer(url, { attribution: TILE_ATTR, maxZoom: 19 }).addTo(map);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = isDarkMode() ? '#1a1d28' : '#ffffff';
}

function setupZoomButtons() {
    document.getElementById('zoomInBtn').addEventListener('click', function() { map.zoomIn(); });
    document.getElementById('zoomOutBtn').addEventListener('click', function() { map.zoomOut(); });
}

// ============================================================
// Data loading — with timeout, loading + error states
// ============================================================

function fetchWithTimeout(url, ms) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var opts = ctrl ? { signal: ctrl.signal } : {};
    var timer = setTimeout(function() { if (ctrl) ctrl.abort(); }, ms);
    return fetch(url, opts).finally(function() { clearTimeout(timer); });
}

function setBadge(text, kind) {
    var badge = document.getElementById('updateBadge');
    if (!badge) return;
    badge.textContent = text || '';
    badge.className = 'update-badge' + (kind ? ' ' + kind : '');
}

function loadPrices() {
    setBadge('Loading prices…', 'loading');
    fetchWithTimeout(PRICES_URL, FETCH_TIMEOUT_MS)
        .then(function(r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        })
        .then(function(data) {
            if (!data || !data.stations || !data.prices) {
                throw new Error('Invalid prices data');
            }
            pricesData = data;
            _stationsByFuelCache = {};
            _suburbListCache = null;
            validateActiveFuel();
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
            setBadge('Could not load prices — check connection.', 'error');
        });
}

function loadHistory() {
    fetchWithTimeout(HISTORY_URL, FETCH_TIMEOUT_MS)
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(data) { historyData = data; })
        .catch(function() { historyData = null; });
}

function validateActiveFuel() {
    if (!pricesData || !pricesData.prices || !pricesData.prices[activeFuel]) {
        activeFuel = 'ulp';
    }
}

function relativeTime(iso) {
    var then = new Date(iso).getTime();
    if (isNaN(then)) return '';
    var diffMin = Math.round((Date.now() - then) / 60000);
    if (diffMin < 1)   return 'just now';
    if (diffMin < 60)  return diffMin + ' min ago';
    var diffH = Math.round(diffMin / 60);
    if (diffH < 24)    return diffH + ' hr ago';
    var diffD = Math.round(diffH / 24);
    if (diffD < 7)     return diffD + ' day' + (diffD === 1 ? '' : 's') + ' ago';
    return new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

function showUpdateBadge() {
    if (!pricesData || !pricesData.updated) return;
    setBadge('Updated ' + relativeTime(pricesData.updated), '');
}

// ============================================================
// Station access — unified for new normalised schema
// ============================================================

function stationsFor(fuel) {
    if (_stationsByFuelCache[fuel]) return _stationsByFuelCache[fuel];
    if (!pricesData || !pricesData.prices || !pricesData.prices[fuel]) return [];
    var priceMap = pricesData.prices[fuel];
    var stations = pricesData.stations;
    var result = [];
    for (var i = 0; i < stations.length; i++) {
        var s = stations[i];
        var p = priceMap[s.id];
        if (p == null) continue;
        result.push({
            id:      s.id,
            station: s.name,
            brand:   s.brand,
            address: s.address,
            suburb:  s.suburb,
            lat:     s.lat,
            lng:     s.lng,
            price:   p,
        });
    }
    _stationsByFuelCache[fuel] = result;
    return result;
}

function priceFor(fuel, id) {
    if (!pricesData || !pricesData.prices || !pricesData.prices[fuel]) return null;
    var p = pricesData.prices[fuel][id];
    return p == null ? null : p;
}

// ============================================================
// Marker rendering
// ============================================================

function clearMarkers() {
    for (var i = 0; i < markers.length; i++) map.removeLayer(markers[i]);
    markers = [];
}

function zoomTier(z) {
    if (z <= 11) return 'dot';
    if (z <= 13) return 'pill';
    return 'full';
}

function renderMarkers() {
    if (!pricesData) return;
    var stations = stationsFor(activeFuel);
    if (stations.length === 0) { clearMarkers(); updatePriceSummary(); return; }

    var prices = stations.map(function(s) { return s.price; });
    var minP = Math.min.apply(null, prices);
    var maxP = Math.max.apply(null, prices);
    var range = maxP - minP || 1;

    var bounds = map.getBounds().pad(0.1);
    var tier = zoomTier(currentZoom);

    // Collision culling — grid sized per zoom tier
    var cellSize = tier === 'dot' ? 24 : tier === 'pill' ? 48 : 56;

    var visible = [];
    for (var i = 0; i < stations.length; i++) {
        var s = stations[i];
        if (hiddenBrands.has(brandToSlug(s.brand))) continue;
        if (!bounds.contains([s.lat, s.lng])) continue;
        visible.push(s);
    }
    visible.sort(function(a, b) { return a.price - b.price; });

    var occupiedCells = {};
    var kept = [];
    for (var j = 0; j < visible.length; j++) {
        var st = visible[j];
        var px = map.latLngToContainerPoint([st.lat, st.lng]);
        var key = Math.floor(px.x / cellSize) + ',' + Math.floor(px.y / cellSize);
        if (occupiedCells[key]) continue;
        occupiedCells[key] = true;
        kept.push(st);
    }

    // Skip full rebuild if visible set + tier are identical to last render
    var renderKey = tier + ':' + activeFuel + ':' + kept.map(function(s) { return s.id; }).join(',');
    if (renderKey === _lastRenderKey) {
        updatePriceSummary();
        return;
    }
    _lastRenderKey = renderKey;

    clearMarkers();

    for (var k = 0; k < kept.length; k++) {
        var sk = kept[k];
        var ratio = (sk.price - minP) / range;
        var colour = priceColour(ratio);
        var marker = buildMarker(sk, tier, colour);
        marker.addTo(map);
        markers.push(marker);
    }

    updatePriceSummary();
}

function buildMarker(s, tier, colour) {
    var slug = brandToSlug(s.brand);
    var priceText = s.price.toFixed(1);
    var logoSrc = brandLogoSrc(slug);
    var html, iconOpts = { className: '' };

    if (tier === 'dot') {
        html = '<div class="price-dot" style="background:' + colour + '"></div>';
        iconOpts.iconSize = [12, 12];
        iconOpts.iconAnchor = [6, 6];
    } else if (tier === 'pill') {
        html = '<div class="price-pill" style="border-color:' + colour + ';color:' + colour + '">' +
            '<img src="' + logoSrc + '" width="18" height="18" alt="" onerror="this.style.display=\'none\'">' +
            '<span>' + priceText + '</span></div>';
        iconOpts.iconSize = null;
        iconOpts.iconAnchor = [0, 10];
    } else {
        html = '<div class="price-marker" style="border-color:' + colour + ';color:' + colour + '">' +
            '<img src="' + logoSrc + '" width="24" height="24" alt="" onerror="this.style.display=\'none\'">' +
            '<span>' + priceText + '</span></div>';
        iconOpts.iconSize = null;
        iconOpts.iconAnchor = [0, 14];
    }
    iconOpts.html = html;

    var marker = L.marker([s.lat, s.lng], { icon: L.divIcon(iconOpts) });
    marker._servoStation = s;
    marker.bindPopup(buildPopupHtml(s), { maxWidth: 300, minWidth: 220 });
    return marker;
}

function buildPopupHtml(s) {
    var directionsUrl = 'https://www.google.com/maps/dir/?api=1&destination=' + s.lat + ',' + s.lng;
    var chips = '';
    for (var i = 0; i < FUEL_ORDER.length; i++) {
        var f = FUEL_ORDER[i];
        var p = priceFor(f, s.id);
        if (p == null) continue;
        var cls = 'popup-price-chip' + (f === activeFuel ? ' active-fuel' : '');
        chips += '<span class="' + cls + '"><strong>' + FUEL_LABEL[f] + '</strong> ' + fmtPrice(p) + '</span>';
    }
    var delta = historyDeltaChip(s.id, activeFuel);
    var spark = sparklineSvg(s.id, activeFuel);
    return '<div class="popup-name">' + escapeHtml(s.station) + '</div>' +
        '<div class="popup-brand">' + escapeHtml(s.brand) + '</div>' +
        '<div class="popup-prices">' + chips + '</div>' +
        (delta || spark ? '<div class="popup-trend">' + delta + spark + '</div>' : '') +
        '<div class="popup-address">' + escapeHtml(s.address) + ', ' + escapeHtml(s.suburb) + '</div>' +
        '<a class="popup-directions" href="' + directionsUrl + '" target="_blank" rel="noopener">Directions ↗</a>';
}

// ============================================================
// History: 7-day sparkline + delta chip
// ============================================================

function historySeries(id, fuel) {
    if (!historyData || !historyData.prices || !historyData.prices[fuel]) return null;
    var series = historyData.prices[fuel][id];
    return Array.isArray(series) && series.length ? series : null;
}

function historyDeltaChip(id, fuel) {
    var series = historySeries(id, fuel);
    if (!series || series.length < 2) return '';
    var current = series[series.length - 1];
    var previous = null;
    for (var i = series.length - 2; i >= 0; i--) {
        if (series[i] != null) { previous = series[i]; break; }
    }
    if (current == null || previous == null) return '';
    var diff = current - previous;
    if (Math.abs(diff) < 0.05) return '<span class="popup-delta flat">— unchanged</span>';
    var cls = diff > 0 ? 'up' : 'down';
    var arrow = diff > 0 ? '▲' : '▼';
    return '<span class="popup-delta ' + cls + '">' + arrow + ' ' + fmtPrice(Math.abs(diff)) + ' vs yesterday</span>';
}

function sparklineSvg(id, fuel) {
    var series = historySeries(id, fuel);
    if (!series || series.length < 3) return '';
    if (!historyData || !historyData.days) return '';
    var days = historyData.days;

    var points = [];
    for (var i = 0; i < series.length; i++) {
        if (series[i] != null) points.push({ i: i, v: series[i] });
    }
    if (points.length < 2) return '';
    var vs = points.map(function(p) { return p.v; });
    var minV = Math.min.apply(null, vs);
    var maxV = Math.max.apply(null, vs);
    var range = maxV - minV || 1;
    var W = 180, H = 36, PAD = 3;
    var n = series.length - 1 || 1;
    var d = points.map(function(p, idx) {
        var x = PAD + (p.i / n) * (W - PAD * 2);
        var y = PAD + (1 - (p.v - minV) / range) * (H - PAD * 2);
        return (idx === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');

    // Last point marker
    var last = points[points.length - 1];
    var lastX = PAD + (last.i / n) * (W - PAD * 2);
    var lastY = PAD + (1 - (last.v - minV) / range) * (H - PAD * 2);

    var firstDate = formatDayShort(days[0]);
    var lastDate = formatDayShort(days[days.length - 1]);
    var title = series.length + '-day range: ' + fmtPrice(minV) + ' – ' + fmtPrice(maxV);

    return '<div class="popup-spark-wrap" title="' + escapeHtml(title) + '">' +
        '<div class="popup-spark-range"><span>' + fmtPrice(maxV) + '</span><span>' + fmtPrice(minV) + '</span></div>' +
        '<svg class="popup-spark" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" aria-hidden="true">' +
          '<path d="' + d + '" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
          '<circle cx="' + lastX.toFixed(1) + '" cy="' + lastY.toFixed(1) + '" r="2.5" fill="currentColor"/>' +
        '</svg>' +
        '<div class="popup-spark-axis"><span>' + firstDate + '</span><span>' + lastDate + '</span></div>' +
      '</div>';
}

function formatDayShort(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

// ============================================================
// Utilities
// ============================================================

function updatePriceSummary() {
    var el = document.getElementById('priceSummary');
    if (!el) return;
    var stations = stationsFor(activeFuel);
    if (stations.length === 0) { el.textContent = ''; return; }
    var prices = stations.map(function(s) { return s.price; });
    var min = Math.min.apply(null, prices);
    var max = Math.max.apply(null, prices);
    var avg = prices.reduce(function(a, b) { return a + b; }, 0) / prices.length;
    el.textContent = fmtPrice(min) + ' – ' + fmtPrice(max) + ' · avg ' + fmtPrice(avg) + ' · ' + stations.length + ' stations';
}

function escapeHtml(str) {
    var d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
}

// Consistent price formatting: "199.9 ¢" — narrow no-break space before ¢
function fmtPrice(cents) {
    return cents.toFixed(1) + '  ¢';
}

function priceColour(ratio) {
    var r, g, b;
    if (ratio < 0.5) {
        var t = ratio * 2;
        r = Math.round(34  + t * (234 - 34));
        g = Math.round(197 + t * (179 - 197));
        b = Math.round(94  + t * (8   - 94));
    } else {
        var t = (ratio - 0.5) * 2;
        r = Math.round(234 + t * (239 - 234));
        g = Math.round(179 + t * (68  - 179));
        b = Math.round(8   + t * (68  - 8));
    }
    return 'rgb(' + r + ',' + g + ',' + b + ')';
}

function brandToSlug(brand) {
    return (brand || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function brandLogoSrc(slug) {
    return 'logos/' + slug + (BRANDS_WITH_PNG.has(slug) ? '.png' : '.svg');
}

// ============================================================
// Fuel Type Selector
// ============================================================

function setActiveFuel(fuel) {
    if (fuel === activeFuel || FUEL_ORDER.indexOf(fuel) === -1) return;
    activeFuel = fuel;
    savePrefs();
    var btns = document.querySelectorAll('[data-fuel]');
    for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('active', btns[i].dataset.fuel === fuel);
        btns[i].setAttribute('aria-pressed', btns[i].dataset.fuel === fuel ? 'true' : 'false');
    }
    _lastRenderKey = null;
    renderMarkers();
    if (routePoints) updateCorridorFilter();
}

function setupFuelSelector() {
    var buttons = document.querySelectorAll('[data-fuel]');
    for (var i = 0; i < buttons.length; i++) {
        var btn = buttons[i];
        var isActive = btn.dataset.fuel === activeFuel;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        btn.addEventListener('click', function() { setActiveFuel(this.dataset.fuel); });
    }
}

// ============================================================
// Cheapest Near Me
// ============================================================

function setupNearbyButton() {
    var btn = document.getElementById('nearbyBtn');
    btn.addEventListener('click', findNearby);
}

function findNearby() {
    if (!navigator.geolocation) return;
    var btn = document.getElementById('nearbyBtn');
    btn.classList.add('locating');
    navigator.geolocation.getCurrentPosition(function(pos) {
        btn.classList.remove('locating');
        showNearby(pos.coords.latitude, pos.coords.longitude);
    }, function() {
        btn.classList.remove('locating');
    });
}

function showNearby(lat, lng) {
    if (!pricesData) return;
    if (locationMarker) map.removeLayer(locationMarker);
    locationMarker = L.circleMarker([lat, lng], {
        radius: 8, color: '#fff', weight: 2,
        fillColor: '#4a9eff', fillOpacity: 1
    }).addTo(map).bindTooltip('You are here', { direction: 'top', offset: [0, -10] });

    var routePanel = document.getElementById('routePanel');
    var routeToggleBtn = document.getElementById('routeToggleBtn');
    if (routePanel) routePanel.hidden = true;
    if (routeToggleBtn) routeToggleBtn.classList.remove('active');

    var stations = stationsFor(activeFuel);
    var nearby = [];
    var hiddenBrandsCount = 0;
    for (var i = 0; i < stations.length; i++) {
        var d = haversine(lat, lng, stations[i].lat, stations[i].lng);
        if (d > 5) continue;
        if (hiddenBrands.has(brandToSlug(stations[i].brand))) {
            hiddenBrandsCount++;
            continue;
        }
        nearby.push({ station: stations[i], dist: d });
    }
    nearby.sort(function(a, b) { return a.station.price - b.station.price; });
    nearby = nearby.slice(0, 5);

    if (routePoints) clearRoute();
    renderNearbySidebar(nearby, hiddenBrandsCount);
    map.setView([lat, lng], 14);
}

function makeStationCard(station, rank, metaText, priceClass, clickFn) {
    var card = document.createElement('div');
    card.className = 'station-card';
    card.setAttribute('role', 'button');
    card.tabIndex = 0;

    var header = document.createElement('div');
    header.className = 'station-card-header';

    var nameGroup = document.createElement('div');
    nameGroup.className = 'station-card-namegroup';

    var rankSpan = document.createElement('span');
    rankSpan.className = 'station-card-rank';
    rankSpan.textContent = String(rank);

    var logo = document.createElement('img');
    logo.src = brandLogoSrc(brandToSlug(station.brand));
    logo.alt = '';
    logo.className = 'station-card-logo';
    logo.onerror = function() { this.style.display = 'none'; };

    var nameEl = document.createElement('span');
    nameEl.className = 'station-card-name';
    nameEl.textContent = station.station;

    nameGroup.appendChild(rankSpan);
    nameGroup.appendChild(logo);
    nameGroup.appendChild(nameEl);

    var priceEl = document.createElement('span');
    priceEl.className = 'station-card-price ' + priceClass;
    priceEl.textContent = fmtPrice(station.price);

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
    card.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); clickFn(); }
    });

    return card;
}

function emptyMessage(text) {
    var msg = document.createElement('div');
    msg.className = 'sidebar-empty';
    msg.textContent = text;
    return msg;
}

function renderNearbySidebar(nearby, hiddenBrandsCount) {
    var sidebar = document.getElementById('sidebar');
    var titleEl = document.getElementById('sidebarTitle');
    titleEl.textContent = 'Cheapest near you';
    var content = document.getElementById('sidebarContent');
    while (content.firstChild) content.removeChild(content.firstChild);

    if (nearby.length === 0) {
        if (hiddenBrandsCount > 0) {
            content.appendChild(emptyMessage(
                'All ' + hiddenBrandsCount + ' nearby station(s) are filtered out by your brand filter.'
            ));
        } else {
            content.appendChild(emptyMessage('No stations within 5km.'));
        }
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
// Route Panel + Suburb/Station/Address Autocomplete
// ============================================================

function getSuburbList() {
    if (_suburbListCache) return _suburbListCache;
    if (!pricesData || !pricesData.stations) return [];
    var seen = {};
    var result = [];
    for (var i = 0; i < pricesData.stations.length; i++) {
        var s = pricesData.stations[i];
        var key = (s.suburb || '').toLowerCase();
        if (key && !seen[key]) {
            seen[key] = true;
            result.push({ type: 'suburb', label: s.suburb, lat: s.lat, lng: s.lng });
        }
    }
    result.sort(function(a, b) { return a.label.localeCompare(b.label); });
    _suburbListCache = result;
    return result;
}

function localAutocompleteMatches(query) {
    var q = query.toLowerCase();
    var results = [];
    var seenKeys = {};

    function push(item, key) {
        if (seenKeys[key]) return;
        seenKeys[key] = true;
        results.push(item);
    }

    // Suburbs — highest priority
    var suburbs = getSuburbList();
    for (var i = 0; i < suburbs.length && results.length < 10; i++) {
        if (suburbs[i].label.toLowerCase().indexOf(q) !== -1) {
            push(suburbs[i], 'sub:' + suburbs[i].label.toLowerCase());
        }
    }

    // Stations — name or address
    if (pricesData && pricesData.stations) {
        for (var j = 0; j < pricesData.stations.length && results.length < 15; j++) {
            var s = pricesData.stations[j];
            var hay = ((s.name || '') + ' ' + (s.address || '') + ' ' + (s.suburb || '')).toLowerCase();
            if (hay.indexOf(q) !== -1) {
                push({
                    type:  'station',
                    label: s.name + ' — ' + s.suburb,
                    sub:   s.address,
                    lat:   s.lat,
                    lng:   s.lng,
                }, 'stn:' + s.id);
            }
        }
    }

    return results.slice(0, 10);
}

var _nominatimTimers = {};

function nominatimFallback(input, list, query) {
    if (_nominatimTimers[input.id]) clearTimeout(_nominatimTimers[input.id]);
    _nominatimTimers[input.id] = setTimeout(function() {
        var url = NOMINATIM_URL + '?format=json&limit=5&countrycodes=au&viewbox=115.5,-31.5,116.3,-32.3&bounded=1&q=' + encodeURIComponent(query);
        fetchWithTimeout(url, 5000)
            .then(function(r) { return r.json(); })
            .then(function(data) {
                if (input.value.trim().toLowerCase() !== query) return; // stale
                if (!data || data.length === 0) return;
                if (list.querySelector('.autocomplete-item')) return; // local hits already shown
                clearDropdown(list);
                for (var i = 0; i < data.length; i++) {
                    (function(d) {
                        var el = document.createElement('div');
                        el.className = 'autocomplete-item';
                        el.textContent = d.display_name.split(',').slice(0, 2).join(', ');
                        el.addEventListener('mousedown', function(e) {
                            e.preventDefault();
                            input.value = el.textContent;
                            input.dataset.lat = d.lat;
                            input.dataset.lng = d.lon;
                            list.hidden = true;
                        });
                        list.appendChild(el);
                    })(data[i]);
                }
                list.hidden = false;
            })
            .catch(function() {});
    }, 300);
}

function clearDropdown(listEl) {
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
}

function showAutocomplete(input) {
    var listId = input.id === 'fromInput' ? 'fromAutocomplete' : 'toAutocomplete';
    var list = document.getElementById(listId);
    var query = input.value.trim().toLowerCase();
    clearDropdown(list);

    if (!query) { list.hidden = true; return; }

    var results = localAutocompleteMatches(query);

    if (results.length === 0) {
        list.hidden = true;
        nominatimFallback(input, list, query);
        return;
    }

    for (var r = 0; r < results.length; r++) {
        (function(item) {
            var el = document.createElement('div');
            el.className = 'autocomplete-item';
            var main = document.createElement('div');
            main.textContent = item.label;
            el.appendChild(main);
            if (item.sub) {
                var sub = document.createElement('div');
                sub.className = 'autocomplete-sub';
                sub.textContent = item.sub;
                el.appendChild(sub);
            }
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

    toggleBtn.addEventListener('click', function() {
        panel.hidden = !panel.hidden;
        toggleBtn.classList.toggle('active', !panel.hidden);
    });

    fromInput.addEventListener('input', function() { showAutocomplete(fromInput); });
    toInput.addEventListener('input', function() { showAutocomplete(toInput); });

    document.addEventListener('click', function(e) {
        if (!e.target.closest('.route-panel')) {
            document.getElementById('fromAutocomplete').hidden = true;
            document.getElementById('toAutocomplete').hidden = true;
        }
    });

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

    goBtn.addEventListener('click', function() {
        var fromLat = parseFloat(fromInput.dataset.lat);
        var fromLng = parseFloat(fromInput.dataset.lng);
        var toLat = parseFloat(toInput.dataset.lat);
        var toLng = parseFloat(toInput.dataset.lng);
        if (isNaN(fromLat) || isNaN(fromLng) || isNaN(toLat) || isNaN(toLng)) return;
        fetchRoute(fromLng, fromLat, toLng, toLat);
    });

    clearBtn.addEventListener('click', clearRoute);
    if (sidebarCloseBtn) sidebarCloseBtn.addEventListener('click', closeSidebar);
}

function closeSidebar() {
    var sidebar = document.getElementById('sidebar');
    sidebar.hidden = true;
    if (routePoints) clearRoute(true);
}

// ============================================================
// OSRM Routing
// ============================================================

function fetchRoute(fromLng, fromLat, toLng, toLat) {
    var url = OSRM_URL + fromLng + ',' + fromLat + ';' + toLng + ',' + toLat +
              '?overview=simplified&geometries=polyline';
    return fetchWithTimeout(url, FETCH_TIMEOUT_MS)
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
        .catch(function(err) { console.error('OSRM fetch error:', err); });
}

function drawRoute() {
    if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
    if (!routePoints || routePoints.length === 0) return;
    routeLine = L.polyline(routePoints, { color: '#4a9eff', weight: 4, opacity: 0.8 }).addTo(map);
    map.fitBounds(routeLine.getBounds(), { padding: [40, 40] });
}

function clearRoute(keepLocationMarker) {
    if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
    if (!keepLocationMarker && locationMarker) { map.removeLayer(locationMarker); locationMarker = null; }
    routePoints = null;
    corridorCache = null;
    var sidebar = document.getElementById('sidebar');
    sidebar.hidden = true;
    var titleEl = document.getElementById('sidebarTitle');
    if (titleEl) titleEl.textContent = 'On your route';
    for (var i = 0; i < markers.length; i++) {
        var el = markers[i].getElement();
        if (!el) continue;
        var inner = el.querySelector('.price-marker, .price-pill, .price-dot');
        if (inner) inner.classList.remove('dimmed');
    }
}

function decodePolyline(encoded) {
    var result = [];
    var index = 0, lat = 0, lng = 0;
    while (index < encoded.length) {
        var b, shift, result_val;
        shift = 0; result_val = 0;
        do {
            b = encoded.charCodeAt(index++) - 63;
            result_val |= (b & 0x1f) << shift;
            shift += 5;
        } while (b >= 0x20);
        lat += (result_val & 1) ? ~(result_val >> 1) : (result_val >> 1);

        shift = 0; result_val = 0;
        do {
            b = encoded.charCodeAt(index++) - 63;
            result_val |= (b & 0x1f) << shift;
            shift += 5;
        } while (b >= 0x20);
        lng += (result_val & 1) ? ~(result_val >> 1) : (result_val >> 1);

        result.push([lat / 1e5, lng / 1e5]);
    }
    return result;
}

// ============================================================
// Corridor Filtering + Results Sidebar
// ============================================================

function updateCorridorFilter() {
    if (!routePoints || !pricesData) return;
    var stations = stationsFor(activeFuel);
    if (stations.length === 0) return;

    var corridor = [];
    for (var i = 0; i < stations.length; i++) {
        var s = stations[i];
        if (hiddenBrands.has(brandToSlug(s.brand))) continue;
        var dist = minDistToRoute(s.lat, s.lng, routePoints);
        if (dist <= CORRIDOR_RADIUS_KM) corridor.push({ station: s, dist: dist });
    }

    corridorCache = corridor.slice();
    lastCorridor = corridor.slice();

    if (corridorSortByDist) corridor.sort(function(a, b) { return a.dist - b.dist; });
    else                    corridor.sort(function(a, b) { return a.station.price - b.station.price; });

    applyCorridorDimming();
    renderSidebar(corridor);
}

function applyCorridorDimming() {
    if (!corridorCache) return;
    var corridorSet = new Set();
    for (var c = 0; c < corridorCache.length; c++) corridorSet.add(corridorCache[c].station.id);
    for (var j = 0; j < markers.length; j++) {
        var m = markers[j];
        var el = m.getElement();
        if (!el) continue;
        var inner = el.querySelector('.price-marker, .price-pill, .price-dot');
        if (!inner) continue;
        inner.classList.toggle('dimmed', !corridorSet.has(m._servoStation.id));
    }
}

function renderSidebar(corridor) {
    var sidebar = document.getElementById('sidebar');
    var content = document.getElementById('sidebarContent');
    while (content.firstChild) content.removeChild(content.firstChild);

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
                s, rank,
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
            if (corridorSortByDist) sorted.sort(function(a, b) { return a.dist - b.dist; });
            else                    sorted.sort(function(a, b) { return a.station.price - b.station.price; });
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

    modal.addEventListener('click', function(e) {
        if (e.target === modal) {
            modal.hidden = true;
            btn.classList.remove('active');
        }
    });
}

function populateBrandFilter() {
    var body = document.getElementById('brandModalBody');
    while (body.firstChild) body.removeChild(body.firstChild);
    if (!pricesData || !pricesData.stations) return;

    var priceMap = pricesData.prices[activeFuel] || {};
    var brandsSeen = {};
    var brands = [];
    for (var i = 0; i < pricesData.stations.length; i++) {
        var s = pricesData.stations[i];
        if (priceMap[s.id] == null) continue; // only brands that sell active fuel
        var slug = brandToSlug(s.brand);
        if (!brandsSeen[slug]) {
            brandsSeen[slug] = true;
            brands.push({ name: s.brand, slug: slug });
        }
    }
    brands.sort(function(a, b) { return a.name.localeCompare(b.name); });

    var actions = document.createElement('div');
    actions.className = 'brand-modal-actions';
    var selectAllBtn = document.createElement('button');
    selectAllBtn.className = 'brand-action-btn';
    selectAllBtn.textContent = 'Select all';
    selectAllBtn.addEventListener('click', function() {
        hiddenBrands.clear();
        savePrefs();
        populateBrandFilter();
        _lastRenderKey = null;
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
        _lastRenderKey = null;
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
                if (this.checked) hiddenBrands.delete(brand.slug);
                else              hiddenBrands.add(brand.slug);
                savePrefs();
                _lastRenderKey = null;
                renderMarkers();
                if (routePoints) updateCorridorFilter();
            });

            var logo = document.createElement('img');
            logo.src = brandLogoSrc(brand.slug);
            logo.alt = '';
            logo.className = 'brand-dropdown-logo';
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

// ============================================================
// Keyboard shortcuts — 1/2/3/4 fuels, F find, B brands, Esc close
// ============================================================

function setupKeyboardShortcuts() {
    document.addEventListener('keydown', function(e) {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        var tag = (document.activeElement && document.activeElement.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;

        switch (e.key) {
            case '1': setActiveFuel('ulp'); break;
            case '2': setActiveFuel('pulp'); break;
            case '3': setActiveFuel('98'); break;
            case '4': setActiveFuel('diesel'); break;
            case 'f': case 'F': findNearby(); break;
            case 'b': case 'B': document.getElementById('brandFilterBtn').click(); break;
            case 'Escape':
                var modal = document.getElementById('brandModal');
                if (modal && !modal.hidden) {
                    modal.hidden = true;
                    document.getElementById('brandFilterBtn').classList.remove('active');
                    return;
                }
                var sidebar = document.getElementById('sidebar');
                if (sidebar && !sidebar.hidden) { closeSidebar(); return; }
                var panel = document.getElementById('routePanel');
                if (panel && !panel.hidden) {
                    panel.hidden = true;
                    var t = document.getElementById('routeToggleBtn');
                    if (t) t.classList.remove('active');
                }
                break;
            default: return;
        }
    });
}
