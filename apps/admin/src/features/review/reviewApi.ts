import { isReviewFrame, isReviewItem, isReviewSession, isReviewSummary, sameScope, sameDetector } from '@roadsense/shared'
import type { ReviewFrame, ReviewItem, ReviewSession, ReviewSummary, SessionScope, DetectorIdentity } from '@roadsense/shared'
import { validateMapReference } from '../damage-map/mapDamageAdapter.ts'
import type { MapReviewReference } from '../damage-map/mapDamageAdapter.ts'
import type { MapQuery } from '../damage-map/mapApi.ts'
import { localApiTarget } from '../../api/localApiTarget.ts'
import { abortError } from '../video-analysis/videoSampling.ts'
export type Filters = { status: string; canonicalClass: string }
export type Page<T> = { items:T[]; nextCursor:string|null }
export type EvidencePage = Page<ReviewFrame> & { observationCount:number; frameCount:number }
export type Vote = { commandId:string; expectedReviewRevision:number; decision:'approve'|'reject' }
export type ReviewContext = {session:SessionScope & {detector:DetectorIdentity}}
const obj=(v:unknown):v is Record<string,unknown>=>!!v && typeof v==='object' && !Array.isArray(v)
const demand=(v:unknown):void=>{if(!v)throw new Error('İnceleme yanıtının kimlik veya sözleşme kontrolü başarısız.')}
const id=(v:string)=>{if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v))throw new Error('Geçersiz kayıt kimliği.');return v}
export class ReviewApiError extends Error {
  status:number
  constructor(status:number){super(({401:'İnceleme kimliği geçersiz; yeniden giriş yapın.',403:'Bu kimliğin reviewer erişimi yok.',404:'Kayıt veya kanıt bulunamadı.',409:'Kayıt başka bir karar veya run nedeniyle değişti. Güncel durum okunuyor.',413:'Yanıt güvenli boyut sınırını aşıyor.',422:'İnceleme isteği veya devam sayfası geçersiz.'} as Record<number,string>)[status]??'İnceleme servisine erişilemedi.');this.status=status}
}
export function createReviewApi(token:string,target:string='http://127.0.0.1:8002',fetcher:typeof fetch=fetch,timeoutMs=12000){
  const origin=localApiTarget(target)
  if(!/^[\x21-\x7e]{32,480}$/.test(token))throw new Error('Reviewer kimliğini parola alanına girin; sohbetten paylaşmayın.')
  async function request(path:string,signal:AbortSignal,body?:Vote,binaryMime?:string):Promise<unknown>{
    const controller=new AbortController(),abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()
    let timer:ReturnType<typeof setTimeout>|undefined,listener=()=>{}
    try {
      const cancelled=new Promise<never>((_,reject)=>{listener=()=>reject(abortError());controller.signal.addEventListener('abort',listener,{once:true});if(controller.signal.aborted)listener()})
      const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{reject(new Error('İnceleme isteği zaman aşımına uğradı.'));controller.abort()},timeoutMs)})
      return await Promise.race([cancelled,timeout,(async()=>{
        if(controller.signal.aborted)throw abortError()
        const response=await fetcher(origin+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:controller.signal,cache:'no-store',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'})
        if(!response.ok)throw new ReviewApiError(response.status)
        const mime=response.headers.get('content-type')?.split(';')[0]
        demand(binaryMime?mime===binaryMime && ['image/png','image/jpeg'].includes(mime):mime==='application/json')
        const limit=binaryMime?8*1024*1024:2*1024*1024,reader=response.body?.getReader();demand(reader)
        const chunks:Uint8Array[]=[];let size=0
        while(true){const chunk=await reader!.read();if(chunk.done)break;size+=chunk.value.length;if(size>limit){await reader!.cancel();throw new ReviewApiError(413)}chunks.push(chunk.value)}
        if(controller.signal.aborted)throw abortError()
        const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
        if(binaryMime){demand(binaryMime==='image/png'?bytes.length>8 && [137,80,78,71,13,10,26,10].every((x,i)=>bytes[i]===x):bytes.length>3 && bytes[0]===255 && bytes[1]===216 && bytes[2]===255);return new Blob([bytes],{type:binaryMime})}
        return JSON.parse(new TextDecoder().decode(bytes)) as unknown
      })()])
    }catch(e){if(signal.aborted)throw abortError();if(e instanceof ReviewApiError)throw e;throw new Error('İnceleme bağlantısı veya yanıtı doğrulanamadı. Karar gönderildiyse sonucu ayrıca kontrol edin.')}
    finally{clearTimeout(timer);signal.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',listener)}
  }
  const base=(s:ReviewContext)=>`/v1/review/sessions/${id(s.session.sessionId)}/runs/${id(s.session.runId)}`
  const query=(values:Record<string,string|undefined|null>)=>{const q=new URLSearchParams();for(const [k,v] of Object.entries(values))if(v)q.set(k,v);return '?'+q.toString()}
  function page<T>(v:unknown,guard:(v:unknown)=>v is T):Page<T>{demand(obj(v)&&v.environment==='TEST'&&Array.isArray(v.items)&&v.items.length<=100&&(v.nextCursor===null||typeof v.nextCursor==='string'&&v.nextCursor.length<=768)&&v.items.every(guard));return v as unknown as Page<T>}
  return {
    async mapPage(q:MapQuery,signal:AbortSignal){
      demand(['production','test'].includes(q.layer)&&['','REAL','SIM','REPLAY'].includes(q.sourceDomain)&&Number.isInteger(q.limit)&&q.limit>=1&&q.limit<=100&&(q.cursor===null||typeof q.cursor==='string'&&q.cursor.length<=768))
      const v=await request('/v1/review/map-damages'+query({environment:'TEST',layer:q.layer,sourceDomain:q.sourceDomain,limit:String(q.limit),cursor:q.cursor}),signal)
      const p=page(v,isReviewItem);demand(obj(v)&&v.layer===q.layer&&p.items.length<=q.limit&&(!q.sourceDomain||p.items.every(i=>i.sourceDomain===q.sourceDomain)))
      return p
    },
    async reference(reference:MapReviewReference,signal:AbortSignal):Promise<ReviewItem>{
      const r=validateMapReference(reference);demand(r.origin===origin)
      const p=page(await request(`/v1/review/sessions/${id(r.sessionId)}/runs/${id(r.runId)}/candidates`+query({candidateId:r.candidateId,limit:'25'}),signal),isReviewItem)
      demand(p.items.length===1&&p.nextCursor===null)
      const item=p.items[0];demand(item.sessionId===r.sessionId&&item.runId===r.runId&&item.sourceDomain===r.sourceDomain&&item.candidateId===r.candidateId&&item.verifiedDamage?.verifiedId===r.verifiedId)
      return item
    },
    async sessions(signal:AbortSignal,cursor?:string|null){return page(await request('/v1/review/sessions'+query({cursor,limit:'25',sourceDomain:'REPLAY'}),signal),isReviewSession)},
    async candidates(s:ReviewSession,filters:Filters,signal:AbortSignal,cursor?:string|null,candidateId?:string){
      const p=page(await request(base(s)+'/candidates'+query({cursor,limit:'25',status:filters.status,canonicalClass:filters.canonicalClass,candidateId:candidateId?id(candidateId):undefined}),signal),isReviewItem)
      demand(p.items.every(i=>sameScope(i,s.session)&&sameDetector(i,s.session.detector)));return p
    },
    async summary(s:ReviewSession,signal:AbortSignal):Promise<ReviewSummary>{const v=await request(base(s)+'/summary',signal);demand(isReviewSummary(v)&&sameScope(v,s.session)&&sameDetector(v,s.session.detector));return v as ReviewSummary},
    async frames(s:ReviewContext,cid:string,signal:AbortSignal,cursor?:string|null):Promise<EvidencePage>{
      const v=await request(base(s)+'/candidates/'+id(cid)+'/evidence'+query({cursor,limit:'100'}),signal),p=page(v,isReviewFrame)
      const observationIds=p.items.flatMap(f=>f.observations.map(o=>o.observationId))
      demand(obj(v)&&v.candidateId===cid&&Number.isSafeInteger(v.observationCount)&&Number.isSafeInteger(v.frameCount)&&Number(v.observationCount)>=observationIds.length&&Number(v.frameCount)>=p.items.length&&Number(v.frameCount)>0&&Number(v.frameCount)<=Number(v.observationCount)&&p.items.length>0&&p.items.length<=20&&observationIds.length<=100&&new Set(observationIds).size===observationIds.length&&new Set(p.items.map(f=>f.frame.frameId)).size===p.items.length&&p.items.every(f=>sameScope(f,s.session)&&sameDetector(f,s.session.detector)&&f.candidateId===cid))
      return {...p,observationCount:Number((v as Record<string,unknown>).observationCount),frameCount:Number((v as Record<string,unknown>).frameCount)}
    },
    async image(s:ReviewContext,f:ReviewFrame,signal:AbortSignal):Promise<Blob>{demand(sameScope(f,s.session)&&sameDetector(f,s.session.detector)&&f.evidence.available&&f.evidence.mime);return await request(base(s)+'/evidence/'+id(f.frame.frameId),signal,undefined,f.evidence.mime) as Blob},
    async vote(s:ReviewSession,item:ReviewItem,body:Vote,signal:AbortSignal){
      demand(sameScope(item,s.session)&&sameDetector(item,s.session.detector)&&item.eventId&&item.sourceDomain==='REPLAY')
      const v=await request(`/v1/sessions/${id(s.session.sessionId)}/runs/${id(s.session.runId)}/events/${id(item.eventId!)}/review`,signal,body)
      demand(obj(v)&&v.resultLabel==='TEST_SYNTHETIC'&&obj(v.event)&&v.event.eventId===item.eventId&&sameScope(v.event,s.session));return v
    },
  }
}
export type ReviewApi=ReturnType<typeof createReviewApi>
