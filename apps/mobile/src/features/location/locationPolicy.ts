import type { LocationFix, LocationPermission } from './locationTypes.ts';

export const MAX_LOCATION_AGE_MS = 30_000;
export const FIRST_FIX_TIMEOUT_MS = 20_000;
export const HEALTH_CHECK_MS = 10_000;
export const MAX_ACCURACY_METRES = 100_000;

export function isFreshLocation(fix: LocationFix | null, now: number): fix is LocationFix {
  return fix !== null && fix.timestampMs <= now + 5000 && now - fix.timestampMs <= MAX_LOCATION_AGE_MS;
}

/** Keep only the current, validated fix; discard altitude, speed and other sensor data. */
export function normalizeLocation(value: unknown, now: number, precision: LocationPermission['precision']): LocationFix | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (!raw.coords || typeof raw.coords !== 'object') return null;
  const coords = raw.coords as Record<string, unknown>;
  const { latitude, longitude } = coords;
  if (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
    || typeof raw.timestamp !== 'number' || !Number.isFinite(raw.timestamp)) return null;
  const accuracy = coords.accuracy;
  const accuracyMetres = typeof accuracy === 'number' && Number.isFinite(accuracy)
    && accuracy >= 0 && accuracy <= MAX_ACCURACY_METRES ? accuracy : null;
  const fix: LocationFix = {
    latitude, longitude, accuracyMetres, timestampMs: Math.floor(raw.timestamp),
    approximate: precision === 'reduced' || accuracyMetres === null || accuracyMetres > 50,
  };
  return isFreshLocation(fix, now) && fix.timestampMs > 0 ? fix : null;
}

export function isPlausibleLocation(previous: LocationFix | null, next: LocationFix): boolean {
  if (!previous) return true;
  const seconds = (next.timestampMs - previous.timestampMs) / 1000;
  if (seconds <= 0) return false;
  const radians = Math.PI / 180;
  const lat = (next.latitude - previous.latitude) * radians;
  const lng = (next.longitude - previous.longitude) * radians;
  const a = Math.sin(lat / 2) ** 2 + Math.cos(previous.latitude * radians)
    * Math.cos(next.latitude * radians) * Math.sin(lng / 2) ** 2;
  const distance = 6_371_000 * 2 * Math.asin(Math.sqrt(Math.min(1, a)));
  const uncertainty = 2 * ((previous.accuracyMetres ?? 0) + (next.accuracyMetres ?? 0));
  return distance <= 100 * seconds + uncertainty + 10;
}
