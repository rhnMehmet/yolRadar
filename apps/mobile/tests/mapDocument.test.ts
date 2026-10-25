/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { createMapDocument } from '../src/features/damage-map/mapDocument.ts';
import { ISPARTA_CENTER, demoMapMarkers } from '../src/features/damage-map/demoMapMarkers.ts';
import { MAP_RUNTIME_JS, LEAFLET_SCRIPT_HASH, MAP_RUNTIME_HASH, THIRD_PARTY_NOTICES } from '../src/features/damage-map/generated/leafletAssets.ts';
import { parseMapMessage } from '../src/features/damage-map/mapBridge.ts';

test('local HTML has exact script hashes, no remote scripts/frames, and three independent demo points', () => {
  const html = createMapDocument();
  const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 3);
  assert.doesNotMatch(html, /<script[^>]+src=|<iframe|<object/i);
  const data = JSON.parse(scripts[0][2]);
  assert.deepEqual(data.center, ISPARTA_CENTER);
  assert.equal(data.zoom, 14);
  assert.deepEqual(data.markers, demoMapMarkers);
  assert.equal(new Set(data.markers.map((p: { id: string }) => p.id)).size, 3);
  for (const [index, expected] of [[1, LEAFLET_SCRIPT_HASH], [2, MAP_RUNTIME_HASH]] as const) {
    const actual = createHash('sha256').update(scripts[index][2]).digest('base64');
    assert.equal(actual, expected);
    assert.ok(html.includes(`'sha256-${actual}'`));
  }
  const policy = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)![1];
  assert.match(policy, /img-src data: https:\/\/tile\.openstreetmap\.org;/);
  assert.match(policy, /connect-src 'none'; frame-src 'none'; object-src 'none'/);
  assert.doesNotMatch(policy.split('style-src')[0], /unsafe-inline|unsafe-eval|https:/);
  assert.doesNotMatch(html, /url\(["']?images\//);
  assert.match(THIRD_PARTY_NOTICES, /BSD 2-Clause/);
  assert.match(THIRD_PARTY_NOTICES, /MIT License/);
});

// Execute the actual packaged runtime with small Leaflet/DOM adapters. This checks
// bridge and lifecycle behavior; real map rendering/gestures remain device tests.
function runtimeHarness(withLeaflet = true) {
  const messages: ReturnType<typeof parseMapMessage>[] = [];
  const mapEvents: Record<string, (value?: unknown) => void> = {};
  const tileEvents: Record<string, () => void> = {};
  const windowEvents: Record<string, () => void> = {};
  const jobs = new Map<number, () => void>();
  const markers: { point: unknown; popup?: unknown }[] = [];
  let sequence = 0;
  let removed = false;
  let view: unknown;
  const map = {
    setView(point: unknown, zoom: number) { view = { point, zoom }; return this; },
    on(name: string, handler: (value?: unknown) => void) { mapEvents[name] = handler; return this; },
    invalidateSize() {}, remove() { removed = true; },
  };
  const layer = {
    on(name: string, handler: () => void) { tileEvents[name] = handler; return this; },
    addTo() { tileEvents.loading(); return this; },
  };
  const L = {
    map() { return map; }, tileLayer() { return layer; },
    circleMarker(point: unknown) {
      const marker: { point: unknown; popup?: unknown } = { point }; markers.push(marker);
      return { addTo() { return this; }, bindPopup(popup: unknown) { marker.popup = popup; return this; }, setLatLng(p: unknown) { marker.point = p; } };
    },
  };
  const context = {
    window: { L: withLeaflet ? L : undefined, ReactNativeWebView: { postMessage(raw: string) { messages.push(parseMapMessage(raw)); } }, addEventListener(name: string, handler: () => void) { windowEvents[name] = handler; } },
    document: {
      getElementById() { return { textContent: JSON.stringify({ v: 1, center: ISPARTA_CENTER, zoom: 14, markers: demoMapMarkers }) }; },
      createElement(tag: string) { return { tag, textContent: '', children: [] as unknown[], appendChild(child: unknown) { this.children.push(child); } }; },
    },
    setTimeout(fn: () => void) { jobs.set(++sequence, fn); return sequence; },
    clearTimeout(id: number) { jobs.delete(id); },
  };
  vm.runInNewContext(MAP_RUNTIME_JS, context, { timeout: 1000 });
  return { messages, mapEvents, tileEvents, windowEvents, jobs, markers, get view() { return view; }, get removed() { return removed; } };
}

test('runtime initializes Isparta and popups but does not claim tiles ready on HTML initialization', () => {
  const h = runtimeHarness();
  assert.deepEqual(JSON.parse(JSON.stringify(h.view)), { point: [37.7648, 30.5566], zoom: 14 });
  assert.equal(h.markers.length, 3);
  assert.ok(h.markers.every((m) => m.popup));
  assert.deepEqual(h.messages, [{ v: 1, type: 'map-ready' }, { v: 1, type: 'tiles-state', state: 'loading' }]);
  h.tileEvents.tileload(); h.tileEvents.load();
  assert.deepEqual(h.messages.at(-1), { v: 1, type: 'tiles-state', state: 'ready' });
  assert.equal(h.jobs.size, 0);
});

test('partial/all tile failures and stalled requests remain distinguishable', () => {
  const partial = runtimeHarness();
  partial.tileEvents.tileload(); partial.tileEvents.tileerror(); partial.tileEvents.load();
  assert.deepEqual(partial.messages.at(-1), { v: 1, type: 'tiles-state', state: 'partial-error' });
  const failed = runtimeHarness(); failed.tileEvents.tileerror(); failed.tileEvents.load();
  assert.deepEqual(failed.messages.at(-1), { v: 1, type: 'tiles-state', state: 'error' });
  const timeout = runtimeHarness(); [...timeout.jobs.values()].forEach((fn) => fn());
  assert.deepEqual(timeout.messages.at(-1), { v: 1, type: 'map-error', code: 'tile-timeout' });
});

test('runtime reports valid selected coordinates without confusing marker popups with selection', () => {
  const h = runtimeHarness();
  const click = (lat: number, lng: number) => h.mapEvents.click({ latlng: { wrap: () => ({ lat, lng }) } });
  click(37.77, 30.55);
  assert.deepEqual(h.messages.at(-1), { v: 1, type: 'point-selected', latitude: 37.77, longitude: 30.55 });
  assert.equal(h.markers.length, 4);
  click(37.78, 30.56);
  assert.equal(h.markers.length, 4, 'selection reuses one marker');
  const count = h.messages.length; click(NaN, 30); click(37, 181);
  assert.equal(h.messages.length, count);
});

test('page cleanup cancels work and reopening creates a fresh map without persisted selection', () => {
  const h = runtimeHarness(); h.windowEvents.pagehide();
  assert.equal(h.removed, true); assert.equal(h.jobs.size, 0);
  const count = h.messages.length; h.tileEvents.load();
  assert.equal(h.messages.length, count);
  const reopened = runtimeHarness();
  assert.equal(reopened.markers.length, 3);
  assert.equal(reopened.messages.some((m) => m?.type === 'point-selected'), false);
});

test('missing local Leaflet is an initialization error, not a successful map', () => {
  assert.deepEqual(runtimeHarness(false).messages, [{ v: 1, type: 'map-error', code: 'init-failed' }]);
});
