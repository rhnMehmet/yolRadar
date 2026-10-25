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

  function send(message) {
    if (!stopped && window.ReactNativeWebView) {
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
    if (map) map.remove();
  }

  try {
    var config = JSON.parse(document.getElementById('map-config').textContent);
    var L = window.L;
    if (!L || config.v !== 1 || config.markers.length !== 3) throw new Error('Invalid local map configuration');
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
    window.addEventListener('resize', function () { if (!stopped) map.invalidateSize(); });
    send({ v: 1, type: 'map-ready' });
    tiles.addTo(map);
    map.invalidateSize();
  } catch (_) {
    clearTimeout(timeout);
    send({ v: 1, type: 'map-error', code: 'init-failed' });
  }
}());
