export { APP_NAME, DAMAGE_TYPES, REPORT_STATUSES } from './types.ts'
export type {
  UserRole, DamageType, ReportStatus, Coordinates, DamageReport,
  ReportPhoto, AiPrediction, ApiError,
} from './types.ts'
export { getDamageTypeLabel, getReportStatusLabel, isValidCoordinates, formatReportDate } from './helpers.ts'
export { createApiClientConfig, DEFAULT_API_TIMEOUT_MS } from './api.ts'
export type {
  TokenProvider, ApiClientOptions, ApiClientConfig,
  ApiRequestOptions, ApiResult, ApiClient,
} from './api.ts'
export { CONTRACT_VERSION, VIDEO_CONTRACT_VERSION, VIDEO_SAMPLE_TOLERANCE_MS } from './contracts.ts'
export type {
  SourceDomain, DetectorKind, CanonicalClass, ResultLabel, SessionScope,
  DetectorIdentity, ClockDomain, CaptureTime, CaptureSession, ImageFrame,
  SpatialPosition, PositionSample, BoundingBox, ClassMap, DetectionObservation,
  DamageLocation, DamageCandidate, VerifiedDamage, AlertEvent, SimulationGroundTruth,
  AnalysisStatus, VideoAnalysisSession, VideoTimelineEvent, CoverageRange,
  FrameAnalysisOutcome, AnalysisCoverage, VideoAnalysisSummary,
} from './contracts.ts'
export {
  isSessionScope, sameScope, isDetectorIdentity, sameDetector, resultLabel,
  isCaptureSession, isVideoAnalysisSession, isCaptureTime, isImageFrame,
  isSpatialPosition, isPositionSample, isClassMap, resolveCanonicalClass,
  isDetectionObservation, isDamageCandidate, isVerifiedDamage, isAlertEvent,
  isSimulationGroundTruth, scopeKey, acceptFrame,
} from './contractValidation.ts'
export type { Acceptance } from './contractValidation.ts'
export {
  createVideoTimelineEvent, isVideoTimelineEvent, acceptVideoTimelineEvent,
  calculateAnalysisCoverage, summarizeVideoAnalysis,
} from './videoAnalysis.ts'
export type { VideoEvidence } from './videoAnalysis.ts'
