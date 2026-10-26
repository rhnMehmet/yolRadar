/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { isFreshLocation, isPlausibleLocation, MAX_LOCATION_AGE_MS, normalizeLocation } from '../src/features/location/locationPolicy.ts';

const now = 1_800_000_000_000;
const raw = (extra = {}) => ({ coords: { latitude: 37, longitude: 30, accuracy: 10 }, timestamp: now, ...extra });

test('normalizes only the required current fix and preserves coordinate order and zero', () => {
  assert.deepEqual(normalizeLocation(raw(), now, 'full'), { latitude: 37, longitude: 30, accuracyMetres: 10, timestampMs: now, approximate: false });
  assert.equal(normalizeLocation(raw({ coords: { latitude: 0, longitude: 0, accuracy: 0 } }), now, 'full')?.longitude, 0);
});

test('rejects invalid, coercible and out-of-range coordinates', () => {
  for (const coords of [{ latitude: '37', longitude: 30 }, { latitude: Infinity, longitude: 0 }, { latitude: 91, longitude: 0 }, { latitude: 0, longitude: -181 }, {}]) {
    assert.equal(normalizeLocation(raw({ coords }), now, 'full'), null);
  }
  for (const input of [null, false, [], 'text', {}]) assert.equal(normalizeLocation(input, now, 'full'), null);
});

test('stale, future, missing and non-finite timestamps cannot become current fixes', () => {
  for (const timestamp of [now - MAX_LOCATION_AGE_MS - 1, now + 5001, 0, NaN, Infinity, '1800000000000', undefined]) {
    assert.equal(normalizeLocation(raw({ timestamp }), now, 'full'), null);
  }
  assert.ok(normalizeLocation(raw({ timestamp: now - MAX_LOCATION_AGE_MS }), now, 'full'));
});

test('reduced precision and poor or missing accuracy remain explicitly approximate', () => {
  assert.equal(normalizeLocation(raw(), now, 'reduced')?.approximate, true);
  assert.equal(normalizeLocation(raw({ coords: { latitude: 37, longitude: 30, accuracy: 80 } }), now, 'full')?.approximate, true);
  for (const accuracy of [null, -1, Infinity, NaN, 100001, '10']) {
    const fix = normalizeLocation(raw({ coords: { latitude: 37, longitude: 30, accuracy } }), now, 'full');
    assert.equal(fix?.accuracyMetres, null); assert.equal(fix?.approximate, true);
  }
});

test('freshness expires without manufacturing a new sample for a stationary user', () => {
  const fix = normalizeLocation(raw(), now, 'full')!;
  assert.equal(isFreshLocation(fix, now + 30000), true);
  assert.equal(isFreshLocation(fix, now + 30001), false);
  assert.equal(isFreshLocation(null, now), false);
});

test('filters backwards/duplicate times and extreme jumps while allowing normal walking and uncertainty', () => {
  const previous = normalizeLocation(raw(), now, 'full')!;
  assert.equal(isPlausibleLocation(null, previous), true);
  assert.equal(isPlausibleLocation(previous, previous), false);
  assert.equal(isPlausibleLocation(previous, { ...previous, timestampMs: now - 1 }), false);
  assert.equal(isPlausibleLocation(previous, { ...previous, latitude: 37.0001, timestampMs: now + 10000 }), true);
  assert.equal(isPlausibleLocation(previous, { ...previous, latitude: 38, timestampMs: now + 1000 }), false);
  assert.equal(isPlausibleLocation(previous, { ...previous, latitude: 37.005, accuracyMetres: 1000, timestampMs: now + 1000 }), true);
});
