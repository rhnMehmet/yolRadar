/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { createMapDocument } from '../src/features/damage-map/mapDocument.ts';
import { ISPARTA_CENTER, demoMapMarkers } from '../src/features/damage-map/demoMapMarkers.ts';
import { MAP_RUNTIME_JS, LEAFLET_SCRIPT_HASH, MAP_RUNTIME_HASH, THIRD_PARTY_NOTICES } from '../src/features/damage-map/generated/leafletAssets.ts';
import { parseMapMessage } from '../src/features/damage-map/mapBridge.ts';

const SESSION = 'roadsense-test';
const now = 1_800_000_000_000;
const event = (value: object) => ({ v: 2, session: SESSION, ...value });

test('local HTML has exact script hashes, no remote scripts/frames, and three independent demo points', () => {
  const html = createMapDocument(SESSION);
  assert.throws(() => createMapDocument('</script>'));
  const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 3); assert.doesNotMatch(html, /<script[^>]+src=|<iframe|<object/i);
  const data = JSON.parse(scripts[0][2]);
  assert.equal(data.v, 2); assert.equal(data.session, SESSION);
  assert.deepEqual(data.center, ISPARTA_CENTER); assert.equal(data.zoom, 14); assert.deepEqual(data.markers, demoMapMarkers);
  assert.equal(new Set(data.markers.map((p: { id: string }) => p.id)).size, 3);
  for (const [index, expected] of [[1, LEAFLET_SCRIPT_HASH], [2, MAP_RUNTIME_HASH]] as const) {
    const actual = createHash('sha256').update(scripts[index][2]).digest('base64');
    assert.equal(actual, expected); assert.ok(html.includes(`'sha256-${actual}'`));
  }
  const policy = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)![1];
  assert.match(policy, /img-src data: https:\/\/tile\.openstreetmap\.org;/);
  assert.match(policy, /connect-src 'none'; frame-src 'none'; object-src 'none'/);
  assert.doesNotMatch(policy.split('style-src')[0], /unsafe-inline|unsafe-eval|https:/);
  assert.doesNotMatch(html, /url\(["']?images\//);
  assert.match(THIRD_PARTY_NOTICES, /BSD 2-Clause/); assert.match(THIRD_PARTY_NOTICES, /MIT License/);
  assert.ok(THIRD_PARTY_NOTICES.endsWith('\n') && !THIRD_PARTY_NOTICES.endsWith('\n\n'));
});

// Real packaged runtime, small DOM/Leaflet adapters; this is not a native/device rendering test.
function runtimeHarness(withLeaflet = true) {
  const messages: ReturnType<typeof parseMapMessage>[] = [];
  type Handler = (value?: unknown) => void;
  const mapEvents: Record<string, Handler> = {}, tileEvents: Record<string, () => void> = {};
  const windowEvents: Record<string, Handler> = {}, documentEvents: Record<string, Handler> = {};
  const jobs = new Map<number, () => void>();
  type Marker = { point: unknown; popup?: unknown; radius?: number; removed?: boolean };
  const markers: Marker[] = [], circles: Marker[] = [];
  let sequence = 0, removed = false;
  let view: { point: unknown; zoom: number } | undefined;
  const map = {
    setView(point: unknown, zoom: number) { view = { point, zoom }; return this; }, getZoom() { return view?.zoom ?? 14; },
    on(name: string, handler: Handler) { mapEvents[name] = handler; return this; },
    invalidateSize() {}, remove() { removed = true; }, removeLayer(item: { data: Marker }) { item.data.removed = true; },
  };
  const layer = { on(name: string, handler: () => void) { tileEvents[name] = handler; return this; }, addTo() { tileEvents.loading(); return this; } };
  function marker(point: unknown, options: { radius: number }, list: Marker[]) {
    const data: Marker = { point, radius: options.radius }; list.push(data);
    return { data, addTo() { return this; }, bindPopup(popup: unknown) { data.popup = popup; return this; }, setLatLng(p: unknown) { data.point = p; return this; }, setRadius(r: number) { data.radius = r; return this; } };
  }
  const L = { map() { return map; }, tileLayer() { return layer; }, circleMarker(p: unknown, o: { radius: number }) { return marker(p, o, markers); }, circle(p: unknown, o: { radius: number }) { return marker(p, o, circles); } };
  const context = {
    window: { L: withLeaflet ? L : undefined, ReactNativeWebView: { postMessage(raw: string) { messages.push(parseMapMessage(raw, SESSION)); } }, addEventListener(name: string, handler: Handler) { windowEvents[name] = handler; }, removeEventListener(name: string) { delete windowEvents[name]; } },
    document: {
      getElementById() { return { textContent: JSON.stringify({ v: 2, session: SESSION, center: ISPARTA_CENTER, zoom: 14, markers: demoMapMarkers }) }; },
      createElement(tag: string) { return { tag, textContent: '', children: [] as unknown[], appendChild(child: unknown) { this.children.push(child); } }; },
      addEventListener(name: string, handler: Handler) { documentEvents[name] = handler; }, removeEventListener(name: string) { delete documentEvents[name]; },
    },
    Date: { now: () => now },
    setTimeout(fn: () => void) { jobs.set(++sequence, fn); return sequence; }, clearTimeout(id: number) { jobs.delete(id); },
  };
  vm.runInNewContext(MAP_RUNTIME_JS, context, { timeout: 1000 });
  return { messages, mapEvents, tileEvents, windowEvents, documentEvents, jobs, markers, circles,
    receive(command: unknown, platform: 'ios' | 'android' = 'ios') { (platform === 'ios' ? windowEvents : documentEvents).message?.({ data: typeof command === 'string' ? command : JSON.stringify(command) }); },
    get view() { return view; }, get removed() { return removed; } };
}

test('runtime initializes Isparta and popups but does not claim tiles ready on HTML initialization', () => {
  const h = runtimeHarness();
  assert.deepEqual(JSON.parse(JSON.stringify(h.view)), { point: [37.7648, 30.5566], zoom: 14 });
  assert.equal(h.markers.length, 3); assert.ok(h.markers.every((m) => m.popup));
  assert.deepEqual(h.messages, [event({ type: 'map-ready' }), event({ type: 'tiles-state', state: 'loading' })]);
  h.tileEvents.tileload(); h.tileEvents.load();
  assert.deepEqual(h.messages.at(-1), event({ type: 'tiles-state', state: 'ready' })); assert.equal(h.jobs.size, 0);
});

test('partial/all tile failures and stalled requests remain distinguishable', () => {
  const partial = runtimeHarness(); partial.tileEvents.tileload(); partial.tileEvents.tileerror(); partial.tileEvents.load();
  assert.deepEqual(partial.messages.at(-1), event({ type: 'tiles-state', state: 'partial-error' }));
  const failed = runtimeHarness(); failed.tileEvents.tileerror(); failed.tileEvents.load();
  assert.deepEqual(failed.messages.at(-1), event({ type: 'tiles-state', state: 'error' }));
  const timeout = runtimeHarness(); [...timeout.jobs.values()].forEach((fn) => fn());
  assert.deepEqual(timeout.messages.at(-1), event({ type: 'map-error', code: 'tile-timeout' }));
});

test('runtime reports valid selected coordinates without confusing marker popups with selection', () => {
  const h = runtimeHarness(); const click = (lat: number, lng: number) => h.mapEvents.click({ latlng: { wrap: () => ({ lat, lng }) } });
  click(37.77, 30.55); assert.deepEqual(h.messages.at(-1), event({ type: 'point-selected', latitude: 37.77, longitude: 30.55 }));
  assert.equal(h.markers.length, 4); click(37.78, 30.56); assert.equal(h.markers.length, 4);
  const count = h.messages.length; click(NaN, 30); click(37, 181); assert.equal(h.messages.length, count);
});

test('page cleanup cancels work and reopening creates a fresh map without persisted selection', () => {
  const h = runtimeHarness(); h.windowEvents.pagehide();
  assert.equal(h.removed, true); assert.equal(h.jobs.size, 0);
  assert.equal(h.windowEvents.message, undefined); assert.equal(h.documentEvents.message, undefined);
  const count = h.messages.length; h.tileEvents.load(); assert.equal(h.messages.length, count);
  assert.equal(runtimeHarness().markers.length, 3);
});

test('missing local Leaflet is an initialization error, not a successful map', () => {
  assert.deepEqual(runtimeHarness(false).messages, [event({ type: 'map-error', code: 'init-failed' })]);
});

const update = (seq: number, extra = {}) => event({ type: 'location-update', seq, latitude: 37.77, longitude: 30.55, accuracyMetres: 12, timestampMs: now, center: false, ...extra });

test('v2 GPS messages update one blue marker/circle without moving camera or deleting demos/selection', () => {
  const h = runtimeHarness(); const initial = h.view;
  h.receive(update(1)); assert.equal(h.markers.length, 4); assert.equal(h.circles.length, 1); assert.equal(h.view, initial);
  h.receive(update(1), 'android'); assert.equal(h.markers.length, 4, 'dual-platform duplicate is ignored');
  h.receive(update(2, { latitude: 37.771, accuracyMetres: 20 }), 'android');
  assert.equal(h.markers.length, 4); assert.equal(h.circles[0].radius, 20); assert.equal(h.view, initial);
  h.receive(update(3, { center: true })); assert.notEqual(h.view, initial);
  h.mapEvents.click({ latlng: { wrap: () => ({ lat: 37.8, lng: 30.6 }) } });
  assert.equal(h.markers.length, 5);
  h.receive(event({ type: 'location-clear', seq: 4 }));
  assert.equal(h.markers[3].removed, true); assert.equal(h.circles[0].removed, true);
  assert.ok(h.markers.slice(0, 3).every(m => m.popup && !m.removed)); assert.notEqual(h.markers[4].removed, true);
});

test('runtime rejects old sessions/sequences, oversized/malformed messages and invalid numeric fields', () => {
  const h = runtimeHarness();
  for (const input of ['{', 'x'.repeat(2049), null, [], update(0), update(1, { session: 'old' }), update(1, { v: 1 }),
    update(1, { latitude: '37' }), update(1, { longitude: 181 }), update(1, { accuracyMetres: -1 }),
    update(1, { timestampMs: now - 30001 }), update(1, { timestampMs: now + 5001 }), update(1, { center: 'true' }), update(1, { code: 'eval()' }),
  ]) h.receive(input);
  assert.equal(h.markers.length, 3); assert.equal(h.circles.length, 0);
  h.receive(update(2)); h.receive(update(1, { center: true })); assert.equal(h.view?.zoom, 14);
  h.receive(update(3, { accuracyMetres: null })); assert.equal(h.circles[0].removed, true);
});
