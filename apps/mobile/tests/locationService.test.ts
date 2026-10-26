/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { ForegroundLocationService } from '../src/features/location/locationService.ts';
import { FIRST_FIX_TIMEOUT_MS, HEALTH_CHECK_MS } from '../src/features/location/locationPolicy.ts';
import type { LocationClock, LocationPermission, LocationProvider, LocationSubscription } from '../src/features/location/locationTypes.ts';

const epoch = 1_800_000_000_000;
const granted: LocationPermission = { granted: true, canAskAgain: true, precision: 'full' };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

function harness() {
  let now = epoch;
  let permission = { ...granted };
  let services = true;
  let requests = 0;
  let reads = 0;
  let sequence = 0;
  const jobs = new Map<number, { due: number; callback: () => void }>();
  const watches: { emit: (raw: unknown) => void; error: () => void; removed: number }[] = [];
  const clock: LocationClock = { now: () => now, schedule(callback, delay) { const id = ++sequence; jobs.set(id, { due: now + delay, callback }); return () => { jobs.delete(id); }; } };
  const provider: LocationProvider = {
    async getPermission() { reads++; return permission; },
    async requestPermission() { requests++; return permission; },
    async servicesEnabled() { return services; },
    async watch(emit, error) { const watch = { emit, error, removed: 0 }; watches.push(watch); return { remove() { watch.removed++; } }; },
  };
  const service = new ForegroundLocationService(provider, clock);
  service.setAppState('active'); service.setEnabled(true);
  return {
    service, provider, watches, jobs,
    raw: (offset = 0) => ({ coords: { latitude: 37 + offset, longitude: 30, accuracy: 10 }, timestamp: now }),
    setPermission: (value: LocationPermission) => { permission = value; },
    setServices: (value: boolean) => { services = value; },
    get requests() { return requests; }, get reads() { return reads; },
    async advance(ms: number) { now += ms; for (const [id, job] of [...jobs]) if (job.due <= now && jobs.delete(id)) job.callback(); await flush(); },
  };
}

test('opening a map never requests permission or starts a native watch', () => {
  const h = harness();
  assert.equal(h.reads, 0); assert.equal(h.requests, 0); assert.equal(h.watches.length, 0);
  assert.equal(h.service.getSnapshot().fix, null);
});

test('one-shot centers one validated fix, removes its subscription and ignores late callbacks', async () => {
  const h = harness(); await h.service.locate();
  h.watches[0].emit(h.raw());
  assert.equal(h.service.getSnapshot().phase, 'ready');
  assert.equal(h.service.getSnapshot().centerRequest, 1);
  assert.equal(h.watches[0].removed, 1); assert.equal(h.jobs.size, 0);
  const snapshot = h.service.getSnapshot();
  await h.advance(1000); h.watches[0].emit(h.raw(.001));
  assert.equal(h.service.getSnapshot(), snapshot);
});

test('permission is requested only on a user operation and denial leaves the map independent', async () => {
  const h = harness(); h.setPermission({ granted: false, canAskAgain: true, precision: 'unknown' });
  await h.service.locate();
  assert.equal(h.requests, 1); assert.equal(h.watches.length, 0);
  assert.equal(h.service.getSnapshot().phase, 'denied');
  h.setPermission({ granted: false, canAskAgain: false, precision: 'unknown' });
  await h.service.startTracking();
  assert.equal(h.requests, 1); assert.equal(h.service.getSnapshot().canAskAgain, false);
});

test('an iOS permission prompt may temporarily become inactive, but no fix starts until active', async () => {
  const h = harness(); const answer = deferred<LocationPermission>();
  h.setPermission({ granted: false, canAskAgain: true, precision: 'unknown' });
  h.provider.requestPermission = () => answer.promise;
  const operation = h.service.locate(); await flush();
  h.service.setAppState('inactive'); answer.resolve(granted); await flush();
  assert.equal(h.watches.length, 0);
  h.service.setAppState('active'); await operation;
  assert.equal(h.watches.length, 1);
  h.service.dispose();
});

test('background during permission acquisition cancels intent and foreground does not restart', async () => {
  const h = harness(); const answer = deferred<LocationPermission>();
  h.setPermission({ granted: false, canAskAgain: true, precision: 'unknown' });
  h.provider.requestPermission = () => answer.promise;
  const operation = h.service.startTracking(); await flush();
  h.service.setAppState('background'); answer.resolve(granted); await operation;
  h.service.setAppState('active'); await flush();
  assert.equal(h.watches.length, 0); assert.equal(h.service.getSnapshot().mode, null);
});

test('disabled providers fail without starting a watch; rejected native calls expose no raw error', async () => {
  const h = harness(); h.setServices(false); await h.service.locate();
  assert.equal(h.watches.length, 0); assert.equal(h.service.getSnapshot().phase, 'error');
  h.provider.getPermission = async () => { throw Error('sensitive native detail'); };
  await h.service.startTracking();
  assert.doesNotMatch(h.service.getSnapshot().message, /sensitive/);
});

test('global services disabled takes priority when iOS also reports permission denied', async () => {
  for (const canAskAgain of [false, true]) {
    const h = harness(); h.setServices(false);
    h.setPermission({ granted: false, canAskAgain, precision: 'unknown' });
    await h.service.locate();
    assert.equal(h.service.getSnapshot().phase, 'error');
    assert.match(h.service.getSnapshot().message, /Konum servisleri kapalı/);
    assert.equal(h.requests, 0); assert.equal(h.watches.length, 0);
  }
  const h = harness(); await h.service.startTracking(); h.watches[0].emit(h.raw());
  h.setServices(false); h.setPermission({ granted: false, canAskAgain: false, precision: 'unknown' });
  await h.advance(HEALTH_CHECK_MS);
  assert.equal(h.service.getSnapshot().phase, 'error');
  assert.match(h.service.getSnapshot().message, /Konum servisleri kullanılamıyor/);
  assert.equal(h.watches[0].removed, 1); assert.equal(h.service.getSnapshot().fix, null);
});

test('double start never creates two watches and live updates do not force centering', async () => {
  const h = harness(); await Promise.all([h.service.startTracking(), h.service.startTracking()]);
  assert.equal(h.watches.length, 1);
  h.watches[0].emit(h.raw()); assert.equal(h.service.getSnapshot().centerRequest, 0);
  await h.advance(10000); h.watches[0].emit(h.raw(.0001));
  assert.equal(h.service.getSnapshot().fix?.latitude, 37.0001);
  await h.service.locate(); assert.equal(h.service.getSnapshot().centerRequest, 1);
  assert.equal(h.watches.length, 1);
  h.service.stop(); assert.equal(h.watches[0].removed, 1); assert.equal(h.service.getSnapshot().fix, null); assert.equal(h.jobs.size, 0);
});

test('first-fix timeout ignores stale data and closes the subscription', async () => {
  const h = harness(); await h.service.locate();
  h.watches[0].emit({ ...h.raw(), timestamp: epoch - 31000 });
  await h.advance(FIRST_FIX_TIMEOUT_MS);
  assert.equal(h.service.getSnapshot().phase, 'error'); assert.equal(h.watches[0].removed, 1);
  assert.equal(h.jobs.size, 0);
});

test('early first callback before watch Promise resolves is still released exactly once', async () => {
  const h = harness(); const pending = deferred<LocationSubscription>(); let removed = 0;
  h.provider.watch = async (emit) => { emit(h.raw()); return pending.promise; };
  const operation = h.service.locate(); await flush();
  assert.equal(h.service.getSnapshot().phase, 'ready');
  pending.resolve({ remove() { removed++; } }); await operation;
  assert.equal(removed, 1); assert.equal(h.jobs.size, 0);
});

test('cancelled asynchronous setup cannot restart tracking or overlap with a new native watch', async () => {
  const h = harness(); const pending = deferred<LocationSubscription>(); let starts = 0; let removed = 0;
  h.provider.watch = async () => { starts++; return pending.promise; };
  const operation = h.service.startTracking(); await flush(); h.service.stop();
  await h.service.startTracking(); assert.equal(starts, 1);
  pending.resolve({ remove() { removed++; } }); await operation;
  assert.equal(removed, 1); assert.equal(h.service.getSnapshot().mode, null); assert.equal(h.jobs.size, 0);
});

test('map error, inactive/background and screen disposal each stop and clear the live fix', async () => {
  for (const reason of ['disabled', 'inactive', 'background', 'dispose']) {
    const h = harness(); await h.service.startTracking(); h.watches[0].emit(h.raw());
    if (reason === 'disabled') h.service.setEnabled(false);
    else if (reason === 'dispose') h.service.dispose();
    else h.service.setAppState(reason);
    assert.equal(h.watches[0].removed, 1); assert.equal(h.service.getSnapshot().fix, null); assert.equal(h.jobs.size, 0);
    h.service.setAppState('active'); await flush(); assert.equal(h.watches.length, 1);
  }
});

test('revoked permission and disabled services are detected during a foreground watch', async () => {
  for (const cause of ['permission', 'services']) {
    const h = harness(); await h.service.startTracking(); h.watches[0].emit(h.raw());
    if (cause === 'permission') h.setPermission({ granted: false, canAskAgain: false, precision: 'unknown' });
    else h.setServices(false);
    await h.advance(HEALTH_CHECK_MS);
    assert.equal(h.watches[0].removed, 1); assert.equal(h.service.getSnapshot().fix, null); assert.equal(h.jobs.size, 0);
  }
});

test('watch errors stop updates and stale health promises cannot remove a later subscription', async () => {
  const h = harness(); await h.service.startTracking(); h.watches[0].emit(h.raw());
  const permission = deferred<LocationPermission>(); h.provider.getPermission = () => permission.promise;
  await h.advance(HEALTH_CHECK_MS); h.service.stop();
  h.provider.getPermission = async () => granted;
  await h.service.startTracking(); permission.resolve({ granted: false, canAskAgain: false, precision: 'unknown' }); await flush();
  assert.equal(h.watches[1].removed, 0);
  h.watches[1].error(); assert.equal(h.watches[1].removed, 1); assert.equal(h.service.getSnapshot().phase, 'error');
});

test('rejects a single implausible jump without replacing the last valid fix', async () => {
  const h = harness(); await h.service.startTracking(); h.watches[0].emit(h.raw());
  const previous = h.service.getSnapshot().fix;
  await h.advance(1000); h.watches[0].emit(h.raw(1));
  assert.equal(h.service.getSnapshot().fix, previous);
  h.service.dispose();
});
