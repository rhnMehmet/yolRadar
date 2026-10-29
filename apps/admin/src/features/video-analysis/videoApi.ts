import { isImageFrame, isVideoAnalysisSession, sameScope, sameDetector } from '@roadsense/shared'
import type { DetectionObservation, ImageFrame, VideoAnalysisSession, VideoAnalysisSummary, VideoTimelineEvent } from '@roadsense/shared'
import { abortError, checkAbort, VIDEO_LIMITS } from './videoSampling.ts'

export const API_ORIGIN = 'http://127.0.0.1:8001'
export const TEST_LABEL = 'TEST_SYNTHETIC'
const classes = ['pothole', 'longitudinal_crack', 'transverse_crack', 'alligator_crack', 'other', 'unknown']
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const number = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const integer = (v: unknown): v is number => number(v) && Number.isSafeInteger(v)
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v)
function demand(value: unknown): asserts value { if (!value) throw new Error('API yanıtı beklenen oturum/kare/sözleşmeyle eşleşmiyor.') }
export class VideoApiError extends Error {
  status: number
  constructor(status: number) {
    super(({ 401: 'API kimliği geçersiz. Sınırlı REPLAY token’ını kontrol edin.', 403: 'Bu kimliğin REPLAY işlemi için yetkisi yok.',
      409: 'Oturum/kare çakışması veya eski run. Analizi yeniden başlatın.', 422: 'Kare zamanı veya API sözleşmesi reddedildi.',
      429: 'API kuyruğu dolu. Bir süre sonra yeni analiz başlatın.' } as Record<number, string>)[status] ?? (status >= 500 ? 'API işlemi tamamlayamadı. Servis durumunu kontrol edin.' : `API isteği başarısız (${status}).`))
    this.status = status
  }
}
export async function delay(ms: number, signal: AbortSignal): Promise<void> {
  checkAbort(signal)
  await new Promise<void>((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(abortError()) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve() }, ms)
    signal.addEventListener('abort', cancel, { once: true })
  })
}

export function validateObservations(value: unknown, session: VideoAnalysisSession, frame: ImageFrame): DetectionObservation[] {
  demand(Array.isArray(value) && value.length <= 100)
  const ids = new Set<string>()
  for (const item of value) {
    demand(obj(item) && sameScope(item, session) && sameDetector(item, session.detector) && id(item.observationId)
      && !ids.has(item.observationId) && item.frameId === frame.frameId && obj(item.capturedAt)
      && item.capturedAt.clockDomain === 'VIDEO' && item.capturedAt.clockId === session.clockId
      && item.capturedAt.videoId === session.videoId && item.capturedAt.valueMs === frame.capturedAt.valueMs
      && id(item.rawClassId) && classes.includes(item.canonicalClass as string) && number(item.confidence, 0, 1))
    const box = item.box
    demand(obj(box) && number(box.x, 0, 1) && number(box.y, 0, 1) && number(box.width, Number.EPSILON, 1)
      && number(box.height, Number.EPSILON, 1) && box.x + box.width <= 1 && box.y + box.height <= 1)
    ids.add(item.observationId)
  }
  return value as DetectionObservation[]
}
export function validateSummary(value: unknown, session: VideoAnalysisSession): VideoAnalysisSummary {
  demand(obj(value) && sameScope(value, session) && sameDetector(value, session.detector) && value.videoId === session.videoId
    && value.resultLabel === TEST_LABEL && ['running', 'completed', 'partial', 'cancelled', 'failed'].includes(value.analysisStatus as string)
    && Array.isArray(value.events) && integer(value.totalEvents) && value.totalEvents === value.events.length
    && integer(value.rawObservationCount) && value.deduplication === 'EXPLICIT_OBSERVATION_GROUPS' && obj(value.classCounts))
  const eventIds = new Set<string>(), observationIds = new Set<string>(), counts: Record<string, number> = Object.fromEntries(classes.map(c => [c, 0]))
  for (const event of value.events) {
    demand(obj(event) && sameScope(event, session) && sameDetector(event, session.detector) && event.videoId === session.videoId
      && id(event.eventId) && !eventIds.has(event.eventId) && classes.includes(event.canonicalClass as string)
      && number(event.videoTimestampMs, 0, session.videoDurationMs) && event.videoTimestampMs < session.videoDurationMs
      && number(event.lastVideoTimestampMs, event.videoTimestampMs, session.videoDurationMs) && event.lastVideoTimestampMs < session.videoDurationMs
      && number(event.confidence, 0, 1) && ['pending', 'approved'].includes(event.reviewStatus as string)
      && Array.isArray(event.observationIds) && event.observationIds.length > 0)
    for (const ref of event.observationIds) { demand(id(ref) && !observationIds.has(ref)); observationIds.add(ref) }
    eventIds.add(event.eventId); counts[event.canonicalClass as string]++
  }
  const classCounts = value.classCounts
  demand(classes.every(c => integer(classCounts[c]) && classCounts[c] === counts[c]) && value.rawObservationCount >= observationIds.size)
  const events = value.events as VideoTimelineEvent[]
  demand(value.firstDamageTimestampMs === (events.length ? Math.min(...events.map(e => e.videoTimestampMs)) : null)
    && value.lastDamageTimestampMs === (events.length ? Math.max(...events.map(e => e.lastVideoTimestampMs)) : null))
  const c = value.coverage
  demand(obj(c) && c.basis === 'DECLARED_SAMPLING_GRID' && c.samplingIntervalMs === session.samplingIntervalMs
    && integer(c.analyzedFrames) && integer(c.skippedFrames) && integer(c.failedFrames)
    && Array.isArray(c.coveredRanges) && Array.isArray(c.unanalysedRanges))
  const slots = Math.ceil(session.videoDurationMs / session.samplingIntervalMs)
  const ranges: { startMs: number; endMs: number; analyzed: boolean }[] = []
  let coveredSlots = 0
  for (const [source, analyzed] of [[c.coveredRanges, true], [c.unanalysedRanges, false]] as const) for (const r of source) {
    demand(obj(r) && number(r.startMs, 0, session.videoDurationMs) && number(r.endMs, r.startMs, session.videoDurationMs)
      && r.endMs > r.startMs && r.startMs % session.samplingIntervalMs === 0
      && (r.endMs === session.videoDurationMs || r.endMs % session.samplingIntervalMs === 0))
    ranges.push({ startMs: r.startMs, endMs: r.endMs, analyzed })
    if (analyzed) coveredSlots += Math.ceil(r.endMs / session.samplingIntervalMs) - r.startMs / session.samplingIntervalMs
  }
  ranges.sort((a, b) => a.startMs - b.startMs)
  demand(ranges.length && ranges[0].startMs === 0 && ranges.at(-1)!.endMs === session.videoDurationMs
    && ranges.every((r, i) => i === 0 || ranges[i - 1].endMs === r.startMs)
    && c.analyzedFrames === coveredSlots && c.analyzedFrames + c.failedFrames + c.skippedFrames <= slots
    && c.status === (coveredSlots === slots ? 'complete' : coveredSlots ? 'partial' : 'none')
    && (value.analysisStatus !== 'completed' || c.status === 'complete'))
  return value as unknown as VideoAnalysisSummary
}

export function createVideoApi(token: string, fetcher: typeof fetch = fetch, timeoutMs = 12000) {
  if (!/^[\x21-\x7e]{32,480}$/.test(token)) throw new Error('Geçerli sınırlı REPLAY token’ını parola alanına girin; sohbetten paylaşmayın.')
  async function request(path: string, method: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!/^\/v1\/[A-Za-z0-9/._:-]+$/.test(path)) throw new Error('API hedefi geçersiz.')
    const controller = new AbortController()
    const cancel = () => controller.abort()
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) controller.abort()
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    let abortListener = () => {}
    const aborted = new Promise<never>((_, reject) => { abortListener = () => reject(abortError()); controller.signal.addEventListener('abort', abortListener, { once: true }) })
    const timed = new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(new Error('API yanıtı zaman aşımına uğradı.')); controller.abort() }, timeoutMs) })
    try {
      const binary = body instanceof Blob
      const payload = body === undefined ? undefined : binary ? body : JSON.stringify(body)
      if (binary ? body.size > VIDEO_LIMITS.maxFrameBytes : payload !== undefined && new TextEncoder().encode(payload as string).length > 128 * 1024) throw new Error('İstek boyutu API sınırını aşıyor.')
      checkAbort(controller.signal)
      return await Promise.race([timed, aborted, (async () => {
        const response = await fetcher(API_ORIGIN + path, { method, signal: controller.signal, body: payload as BodyInit | undefined,
          headers: { Authorization: `Bearer ${token}`, ...(payload === undefined ? {} : { 'Content-Type': binary ? body.type : 'application/json' }) },
          cache: 'no-store', redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' })
        if (!response.ok) throw new VideoApiError(response.status)
        const reader = response.body?.getReader()
        demand(reader)
        let length = 0, text = ''; const decoder = new TextDecoder()
        while (true) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.length
          if (length > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('API yanıtı güvenli boyut sınırını aşıyor.') }
          text += decoder.decode(chunk.value, { stream: true }) }
        checkAbort(controller.signal)
        return JSON.parse(text + decoder.decode()) as unknown
      })()])
    } catch (error) {
      if (signal?.aborted) throw abortError()
      if (error instanceof VideoApiError) throw error
      // Never surface request/response bodies, URLs containing credentials or parser details.
      throw new Error(timedOut ? 'API yanıtı zaman aşımına uğradı.' : 'API bağlantısı/yanıtı başarısız. 127.0.0.1:8001 servisini ve tarayıcı bağlantısını kontrol edin.')
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); controller.signal.removeEventListener('abort', abortListener) }
  }
  const base = (s: VideoAnalysisSession) => `/v1/sessions/${s.sessionId}/runs/${s.runId}`
  return {
    async create(videoId: string, durationMs: number, signal: AbortSignal): Promise<VideoAnalysisSession> {
      const data = await request('/v1/sessions', 'POST', { commandId: crypto.randomUUID(), contractVersion: 2, sourceDomain: 'REPLAY',
        detectorKind: 'TEST', testProfile: 'synthetic_two', clockId: videoId, videoId, videoDurationMs: durationMs, samplingIntervalMs: VIDEO_LIMITS.intervalMs }, signal)
      demand(obj(data) && data.resultLabel === TEST_LABEL && isVideoAnalysisSession(data.session))
      const s = data.session
      demand(s.contractVersion === 2 && s.videoId === videoId && s.clockId === videoId && s.videoDurationMs === durationMs
        && s.samplingIntervalMs === VIDEO_LIMITS.intervalMs && s.status === 'active' && s.detector.detectorKind === 'TEST')
      return s
    },
    async analyze(s: VideoAnalysisSession, frame: ImageFrame, blob: Blob, signal: AbortSignal): Promise<DetectionObservation[]> {
      demand(isImageFrame(frame, s) && blob.size > 0 && blob.size <= VIDEO_LIMITS.maxFrameBytes && ['image/jpeg', 'image/png'].includes(blob.type))
      const registered = await request(base(s) + '/frames', 'POST', { frame }, signal)
      demand(obj(registered) && registered.frameId === frame.frameId && registered.status === 'registered')
      let job = await request(base(s) + `/frames/${frame.frameId}/content`, 'PUT', blob, signal)
      demand(obj(job) && id(job.jobId)); const jobId = job.jobId
      const deadline = performance.now() + 35000
      for (let poll = 0; poll < 45; poll++) {
        demand(obj(job) && job.jobId === jobId && job.sessionId === s.sessionId && job.runId === s.runId && job.frameId === frame.frameId
          && job.sourceDomain === 'REPLAY' && job.detectorKind === 'TEST' && job.resultLabel === TEST_LABEL)
        if (job.status === 'succeeded') return validateObservations(job.observations, s, frame)
        if (job.status === 'failed' || job.status === 'cancelled') throw new Error('Kare analizi başarısız veya iptal edildi. Kapsam tam değildir.')
        demand(job.status === 'queued' || job.status === 'running')
        if (performance.now() >= deadline) break
        await delay(600, signal); job = await request('/v1/jobs/' + jobId, 'GET', undefined, signal)
      }
      throw new Error('Kare işi zaman aşımına uğradı. Analiz kısmi kaldı.')
    },
    async summary(s: VideoAnalysisSession, signal?: AbortSignal) {
      const data = await request(base(s) + '/summary', 'GET', undefined, signal)
      demand(obj(data) && data.trackingStatus === 'NO_PHYSICAL_TRACKER' && data.countMeaning === 'PROVISIONAL_EVENT_GROUPS')
      return validateSummary(data.summary, s)
    },
    async complete(s: VideoAnalysisSession, status: 'completed' | 'partial', signal: AbortSignal) {
      const data = await request(base(s) + '/complete', 'POST', { analysisStatus: status }, signal)
      demand(obj(data) && data.resultLabel === TEST_LABEL && isVideoAnalysisSession(data.session) && sameScope(data.session, s)
        && data.session.videoId === s.videoId && data.session.analysisStatus === status)
    },
    async cancel(s: VideoAnalysisSession) { await request(`/v1/sessions/${s.sessionId}/cancel`, 'POST', undefined) },
  }
}
export type VideoApi = ReturnType<typeof createVideoApi>
