/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMapMessage, parseMapCommand, serializeMapCommand, MAX_MAP_MESSAGE_LENGTH, getAttributionUrl, isDocumentNavigationAllowed, escapeDocumentJson } from '../src/features/damage-map/mapBridge.ts';
import type { MapCommand } from '../src/features/damage-map/mapBridge.ts';

const SESSION = 'roadsense-test';
const now = 1_800_000_000_000;
const envelope = { v: 2, session: SESSION };
const parse = (value: unknown) => parseMapMessage(JSON.stringify(value), SESSION);

test('accepts only the finite, versioned map protocol for the current session', () => {
  for (const value of [
    { ...envelope, type: 'map-ready' },
    ...['loading', 'ready', 'partial-error', 'error'].map((state) => ({ ...envelope, type: 'tiles-state', state })),
    { ...envelope, type: 'point-selected', latitude: 37.7648, longitude: 30.5566 },
    { ...envelope, type: 'map-error', code: 'init-failed' },
    { ...envelope, type: 'map-error', code: 'tile-timeout' },
  ]) assert.deepEqual(parse(value), value);
  for (const session of ['', 'wrong-session', 'x'.repeat(65), '<script>', undefined]) assert.equal(parse({ v: 2, session, type: 'map-ready' }), null);
  assert.equal(parse({ ...envelope, v: 1, type: 'map-ready' }), null);
});

test('rejects invalid containers, oversized payloads, extra fields and executable-looking data', () => {
  for (const raw of [null, {}, 1, '', 'null', '[]', '42', '"ready"', '{', 'x'.repeat(MAX_MAP_MESSAGE_LENGTH + 1)]) assert.equal(parseMapMessage(raw), null);
  for (const value of [
    { ...envelope, v: '2', type: 'map-ready' }, { ...envelope, type: 'eval', code: 'alert(1)' },
    { ...envelope, type: 'map-ready', url: 'https://example.com' }, { ...envelope, type: 'tiles-state', state: 'offline' },
    { ...envelope, type: 'map-error', code: '<script>alert(1)</script>' },
  ]) assert.equal(parse(value), null);
  assert.equal(parseMapMessage('{"v":2,"session":"roadsense-test","type":"map-ready","__proto__":{}}', SESSION), null);
});

test('coordinates preserve order and accept world boundaries', () => {
  for (const [latitude, longitude] of [[-90, -180], [90, 180], [0, 0], [37.7648, 30.5566]]) {
    const value = { ...envelope, type: 'point-selected', latitude, longitude };
    assert.deepEqual(parse(value), value);
  }
});

test('rejects coercible, missing, non-finite and out-of-range coordinates', () => {
  for (const coordinate of [
    { latitude: '37.7', longitude: 30.5 }, { latitude: 37.7, longitude: null },
    { latitude: 90.1, longitude: 30 }, { latitude: -90.1, longitude: 30 },
    { latitude: 37, longitude: 180.1 }, { latitude: 37, longitude: -180.1 },
    { latitude: 37 }, { latitude: {}, longitude: [] },
  ]) assert.equal(parse({ ...envelope, type: 'point-selected', ...coordinate }), null);
  assert.equal(parseMapMessage('{"v":2,"session":"roadsense-test","type":"point-selected","latitude":1e999,"longitude":0}', SESSION), null);
});

test('keeps document navigation and user attribution links as separate allowlists', () => {
  assert.equal(isDocumentNavigationAllowed('about:blank'), true);
  for (const url of ['about:blank#x', 'https://tile.openstreetmap.org/1/0/0.png', 'https://leafletjs.com/', 'javascript:alert(1)', 'file:///x', 'intent://x', null]) assert.equal(isDocumentNavigationAllowed(url), false);
  assert.equal(getAttributionUrl('https://leafletjs.com'), 'https://leafletjs.com/');
  assert.equal(getAttributionUrl('https://www.openstreetmap.org/copyright'), 'https://www.openstreetmap.org/copyright');
  for (const url of ['https://leafletjs.com.evil.test/', 'https://evil@leafletjs.com/', 'https://leafletjs.com/?redirect=x', 'http://leafletjs.com/', 'https://www.openstreetmap.org/copyright#x']) assert.equal(getAttributionUrl(url), null);
});

test('JSON document data cannot terminate its element or introduce markup', () => {
  const value = { label: '</script><script>alert("x")</script>&\u2028\u2029' };
  const encoded = escapeDocumentJson(value);
  assert.doesNotMatch(encoded, /[<>&\u2028\u2029]/);
  assert.deepEqual(JSON.parse(encoded), value);
});

test('v2 location commands carry only bounded data and clear needs no GPS payload', () => {
  const update = { ...envelope, type: 'location-update', seq: 1, latitude: 0, longitude: 0, accuracyMetres: null, timestampMs: now, center: true };
  assert.deepEqual(parseMapCommand(JSON.stringify(update), SESSION, now), update);
  const clear: MapCommand = { v: 2, session: SESSION, seq: 2, type: 'location-clear' };
  assert.deepEqual(parseMapCommand(serializeMapCommand(clear), SESSION, now), clear);
  assert.equal(parseMapMessage(JSON.stringify(update), SESSION), null, 'native location commands cannot be sent back as map events');
});

test('v2 commands reject stale/future timestamps, wrong sessions, unsafe sequences and executable/extra fields', () => {
  const update = { ...envelope, type: 'location-update', seq: 1, latitude: 37, longitude: 30, accuracyMetres: 10, timestampMs: now, center: false };
  for (const change of [
    { timestampMs: now - 30001 }, { timestampMs: now + 5001 }, { timestampMs: 'now' }, { timestampMs: 1.5 },
    { session: 'old' }, { v: 1 }, { seq: 0 }, { seq: -1 }, { seq: 1.5 }, { seq: Number.MAX_SAFE_INTEGER + 1 },
    { latitude: '37' }, { latitude: 91 }, { longitude: -181 }, { accuracyMetres: -1 }, { accuracyMetres: 100001 },
    { accuracyMetres: '10' }, { center: 'true' }, { code: 'eval()' }, { history: [] },
  ]) assert.equal(parseMapCommand(JSON.stringify({ ...update, ...change }), SESSION, now), null);
  for (const input of ['{', '[]', 'null', 'x'.repeat(2049)]) assert.equal(parseMapCommand(input, SESSION, now), null);
});
