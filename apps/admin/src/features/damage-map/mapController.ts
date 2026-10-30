import { localApiTarget } from '../../api/localApiTarget.ts'
import { ReviewApiError } from '../review/reviewApi.ts'
import { createMapApi } from './mapApi.ts'
import type { MapApi,MapPage } from './mapApi.ts'
import type { SourceDomain } from '@roadsense/shared'
const emptyPage=():MapPage=>({items:[],nextCursor:null,rejected:0})
const initial=()=>({connected:false,loading:false,error:'',demo:true,production:true,test:false,sourceDomain:'' as SourceDomain|'',limit:25,
  productionPage:emptyPage(),testPage:emptyPage(),cursors:[null] as (string|null)[],pageIndex:0})
export class MapController {
  private state=initial();private listeners=new Set<()=>void>();private api?:MapApi;private active?:AbortController;private generation=0
  target='http://127.0.0.1:8003'
  private factory:typeof createMapApi
  constructor(factory= createMapApi){this.factory=factory}
  getSnapshot=()=>this.state
  subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>this.listeners.delete(fn)}
  private update(p:Partial<ReturnType<typeof initial>>){this.state={...this.state,...p};this.listeners.forEach(fn=>fn())}
  disconnect(){++this.generation;this.active?.abort();this.api=undefined;this.update(initial())}
  dispose(){this.disconnect();this.listeners.clear()}
  setTarget(target:string){const next=localApiTarget(target);this.disconnect();this.target=next}
  setDemo(demo:boolean){this.update({demo})}
  async connect(token:string){this.disconnect();try{this.api=this.factory(token,this.target);await this.load(true)}catch(e){this.disconnect();this.update({error:e instanceof Error?e.message:'Harita kimliği doğrulanamadı.'})}}
  async configure(p:{test?:boolean;production?:boolean;sourceDomain?:SourceDomain|'';limit?:number}){
    if(p.limit!==undefined&&(!Number.isInteger(p.limit)||p.limit<1||p.limit>100))return
    this.update({...p,cursors:[null],pageIndex:0,productionPage:emptyPage(),testPage:emptyPage()});await this.load()
  }
  async next(){if(!this.state.testPage.nextCursor||this.state.loading)return;const cursors=[...this.state.cursors.slice(0,this.state.pageIndex+1),this.state.testPage.nextCursor];this.update({cursors,pageIndex:this.state.pageIndex+1});await this.load()}
  async previous(){if(this.state.pageIndex===0||this.state.loading)return;this.update({pageIndex:this.state.pageIndex-1});await this.load()}
  async refresh(){this.update({cursors:[null],pageIndex:0});await this.load()}
  private async load(authenticate=false,recover=true){
    if(!this.api)return
    this.active?.abort();const active=new AbortController();this.active=active;const generation=++this.generation,api=this.api,s=this.state
    const current=()=>generation===this.generation&&!active.signal.aborted
    this.update({loading:true,error:'',productionPage:emptyPage(),testPage:emptyPage()})
    try{
      // The default production read authenticates reviewer even when both layers are hidden.
      const production=await api.page({layer:'production',sourceDomain:s.sourceDomain,limit:s.limit,cursor:null},active.signal)
      if(!current())return
      const test=s.test?await api.page({layer:'test',sourceDomain:s.sourceDomain,limit:s.limit,cursor:s.cursors[s.pageIndex]},active.signal):emptyPage()
      if(current())this.update({connected:true,productionPage:s.production?production:emptyPage(),testPage:test})
    }catch(e){if(!current())return
      if(e instanceof ReviewApiError&&e.status===422&&s.cursors[s.pageIndex]&&recover){this.update({cursors:[null],pageIndex:0});await this.load(authenticate,false);return}
      if(authenticate||e instanceof ReviewApiError&&[401,403].includes(e.status))this.disconnect()
      this.update({error:e instanceof Error?e.message:'Harita API bağlantısı başarısız.'})
    }finally{if(current())this.update({loading:false})}
  }
}
