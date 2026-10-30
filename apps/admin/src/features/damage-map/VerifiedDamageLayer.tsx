import { divIcon,latLngBounds } from 'leaflet'
import { Marker,Popup,useMap } from 'react-leaflet'
import { classLabel,formatTime } from '../video-analysis/videoSampling.ts'
import type { MapDamage,MapReviewReference } from './mapDamageAdapter.ts'
const testIcon=divIcon({className:'damage-map__verified-host',html:'<span class="damage-map__verified-pin" aria-hidden="true">T</span>',iconSize:[38,38],iconAnchor:[19,19]})
export function VerifiedDamageLayer({items,onReview}:{items:MapDamage[];onReview:(r:MapReviewReference)=>void}){
  const map=useMap()
  return <><div className="damage-map__fit leaflet-bottom leaflet-left"><button type="button" className="leaflet-control" disabled={!items.length} onClick={()=>{if(items.length)map.fitBounds(latLngBounds(items.map(i=>[i.latitude,i.longitude])),{maxZoom:16,padding:[40,40]})}}>Yüklenen TEST noktalarını göster</button></div>
    {items.map(m=>{const i=m.item;return <Marker key={m.key} position={[m.latitude,m.longitude]} icon={testIcon} keyboard title={`TEST doğrulanmış hasar: ${classLabel(i.canonicalClass)} · ${i.verifiedDamage!.verifiedId}`}><Popup minWidth={160} maxWidth={280} maxHeight={250}>
      <div className="damage-map__popup"><span className="damage-map__popup-kicker">TEST · {i.resultOrigin}</span><h3>{classLabel(i.canonicalClass)}</h3>
        <dl><dt>İçerik / konum</dt><dd>{i.reviewStatus} / {i.locationStatus}</dd><dt>Ortam / kaynak</dt><dd>{i.environment} / {i.sourceDomain}</dd><dt>Detector</dt><dd>{i.detectorKind}</dd><dt>Model / classMap</dt><dd>{i.modelVersion} / {i.classMapVersion}</dd>
          <dt>Hasar GPS</dt><dd>{m.latitude}, {m.longitude}</dd><dt>Yöntem</dt><dd>{m.method}</dd><dt>GPS doğruluğu</dt><dd>{m.accuracyM} m</dd><dt>Hasar belirsizliği</dt><dd>{m.uncertaintyM} m</dd>
          <dt>Konum inceleyen</dt><dd>{i.verifiedDamage!.review.reviewerId}</dd><dt>Kayıtlı audit</dt><dd>{i.reviewedAt?`${i.reviewerId} · ${i.reviewedAt} · ${i.reviewScope}`:'Kayıtlı audit bilgisi yok'}</dd>
          {i.sourceDomain==='REPLAY'&&i.videoTimestampMs!==undefined&&<><dt>Video PTS</dt><dd>{formatTime(i.videoTimestampMs)}</dd></>}
        </dl><p>Konum tahminidir; VERIFIED kesin konum garantisi değildir. Bakım durumu bilgisi yoktur. TEST üretim tespiti değildir.</p><button type="button" onClick={()=>onReview(m.reference)}>İncelemede Aç</button>
      </div></Popup></Marker>})}
  </>
}
