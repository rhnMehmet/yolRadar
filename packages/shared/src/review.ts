import type { CaptureSession, VideoAnalysisSession, SessionScope, DetectorIdentity, CanonicalClass, VerifiedDamage, ImageFrame, DetectionObservation, AnalysisCoverage } from './contracts.ts'
import { canonicalClass, damageClass, finite, identifier, isCaptureSession, isVideoAnalysisSession, record, sameDetector, sameScope, isSessionScope } from './contractValidation.ts'
export interface ReviewEvidence {
  frameId: string; width: number; height: number; available: boolean
  mime?: 'image/jpeg' | 'image/png'; videoTimestampMs?: number
}
/** Safe projection, not the immutable candidate snapshot or a maintenance ticket. */
export interface ReviewItem extends SessionScope, DetectorIdentity {
  environment: 'TEST'; resultOrigin: 'TEST_SYNTHETIC' | 'YOLO_RESULT'
  candidateId: string; eventId?: string; videoId?: string; recordingOrigin?: 'REAL' | 'SIM' | 'UNKNOWN'
  frameId: string; canonicalClass: CanonicalClass; videoTimestampMs?: number; confidence: number
  reviewStatus: 'pending' | 'approved' | 'rejected'; reviewRevision: number
  reviewedAt?: string; reviewerId?: string; reviewScope?: 'CONTENT' | 'LOCATION'
  locationStatus: 'UNKNOWN' | 'ESTIMATED' | 'VERIFIED'; verifiedDamage?: VerifiedDamage
  observationIds: readonly string[]; observationCount: number; frameCount: number; referencesTruncated: boolean
  evidence: readonly ReviewEvidence[]
}
export interface ReviewSession { environment: 'TEST'; resultOrigin: 'TEST_SYNTHETIC' | 'YOLO_RESULT'; session: CaptureSession | VideoAnalysisSession }
const keys = (v: Record<string, unknown>, allowed: readonly string[]) => Object.keys(v).every(k => allowed.includes(k))
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => finite(v, min, max) && Number.isSafeInteger(v)
const origin = (kind: unknown) => kind === 'TEST' ? 'TEST_SYNTHETIC' : 'YOLO_RESULT'
const detectorKeys = ['detectorKind','modelVersion','classMapVersion']
const scopeKeys = ['contractVersion','sessionId','runId','sourceDomain']
export function isReviewSession(value: unknown): value is ReviewSession {
  if (!record(value) || !keys(value, ['environment','resultOrigin','session']) || value.environment !== 'TEST'
    || !record(value.session) || !isCaptureSession(value.session) || !record(value.session.detector)
    || !keys(value.session.detector, detectorKeys) || value.resultOrigin !== origin(value.session.detector.detectorKind)) return false
  const base = [...scopeKeys,'status','clockDomain','clockId','detector']
  return value.session.sourceDomain === 'REPLAY'
    ? isVideoAnalysisSession(value.session) && keys(value.session, [...base,'videoId','videoDurationMs','samplingIntervalMs','recordingOrigin','analysisStatus'])
    : keys(value.session, base)
}
function verified(value: unknown, item: Record<string, unknown>): boolean {
  if (!record(value) || !keys(value, [...scopeKeys,...detectorKeys,'verifiedId','candidateId','canonicalClass','damageLocation','reviewStatus','review'])
    || !sameScope(value, item as unknown as SessionScope) || !sameDetector(value, item as unknown as DetectorIdentity)
    || !identifier(value.verifiedId) || value.candidateId !== item.candidateId || value.canonicalClass !== item.canonicalClass
    || !damageClass(value.canonicalClass) || value.reviewStatus !== 'approved' || item.reviewStatus !== 'approved'
    || !record(value.review) || !keys(value.review, ['kind','reviewerId']) || value.review.kind !== 'HUMAN' || !identifier(value.review.reviewerId)) return false
  const location = value.damageLocation
  if (!record(location) || !keys(location, ['kind','position','uncertaintyM','method']) || location.kind !== 'ESTIMATED'
    || !finite(location.uncertaintyM) || !['HUMAN_PLACEMENT','CALIBRATED_PROJECTION'].includes(location.method as string) || !record(location.position)) return false
  const p = location.position, source = item.sourceDomain === 'REPLAY' ? item.recordingOrigin : item.sourceDomain
  if (p.kind === 'GPS') return source === 'REAL' && keys(p, ['kind','latitude','longitude','accuracyM'])
    && finite(p.latitude,-90,90) && finite(p.longitude,-180,180) && finite(p.accuracyM)
  return p.kind === 'SIM_LOCAL' && source === 'SIM' && keys(p,['kind','frameId','units','x','y','z']) && identifier(p.frameId)
    && p.units === 'm' && finite(p.x,-Number.MAX_SAFE_INTEGER) && finite(p.y,-Number.MAX_SAFE_INTEGER) && finite(p.z,-Number.MAX_SAFE_INTEGER)
}
export function isReviewItem(value: unknown): value is ReviewItem {
  try {
    if (!record(value) || !keys(value,[...scopeKeys,...detectorKeys,'environment','resultOrigin','candidateId','eventId','videoId','recordingOrigin','frameId','canonicalClass','videoTimestampMs','confidence','reviewStatus','reviewRevision','reviewedAt','reviewerId','reviewScope','locationStatus','verifiedDamage','observationIds','observationCount','frameCount','referencesTruncated','evidence'])
      || !isSessionScope(value) || value.environment !== 'TEST' || !sameDetector(value, value as unknown as DetectorIdentity)
      || value.resultOrigin !== origin(value.detectorKind) || !identifier(value.candidateId) || !identifier(value.frameId)
      || !canonicalClass(value.canonicalClass) || !finite(value.confidence,0,1) || !integer(value.reviewRevision)
      || !['pending','approved','rejected'].includes(value.reviewStatus as string) || !['UNKNOWN','ESTIMATED','VERIFIED'].includes(value.locationStatus as string)
      || !integer(value.observationCount,1,10000) || !integer(value.frameCount,1,value.observationCount)
      || !Array.isArray(value.observationIds) || value.observationIds.length !== Math.min(100,value.observationCount)
      || !value.observationIds.every(identifier) || new Set(value.observationIds).size !== value.observationIds.length
      || !Array.isArray(value.evidence) || value.evidence.length !== Math.min(20,value.frameCount)
      || value.referencesTruncated !== (value.observationCount > 100 || value.frameCount > 20)) return false
    const replay = value.sourceDomain === 'REPLAY'
    if (replay ? !identifier(value.eventId) || !identifier(value.videoId) || !finite(value.videoTimestampMs) || !['REAL','SIM','UNKNOWN'].includes(value.recordingOrigin as string)
      : ['eventId','videoId','videoTimestampMs','recordingOrigin'].some(k => k in value)) return false
    const frames = new Set<string>()
    for (const e of value.evidence) {
      if (!record(e) || !keys(e,['frameId','width','height','available','mime','videoTimestampMs']) || !identifier(e.frameId)
        || frames.has(e.frameId) || !integer(e.width,1,32768) || !integer(e.height,1,32768) || typeof e.available !== 'boolean'
        || (e.available ? !['image/jpeg','image/png'].includes(e.mime as string) : 'mime' in e)
        || (replay ? !finite(e.videoTimestampMs) : 'videoTimestampMs' in e)) return false
      frames.add(e.frameId)
    }
    if (value.frameId !== value.evidence[0].frameId) return false
    const audited = value.reviewedAt !== undefined
    if (audited !== (value.reviewerId !== undefined) || audited !== (value.reviewScope !== undefined) || audited !== (value.reviewRevision > 0)) return false
    if (audited && (value.reviewStatus === 'pending' || !identifier(value.reviewerId) || !['CONTENT','LOCATION'].includes(value.reviewScope as string)
      || typeof value.reviewedAt !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.reviewedAt)
      || new Date(value.reviewedAt).toISOString() !== value.reviewedAt)) return false
    if ((value.locationStatus === 'VERIFIED') !== (value.verifiedDamage !== undefined)) return false
    return value.verifiedDamage === undefined || verified(value.verifiedDamage,value)
  } catch { return false }
}
/** This service has TEST data only; real source labels and human votes never promote it. */
export function isReviewMapEligible(value: unknown, layer: 'production' | 'test'): boolean {
  return layer === 'test' && isReviewItem(value) && value.locationStatus === 'VERIFIED' && value.reviewStatus === 'approved'
    && value.verifiedDamage?.damageLocation.position.kind === 'GPS'
}

export interface ReviewFrame extends SessionScope, DetectorIdentity {
  environment: 'TEST'; resultOrigin: 'TEST_SYNTHETIC' | 'YOLO_RESULT'; candidateId: string; eventId?: string; canonicalClass: CanonicalClass
  frame: ImageFrame; evidence: ReviewEvidence; observations: readonly DetectionObservation[]
}
export interface ReviewSummary extends SessionScope, DetectorIdentity {
  environment: 'TEST'; resultOrigin: 'TEST_SYNTHETIC' | 'YOLO_RESULT'; sourceDomain: 'REPLAY'; session: VideoAnalysisSession
  totalEvents: number; includedEvents: number; rawObservationCount: number
  reviewCounts: { pending: number; approved: number; rejected: number }
  locationCounts: { UNKNOWN: number; ESTIMATED: number; VERIFIED: number }
  classCounts: Readonly<Record<CanonicalClass, number>>
  slots: { planned: number; analyzed: number; skipped: number; failed: number; unattempted: number }
  coverage: AnalysisCoverage; firstDamageTimestampMs: number | null; lastDamageTimestampMs: number | null
  verifiedCount: number; verifiedRelations: readonly { candidateId: string; verifiedId: string }[]; verifiedTruncated: boolean
}
function counts(value: unknown, names: readonly string[]): value is Record<string, number> {
  return record(value) && keys(value,names) && names.every(k => integer(value[k]))
}
export function isReviewFrame(value: unknown): value is ReviewFrame {
  if (!record(value) || !keys(value,[...scopeKeys,...detectorKeys,'environment','resultOrigin','candidateId','eventId','canonicalClass','frame','evidence','observations'])
    || !isSessionScope(value) || !sameDetector(value,value as unknown as DetectorIdentity) || value.environment !== 'TEST'
    || value.resultOrigin !== origin(value.detectorKind) || !identifier(value.candidateId) || !canonicalClass(value.canonicalClass)) return false
  const f = value.frame, e = value.evidence, scope = value as unknown as SessionScope
  if (!record(f) || !keys(f,[...scopeKeys,'frameId','capturedAt','width','height','plannedSampleTimestampMs']) || !sameScope(f,scope)
    || !identifier(f.frameId) || !integer(f.width,1,32768) || !integer(f.height,1,32768) || ('plannedSampleTimestampMs' in f && !finite(f.plannedSampleTimestampMs))
    || !record(f.capturedAt) || !identifier(f.capturedAt.clockId) || !finite(f.capturedAt.valueMs)) return false
  const t = f.capturedAt, replay = value.sourceDomain === 'REPLAY'
  if (replay ? !identifier(value.eventId) : 'eventId' in value) return false
  if (t.clockDomain !== {REPLAY:'VIDEO',REAL:'DEVICE_MONOTONIC',SIM:'SIMULATION'}[value.sourceDomain]
    || !keys(t,replay ? ['clockDomain','clockId','valueMs','videoId'] : ['clockDomain','clockId','valueMs']) || (replay && !identifier(t.videoId))) return false
  if (!record(e) || !keys(e,['frameId','width','height','available','mime','videoTimestampMs']) || e.frameId !== f.frameId || e.width !== f.width || e.height !== f.height
    || typeof e.available !== 'boolean' || (e.available ? !['image/jpeg','image/png'].includes(e.mime as string) : 'mime' in e)
    || (replay ? e.videoTimestampMs !== t.valueMs : 'videoTimestampMs' in e)) return false
  if (!Array.isArray(value.observations) || !value.observations.length || value.observations.length > 100) return false
  const seen = new Set<string>()
  for (const o of value.observations) {
    if (!record(o) || !keys(o,[...scopeKeys,...detectorKeys,'observationId','frameId','capturedAt','rawClassId','canonicalClass','confidence','box'])
      || !sameScope(o,scope) || !sameDetector(o,value as unknown as DetectorIdentity) || !identifier(o.observationId) || seen.has(o.observationId)
      || o.frameId !== f.frameId || !identifier(o.rawClassId) || o.canonicalClass !== value.canonicalClass || !finite(o.confidence,0,1)
      || !record(o.capturedAt) || !keys(o.capturedAt,Object.keys(t)) || Object.keys(t).some(k=>(o.capturedAt as Record<string,unknown>)[k] !== t[k])) return false
    const b=o.box
    if (!record(b) || !keys(b,['x','y','width','height']) || !finite(b.x,0,1) || !finite(b.y,0,1) || !finite(b.width,Number.EPSILON,1) || !finite(b.height,Number.EPSILON,1) || b.x+b.width>1 || b.y+b.height>1) return false
    seen.add(o.observationId)
  }
  return true
}
export function isReviewSummary(v: unknown): v is ReviewSummary {
  if (!record(v) || !keys(v,[...scopeKeys,...detectorKeys,'environment','resultOrigin','session','totalEvents','includedEvents','rawObservationCount','reviewCounts','locationCounts','classCounts','slots','coverage','firstDamageTimestampMs','lastDamageTimestampMs','verifiedCount','verifiedRelations','verifiedTruncated'])
    || !isSessionScope(v) || v.sourceDomain !== 'REPLAY' || !sameDetector(v,v as unknown as DetectorIdentity)
    || !isReviewSession({environment:v.environment,resultOrigin:v.resultOrigin,session:v.session}) || !record(v.session)
    || !sameScope(v.session,v) || !record(v.session.detector) || !sameDetector(v,v.session.detector as unknown as DetectorIdentity)) return false
  const s=v.session as unknown as VideoAnalysisSession
  if (!integer(v.totalEvents) || !integer(v.includedEvents) || !integer(v.rawObservationCount) || !integer(v.verifiedCount)
    || !counts(v.reviewCounts,['pending','approved','rejected']) || !counts(v.locationCounts,['UNKNOWN','ESTIMATED','VERIFIED'])
    || !counts(v.classCounts,['pothole','longitudinal_crack','transverse_crack','alligator_crack','other','unknown'])
    || !counts(v.slots,['planned','analyzed','skipped','failed','unattempted'])) return false
  const r=v.reviewCounts,l=v.locationCounts,n=v.slots,c=v.coverage
  if(v.rawObservationCount<v.totalEvents || v.verifiedCount>r.approved)return false
  if (r.pending+r.approved+r.rejected!==v.totalEvents || r.pending+r.approved!==v.includedEvents || l.UNKNOWN+l.ESTIMATED+l.VERIFIED!==v.totalEvents
    || l.VERIFIED!==v.verifiedCount || Object.values(v.classCounts).reduce((a,b)=>a+b,0)!==v.includedEvents
    || n.planned!==Math.ceil(s.videoDurationMs/s.samplingIntervalMs) || n.planned!==n.analyzed+n.skipped+n.failed+n.unattempted
    || !record(c) || !keys(c,['basis','samplingIntervalMs','status','analyzedFrames','skippedFrames','failedFrames','coveredRanges','unanalysedRanges'])
    || c.basis!=='DECLARED_SAMPLING_GRID' || c.samplingIntervalMs!==s.samplingIntervalMs
    || c.analyzedFrames!==n.analyzed || c.skippedFrames!==n.skipped || c.failedFrames!==n.failed
    || !Array.isArray(c.coveredRanges) || !Array.isArray(c.unanalysedRanges)) return false
  const ranges: {startMs:number;endMs:number}[]=[]; let covered=0
  for (const [items,success] of [[c.coveredRanges,true],[c.unanalysedRanges,false]] as const) for (const range of items) {
    if (!record(range) || !keys(range,['startMs','endMs']) || !finite(range.startMs,0,s.videoDurationMs) || !finite(range.endMs,0,s.videoDurationMs)
      || range.startMs>=range.endMs || range.startMs%s.samplingIntervalMs!==0 || (range.endMs!==s.videoDurationMs && range.endMs%s.samplingIntervalMs!==0)) return false
    ranges.push({startMs:range.startMs,endMs:range.endMs})
    if (success) covered+=Math.ceil(range.endMs/s.samplingIntervalMs)-range.startMs/s.samplingIntervalMs
  }
  ranges.sort((a,b)=>a.startMs-b.startMs)
  if (!ranges.length || ranges[0].startMs!==0 || ranges.at(-1)!.endMs!==s.videoDurationMs || ranges.some((r,i)=>i>0 && ranges[i-1].endMs!==r.startMs) || covered!==n.analyzed
    || c.status!==(n.analyzed===n.planned?'complete':n.analyzed?'partial':'none') || (s.analysisStatus==='completed' && c.status!=='complete')) return false
  if (v.includedEvents===0 ? v.firstDamageTimestampMs!==null || v.lastDamageTimestampMs!==null
    : !finite(v.firstDamageTimestampMs,0,s.videoDurationMs) || !finite(v.lastDamageTimestampMs,v.firstDamageTimestampMs,s.videoDurationMs) || v.lastDamageTimestampMs===s.videoDurationMs) return false
  return Array.isArray(v.verifiedRelations) && v.verifiedRelations.length===Math.min(100,v.verifiedCount) && v.verifiedTruncated===(v.verifiedCount>100)
    && v.verifiedRelations.every(r=>record(r) && keys(r,['candidateId','verifiedId']) && identifier(r.candidateId) && identifier(r.verifiedId))
    && new Set(v.verifiedRelations.map(r=>r.verifiedId)).size===v.verifiedRelations.length
}
