import type { VideoTimelineEvent } from '@roadsense/shared'
export type TimelineCluster={key:string;percent:number;events:readonly VideoTimelineEvent[];firstMs:number;lastMs:number}
export function clusterTimeline(events:readonly VideoTimelineEvent[],durationMs:number,width:number):TimelineCluster[]{
  if(!Number.isFinite(durationMs)||durationMs<=0||!Number.isFinite(width)||width<=0)return []
  const bins=Math.max(1,Math.floor(width/44)),groups=new Map<number,VideoTimelineEvent[]>()
  for(const event of [...events].sort((a,b)=>a.videoTimestampMs-b.videoTimestampMs||a.eventId.localeCompare(b.eventId))){
    if(!Number.isFinite(event.videoTimestampMs)||event.videoTimestampMs<0||event.videoTimestampMs>=durationMs)throw new Error('Geçersiz olay zamanı.')
    const bin=Math.min(bins-1,Math.floor(event.videoTimestampMs/durationMs*bins));const group=groups.get(bin)??[];group.push(event);groups.set(bin,group)
  }
  return [...groups].map(([bin,group])=>({key:String(bin),percent:(bin+.5)/bins*100,events:group,firstMs:group[0].videoTimestampMs,lastMs:group.at(-1)!.videoTimestampMs}))
}
export function filterTimeline(events:readonly VideoTimelineEvent[],canonicalClass:string,status:string){return events.filter(e=>(!canonicalClass||e.canonicalClass===canonicalClass)&&(!status||e.reviewStatus===status))}
