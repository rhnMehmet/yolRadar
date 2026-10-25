import { isValidCoordinates } from '@roadsense/shared';
import type { Coordinates } from '@roadsense/shared';

export const MAP_PROTOCOL_VERSION = 1;
export const MAX_MAP_MESSAGE_LENGTH = 2048;
export const DOCUMENT_URL = 'about:blank';
export const ATTRIBUTION_URLS = [
  'https://www.openstreetmap.org/copyright',
  'https://leafletjs.com/',
] as const;

export type TileState = 'loading' | 'ready' | 'partial-error' | 'error';
export type MapMessage =
  | { v: 1; type: 'map-ready' }
  | { v: 1; type: 'tiles-state'; state: TileState }
  | ({ v: 1; type: 'point-selected' } & Coordinates)
  | { v: 1; type: 'map-error'; code: 'init-failed' | 'tile-timeout' };

function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

/** Treat the WebView as an untrusted input boundary; never execute its payload. */
export function parseMapMessage(raw: unknown): MapMessage | null {
  if (typeof raw !== 'string' || raw.length > MAX_MAP_MESSAGE_LENGTH) return null;
  let decoded: unknown;
  try { decoded = JSON.parse(raw); } catch { return null; }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
  const value = decoded as Record<string, unknown>;
  if (value.v !== MAP_PROTOCOL_VERSION) return null;
  switch (value.type) {
    case 'map-ready':
      return hasKeys(value, ['v', 'type']) ? { v: 1, type: 'map-ready' } : null;
    case 'tiles-state':
      return hasKeys(value, ['v', 'type', 'state'])
        && ['loading', 'ready', 'partial-error', 'error'].includes(value.state as string)
        ? { v: 1, type: 'tiles-state', state: value.state as TileState } : null;
    case 'point-selected':
      return hasKeys(value, ['v', 'type', 'latitude', 'longitude']) && isValidCoordinates(value)
        ? { v: 1, type: 'point-selected', latitude: value.latitude, longitude: value.longitude } : null;
    case 'map-error':
      return hasKeys(value, ['v', 'type', 'code'])
        && (value.code === 'init-failed' || value.code === 'tile-timeout')
        ? { v: 1, type: 'map-error', code: value.code } : null;
    default:
      return null;
  }
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
