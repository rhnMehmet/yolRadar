import type { DetectionObservation, ImageFrame, VideoAnalysisSession, VideoAnalysisSummary } from '@roadsense/shared'
import { createVideoApi } from './videoApi.ts'
import type { VideoApi } from './videoApi.ts'
import { abortError, acceptsPTS, captureSample, checkAbort, encodeFrame, validateMetadata, VIDEO_LIMITS } from './videoSampling.ts'
import type { Capture, VideoInfo } from './videoSampling.ts'
import { localApiTarget } from '../../api/localApiTarget.ts'

export type FrozenFrame = { url: string; width: number; height: number; pts: number; frameId: string; observations: DetectionObservation[]; processingMs: number | null }
export type AnalysisState = { phase: 'idle' | 'starting' | 'capturing' | 'processing' | 'completed' | 'partial' | 'cancelled' | 'failed';
  busy: boolean; paused: boolean; attempted: number; gaps: number; total: number; message: string;
  session: VideoAnalysisSession | null; summary: VideoAnalysisSummary | null; frozen: FrozenFrame | null }
const initial = (): AnalysisState => ({ phase: 'idle', busy: false, paused: false, attempted: 0, gaps: 0, total: 0, message: '', session: null, summary: null, frozen: null })
export type ControllerDeps = { api: (token: string) => VideoApi; capture: typeof captureSample; encode: typeof encodeFrame;
  createUrl: (blob: Blob) => string; revokeUrl: (url: string) => void; now: () => number }

/** One task owns capture/encode/upload/poll. A generation cannot publish after invalidation. */
export class VideoAnalysisController {
  private state = initial()
  private generation = 0
  private active?: AbortController
  private listeners = new Set<() => void>()
  private resume?: () => void
  private disposed = false
  private cancelReason = 'user'
  private video?: HTMLVideoElement
  private deps: ControllerDeps
  constructor(deps: Partial<ControllerDeps> = {}) {
    this.deps = { api: createVideoApi, capture: captureSample, encode: encodeFrame,
      createUrl: b => URL.createObjectURL(b), revokeUrl: u => URL.revokeObjectURL(u), now: () => performance.now(), ...deps }
  }
  getSnapshot = () => this.state
  setTarget(value: string) {
    const target = localApiTarget(value)
    this.reset()
    this.deps.api = token => createVideoApi(token, fetch, 12000, target)
  }
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  private update(patch: Partial<AnalysisState>) { this.state = { ...this.state, ...patch }; if (!this.disposed) this.listeners.forEach(fn => fn()) }
  clearFrozen() { if (this.state.frozen) this.deps.revokeUrl(this.state.frozen.url); this.update({ frozen: null }) }
  pause() { if (this.state.busy) this.update({ paused: true }); this.video?.pause() }
  async play() {
    if (this.state.busy) { this.update({ paused: false }); this.resume?.(); this.resume = undefined
      if (this.state.phase === 'capturing') await this.video?.play()
    } else await this.video?.play()
  }
  cancel(reason = 'user') {
    this.cancelReason = reason; this.generation++; this.active?.abort(); this.resume?.(); this.resume = undefined
    this.video?.pause(); this.clearFrozen()
    this.update({ phase: 'cancelled', paused: false, summary: null, message: 'İptal istendi. Sunucu iptalinin ulaşması garanti değildir.' })
  }
  reset() { this.cancel('replace'); this.update({ ...initial(), busy: this.state.busy }) }
  seek(seconds: number, video: HTMLVideoElement, durationMs: number) {
    if (!Number.isFinite(seconds)) return
    if (this.state.busy) this.cancel('seek')
    else this.clearFrozen()
    video.currentTime = Math.max(0, Math.min(seconds, durationMs / 1000))
  }
  activate() { this.disposed = false }
  dispose() {
    this.cancelReason = 'unmount'; this.generation++; this.active?.abort(); this.resume?.(); this.resume = undefined; this.video?.pause()
    if (this.state.frozen) this.deps.revokeUrl(this.state.frozen.url)
    this.state = { ...initial(), busy: this.state.busy }; this.disposed = true; this.listeners.clear()
  }
  private async waitResume(signal: AbortSignal) {
    if (!this.state.paused) return
    await new Promise<void>((resolve, reject) => {
      const done = () => { signal.removeEventListener('abort', cancel); resolve() }
      const cancel = () => { this.resume = undefined; signal.removeEventListener('abort', cancel); reject(abortError()) }
      this.resume = done; signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel()
    })
  }
  async start(video: HTMLVideoElement, info: VideoInfo, videoId: string, token: string): Promise<void> {
    if (this.state.busy || this.disposed) return
    validateMetadata(info)
    const api = this.deps.api(token), abort = new AbortController(), signal = abort.signal
    this.cancelReason = 'user'
    this.active = abort; this.video = video; const generation = ++this.generation
    this.clearFrozen(); this.update({ ...initial(), phase: 'starting', busy: true, total: Math.ceil(info.durationMs / VIDEO_LIMITS.intervalMs) })
    const current = () => { checkAbort(signal); if (generation !== this.generation || this.disposed) throw abortError() }
    let session: VideoAnalysisSession | undefined
    try {
      video.pause(); video.currentTime = 0
      session = await api.create(videoId, info.durationMs, signal); current(); this.update({ session })
      for (let planned = 0; planned < info.durationMs; planned += VIDEO_LIMITS.intervalMs) {
        await this.waitResume(signal); current(); this.update({ phase: 'capturing' })
        const sample: Capture | null = await this.deps.capture(video, planned, info.durationMs, signal)
        current(); this.update({ phase: 'processing' }); video.pause()
        if (!sample) { this.update({ attempted: this.state.attempted + 1, gaps: this.state.gaps + 1 }); continue }
        if (sample.plannedMs !== planned || !acceptsPTS(sample.actualMs, planned, info.durationMs)) throw new Error('Decoded kare planlanan PTS penceresine uymuyor.')
        const started = this.deps.now()
        const blob = await this.deps.encode(sample, signal); current()
        const frame: ImageFrame = { contractVersion: 2, sessionId: session.sessionId, runId: session.runId, sourceDomain: 'REPLAY',
          frameId: crypto.randomUUID(), plannedSampleTimestampMs: planned,
          capturedAt: { clockDomain: 'VIDEO', clockId: session.clockId, videoId, valueMs: sample.actualMs }, width: sample.width, height: sample.height }
        this.clearFrozen()
        this.update({ frozen: { url: this.deps.createUrl(blob), width: sample.width, height: sample.height,
          pts: sample.actualMs, frameId: frame.frameId, observations: [], processingMs: null } })
        const observations = await api.analyze(session, frame, blob, signal); current()
        this.update({ frozen: { ...this.state.frozen!, observations, processingMs: this.deps.now() - started }, attempted: this.state.attempted + 1 })
        const summary = await api.summary(session, signal); current(); this.update({ summary })
      }
      const summary = await api.summary(session, signal); current()
      const status = summary.coverage.status === 'complete' ? 'completed' : 'partial'
      await api.complete(session, status, signal); current()
      const final = await api.summary(session, signal); current()
      this.update({ summary: final, phase: status, message: status === 'completed' ? 'Örnekleme planı tamamlandı; tüm video kareleri analiz edilmiş değildir.' : 'Analiz kısmi: kapsam boşlukları var.' })
    } catch (error) {
      const cancelled = signal.aborted || generation !== this.generation
      const cleanupGeneration = this.generation
      const reason = this.cancelReason
      if (!cancelled) { this.clearFrozen(); this.update({ phase: 'failed', message: error instanceof Error ? error.message : 'Analiz tamamlanamadı.' }) }
      if (session) {
        try {
          await api.cancel(session)
          const summary = await api.summary(session)
          if (!this.disposed && this.generation === cleanupGeneration && (!cancelled || reason === 'user')) this.update({ summary })
        } catch { if (!this.disposed && this.generation === cleanupGeneration && reason !== 'replace' && reason !== 'unmount') this.update({ message: this.state.message + ' Sunucu iptali/özeti doğrulanamadı. Yerel işlem durdu; sunucuda iş kalmış olabilir.' }) }
      }
    } finally {
      video.pause(); this.active = undefined; this.update({ busy: false, paused: false })
    }
  }
}
