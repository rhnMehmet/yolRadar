import { useRef } from 'react'
import type { CSSProperties } from 'react'
import type { ReviewFrame } from '@roadsense/shared'
import { classLabel, formatTime } from '../video-analysis/videoSampling.ts'
import { evidenceBoxes,imageDimensionsMatch } from './evidenceGeometry.ts'
export function ReviewEvidence({frame,url,onError}:{frame:ReviewFrame|null;url:string;onError:()=>void}){
  const container=useRef<HTMLDivElement>(null)
  if(!frame)return <div className="rv-empty">Bir olay seçerek kayıtlı kanıtını inceleyin.</div>
  const image=frame.frame
  const boxes=evidenceBoxes(frame)
  return <section aria-label="Olay kanıtı"><div ref={container} className="rv-evidence">
    {url?<div className="rv-plane" style={{aspectRatio:`${image.width}/${image.height}`,'--image-ratio':image.width/image.height} as CSSProperties}>
      <img key={url} src={url} alt={`${classLabel(frame.canonicalClass)} için kayıtlı TEST kanıt karesi`} width={image.width} height={image.height} onError={onError} onLoad={e=>{if(!imageDimensionsMatch(frame,e.currentTarget.naturalWidth,e.currentTarget.naturalHeight))onError()}}/>
      {boxes.map((b,i)=><span key={b.id} className="rv-box" style={{left:b.left+'%',top:b.top+'%',width:b.width+'%',height:b.height+'%'}}><span>{classLabel(frame.observations[i].canonicalClass)} · {frame.observations[i].confidence.toFixed(2)}</span></span>)}
    </div>:<p>Kanıt görüntüsü bekleniyor veya kullanılamıyor.</p>}
  </div><div className="rv-evidence-meta"><span>{image.width} × {image.height} · PTS {formatTime(image.capturedAt.valueMs)}</span><button type="button" disabled={!url} onClick={()=>{void container.current?.requestFullscreen?.().catch(()=>undefined)}}>Tam ekran</button></div>
  <p>Bu kutular yalnız kayıtlı kanıt karesine aittir. TEST_SYNTHETIC model skoru gerçek doğruluk veya hasar şiddeti değildir.</p></section>
}
