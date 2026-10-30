import { isReviewItem, isReviewMapEligible } from '@roadsense/shared'
import type { ReviewItem, SourceDomain } from '@roadsense/shared'
import { localApiTarget } from '../../api/localApiTarget.ts'

export type MapLayer = 'production' | 'test'
export type MapReviewReference = { origin:string; sourceDomain:SourceDomain; sessionId:string; runId:string; candidateId:string; verifiedId:string }
export type MapDamage = { key:string; item:ReviewItem; latitude:number; longitude:number; accuracyM:number; uncertaintyM:number; method:string; reference:MapReviewReference }
export const MAX_MAP_LATITUDE = 85.0511287798
export function mapReference(origin:string,item:ReviewItem):MapReviewReference {
  if(!isReviewItem(item)||!item.verifiedDamage)throw new Error('Doğrulanmış kayıt referansı yok.')
  return {origin:localApiTarget(origin),sourceDomain:item.sourceDomain,sessionId:item.sessionId,runId:item.runId,candidateId:item.candidateId,verifiedId:item.verifiedDamage.verifiedId}
}
export function validateMapReference(value:MapReviewReference):MapReviewReference {
  if(!value||Object.keys(value).sort().join(',')!=='candidateId,origin,runId,sessionId,sourceDomain,verifiedId'
    ||!['REAL','REPLAY','SIM'].includes(value.sourceDomain)||![value.sessionId,value.runId,value.candidateId,value.verifiedId].every(v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v)))throw new Error('Harita inceleme referansı geçersiz.')
  return {...value,origin:localApiTarget(value.origin)}
}
export function adaptMapDamage(value:unknown,layer:MapLayer,origin:string):MapDamage|null {
  if(!isReviewItem(value)||!isReviewMapEligible(value,layer))return null
  const location=value.verifiedDamage!.damageLocation,p=location.kind==='ESTIMATED'?location.position:null
  if(!p||p.kind!=='GPS'||Math.abs(p.latitude)>MAX_MAP_LATITUDE)return null
  const reference=mapReference(origin,value)
  return {key:[reference.origin,value.environment,value.sourceDomain,value.sessionId,value.runId,reference.verifiedId].join('|'),item:value,
    latitude:p.latitude,longitude:p.longitude,accuracyM:p.accuracyM,uncertaintyM:location.uncertaintyM,method:location.method,reference}
}
