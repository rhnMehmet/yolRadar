import * as Location from 'expo-location';
import type { LocationPermission, LocationProvider } from './locationTypes.ts';

function permission(value: Location.LocationPermissionResponse): LocationPermission {
  return {
    granted: value.granted, canAskAgain: value.canAskAgain,
    precision: value.ios?.accuracy === 'reduced' || value.android?.accuracy === 'coarse'
      ? 'reduced' : value.ios?.accuracy === 'full' || value.android?.accuracy === 'fine' ? 'full' : 'unknown',
  };
}

export const expoLocationProvider: LocationProvider = {
  getPermission: async () => permission(await Location.getForegroundPermissionsAsync()),
  requestPermission: async () => permission(await Location.requestForegroundPermissionsAsync()),
  servicesEnabled: () => Location.hasServicesEnabledAsync(),
  watch: (onLocation, onError) => Location.watchPositionAsync(
    { accuracy: Location.Accuracy.High, distanceInterval: 10, timeInterval: 5000 },
    onLocation, () => onError(),
  ),
};
