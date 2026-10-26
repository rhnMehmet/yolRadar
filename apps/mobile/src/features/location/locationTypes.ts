export type LocationPermission = {
  granted: boolean;
  canAskAgain: boolean;
  precision: 'full' | 'reduced' | 'unknown';
};

export type LocationFix = {
  latitude: number;
  longitude: number;
  accuracyMetres: number | null;
  timestampMs: number;
  approximate: boolean;
};

export type LocationSubscription = { remove: () => void };
export type LocationProvider = {
  getPermission: () => Promise<LocationPermission>;
  requestPermission: () => Promise<LocationPermission>;
  servicesEnabled: () => Promise<boolean>;
  watch: (
    onLocation: (value: unknown) => void,
    onError: () => void,
  ) => Promise<LocationSubscription>;
};

export type LocationState = {
  phase: 'idle' | 'permission' | 'locating' | 'tracking' | 'ready' | 'denied' | 'error' | 'paused';
  mode: 'once' | 'tracking' | null;
  fix: LocationFix | null;
  canAskAgain: boolean;
  message: string;
  centerRequest: number;
};

export const initialLocationState: LocationState = {
  phase: 'idle', mode: null, fix: null, canAskAgain: true,
  message: 'Konum yalnızca siz başlattığınızda kullanılır.', centerRequest: 0,
};

export type LocationClock = {
  now: () => number;
  schedule: (callback: () => void, milliseconds: number) => () => void;
};
