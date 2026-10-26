/* Runs only inside the local WebView document, never as a React Native module. */
(function () {
  'use strict';
  var map;
  var timeout;
  var stopped = false;
  var lastState;
  var successes = 0;
  var failures = 0;
  var selected;
  var config;
  var userMarker;
  var accuracyCircle;
  var lastSequence = 0;

  function send(message) {
    if (!stopped && window.ReactNativeWebView) {
      message.v = 2;
      message.session = config && config.session;
      window.ReactNativeWebView.postMessage(JSON.stringify(message));
    }
  }

  function tileState(state) {
    if (lastState === state) return;
    lastState = state;
    send({ v: 1, type: 'tiles-state', state: state });
  }

  function startTileTimeout() {
    clearTimeout(timeout);
    timeout = setTimeout(function () {
      if (successes === 0) {
        tileState('error');
        send({ v: 1, type: 'map-error', code: 'tile-timeout' });
      } else {
        tileState('partial-error');
      }
    }, 15000);
  }

  function cleanup() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timeout);
    window.removeEventListener('message', receiveLocation);
    document.removeEventListener('message', receiveLocation);
    if (map) map.remove();
  }

  function exactKeys(value, keys) {
    return Object.keys(value).length === keys.length
      && keys.every(function (key) { return Object.prototype.hasOwnProperty.call(value, key); });
  }

  function receiveLocation(event) {
    if (stopped || !map || typeof event.data !== 'string' || event.data.length > 2048) return;
    var value;
    try { value = JSON.parse(event.data); } catch (_) { return; }
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.v !== 2
      || value.session !== config.session || !Number.isSafeInteger(value.seq) || value.seq <= lastSequence) return;
    if (value.type === 'location-clear' && exactKeys(value, ['v', 'session', 'type', 'seq'])) {
      lastSequence = value.seq;
      if (userMarker) { map.removeLayer(userMarker); userMarker = null; }
      if (accuracyCircle) { map.removeLayer(accuracyCircle); accuracyCircle = null; }
      return;
    }
    if (value.type !== 'location-update'
      || !exactKeys(value, ['v', 'session', 'type', 'seq', 'latitude', 'longitude', 'accuracyMetres', 'timestampMs', 'center'])
      || typeof value.latitude !== 'number' || !Number.isFinite(value.latitude) || value.latitude < -90 || value.latitude > 90
      || typeof value.longitude !== 'number' || !Number.isFinite(value.longitude) || value.longitude < -180 || value.longitude > 180
      || !Number.isSafeInteger(value.timestampMs) || value.timestampMs <= 0
      || value.timestampMs > Date.now() + 5000 || Date.now() - value.timestampMs > 30000
      || typeof value.center !== 'boolean'
      || (value.accuracyMetres !== null && (typeof value.accuracyMetres !== 'number'
        || !Number.isFinite(value.accuracyMetres) || value.accuracyMetres < 0 || value.accuracyMetres > 100000))) return;
    lastSequence = value.seq;
    var point = [value.latitude, value.longitude];
    if (userMarker) userMarker.setLatLng(point);
    else userMarker = L.circleMarker(point, {
      radius: 9, color: '#FFFFFF', weight: 3, fillColor: '#2563EB', fillOpacity: 1, interactive: false,
    }).addTo(map);
    if (value.accuracyMetres !== null) {
      if (accuracyCircle) accuracyCircle.setLatLng(point).setRadius(value.accuracyMetres);
      else accuracyCircle = L.circle(point, {
        radius: value.accuracyMetres, color: '#2563EB', weight: 1, fillColor: '#2563EB', fillOpacity: 0.1, interactive: false,
      }).addTo(map);
    } else if (accuracyCircle) { map.removeLayer(accuracyCircle); accuracyCircle = null; }
    if (value.center) map.setView(point, value.accuracyMetres !== null && value.accuracyMetres > 500 ? 13 : Math.min(Math.max(map.getZoom(), 15), 17));
  }

  try {
    config = JSON.parse(document.getElementById('map-config').textContent);
    var L = window.L;
    if (!L || config.v !== 2 || typeof config.session !== 'string'
      || !/^[a-zA-Z0-9-]{1,64}$/.test(config.session) || config.markers.length !== 3) throw new Error('Invalid local map configuration');
    map = L.map('map', {
      zoomControl: true,
      attributionControl: true,
      worldCopyJump: true,
      zoomSnap: 1,
    }).setView([config.center.latitude, config.center.longitude], config.zoom);

    var tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      minZoom: 2,
      maxZoom: 19,
      updateWhenIdle: true,
      updateWhenZooming: false,
      keepBuffer: 1,
    });
    tiles.on('loading', function () {
      successes = 0;
      failures = 0;
      tileState('loading');
      startTileTimeout();
    });
    tiles.on('tileload', function () { successes += 1; });
    tiles.on('tileerror', function () { failures += 1; });
    tiles.on('load', function () {
      clearTimeout(timeout);
      tileState(failures ? (successes ? 'partial-error' : 'error') : 'ready');
    });

    config.markers.forEach(function (marker) {
      var content = document.createElement('div');
      var title = document.createElement('strong');
      title.textContent = marker.label;
      var detail = document.createElement('p');
      detail.textContent = marker.id + ' — Temsili nokta; gerçek hasar bildirimi değildir.';
      content.appendChild(title);
      content.appendChild(detail);
      L.circleMarker([marker.latitude, marker.longitude], {
        radius: 12,
        color: '#FFFFFF',
        weight: 3,
        fillColor: marker.color,
        fillOpacity: 1,
        bubblingMouseEvents: false,
      }).addTo(map).bindPopup(content, { maxWidth: 230 });
    });

    map.on('click', function (event) {
      var point = event.latlng.wrap();
      if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)
        || point.lat < -90 || point.lat > 90 || point.lng < -180 || point.lng > 180) return;
      if (selected) selected.setLatLng(point);
      else selected = L.circleMarker(point, {
        radius: 8, color: '#152E3A', weight: 3, fillColor: '#FFFFFF', fillOpacity: 1,
        interactive: false,
      }).addTo(map);
      send({ v: 1, type: 'point-selected', latitude: point.lat, longitude: point.lng });
    });

    window.addEventListener('pagehide', cleanup, { once: true });
    window.addEventListener('message', receiveLocation);
    document.addEventListener('message', receiveLocation);
    window.addEventListener('resize', function () { if (!stopped) map.invalidateSize(); });
    send({ v: 1, type: 'map-ready' });
    tiles.addTo(map);
    map.invalidateSize();
  } catch (_) {
    clearTimeout(timeout);
    send({ v: 1, type: 'map-error', code: 'init-failed' });
  }
}());
