import type { ReviewFrame, ReviewItem, ReviewSession, ReviewSummary } from '@roadsense/shared'
import { createReviewApi, ReviewApiError } from './reviewApi.ts'
import type { ReviewApi, Filters, Vote } from './reviewApi.ts'
import { validateMapReference } from '../damage-map/mapDamageAdapter.ts'
import type { MapReviewReference } from '../damage-map/mapDamageAdapter.ts'
import type { ReviewContext } from './reviewApi.ts'
import { localApiTarget } from '../../api/localApiTarget.ts'
const initial=()=>({reference:null as MapReviewReference|null,connected:false,loading:false,error:'',message:'',sessions:[] as ReviewSession[],sessionCursor:null as string|null,session:null as ReviewSession|null,
  items:[] as ReviewItem[],cursor:null as string|null,selected:null as ReviewItem|null,frames:[] as ReviewFrame[],frameCursor:null as string|null,
  frame:null as ReviewFrame|null,imageUrl:'',summary:null as ReviewSummary|null,filters:{status:'pending',canonicalClass:''} as Filters,pendingDecision:false})
export type ReviewState=ReturnType<typeof initial>
type Pending={session:ReviewSession;item:ReviewItem;body:Vote}
export class ReviewController {
  private state=initial();private listeners=new Set<()=>void>();private active?:AbortController;private generation=0;private api?:ReviewApi;private pending?:Pending
  private factory:typeof createReviewApi;private createUrl:(blob:Blob)=>string;private revoke:(url:string)=>void
  target='http://127.0.0.1:8002'
  constructor(deps:{api?:typeof createReviewApi;createUrl?:(b:Blob)=>string;revoke?:(u:string)=>void}={}){this.factory=deps.api??createReviewApi;this.createUrl=deps.createUrl??(b=>URL.createObjectURL(b));this.revoke=deps.revoke??(u=>URL.revokeObjectURL(u))}
  getSnapshot=()=>this.state
  subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>this.listeners.delete(fn)}
  private update(patch:Partial<ReviewState>){this.state={...this.state,...patch};this.listeners.forEach(fn=>fn())}
  private clearImage(){if(this.state.imageUrl)this.revoke(this.state.imageUrl);this.update({imageUrl:'',frame:null})}
  private begin(){this.active?.abort();this.active=new AbortController();const generation=++this.generation;this.update({loading:true,error:'',message:''});return {signal:this.active.signal,current:()=>generation===this.generation&&!this.active?.signal.aborted}}
  private failed(e:unknown,current:()=>boolean){if(!current())return;const message=e instanceof Error?e.message:'İnceleme tamamlanamadı.';if(e instanceof ReviewApiError&&e.status===401)this.disconnect();this.update({error:message})}
  disconnect(){this.generation++;this.active?.abort();this.api=undefined;this.pending=undefined;this.clearImage();this.update(initial())}
  dispose(){this.disconnect();this.listeners.clear()}
  setTarget(value:string){const target=localApiTarget(value);this.disconnect();this.target=target}
  async connect(token:string){this.disconnect();const task=this.begin();try{const api=this.factory(token,this.target);const page=await api.sessions(task.signal);if(!task.current())return;this.api=api;this.update({connected:true,sessions:page.items,sessionCursor:page.nextCursor})}catch(e){this.failed(e,task.current)}finally{if(task.current())this.update({loading:false})}}
  async connectReference(token:string,reference:MapReviewReference){
    this.disconnect();const task=this.begin()
    try{const r=validateMapReference(reference);if(r.origin!==this.target)throw new Error('Harita hedefi ile inceleme hedefi eşleşmiyor.')
      const api=this.factory(token,this.target),item=await api.reference(r,task.signal);if(!task.current())return
      this.api=api;this.update({connected:true,reference:r,selected:item,items:[item]})
      await this.selectItem(item)
    }catch(e){this.failed(e,task.current)}finally{if(task.current())this.update({loading:false})}
  }
  private context():ReviewContext|null{
    if(this.state.session)return this.state.session
    const i=this.state.selected
    if(!this.state.reference||!i)return null
    return {session:{contractVersion:i.contractVersion,sessionId:i.sessionId,runId:i.runId,sourceDomain:i.sourceDomain,detector:{detectorKind:i.detectorKind,modelVersion:i.modelVersion,classMapVersion:i.classMapVersion}}}
  }
  async sessionPage(cursor:string|null=null){if(!this.api)return;const api=this.api,task=this.begin();this.clearImage();this.update({session:null,selected:null,summary:null,items:[],frames:[]});try{const page=await api.sessions(task.signal,cursor);if(task.current())this.update({sessions:page.items,sessionCursor:page.nextCursor})}catch(e){this.failed(e,task.current)}finally{if(task.current())this.update({loading:false})}}
  async selectSession(session:ReviewSession,cursor:string|null=null,filters=this.state.filters){if(!this.api)return;const api=this.api,task=this.begin();this.clearImage();this.update({session,selected:null,frames:[],items:[],summary:null,filters});try{const [page,summary]=await Promise.all([api.candidates(session,filters,task.signal,cursor),api.summary(session,task.signal)]);if(task.current())this.update({items:page.items,cursor:page.nextCursor,summary})}catch(e){this.failed(e,task.current)}finally{if(task.current())this.update({loading:false})}}
  async filters(filters:Filters){if(this.state.session)await this.selectSession(this.state.session,null,filters);else this.update({filters})}
  async selectItem(item:ReviewItem,cursor:string|null=null){const session=this.context();if(!this.api||!session)return;const api=this.api,task=this.begin();this.clearImage();this.update({selected:item,frames:[]});try{const page=await api.frames(session,item.candidateId,task.signal,cursor);if(!task.current())return;if(page.items.some(f=>f.eventId!==item.eventId||f.canonicalClass!==item.canonicalClass))throw new Error('Kanıt olay kimliği veya sınıfı seçili kayıtla eşleşmiyor.');this.update({frames:page.items,frameCursor:page.nextCursor});if(page.items[0])await this.loadImage(api,session,page.items[0],task)}catch(e){this.failed(e,task.current)}finally{if(task.current())this.update({loading:false})}}
  private async loadImage(api:ReviewApi,s:ReviewContext,f:ReviewFrame,task:{signal:AbortSignal;current:()=>boolean}){this.clearImage();this.update({frame:f});if(!f.evidence.available)throw new Error('Bu kanıt görüntüsü şu anda kullanılamıyor.');const blob=await api.image(s,f,task.signal);if(!task.current())return;const url=this.createUrl(blob);this.update({imageUrl:url})}
  async selectFrame(frame:ReviewFrame){if(!this.api||!this.context()||frame.candidateId!==this.state.selected?.candidateId||frame.eventId!==this.state.selected.eventId)return;const api=this.api,s=this.context()!,task=this.begin();try{await this.loadImage(api,s,frame,task)}catch(e){this.failed(e,task.current)}finally{if(task.current())this.update({loading:false})}}
  imageFailed(url:string){if(url!==this.state.imageUrl)return;this.clearImage();this.update({error:'Kanıt görüntüsünün doğal boyutları veya içeriği doğrulanamadı.'})}
  async vote(decision:'approve'|'reject'){if(this.state.reference||!this.api||!this.state.session||!this.state.selected||this.state.selected.reviewStatus!=='pending'||this.state.loading||this.pending)return
    this.pending={session:this.state.session,item:this.state.selected,body:{commandId:crypto.randomUUID(),expectedReviewRevision:this.state.selected.reviewRevision,decision}};this.update({pendingDecision:true});await this.sendPending()}
  async retry(){if(this.pending&&!this.state.loading)await this.sendPending()}
  async refresh(){if(!this.api||!this.state.session)return;if(this.pending){await this.reconcileOnly();return}const selected=this.state.selected,s=this.state.session;await this.selectSession(s);if(selected&&this.api){const task=this.begin();try{const p=await this.api.candidates(s,{status:'',canonicalClass:''},task.signal,null,selected.candidateId);if(task.current()&&p.items[0])this.update({selected:p.items[0]})}catch(e){this.failed(e,task.current)}finally{if(task.current())this.update({loading:false})}}}
  private async canonical(api:ReviewApi,pending:Pending,task:{signal:AbortSignal;current:()=>boolean}){
    const [p,summary,page]=await Promise.all([api.candidates(pending.session,{status:'',canonicalClass:''},task.signal,null,pending.item.candidateId),api.summary(pending.session,task.signal),api.candidates(pending.session,this.state.filters,task.signal)])
    if(!task.current())return
    if(!p.items[0])throw new Error('Güncel karar kaydı bulunamadı; run değişmiş olabilir.')
    const item=p.items[0];if(this.state.selected?.candidateId!==item.candidateId){this.clearImage();this.update({frames:[]})}this.update({selected:item,session:pending.session,summary,items:page.items,cursor:page.nextCursor})
    if(item.reviewStatus!=='pending'){this.pending=undefined;this.update({pendingDecision:false})}
  }
  private async reconcileOnly(){if(!this.pending||!this.api)return;const task=this.begin();try{await this.canonical(this.api,this.pending,task);if(task.current())this.update({message:this.pending?'Karar henüz doğrulanamadı; yalnız aynı komutla tekrar deneyebilirsiniz.':'Güncel sunucu kararı okundu.'})}catch(e){this.failed(e,task.current)}finally{if(task.current())this.update({loading:false})}}
  private async sendPending(){if(!this.pending||!this.api)return;const pending=this.pending,api=this.api,task=this.begin();let failed:unknown
    try{try{await api.vote(pending.session,pending.item,pending.body,task.signal)}catch(e){failed=e;if(e instanceof ReviewApiError&&[401,403].includes(e.status))throw e}
      if(!task.current())return;await this.canonical(api,pending,task);if(task.current())this.update({message:failed instanceof ReviewApiError&&failed.status===409?'Karar çatışması: sunucudaki güncel durum gösteriliyor.':failed?'İstek sonucu belirsizdi; sunucudaki güncel durum kontrol edildi.':this.pending?'Karar henüz doğrulanamadı.':'Karar sunucudan doğrulandı.'})
    }catch(e){this.failed(e,task.current)}finally{if(task.current())this.update({loading:false})}}
}
