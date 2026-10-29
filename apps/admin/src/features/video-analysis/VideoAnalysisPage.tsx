import { useEffect, useRef, useState } from 'react'
import { useVideoAnalysis } from './useVideoAnalysis.ts'
import { formatTime, validateFile, validateMetadata } from './videoSampling.ts'
import type { VideoInfo } from './videoSampling.ts'
import { VideoStage } from './VideoStage.tsx'
import { VideoTimeline } from './VideoTimeline.tsx'
import { VideoSummary } from './VideoSummary.tsx'
import './videoAnalysis.css'
import { API_TARGETS } from '../../api/localApiTarget.ts'

export default function VideoAnalysisPage() {
  const { controller, state } = useVideoAnalysis()
  const [target,setTarget] = useState<string>('http://127.0.0.1:8001')
  const video = useRef<HTMLVideoElement>(null), mounted = useRef(false)
  const [media, setMedia] = useState<{ url: string; file: File; id: string } | null>(null)
  const [info, setInfo] = useState<VideoInfo | null>(null), [error, setError] = useState(''), [token, setToken] = useState('')
  const [decoded, setDecoded] = useState(false)
  const [currentMs, setCurrentMs] = useState(0), [playing, setPlaying] = useState(false)
  const supported = typeof HTMLVideoElement.prototype.requestVideoFrameCallback === 'function'
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (!media) return
    const node = video.current
    const timer = setTimeout(() => { if (node && node.readyState < 2) { setError('Video karesi çözülemedi. Codec desteklenmiyor veya dosya bozuk.'); setInfo(null); setDecoded(false) } }, 8000)
    return () => { clearTimeout(timer); node?.pause(); node?.removeAttribute('src'); node?.load(); URL.revokeObjectURL(media.url) }
  }, [media])
  const select = (file?: File) => {
    if (!file) return
    controller.reset(); setError(''); setInfo(null); setDecoded(false); setCurrentMs(0); setMedia(null)
    try { validateFile(file); setMedia({ url: URL.createObjectURL(file), file, id: crypto.randomUUID() }) }
    catch (e) { setError(e instanceof Error ? e.message : 'Video seçilemedi.') }
  }
  const seek = (seconds: number) => { if (video.current && info) controller.seek(seconds, video.current, info.durationMs) }
  const play = () => { const promise = state.busy ? controller.play() : video.current?.play(); void promise?.catch(() => setError('Video oynatılamadı. Desteklenen bir codec seçin.')) }
  const pause = () => { controller.pause(); video.current?.pause() }
  const start = () => {
    if (!info || !media || !video.current) return
    setError('')
    void controller.start(video.current, info, media.id, token).catch(e => { if (mounted.current) setError(e instanceof Error ? e.message : 'Analiz başlatılamadı.') })
  }
  return <div className="video-analysis">
    <div className="va-heading"><div><span className="section-kicker">YEREL VİDEO LABORATUVARI</span><h2>Video Analizi</h2></div><span className="va-test">TEST_SYNTHETIC · Gerçek YOLO yok</span></div>
    <p className="va-notice">TestDetector görüntüyü yorumlamaz; önceden belirlenmiş sentetik kutular döndürür. Orijinal video yüklenmez; yalnız seçilmiş JPEG kareler yerel API’ye gönderilir.</p>
    <section className="va-card"><label>Analiz API çalışma alanı<select value={target} disabled={state.busy} onChange={e=>{controller.setTarget(e.target.value);setTarget(e.target.value);setToken('');setError('')}}>{API_TARGETS.map(t=><option key={t.origin} value={t.origin}>{t.label}</option>)}</select></label><div className="va-controls"><label className="va-file">Video seç (MP4 / desteklenen MOV)<input type="file" accept=".mp4,.mov,video/mp4,video/quicktime" onChange={e => { select(e.target.files?.[0]); e.target.value = '' }} /></label>
      <label>REPLAY / TEST API kimliği<input type="password" aria-label="Sınırlı REPLAY API token" value={token} disabled={state.busy} autoComplete="off" spellCheck={false} onChange={e => setToken(e.target.value)} /></label>
      <button type="button" disabled={state.busy} onClick={() => setToken('')}>Kimliği temizle</button></div>
      <p>En fazla 512 MiB, 10 dakika, 33 megapiksel. Analiz token’ı yalnız bu sayfanın belleğinde tutulur; sohbetten paylaşmayın. Hedef: {target}. {target.endsWith('8002')&&'İnceleme için analizi bu ayrı TEST alanında oluşturun; 8001 kayıtları taşınmaz.'}</p>
      {!supported && <p role="alert">Bu tarayıcı rVFC desteklemiyor; gerçek PTS olmadan analiz yapılmaz.</p>}
      {(error || state.message) && <p className={error || state.phase === 'failed' ? 'va-error' : 'va-status'} role={error || state.phase === 'failed' ? 'alert' : 'status'}>{error || state.message}</p>}
      {media && <div className="va-player"><video key={media.url} ref={video} src={media.url} preload="auto" playsInline muted
        onLoadedData={() => setDecoded(true)}
        onLoadedMetadata={() => { const node = video.current; if (!node) return; try { const value = { name: media.file.name, bytes: media.file.size, durationMs: node.duration * 1000, width: node.videoWidth, height: node.videoHeight }; validateMetadata(value); setInfo(value) } catch (e) { setInfo(null); setError(e instanceof Error ? e.message : 'Video bilgisi geçersiz.') } }}
        onTimeUpdate={e => setCurrentMs(e.currentTarget.currentTime * 1000)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
        onError={() => { controller.cancel('decode'); setInfo(null); setDecoded(false); setError('Video açılamadı: codec desteklenmiyor veya dosya bozuk. MP4/H.264 deneyin.') }} />
        <div className="va-controls"><button type="button" onClick={play}>Oynat / Analizi sürdür</button><button type="button" onClick={pause}>Duraklat</button>
          <button type="button" disabled={!info} onClick={() => seek((currentMs - 5000) / 1000)}>5 sn geri</button><button type="button" disabled={!info} onClick={() => seek((currentMs + 5000) / 1000)}>5 sn ileri</button><button type="button" onClick={() => seek(0)}>Başa dön</button></div>
      </div>}
      {info && <p className="va-wrap"><strong>{info.name}</strong> · {(info.bytes / 1024 / 1024).toFixed(2)} MiB · {info.width} × {info.height} · {formatTime(info.durationMs)}</p>}
      <div className="va-controls"><button type="button" className="va-primary" disabled={!info || !decoded || !supported || !token || state.busy} onClick={start}>{state.session ? 'Analizi yeniden başlat (baştan)' : 'Analizi başlat'}</button>
        <button type="button" disabled={!state.busy} onClick={() => controller.cancel()}>Analizi iptal et</button></div>
      <p aria-live="polite">Yerel durum: {state.phase}{state.paused ? ' · kullanıcı duraklattı' : ''} · Video: {playing ? 'oynuyor' : 'duraklatıldı'}</p>
      <label className="va-progress">Plan ilerlemesi: {state.attempted} / {state.total} yuva<progress value={state.attempted} max={Math.max(1, state.total)} /></label>
      <p>Yerel örnek alınamayan yuva: {state.gaps}. Bu yuvalar backend’de uydurma kare/skip kaydı oluşturmaz; analiz edilmemiş aralık kalır. Oynatma ilerlemesi analiz kapsamından bağımsızdır.</p>
    </section>
    {info && <VideoTimeline key={state.session?.runId??media?.id??'empty'} events={state.summary?.events ?? []} durationMs={info.durationMs} currentMs={currentMs} onSeek={seek} />}
    <VideoStage frame={state.frozen} />
    <VideoSummary key={state.session?.runId??'empty'} summary={state.summary} session={state.session} onSeek={seek} />
  </div>
}
