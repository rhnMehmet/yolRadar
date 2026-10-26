import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { expoLocationProvider } from './expoLocationAdapter.ts';
import { ForegroundLocationService } from './locationService.ts';
import { initialLocationState } from './locationTypes.ts';
import { isFreshLocation } from './locationPolicy.ts';

export function useForegroundLocation(enabled: boolean) {
  const serviceRef = useRef<ForegroundLocationService | null>(null);
  const [state, setState] = useState(initialLocationState);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const service = new ForegroundLocationService(expoLocationProvider);
    serviceRef.current = service;
    service.setAppState(AppState.currentState ?? 'unknown');
    const unsubscribe = service.subscribe(setState);
    setState(service.getSnapshot());
    const listener = AppState.addEventListener('change', (value) => service.setAppState(value));
    return () => {
      unsubscribe(); listener.remove(); service.dispose();
      if (serviceRef.current === service) serviceRef.current = null;
    };
  }, []);

  useEffect(() => { serviceRef.current?.setEnabled(enabled); }, [enabled]);
  useEffect(() => {
    setNow(Date.now());
    if (!state.fix) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state.fix]);

  return {
    state, freshFix: isFreshLocation(state.fix, now) ? state.fix : null,
    busy: state.mode !== null,
    locate: () => { void serviceRef.current?.locate(); },
    startTracking: () => { void serviceRef.current?.startTracking(); },
    stop: () => serviceRef.current?.stop(),
  };
}
