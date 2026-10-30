import { createReviewApi } from '../review/reviewApi.ts'
import { adaptMapDamage } from './mapDamageAdapter.ts'
import type { MapLayer,MapDamage } from './mapDamageAdapter.ts'
import type { SourceDomain } from '@roadsense/shared'
export type MapQuery = {layer:MapLayer;sourceDomain:SourceDomain|'';limit:number;cursor:string|null}
export type MapPage = {items:MapDamage[];nextCursor:string|null;rejected:number}
/** Read-only capability: no review or location mutation is exposed. */
export function createMapApi(token:string,origin:string,fetcher:typeof fetch=fetch){
  const api=createReviewApi(token,origin,fetcher)
  return {async page(q:MapQuery,signal:AbortSignal):Promise<MapPage>{
    const page=await api.mapPage(q,signal),items=page.items.map(i=>adaptMapDamage(i,q.layer,origin))
    if(new Set(items.filter((i):i is MapDamage=>i!==null).map(i=>i.key)).size!==items.filter(i=>i!==null).length)throw new Error('Harita sayfasında yinelenen kayıt kimliği var.')
    return {items:items.filter((i):i is MapDamage=>i!==null),nextCursor:page.nextCursor,rejected:items.filter(i=>i===null).length}
  }}
}
export type MapApi=ReturnType<typeof createMapApi>
