import type { VideoAnalysisSession,VideoAnalysisSummary } from '@roadsense/shared'
export function summaryMetrics(summary:VideoAnalysisSummary,session:VideoAnalysisSession){
  const planned=Math.ceil(session.videoDurationMs/session.samplingIntervalMs),c=summary.coverage
  const unattempted=planned-c.analyzedFrames-c.skippedFrames-c.failedFrames
  if(!Number.isSafeInteger(planned)||planned<1||unattempted<0)throw new Error('Özet yuva sayıları tutarsız.')
  const unanalysedMs=c.unanalysedRanges.reduce((n,r)=>n+r.endMs-r.startMs,0)
  return {planned,analyzed:c.analyzedFrames,skipped:c.skippedFrames,failed:c.failedFrames,unattempted,outsideSuccess:planned-c.analyzedFrames,unanalysedMs,percent:c.analyzedFrames/planned*100}
}
