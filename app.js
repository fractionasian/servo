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

// Init
function init() {
    map = L.map('map', { zoomControl: false }).setView(PERTH_CENTER, DEFAULT_ZOOM);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
        maxZoom: 19,
    }).addTo(map);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
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
        })
        .catch(function(err) {
            console.error('Failed to load prices:', err);
        });
}

function showUpdateBadge() {
    var badge = document.getElementById('update-badge');
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

    for (var i = 0; i < stations.length; i++) {
        var s = stations[i];
        var slug = brandToSlug(s.brand);

        if (hiddenBrands.has(slug)) continue;

        var ratio = (s.price - minP) / range;
        var colour = priceColour(ratio);
        var priceText = s.price.toFixed(1);

        var html = '<div class="price-marker" style="border-color:' + colour + ';color:' + colour + '">' +
            '<img src="logos/' + slug + '.svg" alt="" ' +
            'onerror="this.src=\'logos/default.svg\'" ' +
            'style="width:14px;height:14px;vertical-align:middle;margin-right:3px;">' +
            '<span>' + priceText + '</span>' +
            '</div>';

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
}

// ============================================================
// Utilities
// ============================================================

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
// Stubs — implemented in later tasks
// ============================================================

function setupFuelSelector() {}
function setupRoutePanel() {}
function setupBrandFilter() {}
