import { isValidCoordinates } from '@roadsense/shared';
import type { Coordinates } from '@roadsense/shared';
import { MAX_ACCURACY_METRES, MAX_LOCATION_AGE_MS } from '../location/locationPolicy.ts';

export const MAP_PROTOCOL_VERSION = 2;
export const MAX_MAP_MESSAGE_LENGTH = 2048;
export const DOCUMENT_URL = 'about:blank';
export const ATTRIBUTION_URLS = [
  'https://www.openstreetmap.org/copyright',
  'https://leafletjs.com/',
] as const;

export type TileState = 'loading' | 'ready' | 'partial-error' | 'error';
type Envelope = { v: 2; session: string };
export type MapMessage = Envelope & (
  | { type: 'map-ready' }
  | { type: 'tiles-state'; state: TileState }
  | ({ type: 'point-selected' } & Coordinates)
  | { type: 'map-error'; code: 'init-failed' | 'tile-timeout' });
export type MapCommand = Envelope & { seq: number } & (
  | { type: 'location-clear' }
  | ({ type: 'location-update'; accuracyMetres: number | null; timestampMs: number; center: boolean } & Coordinates));

export function isMapSession(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(value);
}

function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

/** Treat the WebView as an untrusted input boundary; never execute its payload. */
function decode(raw: unknown, expectedSession?: string): Record<string, unknown> | null {
  if (typeof raw !== 'string' || raw.length > MAX_MAP_MESSAGE_LENGTH) return null;
  let decoded: unknown;
  try { decoded = JSON.parse(raw); } catch { return null; }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
  const value = decoded as Record<string, unknown>;
  if (value.v !== MAP_PROTOCOL_VERSION || !isMapSession(value.session)
    || (expectedSession !== undefined && value.session !== expectedSession)) return null;
  return value;
}

export function parseMapMessage(raw: unknown, expectedSession?: string): MapMessage | null {
  const value = decode(raw, expectedSession);
  if (!value) return null;
  const envelope: Envelope = { v: 2, session: value.session as string };
  switch (value.type) {
    case 'map-ready':
      return hasKeys(value, ['v', 'session', 'type']) ? { ...envelope, type: 'map-ready' } : null;
    case 'tiles-state':
      return hasKeys(value, ['v', 'session', 'type', 'state'])
        && ['loading', 'ready', 'partial-error', 'error'].includes(value.state as string)
        ? { ...envelope, type: 'tiles-state', state: value.state as TileState } : null;
    case 'point-selected':
      return hasKeys(value, ['v', 'session', 'type', 'latitude', 'longitude']) && isValidCoordinates(value)
        ? { ...envelope, type: 'point-selected', latitude: value.latitude, longitude: value.longitude } : null;
    case 'map-error':
      return hasKeys(value, ['v', 'session', 'type', 'code'])
        && (value.code === 'init-failed' || value.code === 'tile-timeout')
        ? { ...envelope, type: 'map-error', code: value.code } : null;
    default:
      return null;
  }
}

export function parseMapCommand(raw: unknown, session: string, now = Date.now()): MapCommand | null {
  const value = decode(raw, session);
  if (!value || !Number.isSafeInteger(value.seq) || (value.seq as number) < 1) return null;
  const envelope = { v: 2 as const, session, seq: value.seq as number };
  if (value.type === 'location-clear' && hasKeys(value, ['v', 'session', 'type', 'seq'])) return { ...envelope, type: 'location-clear' };
  if (value.type !== 'location-update'
    || !hasKeys(value, ['v', 'session', 'type', 'seq', 'latitude', 'longitude', 'accuracyMetres', 'timestampMs', 'center'])
    || !isValidCoordinates(value) || typeof value.center !== 'boolean'
    || !Number.isSafeInteger(value.timestampMs) || (value.timestampMs as number) <= 0
    || (value.timestampMs as number) > now + 5000 || now - (value.timestampMs as number) > MAX_LOCATION_AGE_MS
    || (value.accuracyMetres !== null && (typeof value.accuracyMetres !== 'number'
      || !Number.isFinite(value.accuracyMetres) || value.accuracyMetres < 0 || value.accuracyMetres > MAX_ACCURACY_METRES))) return null;
  return { ...envelope, type: 'location-update', latitude: value.latitude, longitude: value.longitude,
    accuracyMetres: value.accuracyMetres as number | null, timestampMs: value.timestampMs as number, center: value.center };
}

export function serializeMapCommand(command: MapCommand): string | null {
  const raw = JSON.stringify(command);
  return parseMapCommand(raw, command.session) ? raw : null;
}

export function isDocumentNavigationAllowed(url: unknown): boolean {
  return url === DOCUMENT_URL;
}

export function getAttributionUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  // Exact known URLs only: no credentials, redirects, query strings or lookalike hosts.
  if (url === 'https://leafletjs.com') return ATTRIBUTION_URLS[1];
  return ATTRIBUTION_URLS.find((allowed) => url === allowed) ?? null;
}

export function escapeDocumentJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (char) =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
