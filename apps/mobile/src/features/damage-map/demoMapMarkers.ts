import { isValidCoordinates } from '@roadsense/shared';
import type { Coordinates } from '@roadsense/shared';

export const ISPARTA_CENTER: Coordinates = { latitude: 37.7648, longitude: 30.5566 };
export const INITIAL_MAP_ZOOM = 14;
export const DEMO_MAP_NOTICE = 'Demo harita — işaretçiler gerçek yol hasarı bildirimlerini temsil etmez.';

// Representative map UI examples, deliberately separate from the eight admin reports.
export const demoMapMarkers = [
  { id: 'MOBILE-MAP-DEMO-001', label: 'Demo çukur', color: '#B45309', latitude: 37.7664, longitude: 30.5538 },
  { id: 'MOBILE-MAP-DEMO-002', label: 'Demo boyuna çatlak', color: '#2563EB', latitude: 37.7629, longitude: 30.5588 },
  { id: 'MOBILE-MAP-DEMO-003', label: 'Demo enine çatlak', color: '#0B6B59', latitude: 37.7653, longitude: 30.5610 },
] as const;

if (!isValidCoordinates(ISPARTA_CENTER) || demoMapMarkers.some((marker) => !isValidCoordinates(marker))) {
  throw new RangeError('Demo harita koordinatları geçerli dünya aralıklarında olmalı.');
}
