import { FIRST_FIX_TIMEOUT_MS, HEALTH_CHECK_MS, isFreshLocation, isPlausibleLocation, normalizeLocation } from './locationPolicy.ts';
import { initialLocationState } from './locationTypes.ts';
import type { LocationClock, LocationPermission, LocationProvider, LocationState, LocationSubscription } from './locationTypes.ts';

const realClock: LocationClock = {
  now: () => Date.now(),
  schedule: (callback, delay) => { const timer = setTimeout(callback, delay); return () => clearTimeout(timer); },
};

/** Foreground-only lifecycle. No map, storage, logging, network or Expo dependency. */
export class ForegroundLocationService {
  private state: LocationState = { ...initialLocationState };
  private listeners = new Set<(state: LocationState) => void>();
  private subscription: LocationSubscription | null = null;
  private cancelDeadline: (() => void) | null = null;
  private cancelHealth: (() => void) | null = null;
  private generation = 0;
  private foreground = false;
  private enabled = false;
  private disposed = false;
  private permissionPrompt: number | null = null;
  private precision: LocationPermission['precision'] = 'unknown';
  private resumePermission: (() => void) | null = null;
  private centerPending = false;
  private watchInFlight = false;
  private cleanupFailed = false;

  private provider: LocationProvider;
  private clock: LocationClock;

  constructor(provider: LocationProvider, clock: LocationClock = realClock) {
    this.provider = provider;
    this.clock = clock;
  }

  getSnapshot = (): LocationState => this.state;
  subscribe = (listener: (state: LocationState) => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(value: Partial<LocationState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...value };
    for (const listener of this.listeners) listener(this.state);
  }

  private remove(subscription: LocationSubscription | null) {
    if (!subscription) return;
    try { subscription.remove(); } catch {
      this.cleanupFailed = true;
      this.publish({ phase: 'error', message: 'Konum aboneliği kapatılamadı. Uygulamayı kapatıp yeniden açın.' });
    }
  }

  private release() {
    this.cancelDeadline?.(); this.cancelDeadline = null;
    this.cancelHealth?.(); this.cancelHealth = null;
    const subscription = this.subscription;
    this.subscription = null;
    this.remove(subscription);
    const resume = this.resumePermission;
    this.resumePermission = null;
    resume?.();
    this.centerPending = false;
  }

  stop = (message = 'Konum takibi durduruldu.') => {
    this.generation += 1;
    this.release();
    this.publish({ phase: this.cleanupFailed ? 'error' : 'idle', mode: null, fix: null,
      message: this.cleanupFailed ? 'Konum aboneliği kapatılamadı. Uygulamayı kapatıp yeniden açın.' : message });
  };

  setEnabled(enabled: boolean) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.stop('Harita kapalı; konum takibi durduruldu.');
  }

  setAppState(value: string) {
    this.foreground = value === 'active';
    if (this.foreground) {
      const resume = this.resumePermission;
      this.resumePermission = null;
      resume?.();
    } else if (value !== 'inactive' || this.permissionPrompt !== this.generation) {
      this.stop('Uygulama etkin değil; konum takibi durduruldu.');
      this.publish({ phase: 'paused' });
    }
  }

  dispose() {
    this.stop();
    this.disposed = true;
    this.listeners.clear();
  }

  locate = async () => {
    if (this.state.mode === 'tracking') {
      if (isFreshLocation(this.state.fix, this.clock.now())) {
        this.publish({ centerRequest: this.state.centerRequest + 1 });
      } else {
        this.centerPending = true;
        this.publish({ message: 'Merkezlemek için yeni konum ölçümü bekleniyor.' });
      }
      return;
    }
    await this.start('once');
  };

  startTracking = () => this.start('tracking');

  private current(token: number) {
    return !this.disposed && this.enabled && this.foreground && token === this.generation;
  }

  private fail(token: number, message: string, phase: 'error' | 'denied' = 'error', canAskAgain = true) {
    if (token !== this.generation || this.disposed) return;
    this.stop(message);
    this.publish({ phase, canAskAgain });
  }

  private async start(mode: 'once' | 'tracking') {
    if (this.disposed || !this.enabled || !this.foreground || this.state.mode !== null) return;
    if (this.cleanupFailed) return;
    if (this.watchInFlight) { this.publish({ message: 'Önceki konum isteği kapatılıyor; lütfen bekleyip yeniden deneyin.' }); return; }
    const token = ++this.generation;
    this.publish({ phase: 'permission', mode, fix: null, message: 'Konum izni kontrol ediliyor…' });
    try {
      let permission = await this.provider.getPermission();
      if (!this.current(token)) return;
      const servicesEnabled = await this.provider.servicesEnabled();
      if (!this.current(token)) return;
      if (!servicesEnabled) {
        this.fail(token, 'Konum servisleri kapalı veya kullanılamıyor. Haritayı kullanabilirsiniz.');
        return;
      }
      if (!permission.granted && permission.canAskAgain) {
        this.permissionPrompt = token;
        try {
          permission = await this.provider.requestPermission();
          if (token === this.generation && !this.foreground) {
            await new Promise<void>((resolve) => { this.resumePermission = resolve; });
          }
        } finally { if (this.permissionPrompt === token) this.permissionPrompt = null; }
      }
      if (!this.current(token)) return;
      if (!permission.granted) {
        this.fail(token, permission.canAskAgain
          ? 'Konum izni verilmedi. Haritayı kullanmaya devam edebilirsiniz.'
          : 'Konum izni kapalı. İsterseniz Ayarlar üzerinden değiştirebilirsiniz.', 'denied', permission.canAskAgain);
        return;
      }
      this.precision = permission.precision;
      this.publish({ phase: 'locating', canAskAgain: permission.canAskAgain, message: 'Güncel konum ölçümü bekleniyor…' });
      this.centerPending = mode === 'once';
      this.cancelDeadline = this.clock.schedule(() => {
        this.fail(token, '20 saniye içinde güncel konum alınamadı. Açık bir alanda yeniden deneyin.');
      }, FIRST_FIX_TIMEOUT_MS);
      this.watchInFlight = true;
      let subscription: LocationSubscription;
      try {
        subscription = await this.provider.watch((raw) => this.accept(token, mode, raw), () => {
          this.fail(token, 'Konum güncellenemedi. İzinleri ve konum servislerini kontrol edin.');
        });
      } finally { this.watchInFlight = false; }
      if (!this.current(token)) { this.remove(subscription); return; }
      this.subscription = subscription;
      if (mode === 'tracking') {
        this.publish({ phase: 'tracking' });
        this.scheduleHealth(token);
      }
    } catch {
      this.fail(token, 'Konum kullanılamıyor. İzinleri ve konum servislerini kontrol edip yeniden deneyin.');
    }
  }

  private accept(token: number, mode: 'once' | 'tracking', raw: unknown) {
    if (!this.current(token)) return;
    const fix = normalizeLocation(raw, this.clock.now(), this.precision);
    if (!fix || !isPlausibleLocation(this.state.fix, fix)) return;
    this.cancelDeadline?.(); this.cancelDeadline = null;
    const centerRequest = this.state.centerRequest + (this.centerPending ? 1 : 0);
    this.centerPending = false;
    if (mode === 'once') { this.generation += 1; this.release(); }
    this.publish({
      phase: mode === 'once' ? 'ready' : 'tracking', mode: mode === 'once' ? null : 'tracking',
      fix, centerRequest,
      message: fix.approximate ? 'Yaklaşık/düşük doğruluklu konum. Yol seviyesinde kesinlik garanti edilmez.'
        : mode === 'once' ? 'Konum bulundu; tek seferlik abonelik kapatıldı.' : 'Konum takibi açık; kamera elle kontrolünüzde.',
    });
  }

  private scheduleHealth(token: number) {
    this.cancelHealth = this.clock.schedule(() => { void this.checkHealth(token); }, HEALTH_CHECK_MS);
  }

  private async checkHealth(token: number) {
    if (!this.current(token)) return;
    try {
      const permission = await this.provider.getPermission();
      if (!this.current(token)) return;
      const enabled = await this.provider.servicesEnabled();
      if (!this.current(token)) return;
      if (!enabled) { this.fail(token, 'Konum servisleri kullanılamıyor; takip durduruldu.'); return; }
      if (!permission.granted) {
        this.fail(token, 'Konum izni kapatıldı; takip durduruldu.', 'denied', permission.canAskAgain);
        return;
      }
      this.precision = permission.precision;
      this.scheduleHealth(token);
    } catch { this.fail(token, 'Konum durumu kontrol edilemedi; takip durduruldu.'); }
  }
}
