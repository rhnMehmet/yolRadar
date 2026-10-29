import type { CaptureSession, VideoAnalysisSession, SessionScope, DetectorIdentity, CanonicalClass, VerifiedDamage } from './contracts.ts'
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
