export const VIDEO_LIMITS = Object.freeze({ maxBytes: 512 * 1024 * 1024, maxDurationMs: 600_000,
  maxSourcePixels: 33_177_600, maxEdge: 1280, maxFrameBytes: 4 * 1024 * 1024, intervalMs: 1000, decodeTimeoutMs: 8000 })
export type VideoInfo = { name: string; bytes: number; durationMs: number; width: number; height: number }
export type Capture = { canvas: HTMLCanvasElement; actualMs: number; plannedMs: number; width: number; height: number }
export function classLabel(value: string) {
  return ({ pothole: 'Olası çukur', longitudinal_crack: 'Boyuna çatlak', transverse_crack: 'Enine çatlak',
    alligator_crack: 'Ağ çatlağı', other: 'Diğer', unknown: 'Bilinmeyen' } as Record<string, string>)[value] ?? 'Bilinmeyen'
}

export function validateFile(file: Pick<File, 'name' | 'type' | 'size'>): void {
  if (!/\.(mp4|mov)$/i.test(file.name) || !['', 'video/mp4', 'video/quicktime'].includes(file.type)) throw new Error('MP4 veya tarayıcınızın desteklediği MOV dosyası seçin.')
  if (file.size <= 0 || file.size > VIDEO_LIMITS.maxBytes) throw new Error('Video boş olamaz; boyut sınırı 512 MiB.')
}
export function validateMetadata(info: VideoInfo): void {
  if (!Number.isFinite(info.durationMs) || info.durationMs <= 0 || info.durationMs > VIDEO_LIMITS.maxDurationMs
    || !Number.isSafeInteger(info.width) || !Number.isSafeInteger(info.height) || info.width <= 0 || info.height <= 0
    || info.width * info.height > VIDEO_LIMITS.maxSourcePixels) throw new Error('Geçerli süre/çözünürlük okunamadı. En fazla 10 dakika ve 33 megapiksel desteklenir.')
}
export function acceptsPTS(actualMs: number, plannedMs: number, durationMs: number): boolean {
  return Number.isFinite(actualMs) && Number.isFinite(plannedMs) && plannedMs >= 0 && plannedMs % VIDEO_LIMITS.intervalMs === 0
    && actualMs >= plannedMs && actualMs <= plannedMs + 100 && actualMs < Math.min(plannedMs + VIDEO_LIMITS.intervalMs, durationMs)
}
export function frameSize(width: number, height: number) {
  const scale = Math.min(1, VIDEO_LIMITS.maxEdge / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}
export function containRect(containerWidth: number, containerHeight: number, width: number, height: number) {
  const scale = Math.min(containerWidth / width, containerHeight / height)
  return { x: (containerWidth - width * scale) / 2, y: (containerHeight - height * scale) / 2, width: width * scale, height: height * scale }
}
export function markerPercent(timestampMs: number, durationMs: number): number {
  if (!Number.isFinite(timestampMs) || !Number.isFinite(durationMs) || durationMs <= 0 || timestampMs < 0 || timestampMs >= durationMs) throw new Error('Geçersiz olay zamanı.')
  return timestampMs / durationMs * 100
}
export function formatTime(ms: number): string {
  return `${Math.floor(ms / 60000).toString().padStart(2, '0')}:${(ms / 1000 % 60).toFixed(3).padStart(6, '0')}`
}
export function abortError(): DOMException { return new DOMException('İşlem iptal edildi.', 'AbortError') }
export function checkAbort(signal: AbortSignal): void { if (signal.aborted) throw abortError() }

/** Copy synchronously inside rVFC, before any await; never substitute currentTime for PTS. */
export function captureSample(video: HTMLVideoElement, plannedMs: number, durationMs: number, signal: AbortSignal): Promise<Capture | null> {
  if (typeof video.requestVideoFrameCallback !== 'function') return Promise.reject(new Error('Tarayıcı gerçek video kare zamanını (rVFC) desteklemiyor. Güncel Chrome/Edge kullanın.'))
  return new Promise((resolve, reject) => {
    let callback = 0, activeMs = 0, settled = false
    const finish = (value: Capture | null, error?: unknown) => {
      if (settled) return
      settled = true; video.cancelVideoFrameCallback(callback); clearInterval(timer)
      signal.removeEventListener('abort', cancel); video.removeEventListener('ended', ended); video.removeEventListener('error', failed)
      if (error) reject(error); else resolve(value)
    }
    const cancel = () => finish(null, abortError())
    const ended = () => finish(null)
    const failed = () => finish(null, new Error('Video çözümlenemedi. Codec desteklenmiyor veya dosya bozuk.'))
    const onFrame: VideoFrameRequestCallback = (_now, meta) => {
      if (signal.aborted) { cancel(); return }
      const actualMs = meta.mediaTime * 1000
      if (!Number.isFinite(actualMs)) { failed(); return }
      if (actualMs < plannedMs) { callback = video.requestVideoFrameCallback(onFrame); return }
      if (!acceptsPTS(actualMs, plannedMs, durationMs)) { finish(null); return }
      try {
        const size = frameSize(video.videoWidth, video.videoHeight)
        const canvas = document.createElement('canvas'); canvas.width = size.width; canvas.height = size.height
        const context = canvas.getContext('2d')
        if (!context) throw new Error('Canvas kullanılamıyor.')
        context.drawImage(video, 0, 0, size.width, size.height)
        finish({ canvas, actualMs, plannedMs, ...size })
      } catch { failed() }
    }
    // User pause suspends the decode budget. Abort/unmount still cleans everything.
    const timer = setInterval(() => { if (!video.paused) activeMs += 250; if (activeMs >= VIDEO_LIMITS.decodeTimeoutMs) finish(null, new Error('Decoded kare alınamadı; analiz kısmi kaldı.')) }, 250)
    signal.addEventListener('abort', cancel, { once: true }); video.addEventListener('ended', ended); video.addEventListener('error', failed)
    if (signal.aborted) { cancel(); return }
    callback = video.requestVideoFrameCallback(onFrame)
    void video.play().catch(() => finish(null, new Error('Video oynatılamadı. Önce Oynat düğmesine basın veya desteklenen bir codec seçin.')))
  })
}
export async function encodeFrame(capture: Capture, signal: AbortSignal): Promise<Blob> {
  checkAbort(signal)
  const blob = await new Promise<Blob>((resolve, reject) => {
    const timer = setTimeout(() => done(null), 8000)
    const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(abortError()) }
    function done(result: Blob | null) { clearTimeout(timer); signal.removeEventListener('abort', cancel); if (signal.aborted) reject(abortError()); else if (result) resolve(result); else reject(new Error('Kare JPEG olarak hazırlanamadı.')) }
    signal.addEventListener('abort', cancel, { once: true })
    capture.canvas.toBlob(done, 'image/jpeg', 0.85)
  })
  checkAbort(signal)
  if (blob.size <= 0 || blob.size > VIDEO_LIMITS.maxFrameBytes || !['image/jpeg', 'image/png'].includes(blob.type)) throw new Error('Kare boyutu/biçimi API sınırına uygun değil (en fazla 4 MiB).')
  return blob
}
