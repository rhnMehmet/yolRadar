import { useRef } from 'react'
import type { CSSProperties } from 'react'
import type { FrozenFrame } from './videoAnalysisController.ts'
import { classLabel, formatTime } from './videoSampling.ts'
export function VideoStage({ frame }: { frame: FrozenFrame | null }) {
  const container = useRef<HTMLDivElement>(null)
  return <section className="va-card" aria-labelledby="frame-title">
    <div className="va-card-heading"><h3 id="frame-title">Analiz edilen dondurulmuş kare</h3><span className="va-test">TEST_SYNTHETIC</span></div>
    <p>Kutular yalnız bu kareye aittir. Oynayan videonun üzerine gecikmiş sonuç çizilmez.</p>
    <div ref={container} className="va-frozen-stage">
      {frame ? <div className="va-image-plane" style={{ aspectRatio: `${frame.width}/${frame.height}`, '--frame-ratio': frame.width / frame.height } as CSSProperties}>
        <img src={frame.url} width={frame.width} height={frame.height} alt={`Analiz edilen kare, video zamanı ${formatTime(frame.pts)}`} />
        {frame.observations.map((obs, i) => <div className="va-box" key={obs.observationId} style={{ left: `${obs.box.x * 100}%`, top: `${obs.box.y * 100}%`, width: `${obs.box.width * 100}%`, height: `${obs.box.height * 100}%` }}><span>{i + 1} · {classLabel(obs.canonicalClass)}</span></div>)}
      </div> : <span className="va-placeholder">Henüz analiz edilmiş kare yok.</span>}
    </div>
    {frame && <>
      <p>PTS: <strong>{formatTime(frame.pts)}</strong> · {frame.width} × {frame.height} · {frame.processingMs === null ? 'Kare işleniyor…' : `Encode/API/analiz süresi: ${(frame.processingMs / 1000).toFixed(2)} sn`}</p>
      <p className="va-wrap">Kare ID: {frame.frameId}</p>
      <ol className="va-box-list">{frame.observations.map(obs => <li key={obs.observationId}>{classLabel(obs.canonicalClass)} · Model skoru: {obs.confidence.toFixed(2)} · {formatTime(obs.capturedAt.valueMs)} · TEST_SYNTHETIC</li>)}</ol>
      {frame.processingMs !== null && frame.observations.length === 0 && <p>Bu kare için sentetik gözlem yok.</p>}
      <p>Model skoru gerçek doğruluk oranı veya fiziksel hasar şiddeti değildir.</p>
      <button type="button" onClick={() => { void container.current?.requestFullscreen?.().catch(() => undefined) }}>Kareyi tam ekran göster</button>
    </>}
  </section>
}
