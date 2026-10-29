import { DAMAGE_TYPES } from './types.ts'
import type {
  AlertEvent, CaptureSession, CaptureTime, ClassMap, DamageCandidate,
  DetectionObservation, DetectorIdentity, ImageFrame, PositionSample,
  ResultLabel, SessionScope, SimulationGroundTruth, SpatialPosition,
  VerifiedDamage, VideoAnalysisSession,
} from './contracts.ts'

type RecordValue = Record<string, unknown>
export function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function onlyKeys(value: RecordValue, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}
export function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
}
export function finite(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
}
export function damageClass(value: unknown): boolean {
  return typeof value === 'string' && DAMAGE_TYPES.some(item => item === value)
}
export function canonicalClass(value: unknown): boolean {
  return value === 'unknown' || damageClass(value)
}
export function stringIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 10_000
    && value.every(identifier) && new Set(value).size === value.length
}
export function isSessionScope(value: unknown): value is SessionScope {
  return record(value) && value.contractVersion === 1 && identifier(value.sessionId)
    && identifier(value.runId) && ['REAL', 'SIM', 'REPLAY'].includes(value.sourceDomain as string)
}
export function sameScope(value: unknown, expected: SessionScope): value is SessionScope {
  return isSessionScope(value) && value.contractVersion === expected.contractVersion
    && value.sessionId === expected.sessionId && value.runId === expected.runId
    && value.sourceDomain === expected.sourceDomain
}
export function isDetectorIdentity(value: unknown): value is DetectorIdentity {
  return record(value) && (value.detectorKind === 'TEST' || value.detectorKind === 'YOLO')
    && identifier(value.modelVersion) && identifier(value.classMapVersion)
}
export function sameDetector(value: unknown, expected: DetectorIdentity): value is DetectorIdentity {
  return isDetectorIdentity(value) && value.detectorKind === expected.detectorKind
    && value.modelVersion === expected.modelVersion && value.classMapVersion === expected.classMapVersion
}
export function resultLabel(kind: DetectorIdentity['detectorKind']): ResultLabel {
  return kind === 'TEST' ? 'TEST_SYNTHETIC' : 'YOLO_RESULT'
}
export function isCaptureSession(value: unknown): value is CaptureSession {
  if (!record(value) || !isSessionScope(value) || !isDetectorIdentity(value.detector)
    || !identifier(value.clockId) || !['active', 'completed', 'cancelled'].includes(value.status as string)) return false
  const expectedClock = { REAL: 'DEVICE_MONOTONIC', SIM: 'SIMULATION', REPLAY: 'VIDEO' }
  return value.clockDomain === expectedClock[value.sourceDomain]
}
export function isVideoAnalysisSession(value: unknown): value is VideoAnalysisSession {
  if (!record(value) || !isCaptureSession(value) || value.sourceDomain !== 'REPLAY'
    || !identifier(value.videoId) || !finite(value.videoDurationMs, Number.EPSILON)
    || !finite(value.samplingIntervalMs, Number.EPSILON)
    || Math.ceil(value.videoDurationMs / value.samplingIntervalMs) > 100_000
    || !['REAL', 'SIM', 'UNKNOWN'].includes(value.recordingOrigin as string)) return false
  return value.status === 'active' ? value.analysisStatus === 'running'
    : value.status === 'cancelled' ? value.analysisStatus === 'cancelled'
      : ['completed', 'partial', 'failed'].includes(value.analysisStatus as string)
}
export function isCaptureTime(value: unknown, session: CaptureSession): value is CaptureTime {
  if (!record(value) || value.clockDomain !== session.clockDomain
    || value.clockId !== session.clockId || !finite(value.valueMs)) return false
  if (value.clockDomain !== 'VIDEO') return onlyKeys(value, ['clockDomain', 'clockId', 'valueMs'])
  return isVideoAnalysisSession(session) && value.videoId === session.videoId
    && value.valueMs <= session.videoDurationMs
    && onlyKeys(value, ['clockDomain', 'clockId', 'valueMs', 'videoId'])
}
export function isImageFrame(value: unknown, session: CaptureSession): value is ImageFrame {
  return record(value) && isCaptureSession(session) && sameScope(value, session)
    && identifier(value.frameId) && isCaptureTime(value.capturedAt, session)
    && Number.isSafeInteger(value.width) && finite(value.width, 1, 32_768)
    && Number.isSafeInteger(value.height) && finite(value.height, 1, 32_768)
}
export function isSpatialPosition(value: unknown, session: CaptureSession): value is SpatialPosition {
  if (!record(value) || !isCaptureSession(session)) return false
  const origin = session.sourceDomain === 'REPLAY'
    ? isVideoAnalysisSession(session) ? session.recordingOrigin : 'UNKNOWN'
    : session.sourceDomain
  if (value.kind === 'GPS') return origin === 'REAL'
    && onlyKeys(value, ['kind', 'latitude', 'longitude', 'accuracyM'])
    && finite(value.latitude, -90, 90) && finite(value.longitude, -180, 180)
    && finite(value.accuracyM)
  return value.kind === 'SIM_LOCAL' && origin === 'SIM' && identifier(value.frameId)
    && onlyKeys(value, ['kind', 'frameId', 'units', 'x', 'y', 'z'])
    && value.units === 'm' && finite(value.x, -Number.MAX_SAFE_INTEGER)
    && finite(value.y, -Number.MAX_SAFE_INTEGER) && finite(value.z, -Number.MAX_SAFE_INTEGER)
}
export function isPositionSample(value: unknown, session: CaptureSession): value is PositionSample {
  return record(value) && sameScope(value, session) && identifier(value.sampleId)
    && isCaptureTime(value.capturedAt, session) && isSpatialPosition(value.position, session)
}
export function isClassMap(value: unknown): value is ClassMap {
  if (!record(value) || !identifier(value.version) || typeof value.approved !== 'boolean'
    || !Array.isArray(value.entries) || value.entries.length === 0 || value.entries.length > 1_000) return false
  const ids = new Set<string>()
  for (const entry of value.entries) {
    if (!record(entry) || !identifier(entry.rawClassId) || !damageClass(entry.canonicalClass)
      || ids.has(entry.rawClassId)) return false
    ids.add(entry.rawClassId)
  }
  return true
}
export function resolveCanonicalClass(rawClassId: string, map: ClassMap): DetectionObservation['canonicalClass'] {
  if (!isClassMap(map) || !map.approved) return 'unknown'
  return map.entries.find(entry => entry.rawClassId === rawClassId)?.canonicalClass ?? 'unknown'
}
export function isDetectionObservation(
  value: unknown, session: CaptureSession, frame: ImageFrame, map: ClassMap,
): value is DetectionObservation {
  if (!record(value) || !isImageFrame(frame, session) || !sameScope(value, session)
    || !sameDetector(value, session.detector) || !isClassMap(map)
    || map.version !== session.detector.classMapVersion || !identifier(value.observationId)
    || value.frameId !== frame.frameId || !isCaptureTime(value.capturedAt, session)
    || value.capturedAt.valueMs !== frame.capturedAt.valueMs
    || !identifier(value.rawClassId) || !finite(value.confidence, 0, 1)
    || value.canonicalClass !== resolveCanonicalClass(value.rawClassId, map)) return false
  const box = value.box
  return record(box) && finite(box.x, 0, 1) && finite(box.y, 0, 1)
    && finite(box.width, Number.EPSILON, 1) && finite(box.height, Number.EPSILON, 1)
    && box.x + box.width <= 1 && box.y + box.height <= 1
}
function validDamageLocation(value: unknown, session: CaptureSession): boolean {
  return record(value) && ((value.kind === 'UNKNOWN' && onlyKeys(value, ['kind'])) || (value.kind === 'ESTIMATED'
    && onlyKeys(value, ['kind', 'position', 'uncertaintyM', 'method'])
    && isSpatialPosition(value.position, session) && finite(value.uncertaintyM)
    && ['CALIBRATED_PROJECTION', 'HUMAN_PLACEMENT'].includes(value.method as string)))
}
/** Inputs are previously frame/class-map validated observations, not raw detector JSON. */
export function isDamageCandidate(
  value: unknown, session: CaptureSession, observations: readonly DetectionObservation[],
): value is DamageCandidate {
  if (!record(value) || !sameScope(value, session) || !sameDetector(value, session.detector)
    || !identifier(value.candidateId) || !stringIds(value.observationIds) || !canonicalClass(value.canonicalClass)
    || !['pending', 'rejected'].includes(value.reviewStatus as string)
    || !validDamageLocation(value.damageLocation, session)
    || (value.vehiclePosition !== undefined && !isPositionSample(value.vehiclePosition, session))) return false
  return value.observationIds.every(id => {
    const matches = observations.filter(item => item.observationId === id)
    return matches.length === 1 && sameScope(matches[0], session)
      && sameDetector(matches[0], session.detector) && matches[0].canonicalClass === value.canonicalClass
  })
}
/** A human review preserves the original domain/detector; it cannot promote SIM/TEST to REAL/YOLO. */
export function isVerifiedDamage(value: unknown, session: CaptureSession, candidate: DamageCandidate): value is VerifiedDamage {
  return record(value) && sameScope(candidate, session) && sameDetector(candidate, session.detector)
    && candidate.reviewStatus === 'pending' && sameScope(value, session)
    && sameDetector(value, session.detector) && identifier(value.verifiedId)
    && value.candidateId === candidate.candidateId && damageClass(value.canonicalClass)
    && value.canonicalClass === candidate.canonicalClass && value.reviewStatus === 'approved'
    && record(value.review) && value.review.kind === 'HUMAN' && identifier(value.review.reviewerId)
    && record(value.damageLocation) && value.damageLocation.kind === 'ESTIMATED'
    && validDamageLocation(value.damageLocation, session)
}
/** Structural eligibility only, not a proximity, driving-safety or speech implementation. */
export function isAlertEvent(
  value: unknown, session: CaptureSession, candidate: DamageCandidate, map: ClassMap, verified?: VerifiedDamage,
): value is AlertEvent {
  return record(value) && session.status === 'active' && sameScope(candidate, session)
    && sameDetector(candidate, session.detector) && candidate.reviewStatus === 'pending'
    && sameScope(value, session) && sameDetector(value, session.detector)
    && identifier(value.alertId) && value.candidateId === candidate.candidateId
    && isClassMap(map) && map.approved && map.version === session.detector.classMapVersion
    && damageClass(value.canonicalClass) && value.canonicalClass === candidate.canonicalClass
    && map.entries.some(entry => entry.canonicalClass === value.canonicalClass)
    && value.resultLabel === resultLabel(session.detector.detectorKind)
    && ['CAMERA_OBSERVATION', 'MAP_APPROACH'].includes(value.reason as string)
    && (value.reason !== 'MAP_APPROACH' || (verified !== undefined && isVerifiedDamage(verified, session, candidate)))
}
export function isSimulationGroundTruth(value: unknown, session: CaptureSession): value is SimulationGroundTruth {
  return record(value) && session.sourceDomain === 'SIM' && sameScope(value, session)
    && identifier(value.truthId) && isCaptureTime(value.capturedAt, session)
    && damageClass(value.canonicalClass) && record(value.position)
    && value.position.kind === 'SIM_LOCAL' && isSpatialPosition(value.position, session)
}

export type Acceptance = { status: 'accepted' | 'duplicate' } | { status: 'rejected'; reason: string }
export function scopeKey(scope: SessionScope, kind: string, id: string): string {
  return JSON.stringify([scope.contractVersion, scope.sourceDomain, scope.sessionId, scope.runId, kind, id])
}
/** Pure idempotency decision; caller stores keys per run. No hidden global registry. */
export function acceptFrame(value: unknown, session: CaptureSession, seen: ReadonlySet<string>): Acceptance {
  if (!isCaptureSession(session) || session.status !== 'active' || !isImageFrame(value, session)) {
    return { status: 'rejected', reason: 'invalid_or_inactive_frame' }
  }
  return { status: seen.has(scopeKey(session, 'frame', value.frameId)) ? 'duplicate' : 'accepted' }
}
