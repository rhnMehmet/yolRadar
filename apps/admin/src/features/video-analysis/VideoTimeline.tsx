import type { VideoTimelineEvent } from '@roadsense/shared'
import { classLabel, formatTime, markerPercent } from './videoSampling.ts'
export function VideoTimeline({ events, durationMs, currentMs, onSeek }: { events: readonly VideoTimelineEvent[]; durationMs: number; currentMs: number; onSeek: (seconds: number) => void }) {
  return <section className="va-card" aria-labelledby="timeline-title">
    <h3 id="timeline-title">Video zamanı ve olay işaretleri</h3>
    <label className="va-scrubber">Oynatma konumu · {formatTime(currentMs)} / {formatTime(durationMs)}
      <input aria-label="Video zamanına git" type="range" min="0" max={durationMs / 1000} step="0.001" value={Math.min(currentMs, durationMs) / 1000} onChange={e => onSeek(Number(e.target.value))} />
    </label>
    <div className="va-marker-track" aria-label="Gerçek PTS olay işaretleri">
      {events.map((event, i) => <button type="button" key={event.eventId} style={{ left: `${markerPercent(event.videoTimestampMs, durationMs)}%`, top: `${(i % 3) * 24}px` }}
        title={`${classLabel(event.canonicalClass)} · ${formatTime(event.videoTimestampMs)}`} aria-label={`${classLabel(event.canonicalClass)}, ${formatTime(event.videoTimestampMs)} zamanına git`}
        onClick={() => onSeek(event.videoTimestampMs / 1000)}>{i + 1}</button>)}
    </div>
    <p>Numaralı işaretler backend olaylarına bağlıdır. Aynı zamanda birden çok olay olabilir; tamamlanan raporda tıklamak yeni analiz başlatmaz.</p>
  </section>
}
