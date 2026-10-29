import type { DamageType } from './types.ts'

/** Wire version, independent of model, dataset and application versions. */
export const CONTRACT_VERSION = 1 as const
export type SourceDomain = 'REAL' | 'SIM' | 'REPLAY'
export type DetectorKind = 'TEST' | 'YOLO'
export type CanonicalClass = DamageType | 'unknown'
export type ResultLabel = 'TEST_SYNTHETIC' | 'YOLO_RESULT'

export interface SessionScope {
  contractVersion: typeof CONTRACT_VERSION
  sessionId: string
  /** Rotate on seek, restart, video replacement or a new analysis attempt. */
  runId: string
  sourceDomain: SourceDomain
}

export interface DetectorIdentity {
  detectorKind: DetectorKind
  modelVersion: string
  classMapVersion: string
}

export type ClockDomain = 'DEVICE_MONOTONIC' | 'SIMULATION' | 'VIDEO'
export type CaptureTime = {
  clockDomain: 'DEVICE_MONOTONIC' | 'SIMULATION'
  clockId: string
  valueMs: number
} | {
  clockDomain: 'VIDEO'
  clockId: string
  videoId: string
  valueMs: number
}

export interface CaptureSession extends SessionScope {
  status: 'active' | 'completed' | 'cancelled'
  clockDomain: ClockDomain
  /** Clock epoch/instance; milliseconds from different clocks cannot be compared. */
  clockId: string
  detector: DetectorIdentity
}

export interface ImageFrame extends SessionScope {
  frameId: string
  capturedAt: CaptureTime
  width: number
  height: number
}

export type SpatialPosition = {
  kind: 'GPS'
  latitude: number
  longitude: number
  accuracyM: number
} | {
  kind: 'SIM_LOCAL'
  frameId: string
  units: 'm'
  x: number
  y: number
  z: number
}

export interface PositionSample extends SessionScope {
  sampleId: string
  capturedAt: CaptureTime
  position: SpatialPosition
}

/** Normalized image coordinates, never pixels or GPS coordinates. */
export interface BoundingBox {
  x: number
  y: number
  width: number
  height: number
}

export interface ClassMap {
  version: string
  approved: boolean
  entries: readonly { rawClassId: string; canonicalClass: DamageType }[]
}

export interface DetectionObservation extends SessionScope, DetectorIdentity {
  observationId: string
  frameId: string
  capturedAt: CaptureTime
  rawClassId: string
  canonicalClass: CanonicalClass
  /** Model score, not damage severity or calibrated probability of correctness. */
  confidence: number
  box: BoundingBox
}

export type DamageLocation = { kind: 'UNKNOWN' } | {
  kind: 'ESTIMATED'
  position: SpatialPosition
  uncertaintyM: number
  method: 'CALIBRATED_PROJECTION' | 'HUMAN_PLACEMENT'
}

export interface DamageCandidate extends SessionScope, DetectorIdentity {
  candidateId: string
  observationIds: readonly string[]
  canonicalClass: CanonicalClass
  reviewStatus: 'pending' | 'rejected'
  /** Capture vehicle pose is evidence, never implicitly the defect location. */
  vehiclePosition?: PositionSample
  damageLocation: DamageLocation
}

export interface VerifiedDamage extends SessionScope, DetectorIdentity {
  verifiedId: string
  candidateId: string
  canonicalClass: DamageType
  damageLocation: Extract<DamageLocation, { kind: 'ESTIMATED' }>
  reviewStatus: 'approved'
  review: { kind: 'HUMAN'; reviewerId: string }
}

export interface AlertEvent extends SessionScope, DetectorIdentity {
  alertId: string
  candidateId: string
  canonicalClass: DamageType
  resultLabel: ResultLabel
  reason: 'CAMERA_OBSERVATION' | 'MAP_APPROACH'
}

/** Ground truth is a separate channel; it is never detector output. */
export interface SimulationGroundTruth extends SessionScope {
  sourceDomain: 'SIM'
  truthId: string
  capturedAt: CaptureTime
  canonicalClass: DamageType
  position: Extract<SpatialPosition, { kind: 'SIM_LOCAL' }>
}

export type AnalysisStatus = 'running' | 'completed' | 'partial' | 'cancelled' | 'failed'

/** Recorded video is REPLAY even when YOLO runs against it now. */
export interface VideoAnalysisSession extends CaptureSession {
  sourceDomain: 'REPLAY'
  clockDomain: 'VIDEO'
  videoId: string
  videoDurationMs: number
  /** Fixed grid for coverage accounting, not playback FPS. At most 100,000 slots. */
  samplingIntervalMs: number
  recordingOrigin: 'REAL' | 'SIM' | 'UNKNOWN'
  analysisStatus: AnalysisStatus
}

export interface VideoTimelineEvent extends SessionScope, DetectorIdentity {
  sourceDomain: 'REPLAY'
  videoId: string
  eventId: string
  videoTimestampMs: number
  lastVideoTimestampMs: number
  canonicalClass: CanonicalClass
  confidence: number
  observationIds: readonly string[]
  reviewStatus: 'pending' | 'approved' | 'rejected'
}

export interface CoverageRange {
  startMs: number
  endMs: number
}

/** Successful sampled frames do not prove continuous coverage between frames. */
export interface FrameAnalysisOutcome extends SessionScope {
  videoId: string
  frameId: string
  videoTimestampMs: number
  status: 'analyzed' | 'skipped' | 'failed'
}

export interface AnalysisCoverage {
  basis: 'DECLARED_SAMPLING_GRID'
  samplingIntervalMs: number
  status: 'none' | 'partial' | 'complete'
  analyzedFrames: number
  skippedFrames: number
  failedFrames: number
  /** Verified ranges from a future sampling scheduler, not playback progress. */
  coveredRanges: readonly CoverageRange[]
  unanalysedRanges: readonly CoverageRange[]
}

export interface VideoAnalysisSummary extends SessionScope, DetectorIdentity {
  sourceDomain: 'REPLAY'
  videoId: string
  resultLabel: ResultLabel
  analysisStatus: AnalysisStatus
  coverage: AnalysisCoverage
  totalEvents: number
  rawObservationCount: number
  classCounts: Readonly<Record<CanonicalClass, number>>
  firstDamageTimestampMs: number | null
  lastDamageTimestampMs: number | null
  events: readonly VideoTimelineEvent[]
  deduplication: 'EXPLICIT_OBSERVATION_GROUPS'
}
