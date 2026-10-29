import { isReviewFrame } from '@roadsense/shared'
import type { ReviewFrame } from '@roadsense/shared'
export function evidenceBoxes(frame:ReviewFrame){
  if(!isReviewFrame(frame))throw new Error('Kanıt geometrisi geçersiz.')
  return frame.observations.map(o=>({id:o.observationId,left:o.box.x*100,top:o.box.y*100,width:o.box.width*100,height:o.box.height*100}))
}
export function imageDimensionsMatch(frame:ReviewFrame,width:number,height:number){return isReviewFrame(frame)&&width===frame.frame.width&&height===frame.frame.height}
