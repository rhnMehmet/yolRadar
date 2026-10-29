import type { VideoAnalysisSummary } from '@roadsense/shared'
import { classLabel, formatTime } from './videoSampling.ts'
export function VideoSummary({ summary, onSeek }: { summary: VideoAnalysisSummary | null; onSeek: (seconds: number) => void }) {
  if (!summary) return <section className="va-card"><h3>Analiz özeti</h3><p>Backend özeti analiz başladığında burada görünür. Videonun sona gelmesi analiz tamamlandı anlamına gelmez.</p></section>
  const c = summary.coverage
  return <section className="va-card" aria-labelledby="summary-title">
    <div className="va-card-heading"><h3 id="summary-title">Backend analiz özeti</h3><span className="va-test">{summary.resultLabel}</span></div>
    <p>Sunucu analiz durumu: <strong>{summary.analysisStatus}</strong> · Kapsam: <strong>{c.status}</strong></p>
    <div className="va-metrics">
      <div><strong>{c.analyzedFrames}</strong><span>Analiz edilen kare / başarılı yuva</span></div>
      <div><strong>{c.skippedFrames} / {c.failedFrames}</strong><span>Backend atlanan / başarısız kare</span></div>
      <div><strong>{summary.totalEvents}</strong><span>Geçici analiz olayları</span></div>
      <div><strong>{summary.rawObservationCount}</strong><span>Ham gözlem</span></div>
    </div>
    <p>Fiziksel tracker yoktur; provisional event groups kesin fiziksel hasar sayısı değildir. Bir saniyelik plan kapsamı tüm video karelerini kapsamaz.</p>
    <dl className="va-details"><dt>Kimlik</dt><dd>{summary.detectorKind} · {summary.modelVersion} · {summary.classMapVersion}</dd>
      <dt>İlk / son olay</dt><dd>{summary.firstDamageTimestampMs === null ? 'Yok' : formatTime(summary.firstDamageTimestampMs)} / {summary.lastDamageTimestampMs === null ? 'Yok' : formatTime(summary.lastDamageTimestampMs)}</dd>
      <dt>Sınıf dağılımı</dt><dd>{Object.entries(summary.classCounts).map(([label, count]) => `${classLabel(label)}: ${count}`).join(' · ')}</dd>
      <dt>Başarılı kapsam</dt><dd>{c.coveredRanges.length ? c.coveredRanges.map(r => `[${formatTime(r.startMs)}–${formatTime(r.endMs)})`).join(' · ') : 'Yok'}</dd>
      <dt>Analiz edilmemiş aralıklar</dt><dd>{c.unanalysedRanges.length ? c.unanalysedRanges.map(r => `[${formatTime(r.startMs)}–${formatTime(r.endMs)})`).join(' · ') : 'Yok'}</dd></dl>
    <div className="table-scroll" role="region" aria-label="Geçici video olayları" tabIndex={0}><table><caption className="sr-only">TEST_SYNTHETIC geçici olay listesi</caption><thead><tr><th>Olay / zaman</th><th>Sınıf</th><th>Model skoru</th><th>İnceleme</th><th>Git</th></tr></thead>
      <tbody>{summary.events.map(event => <tr key={event.eventId}><td className="va-wrap">{event.eventId}<br />{formatTime(event.videoTimestampMs)}</td><td>{classLabel(event.canonicalClass)}</td><td>{event.confidence.toFixed(2)}</td><td>{event.reviewStatus}</td><td><button type="button" aria-label={`${event.eventId} olayının video zamanına git`} onClick={() => onSeek(event.videoTimestampMs / 1000)}>Videoda aç</button></td></tr>)}</tbody></table></div>
    {!summary.events.length && <p>Bu run için geçici olay yok.</p>}
  </section>
}
