import { useEffect, useMemo, useRef, useState } from 'react'
import { divIcon, Popup as LeafletPopup } from 'leaflet'
import type { LeafletEventHandlerFnMap } from 'leaflet'
import { MapContainer, Marker, Popup, TileLayer, ZoomControl, useMap } from 'react-leaflet'
import { getDamageTypeLabel, getReportStatusLabel } from '@roadsense/shared'
import { demoMapMarkers, INITIAL_MAP_ZOOM, ISPARTA_CENTER } from './demoMapMarkers'
import { MapDataPanel } from './MapDataPanel.tsx'
import { VerifiedDamageLayer } from './VerifiedDamageLayer.tsx'
import { useMapDamages } from './useMapDamages.ts'
import type { MapReviewReference } from './mapDamageAdapter.ts'
import 'leaflet/dist/leaflet.css'
import './DamageMap.css'

const tileUrl = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const attribution = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> katkıda bulunanlar'
const center: [number, number] = [ISPARTA_CENTER.latitude, ISPARTA_CENTER.longitude]

const icons = demoMapMarkers.map((marker, index) => divIcon({
  className: 'damage-map__pin-host',
  html: `<span class="damage-map__pin damage-map__pin--${marker.status}" aria-hidden="true"><b>${index + 1}</b></span>`,
  iconSize: [36, 44],
  iconAnchor: [18, 42],
  popupAnchor: [0, -40],
}))

function MapViewportSync() {
  const map = useMap()
  useEffect(() => {
    let frame = 0
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        map.invalidateSize({ pan: false })
        map.eachLayer(layer=>{if(layer instanceof LeafletPopup && layer.isOpen())layer.update()})
      })
    }
    const observer = new ResizeObserver(update)
    observer.observe(map.getContainer())
    update()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [map])
  return null
}

function CenterControl() {
  const map = useMap()
  return (
    <div className="damage-map__center-control leaflet-top leaflet-right">
      <button type="button" className="leaflet-control" onClick={() => map.setView(center, INITIAL_MAP_ZOOM)}>
        Isparta merkeze dön
      </button>
    </div>
  )
}

type TileState = 'loading' | 'ready' | 'error'

export default function DamageMap({onReview}:{onReview:(reference:MapReviewReference)=>void}) {
  const {controller,state}=useMapDamages()
  const [classFilter,setClassFilter]=useState('')
  const verifiedItems=[...state.productionPage.items,...(state.test?state.testPage.items:[])].filter(i=>!classFilter||i.item.canonicalClass===classFilter)
  const [tileState, setTileState] = useState<TileState>('loading')
  const [generation, setGeneration] = useState(0)
  const counts = useRef({ loaded: 0, failed: 0 })

  const events = useMemo<LeafletEventHandlerFnMap>(() => ({
    loading: () => {
      counts.current = { loaded: 0, failed: 0 }
      setTileState('loading')
    },
    tileload: () => { counts.current.loaded += 1 },
    tileerror: () => { counts.current.failed += 1 },
    load: () => setTileState(counts.current.failed > 0 ? 'error' : 'ready'),
  }), [])

  useEffect(() => {
    if (tileState !== 'loading') return
    const timeout = window.setTimeout(() => setTileState('error'), 15_000)
    return () => window.clearTimeout(timeout)
  }, [tileState, generation])

  const retryTiles = () => {
    counts.current = { loaded: 0, failed: 0 }
    setTileState('loading')
    setGeneration((value) => value + 1)
  }

  return (
    <section className="panel damage-map" aria-labelledby="damage-map-title">
      <div className="panel-heading damage-map__heading">
        <div><span className="section-kicker">ISPARTA MERKEZ</span><h2 id="damage-map-title">Hasar Haritası</h2></div>
        <span className="damage-map__count">3 demo nokta</span>
      </div>

      <p className="damage-map__demo-notice">Demo harita — işaretçiler gerçek yol hasarı bildirimlerini temsil etmez.</p>

      <MapDataPanel controller={controller} classFilter={classFilter} onClassFilter={setClassFilter}/>
      <div className="damage-map__canvas-frame">
        <MapContainer
          className="damage-map__canvas"
          center={center}
          zoom={INITIAL_MAP_ZOOM}
          minZoom={3}
          maxZoom={19}
          zoomControl={false}
          scrollWheelZoom={false}
          touchZoom
          aria-label="Isparta merkezli demo hasar haritası"
        >
          <ZoomControl position="topleft" zoomInTitle="Yakınlaştır" zoomOutTitle="Uzaklaştır" />
          <TileLayer key={generation} url={tileUrl} attribution={attribution} maxZoom={19} keepBuffer={0} eventHandlers={events} />
          <MapViewportSync />
          <CenterControl />
          {state.demo && demoMapMarkers.map((marker, index) => (
            <Marker
              key={marker.id}
              position={[marker.coordinates.latitude, marker.coordinates.longitude]}
              icon={icons[index]}
              title={`${index + 1}. demo işaretçisi: ${getDamageTypeLabel(marker.damageType)} (${marker.id})`}
              keyboard
            >
              <Popup minWidth={180} maxWidth={220}>
                <div className="damage-map__popup">
                  <span className="damage-map__popup-kicker">YALNIZCA ARAYÜZ TESTİ</span>
                  <h3>{getDamageTypeLabel(marker.damageType)}</h3>
                  <dl>
                    <div><dt>Demo kimliği</dt><dd>{marker.id}</dd></div>
                    <div><dt>Durum</dt><dd>{getReportStatusLabel(marker.status)}</dd></div>
                    <div><dt>Koordinat</dt><dd>{marker.coordinates.latitude.toFixed(4)}, {marker.coordinates.longitude.toFixed(4)}</dd></div>
                  </dl>
                  <p>Temsili test noktasıdır. Gerçek bir yol hasarı bildirimi değildir.</p>
                </div>
              </Popup>
            </Marker>
          ))}
          <VerifiedDamageLayer items={verifiedItems} onReview={onReview}/>
        </MapContainer>
        {tileState === 'loading' && <div className="damage-map__loading" role="status">Harita döşemeleri yükleniyor…</div>}
      </div>

      {tileState === 'error' && (
        <div className="damage-map__error" role="alert">
          <p>Harita döşemelerinin tamamı yüklenemedi. İnternet bağlantınızı kontrol edin. Demo noktalar gerçek kayıt değildir.</p>
          <button type="button" onClick={retryTiles}>Döşemeleri yeniden dene</button>
        </div>
      )}

      <div className="damage-map__legend" aria-label="Katman işaretçi açıklamaları">
        <span><i className="damage-map__verified-pin">T</i>TEST Verified Damage · açıkça etkinleştirilir</span>
        <span>ÜRETİM Verified Damage · TEST servisinde boş</span>
        {demoMapMarkers.map((marker, index) => (
          <span key={marker.id}><i className={`damage-map__legend-dot damage-map__legend-dot--${marker.status}`}>{index + 1}</i>{getDamageTypeLabel(marker.damageType)}</span>
        ))}
      </div>
      <div className="damage-map__footer">
        <span>Haritayı sürükleyin; + / − ile yakınlaştırın. Dokunmatik ekranda iki parmakla yakınlaştırabilirsiniz.</span>
        <span>Bu 3 test noktası paneldeki 8 bildirimden ayrıdır; istatistiklere dahil değildir.</span>
      </div>
    </section>
  )
}
