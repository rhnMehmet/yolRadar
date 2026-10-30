import { useState } from 'react'
import { API_TARGETS } from '../../api/localApiTarget.ts'
import type { MapController } from './mapController.ts'
import { classLabel } from '../video-analysis/videoSampling.ts'
export function MapDataPanel({controller,classFilter,onClassFilter}:{controller:MapController;classFilter:string;onClassFilter:(v:string)=>void}){
  const s=controller.getSnapshot(),[token,setToken]=useState(''),[target,setTarget]=useState(controller.target)
  return <section className="map-data" aria-label="Harita katmanları ve reviewer erişimi">
    <h3>Katmanlar ve doğrulanmış kayıtlar</h3>
    <div className="map-data__layers"><label><input type="checkbox" checked={s.demo} onChange={e=>controller.setDemo(e.target.checked)}/>DEMO · 3 temsili nokta</label>
      <label><input type="checkbox" checked={s.production} onChange={e=>void controller.configure({production:e.target.checked})}/>ÜRETİM · Verified Damage</label>
      <label><input type="checkbox" checked={s.test} disabled={!s.connected} onChange={e=>void controller.configure({test:e.target.checked})}/>TEST · Verified Damage (sentetik olabilir)</label></div>
    <label>Reviewer API alanı<select value={target} onChange={e=>{controller.setTarget(e.target.value);setTarget(e.target.value);setToken('');onClassFilter('')}}>{API_TARGETS.map(t=><option key={t.origin} value={t.origin}>{t.label}</option>)}</select></label>
    <form onSubmit={e=>{e.preventDefault();void controller.connect(token);setToken('')}}><label>Harita reviewer kimliği<input type="password" autoComplete="off" spellCheck={false} value={token} disabled={s.connected||s.loading} onChange={e=>setToken(e.target.value)}/></label>
      <button disabled={!token||s.loading||s.connected}>Harita verisine bağlan</button><button type="button" onClick={()=>{controller.disconnect();setToken('');onClassFilter('')}}>Çıkış / Verileri temizle</button></form>
    <p>Kimlik yalnız bu ekranın belleğindedir; İncelemeye aktarılmaz. API olmadan demo harita kullanılabilir. TEST ortamı üretim kanıtı değildir.</p>
    {s.error&&<p role="alert" className="map-data__error">API: {s.error}</p>}{s.loading&&<p role="status">API kayıtları yükleniyor…</p>}
    {s.connected&&<><p>ÜRETİM: Bu TEST-only servis üretim kaydı sunmaz. {s.productionPage.items.length} kayıt bu sayfada.</p>
      <div className="map-data__filters"><label>Kaynak<select value={s.sourceDomain} onChange={e=>void controller.configure({sourceDomain:e.target.value as typeof s.sourceDomain})}><option value="">Yetkili tüm kaynaklar</option><option>REAL</option><option>REPLAY</option><option>SIM</option></select></label>
        <label>Sayfa sınırı<select value={s.limit} onChange={e=>void controller.configure({limit:Number(e.target.value)})}>{[25,50,100].map(n=><option key={n}>{n}</option>)}</select></label>
        <label>Sınıf (yalnız yüklenen sayfa)<select value={classFilter} onChange={e=>onClassFilter(e.target.value)}><option value="">Tümü</option>{['pothole','longitudinal_crack','transverse_crack','alligator_crack','other','unknown'].map(c=><option key={c} value={c}>{classLabel(c)}</option>)}</select></label></div>
      {s.test&&<><p><strong>TEST · Sayfa {s.pageIndex+1}</strong>: {s.testPage.items.length} gösterilebilir kayıt yüklendi; veritabanı toplamı değildir. {s.testPage.rejected>0&&`${s.testPage.rejected} kayıt konum/katman politikası nedeniyle çizilmedi.`}</p>
        {!s.loading&&!s.testPage.items.length&&<p>Bu yetki ve filtrelerde uygun GPS VerifiedDamage yok. İçerik onayı tek başına GPS oluşturmaz.</p>}
        <div className="map-data__actions"><button type="button" disabled={!s.pageIndex||s.loading} onClick={()=>void controller.previous()}>Önceki sayfa</button><button type="button" disabled={!s.testPage.nextCursor||s.loading} onClick={()=>void controller.next()}>Sonraki sayfa</button><button type="button" disabled={s.loading} onClick={()=>void controller.refresh()}>İlk sayfa / Yenile</button></div></>}
    </>}
  </section>
}
