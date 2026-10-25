/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMapMessage, MAX_MAP_MESSAGE_LENGTH, getAttributionUrl, isDocumentNavigationAllowed, escapeDocumentJson } from '../src/features/damage-map/mapBridge.ts';

test('accepts only the finite, versioned map protocol', () => {
  for (const value of [
    { v: 1, type: 'map-ready' },
    ...['loading', 'ready', 'partial-error', 'error'].map((state) => ({ v: 1, type: 'tiles-state', state })),
    { v: 1, type: 'point-selected', latitude: 37.7648, longitude: 30.5566 },
    { v: 1, type: 'map-error', code: 'init-failed' },
    { v: 1, type: 'map-error', code: 'tile-timeout' },
  ]) assert.deepEqual(parseMapMessage(JSON.stringify(value)), value);
});

test('rejects invalid containers, oversized payloads, extra fields and executable-looking data', () => {
  for (const raw of [null, {}, 1, '', 'null', '[]', '42', '"ready"', '{', 'x'.repeat(MAX_MAP_MESSAGE_LENGTH + 1),
    '{"v":2,"type":"map-ready"}', '{"v":"1","type":"map-ready"}',
    '{"v":1,"type":"eval","code":"alert(1)"}', '{"v":1,"type":"map-ready","url":"https://example.com"}',
    '{"v":1,"type":"map-ready","__proto__":{}}', '{"v":1,"type":"tiles-state","state":"offline"}',
    '{"v":1,"type":"map-error","code":"<script>alert(1)</script>"}',
  ]) assert.equal(parseMapMessage(raw), null);
});

test('coordinates preserve order and accept world boundaries', () => {
  for (const [latitude, longitude] of [[-90, -180], [90, 180], [0, 0], [37.7648, 30.5566]]) {
    assert.deepEqual(parseMapMessage(JSON.stringify({ v: 1, type: 'point-selected', latitude, longitude })),
      { v: 1, type: 'point-selected', latitude, longitude });
  }
});

test('rejects coercible, missing, non-finite and out-of-range coordinates', () => {
  for (const coordinate of [
    { latitude: '37.7', longitude: 30.5 }, { latitude: 37.7, longitude: null },
    { latitude: 90.1, longitude: 30 }, { latitude: -90.1, longitude: 30 },
    { latitude: 37, longitude: 180.1 }, { latitude: 37, longitude: -180.1 },
    { latitude: 37 }, { latitude: {}, longitude: [] },
  ]) assert.equal(parseMapMessage(JSON.stringify({ v: 1, type: 'point-selected', ...coordinate })), null);
  assert.equal(parseMapMessage('{"v":1,"type":"point-selected","latitude":1e999,"longitude":0}'), null);
});

test('keeps document navigation and user attribution links as separate allowlists', () => {
  assert.equal(isDocumentNavigationAllowed('about:blank'), true);
  for (const url of ['about:blank#x', 'https://tile.openstreetmap.org/1/0/0.png', 'https://leafletjs.com/', 'javascript:alert(1)', 'file:///x', 'intent://x', null]) {
    assert.equal(isDocumentNavigationAllowed(url), false);
  }
  assert.equal(getAttributionUrl('https://leafletjs.com'), 'https://leafletjs.com/');
  assert.equal(getAttributionUrl('https://www.openstreetmap.org/copyright'), 'https://www.openstreetmap.org/copyright');
  for (const url of ['https://leafletjs.com.evil.test/', 'https://evil@leafletjs.com/', 'https://leafletjs.com/?redirect=x', 'http://leafletjs.com/', 'https://www.openstreetmap.org/copyright#x']) {
    assert.equal(getAttributionUrl(url), null);
  }
});

test('JSON document data cannot terminate its element or introduce markup', () => {
  const value = { label: '</script><script>alert("x")</script>&\u2028\u2029' };
  const encoded = escapeDocumentJson(value);
  assert.doesNotMatch(encoded, /[<>&\u2028\u2029]/);
  assert.deepEqual(JSON.parse(encoded), value);
});
